# stall.py
import time, asyncio
from fastapi import FastAPI

app = FastAPI()

@app.get("/healthy")
async def healthy():
    await asyncio.sleep(0.01)
    return {"ok": True}

@app.get("/blocked")
async def blocked():
    time.sleep(2)  # looks harmless; holds the whole loop
    return {"ok": True}


# uv run uvicorn 05stall:app &
# curl -s localhost:8000/blocked &
# time curl -s localhost:8000/healthy
