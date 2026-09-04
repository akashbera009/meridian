# A semaphore is a concurrency-control mechanism that limits how many tasks can access something at the same time.
import asyncio

async def access_resource(semaphore, resource_id):
    async with semaphore:
        # simulate accessing a limited resource 
        print('accessing resource' , resource_id)
        await asyncio.sleep(1)
        print('exiting resource' , resource_id)

async def main():
    semaphore = asyncio.Semaphore(2) # allow 2 concurrent accesses to the resource at a time 
    tasks = [access_resource(semaphore, i) for i in range(5)]
    await asyncio.gather(*tasks)

if __name__ == '__main__':
    asyncio.run(main())