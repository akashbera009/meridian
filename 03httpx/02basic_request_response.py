

import httpx
import asyncio

base_url ='https://jsonplaceholder.typicode.com'
async def fetch_data():
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{base_url}/todos/1")
        print(response.status_code)
        print(response.text)


def main():
    asyncio.run(fetch_data())

if  __name__ == '__main__':
    main()
