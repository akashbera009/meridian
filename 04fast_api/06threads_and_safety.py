"""
Threads and thread safety - what breaks, and why the GIL does not save you.

    uv run 06threads_and_safety.py            # run every demo below
    uv run uvicorn 06threads_and_safety:app   # the FastAPI part (section 7)

`coroutines_lock.py` showed asyncio.Lock: one thread, many coroutines, and a
switch only ever happens at an `await`. Threads are the harder case - the
interpreter can switch between *any* two bytecodes, including halfway through
a line you thought was one step.
"""

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from queue import Queue

from fastapi import FastAPI

# Make races reproducible on a small demo. Default is 5ms, which is long enough
# that short loops often finish inside one slice and look deceptively correct.
sys.setswitchinterval(1e-6)

THREADS = 8
TIGHT_STEPS = 100_000    # for the bare-increment loop
IO_STEPS = 200           # for the realistic read -> work -> write loop


# ------------------------------------------- 1a. the demo that lies to you

counter = 0


def increment_tight():
    global counter
    for _ in range(TIGHT_STEPS):
        # ONE line, but FOUR bytecodes: LOAD_GLOBAL, LOAD_CONST, BINARY_OP,
        # STORE_GLOBAL. The textbook says a thread switch between the load and
        # the store loses an increment. Run it and see what actually happens.
        counter += 1


def demo_tight():
    global counter
    counter = 0
    run(increment_tight)

    expected = THREADS * TIGHT_STEPS
    print(f"1a. bare `counter += 1` : {counter:,} of {expected:,} "
          f"(lost {expected - counter:,})")
    print("    Nothing lost - and that is the dangerous part. CPython only")
    print("    offers to switch threads at certain points (loop back-edges,")
    print("    calls), so this sequence tends to finish uninterrupted. That is")
    print("    an accident of this interpreter, NOT a guarantee. Same code on a")
    print("    free-threaded 3.13+ build, or with a call in the middle, loses")
    print("    counts immediately. 'I tested it and it was fine' is how these")
    print("    bugs reach production.\n")


# ---------------------------------------------- 1b. the race for real

def increment_realistic():
    """The shape every real race has: read state, do some work, write it back."""
    global counter
    for _ in range(IO_STEPS):
        value = counter
        time.sleep(0)     # stands in for: a query, an HTTP call, a file read.
        counter = value + 1   # ...by now `counter` has moved on without us.


def demo_race():
    global counter
    counter = 0
    run(increment_realistic)

    expected = THREADS * IO_STEPS
    lost = expected - counter
    print(f"1b. read -> work -> write: {counter:,} of {expected:,} "
          f"(lost {lost:,} = {lost / expected:.0%})")
    print("    Anything that releases the GIL mid-sequence - I/O, sleep, a C")
    print("    extension - opens the window wide. The GIL protects the")
    print("    interpreter's own memory, not your logic: it guarantees no")
    print("    crash, and nothing whatsoever about correctness.\n")


# ------------------------------------------------------------ 2. the lock

lock = threading.Lock()


def increment_locked():
    global counter
    for _ in range(IO_STEPS):
        # `with lock` makes the whole read-work-write indivisible: any other
        # thread reaching this line waits until the block exits.
        with lock:
            value = counter
            time.sleep(0)
            counter = value + 1


def demo_lock():
    global counter
    counter = 0
    run(increment_locked)
    print(f"2. under threading.Lock : {counter:,} of {THREADS * IO_STEPS:,}  correct")
    print("   The lock serialises the critical section, so the threads no")
    print("   longer overlap there. Hold it around the smallest region that")
    print("   must be atomic - a lock around everything is just one thread.\n")


# ------------------------------------------------- 3. check-then-act is a race

cache: dict[str, int] = {}
builds = 0


def expensive_build(key: str) -> int:
    time.sleep(0.05)          # pretend: a query, an API call, loading a model
    return len(key)


def get_unsafe(key: str):
    global builds
    # dict operations are individually atomic, so this NEVER corrupts the dict.
    # It is still wrong: every thread can pass the `not in` check before any of
    # them stores, so the expensive work runs N times instead of once.
    if key not in cache:
        value = expensive_build(key)
        builds += 1
        cache[key] = value


