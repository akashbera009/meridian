# Assignment: fire 50 LLM calls concurrently with a Semaphore(5),
# exponential backoff on 429, print p50/p95 latency and total wall time.
# Compare against the sequential version.

# --- Setup ---
# 1. This needs an async LLM client — reuse your Groq/OpenRouter/Ollama
#    setup from basic_agent.py or 04chat_server.py (client = OpenAI(...)
#    with an OpenAI-compatible base_url, or raw httpx.AsyncClient calls).
# 2. New concept: asyncio.Semaphore(5) — same async-with pattern as the
#    Lock you used in coroutines_lock.py, but allows up to 5 concurrent
#    holders instead of 1. That's your concurrency cap for the 50 calls.
# 3. New concept: exponential backoff — on a 429 (rate limit) response,
#    sleep, then retry with a growing delay (e.g. 1s, 2s, 4s...), up to
#    some max number of attempts before giving up on that call.
# 4. Timing: use time.perf_counter() around each individual call to
#    build a list of durations, and around the whole batch for wall time.
# 5. p50/p95: sort the durations list; p50 = median, p95 = 95th
#    percentile value. statistics.quantiles() can help, or manual index
#    math (sorted_list[int(len * 0.95)]).

# --- Structure to build (fill in the logic yourself) ---

import os
import asyncio
import statistics
import time
import httpx
from dotenv import load_dotenv

# root .env lives one level up from this file (03httpx/), not inside it
load_dotenv(dotenv_path="../.env")

total_calls = 50
semaphore_concurrency = 5

OLLAMA_URL = "http://localhost:11434/api/chat"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_API_KEY = os.getenv("GROQ_LEARl_API_KEY")

# Flip this to switch which backend call_llm_once hits, without touching
# run_sequential / run_concurrent / report / main at all.
USE_GROQ = False


async def call_llm_once(prompt: str) -> str:
    """Make one LLM call, retrying on 429 with exponential backoff.
    Return the model's text response (timing happens in the caller)."""
    if USE_GROQ:
        payload = {
            "model": "openai/gpt-oss-120b",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
        max_retries = 5
        delay = 1.0
        async with httpx.AsyncClient(timeout=None) as client:
            for attempt in range(max_retries):
                response = await client.post(
                    GROQ_URL,
                    json=payload,
                    headers=headers,
                    timeout=30,
                )
                if response.status_code == 429:
                    # Prefer the server's own hint if it gives one,
                    # otherwise fall back to our doubling delay.
                    retry_after = response.headers.get("retry-after")
                    wait = float(retry_after) if retry_after else delay
                    await asyncio.sleep(wait)
                    delay *= 2
                    continue

                response.raise_for_status()
                # Groq follows the OpenAI response shape — choices[0].message,
                # not Ollama's flat message.content.
                return response.json()["choices"][0]["message"]["content"]

            raise RuntimeError(f"Gave up after {max_retries} retries (429s)")

    payload = {
        "model":"llama3.2:3b",
        "messages": [{"role": "user", "content": prompt}],
        "stream":False
    }
    async with httpx.AsyncClient(timeout=None) as client :
        response = await client.post(
            OLLAMA_URL,
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        msg = response.json()["message"]["content"]
        return msg


async def call_with_semaphore(sem: asyncio.Semaphore, prompt: str) -> float:
    """Wrap call_llm_once so only `sem`'s permit-count run concurrently."""
    start = time.perf_counter()
    async with sem:
        await call_llm_once(prompt)
    end = time.perf_counter()
    return end - start


async def run_concurrent(prompts: list[str], concurrency: int = 5) -> list[float]:
    """Fire all prompts concurrently, capped at `concurrency` in flight.
    Return the list of per-call durations."""
    tasks = []
    base_semaphore = asyncio.Semaphore(concurrency)
    tasks = [ call_with_semaphore(base_semaphore, prompts[i]) for i in range(len(prompts))]
    result = await asyncio.gather(*tasks,return_exceptions=True) # if one falis will fails nothing will fall 
    return result

async def run_sequential(prompts: list[str]) -> list[float]:
    """Fire all prompts one at a time, no concurrency. For comparison."""
    durations = []
    for i in range(len(prompts)):
        start = time.perf_counter()
        await call_llm_once(prompts[i])
        end = time.perf_counter()
        durations.append(end - start)
    return durations



def report(label: str, durations: list[float], wall_time: float):
    """Print p50, p95, and total wall time for a batch of calls."""
    # statistics.quantiles(data, n=100) splits `data` into 100 equal-size
    # groups and returns the 99 cut points between them. Index 49 is the
    # boundary that has 50% of values below it (median = p50); index 94
    # is the one with 95% of values below it (p95). `n=100` is what makes
    # the indices line up with "percentile" numbers directly.
    percentiles = statistics.quantiles(durations, n=100)
    p50 = percentiles[49]
    p95 = percentiles[94]

    print(f"\n--- {label} ---")
    print(f"  calls:      {len(durations)}")
    print(f"  p50:        {p50:.3f}s")
    print(f"  p95:        {p95:.3f}s")
    print(f"  wall time:  {wall_time:.3f}s")


async def main():
    prompts = [f"Say the number {i}" for i in range(total_calls)]

    # --- run and time the sequential version ---
    # --- run and time the concurrent (Semaphore(5)) version ---
    # --- report() both, so they're easy to compare side by side ---

    concurrent_results = await run_concurrent(prompts ,concurrency= semaphore_concurrency) 
    print(concurrent_results)

    # sequential_results = await run_sequential(prompts)
    # print("time table" , sequential_results)

    # await call_llm_once("how are u?")


if __name__ == "__main__":
    asyncio.run(main())


# --- How to run ---
# cd 03httpx
# uv run assignment.py
#
# (make sure your LLM client's API key / base_url is set up first,
#  same as basic_agent.py / 04chat_server.py — Groq env var, or Ollama
#  running locally, whichever you choose to test against)


# --- Real production use case ---
# This is the exact pattern behind any service that calls an LLM API on
# behalf of many users/requests: a RAG pipeline embedding hundreds of
# document chunks, a batch job re-summarizing old support tickets, an
# agent fanning out sub-tasks to a model. Firing all calls unbounded
# risks getting rate-limited (or banned) by the provider and blowing
# past cost/latency budgets; firing them one-by-one is needlessly slow.
# Semaphore(N) caps concurrency to what the provider's rate limit
# actually allows, backoff handles the inevitable 429s gracefully
# instead of crashing the whole batch, and p50/p95 (not just average)
# is what production monitoring actually watches — average latency
# hides the slow outliers that real users feel, which is exactly what
# p95 is built to surface.
