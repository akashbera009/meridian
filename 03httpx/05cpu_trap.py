import asyncio
import time
from concurrent.futures import ProcessPoolExecutor
from fastapi import FastAPI

app = FastAPI()

# Created once at import time, reused across requests — spinning up a
# process pool per-request would defeat the point (process startup cost).
pool = ProcessPoolExecutor()


def cpu_heavy(n: int) -> int:
    # Pure Python loop — no I/O, no sleep. Holds the GIL the entire time
    # it runs on a thread; a *process* has its own separate GIL entirely.
    total = 0
    for i in range(n):
        total += i * i
    return total


@app.get("/cpu-blocking")
async def cpu_blocking():
    # Same mistake as Trap 1, but the "blocking" part is CPU work, not I/O.
    result = cpu_heavy(500000000)
    return {"result": result}


@app.get("/cpu-to-thread")
async def cpu_to_thread():
    # Trap 2's twist: to_thread moves it off the event-loop thread, but
    # the GIL means the two threads still can't run Python bytecode at
    # the same time. It only helps if the OTHER work is I/O-bound.
    result = await asyncio.to_thread(cpu_heavy, 500000000)
    return {"result": result}


# make heavy CPU work run faster / truly in parallel with other heavy CPU work
@app.get("/cpu-process-pool")
async def cpu_process_pool():
    # Real fix: a separate OS process has its own interpreter and its
    # own GIL, so this genuinely runs in parallel with the event loop
    # (and with other process-pool jobs, up to the number of CPU cores).
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(pool, cpu_heavy, 500000000) #  pool , function , parameter  
    return {"result": result}


@app.get("/ping")
async def ping():
    return {"pong": True}
 