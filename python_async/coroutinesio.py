import asyncio

async def fetch_data(name, delay):
    print(f"Starting task {name}")
    await asyncio.sleep(delay)
    print(f"Finished task {name}")
    return f"Result of task {name}"


async def main():
    # we can start run each task concurrently via 
    # 1. first approach -> 
    # task1 = asyncio.create_task(fetch_data("Task 1", 1))
    # task2 = asyncio.create_task(fetch_data("Task 2", 2))
    # task3 = asyncio.create_task(fetch_data("Task 3", 3))

    # 2. second approach -> [gather]
    # result = await asyncio.gather(fetch_data("Task 1", 1), fetch_data("Task 2", 2), fetch_data("Task 3", 3))
    # print(result)

    #3rd approad [Task group]
    tasks =[]
    async with asyncio.TaskGroup() as tg:
        for i , sleep_time in enumerate([1, 2, 3], start  = 1 ):
            task = tg.create_task(fetch_data(i, sleep_time))
            tasks.append(task)

    results = [task.result() for task in tasks]
    print(results)

# Approach 1 (asyncio.create_task manually): if task2 raises an exception, nothing automatically cancels task1/task3 or even surfaces the error unless you explicitly await each task and check. Tasks can fail silently — you might never notice unless you happen to await them.
# Approach 2 (asyncio.gather): better, since it does propagate the first exception raised. But by default it does not cancel the other still-running tasks when one fails — they keep running in the background orphaned, unless you pass return_exceptions=True and handle it yourself, which is easy to forget.
# Approach 3 (TaskGroup): if any task inside the group raises, it automatically cancels all the other sibling tasks, waits for them to finish cancelling, and then raises an ExceptionGroup containing everything that failed. It's structured concurrency — no dangling tasks, no silent failures. This is the same idea Trio pioneered and Python later adopted natively.

if __name__ == "__main__":
    asyncio.run(main())