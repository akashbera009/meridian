import asyncio

# A shared lock 
shared_resource = 0

# A async lock 
lock = asyncio.Lock()


# idea is that 5 tasks want to modify the shared_resource at the same time 
# but there will be a lock , so that only 1 task at a time can modify the resource 
async def modify_shared_lock():
    global shared_resource
    async with lock :
        #enterine  
        print('Entering criticle section :[resource before modifiction]' , shared_resource)
        await asyncio.sleep(1)
        shared_resource += 1 
        print('Exit criticle section :[resource after modifiction]' , shared_resource)


async def main ():
    await asyncio.gather(*[modify_shared_lock() for i in range(5)])


if __name__ == "__main__":
    asyncio.run(main())
