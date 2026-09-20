from fastapi import Request
from contextlib import asynccontextmanager
from fastapi import FastAPI

app = FastAPI()

## lifespan context manager
def  load_embedding_model():
    pass
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Application starting...")

    # STARTUP
    app.state.embedding_model = load_embedding_model() # modern approach is to store in application state 

    yield

    '''BEFORE yield
        ↓
        STARTUP

        yield
            ↓
        APPLICATION RUNNING

        AFTER yield
            ↓
        SHUTDOWN'''
    # SHUTDOWN
    print("Application shutting down...")
    # cleanup if necessary

app1 = FastAPI(lifespan=lifespan)

@app1.post("/embed")
async def create_embedding(
    text: str,
    request: Request
):
    # then access 
    model = request.app.state.embedding_model

    vector = model.embed(text)

    return {
        "embedding": vector
    }