def get_safe(key: str):
    global builds
    if key not in cache:                 # fast path, no lock, no contention
        with lock:
            if key not in cache:         # re-check: someone may have won the race
                cache[key] = expensive_build(key)
                builds += 1


def demo_check_then_act():
    global builds
    for name, fn in (("unsafe", get_unsafe), ("safe", get_safe)):
        cache.clear()
        builds = 0
        run(fn, "model")
        print(f"3. {name:<6} cache fill: built {builds}x for 1 key")
    print("   'Atomic operations' is not the same as 'atomic sequence'.")
    print("   Two checks around one lock = double-checked locking.\n")


# --------------------------------------------------- 4. don't share at all

def demo_queue():
    """The easiest thread-safe program is one with no shared mutable state."""
    work = Queue()
    results = Queue()

    def worker():
        while True:
            item = work.get()
            if item is None:             # sentinel: one per worker, to stop it
                break
            results.put(item * item)
            work.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(THREADS)]
    for t in threads:
        t.start()
    for i in range(20):
        work.put(i)
    for _ in threads:
        work.put(None)
    for t in threads:
        t.join()

    total = sum(results.queue)
    print(f"4. Queue      : summed {results.qsize()} results -> {total}")
    print("   Queue has its own internal lock. Hand off data, don't share it.\n")


# ------------------------------------------------------- 5. thread-local state

local = threading.local()


def demo_thread_local():
    seen = Queue()

    def task(n):
        # Each thread gets its own `local.request_id`. No lock needed, because
        # nothing is shared - this is how frameworks track "current request".
        local.request_id = n
        time.sleep(0.01)
        seen.put(local.request_id == n)

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        list(pool.map(task, range(20)))

    print(f"5. thread-local: all {seen.qsize()} threads kept their own value "
          f"-> {all(seen.queue)}\n")


# ------------------------------------------------------------- 6. deadlock

def demo_deadlock():
    a, b = threading.Lock(), threading.Lock()

    def grab(first, second):
        with first:
            time.sleep(0.05)             # long enough for the other to grab its first
            with second:
                pass

    # Opposite acquisition order: thread 1 holds a and waits for b, thread 2
    # holds b and waits for a. Neither ever lets go.
    t1 = threading.Thread(target=grab, args=(a, b), daemon=True)
    t2 = threading.Thread(target=grab, args=(b, a), daemon=True)
    t1.start(), t2.start()
    t1.join(timeout=1.0)

    stuck = t1.is_alive()
    print(f"6. deadlock   : threads still blocked after 1s -> {stuck}")
    print("   Fix: always acquire multiple locks in the same global order,")
    print("   or use lock.acquire(timeout=...) so it fails loudly.\n")


# --------------------------------------------------- 7. where this bites in FastAPI

app = FastAPI()

hits = 0
hits_lock = threading.Lock()


@app.get("/sync-unsafe")
def sync_unsafe():
    """`def` (not `async def`) -> FastAPI runs this in a worker THREAD.

    Several requests genuinely execute this body at the same time, on different
    threads. Module-level mutable state is shared between them, so `hits += 1`
    is the exact race from section 1.
    """
    global hits
    hits += 1
    return {"hits": hits}


@app.get("/sync-safe")
def sync_safe():
    global hits
    with hits_lock:
        hits += 1
        return {"hits": hits}


@app.get("/async-endpoint")
async def async_endpoint():
    """`async def` -> runs on the event loop's single thread.

    `hits += 1` is safe here only because there is no `await` inside it. Put an
    await between the read and the write and you have the same bug again - that
    is what asyncio.Lock in coroutines_lock.py is for. Different primitive,
    same disease.
    """
    global hits
    hits += 1
    return {"hits": hits}


# ------------------------------------------------------------------- runner

def run(fn, *args) -> float:
    """Start THREADS threads on fn, wait for all, return elapsed seconds."""
    threads = [threading.Thread(target=fn, args=args) for _ in range(THREADS)]
    start = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.perf_counter() - start


if __name__ == "__main__":
    print(f"\npython {sys.version.split()[0]}  |  {THREADS} threads\n")
    demo_tight()
    demo_race()
    demo_lock()
    demo_check_then_act()
    demo_queue()
    demo_thread_local()
    demo_deadlock()
    print("Rule of thumb: share nothing (Queue, thread-local) > share behind a")
    print("lock > share and hope. Reach for the third only after measuring.")
