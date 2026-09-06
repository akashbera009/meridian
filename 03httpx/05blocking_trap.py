import time
import asyncio
from fastapi import FastAPI

app = FastAPI()


def blocking_work(seconds: float):
    # Simulates: a sync DB driver call, hashlib work, pandas, PIL, etc.
    # No await anywhere inside — the event loop cannot get control back
    # until this function fully returns.
    time.sleep(seconds)
    return f"finished blocking work after {seconds}s"


# --- THE TRAP ---
@app.get("/bad")
async def bad_endpoint():
    # This call runs synchronously on the event loop's own thread.
    # Every other request currently being served — even ones that are
    # just streaming tokens and doing nothing CPU-heavy — freezes for
    # the full 5 seconds, because there's only one thread and it's busy.
    result = blocking_work(5)
    return {"result": result}


# --- THE FIX ---
@app.get("/good")
async def good_endpoint():
    # asyncio.to_thread runs the blocking call in a separate worker thread
    # from a thread pool, and *awaits* its completion.
    # The event loop's own thread stays free the whole time to keep
    # serving other requests/coroutines.
    result = await asyncio.to_thread(blocking_work, 5)
    return {"result": result}


# Older equivalent (pre-3.9, or when you need more control over the
# executor/thread pool used): loop.run_in_executor(None, fn, *args)
@app.get("/good-old-style")
async def good_old_style_endpoint():
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, blocking_work, 5)
    return {"result": result}


@app.get("/ping")
async def ping():
    # Cheap async endpoint used to prove the other endpoints are (or
    # aren't) blocking the whole server.
    return {"pong": True}


# how to test 
# 1. Start the server (leave this running in a terminal):
# cd /Users/admin/Desktop/ai/03httpx
# uv run uvicorn 05blocking_trap:app --port 8030 --reload

# 2. Open two new terminals and run these two commands **at the same time** (or as quickly as you can):

# Terminal 2: Call the bad endpoint and watch it hang for 5 seconds
# curl localhost:8030/bad
# Terminal 3: Call ping **while the first one is still running**
# curl localhost:8030/ping

# What you should see
# In Terminal 3, the ping request will take ~5 seconds to complete — the same amount of time the bad endpoint took to finish.
# This proves that the single event loop thread is completely blocked and cannot serve any other requests while /bad is running.


# 3.now same with the good endpoint

