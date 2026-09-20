import time

from fastapi import FastAPI, Request

app = FastAPI()


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.perf_counter()
    print("before request, it caught " , request.headers)
    response = await call_next(request) # pass to the next 
    print("after request")
    process_time = time.perf_counter() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response


@app.get("/users/{user_name}")
async def users(user_name:str):
    return {"users": user_name}

'''
    Client
    ↓
    Middleware
    ↓
    Route handler
    ↓
    Response
    ↓
    Middleware
    ↓
    Client
'''