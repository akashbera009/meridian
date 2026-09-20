"""
SSE endpoint that streams an LLM response to the browser.

    uv run uvicorn 05streaming_llm:app --reload
    open http://127.0.0.1:8000/

This is `04streaming_resopnse.py` grown up. Three things a toy SSE handler skips:

  1. client disconnect  -> notice it, log it, stop burning GPU on a dead browser
  2. error recovery     -> retry what is retryable, tell the browser what isn't
  3. real token stream  -> JSON frames, so whitespace and newlines survive
"""

import asyncio
import json
import logging

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from ollama import AsyncClient, RequestError, ResponseError
from sse_starlette import EventSourceResponse, ServerSentEvent

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s | %(message)s")
log = logging.getLogger("sse")

MODEL = "llama3.2:3b"
MAX_ATTEMPTS = 3        # how many times we try to *open* the stream
BACKOFF = 1.0           # seconds before first retry, doubled each attempt

# Failures worth retrying: ollama not started yet, model still loading,
# connection refused, socket timeout. Anything else is a real bug -> let it out.
RETRYABLE = (RequestError, ResponseError, httpx.HTTPError, ConnectionError, TimeoutError)

app = FastAPI()


# ---------------------------------------------------------------- 1. disconnect

async def on_client_close(message):
    """Called by sse-starlette the moment the browser drops the connection.

    This is the hook you want for logging/metrics/cleanup. Note what we do NOT
    use here: `await request.is_disconnected()`. Both it and sse-starlette read
    from the same ASGI `receive` channel, and an ASGI message is delivered
    once - so polling it yourself can eat the `http.disconnect` that
    sse-starlette is waiting for. Use this callback instead.
    """
    log.warning("client disconnected -> cancelling generation")


# ------------------------------------------------------------------ 2. the feed

async def token_stream(prompt: str):
    """Yield SSE frames for one prompt.

    Contract: this generator never raises on a *handled* failure. Anything the
    user should know about leaves as an `error` frame, because an exception
    escaping here just kills the connection with no explanation in the browser.
    """
    client = AsyncClient()
    sent = 0
    delay = BACKOFF

    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                stream = await client.chat(
                    model=MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    stream=True,
                )

                async for chunk in stream:
                    text = chunk["message"]["content"]
                    if not text:
                        continue
                    sent += 1
                    # JSON-encode the token. Raw `data: {text}` works until a
                    # token is " " or "\n" and the SSE framing eats it.
                    yield ServerSentEvent(
                        event="token",
                        data=json.dumps({"text": text}),
                        id=str(sent),
                    )

                log.info("completed: %d tokens", sent)
                yield ServerSentEvent(event="done", data=json.dumps({"tokens": sent}))
                return

            except RETRYABLE as exc:
                # Already streamed text to the screen? A silent retry would
                # duplicate it. Stop and say so.
                if sent:
                    log.error("stream died after %d tokens: %s", sent, exc)
                    yield ServerSentEvent(
                        event="error",
                        data=json.dumps({"message": f"Stream interrupted: {exc}"}),
                    )
                    return

                if attempt == MAX_ATTEMPTS:
                    log.error("giving up after %d attempts: %s", attempt, exc)
                    yield ServerSentEvent(
                        event="error",
                        data=json.dumps({"message": f"Model unreachable: {exc}"}),
                    )
                    return

                # Nothing sent yet, so retrying is safe and invisible.
                log.warning("attempt %d/%d failed (%s), retrying in %.1fs",
                            attempt, MAX_ATTEMPTS, exc, delay)
                yield ServerSentEvent(
                    event="retrying",
                    data=json.dumps({"attempt": attempt, "in": delay}),
                )
                await asyncio.sleep(delay)
                delay *= 2

    except asyncio.CancelledError:
        # sse-starlette cancels this generator when the browser goes away.
        # Re-raise: swallowing a CancelledError leaves the task group hanging.
        log.info("generation cancelled after %d tokens", sent)
        raise

    finally:
        # Runs on success, error, and disconnect alike - the only safe place
        # to release anything you opened (here: the httpx pool behind ollama).
        await client.close()
        log.info("connection closed (%d tokens sent)", sent)


@app.get("/stream")
async def stream(prompt: str = "Why is the sky blue?"):
    return EventSourceResponse(
        token_stream(prompt),
        client_close_handler_callable=on_client_close,
        ping=15,           # ping after every 15 seconds
        send_timeout=30,   # a client that stops reading is treated as gone
    )


# ------------------------------------------------------------------ 3. the page

PAGE = """
<!doctype html>
<title>LLM stream</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
         max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.1rem; letter-spacing: .02em; text-transform: uppercase;
       opacity: .6; font-weight: 600; }
  form { display: flex; gap: .5rem; margin: 1.25rem 0; }
  input { flex: 1; padding: .6rem .75rem; font: inherit;
          border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
          border-radius: 6px; background: transparent; color: inherit; }
  button { padding: .6rem 1rem; font: inherit; border-radius: 6px; cursor: pointer;
           border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
           background: transparent; color: inherit; }
  #out { white-space: pre-wrap; min-height: 6rem; padding: 1rem;
         border-radius: 8px;
         background: color-mix(in srgb, currentColor 6%, transparent); }
  #status { font-size: .8rem; opacity: .65; margin-top: .75rem; }
  .err { color: #c0392b; }
</style>

<h1>Streaming from llama3.2:3b</h1>
<form id="f">
  <input id="q" value="Why is the sky blue?" autocomplete="off">
  <button>Send</button>
  <button type="button" id="stop">Stop</button>
</form>
<div id="out"></div>
<div id="status">idle</div>

<script>
const out = document.getElementById("out");
const status = document.getElementById("status");
let es = null;

function stop(msg) {
  if (es) { es.close(); es = null; }   // closing is what sends http.disconnect
  status.textContent = msg;
}

document.getElementById("f").onsubmit = (e) => {
  e.preventDefault();
  stop("connecting...");
  out.textContent = "";
  status.className = "";

  es = new EventSource("/stream?prompt=" + encodeURIComponent(q.value));

  es.addEventListener("token", (e) => {
    status.textContent = "streaming...";
    out.textContent += JSON.parse(e.data).text;
  });

  es.addEventListener("retrying", (e) => {
    const d = JSON.parse(e.data);
    status.textContent = `model not ready, retry ${d.attempt} in ${d.in}s...`;
  });

  es.addEventListener("error", (e) => {
    // Our own error frame carries data; a transport error does not.
    const msg = e.data ? JSON.parse(e.data).message : "connection lost";
    status.className = "err";
    stop(msg);
  });

  es.addEventListener("done", (e) => {
    // Critical: EventSource auto-reconnects whenever the stream ends. Without
    // this close() the browser silently re-runs the prompt, forever.
    stop(`done - ${JSON.parse(e.data).tokens} tokens`);
  });
};

document.getElementById("stop").onclick = () => stop("stopped by user");
</script>
"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return PAGE
