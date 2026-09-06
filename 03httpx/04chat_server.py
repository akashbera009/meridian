import json
import httpx
from fastapi import FastAPI
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel

OLLAMA_URL = "http://localhost:11434/api/chat"

app = FastAPI()


class ChatRequest(BaseModel):
    prompt: str


async def stream_from_ollama(prompt: str, model: str = "llama3.2:3b"):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }

    # One AsyncClient per request here is fine for a demo; a real app
    # would create it once at startup and reuse it (connection pooling).
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", OLLAMA_URL, json=payload) as response:
            response.raise_for_status()

            async for line in response.aiter_lines():
                if not line:
                    continue

                chunk = json.loads(line)
                token = chunk["message"]["content"]

                # This is the actual re-streaming step: whatever Ollama
                # sends us, we immediately forward to whoever is reading
                # our own response body (the browser).
                yield token

                if chunk.get("done"):
                    break


@app.post("/chat")
async def chat(req: ChatRequest):
    # media_type text/plain: the browser reads this as a raw chunked
    # stream of text, not a JSON payload it waits to fully arrive.

    # async generator function -> gets a token, yields it out, freezes & wait for next token.
    return StreamingResponse(stream_from_ollama(req.prompt), media_type="text/plain")


@app.get("/")
async def index():
    return HTMLResponse(open("static_chat.html").read())
# how  to run 
#  uv run uvicorn 04chat_server:app --port 8001



## core IDEA 
# 1. At the bottom layer, httpx's aiter_lines() pulls one line of raw NDJSON off the network socket as it arrives.

# 2. Your generator (stream_from_ollama) parses that line, extracts just the content field → that's token.

# 3. It then yields token — this is the moment control hands back to whoever is driving the generator (here, StreamingResponse), carrying that one token value with it.

# 4. StreamingResponse immediately writes that token into the outgoing HTTP response to the browser — so it gets "re-streamed" out, exactly as you said.

# 5. Then your generator pauses right there, mid-function, waiting to be resumed for the next token.

# 6. When StreamingResponse asks for the next value, execution resumes right after yield, loops back to async for line in response.aiter_lines(), waits for/gets the next line from Ollama, and repeats.