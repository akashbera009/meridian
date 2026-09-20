# uv run uvicorn 04streaming_resopnse:app --reload

import asyncio
from starlette.applications import Starlette
from starlette.routing import Route
from sse_starlette import EventSourceResponse

## Key Components
''' 
1. EventSourceResponse

2. ServerSentEvent

3. JSONServerSentEvent

'''
async def generate_events():
    for i in range(10):
        yield {"data": f"Event {i}"}
        await asyncio.sleep(1)

async def sse_endpoint(request):
    return EventSourceResponse(generate_events())

# app = Starlette(routes=[Route("/events", sse_endpoint)])


# 1. EventSourceResponse

# async def stream_data():
#     for item in data:
#         yield {"data": item, "event": "update", "id": str(item.id)}

# return EventSourceResponse(stream_data())

# 2. ServerSentEvent
from sse_starlette import ServerSentEvent

event = ServerSentEvent(
    data="Custom message",
    event="notification", 
    id="msg-123",
    retry=5000
)

# 3. JSONServerSentEvent
from sse_starlette import JSONServerSentEvent

event = JSONServerSentEvent(
    data={"field":"value"}, # Anything serializable with json.dumps
)

# usaegs : 
from fastapi import FastAPI
from sse_starlette import EventSourceResponse

app = FastAPI()

@app.get("/stream")
async def stream():

    async def generator():
        yield {"data": "hello"}
        yield {"data": "world"}

    return EventSourceResponse(generator())