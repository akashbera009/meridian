from fastapi import Request
from contextlib import asynccontextmanager
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}

# path param 
@app.get('/item/{id}')
async def why (id: int):
     return {"message": f'we got the item {id}'}

# order matters 
@app.get("/users/me")
async def read_user_me():
    return {"user_id": "the current user"}

@app.get("/users/{username}")
async def read_user(username: str):
    return {"username": username}


# file path param 
'''
uploads/
├── photos/
│   ├── vacation/
│   │   └── beach.jpg
│   └── profile.jpg
├── documents/
│   ├── resume.pdf
│   └── report.pdf
'''
# http://localhost:8000/files/sc/sd/ab.pdf
@app.get("/files/{path}")
async def read_file(file_path: str):
    return {"normal file_path": file_path} # this can't catch /sc/sd/ab.pdf

@app.get("/files/{file_path:path}")
async def read_file(file_path: str):
    return {"file_path": file_path}


# query param 
# http://localhost:8000/product?skip=2&limit=3
@app.get('/product')
async def read_items(skip: int = 0, limit: int = 10):
    return {"skip": skip, "limit": limit}


# http://localhost:8000/items/1?q=somequery
@app.get("/items/{item_id}")
async def read_item(item_id: str, q: str | None = None):
    if q:
        return {"item_id": item_id, "q": q}
    return {"item_id": item_id}

# http://localhost:8000/users/1/items/23?q=somequery&short=True
@app.get("/users/{user_id}/items/{item_id}") # multi path query params 
async def read_user_items(user_id: str, item_id: str, q: str | None = None, short: bool = False): # boolean 
    if q:
        return {"user_id": user_id, "item_id": item_id, "q": q , "short": short }
    return {"user_id": user_id, "item_id": item_id, "q": q , "short": short}


# request body 
from pydantic import BaseModel

class ItemBase(BaseModel):
    id: str
    name: str 
    description: str | None = None 
# response model 
@app.post("/items/" , response_model=ItemBase) #         ----> validates the request [response_model will take priority]
async def create_item(item: ItemBase)->ItemBase:#        ----> validates the response
    return item


#depends 
# http://localhost:8000/items-depends/?q=apple&skip=10&limit=20
from typing import Annotated
from fastapi import Depends

async def common_parameters(
    q: str | None = None,
    skip: int = 0,
    limit: int = 100
):
    return {"q": q, "skip": skip, "limit": limit}

CommonsDep = Annotated[dict, Depends(common_parameters)]
@app.get("/items-depends/")
async def read_users(commons: CommonsDep):
    return commons

# dependencies in action 
# http://localhost:8000/checked-items/  
from fastapi import Header, HTTPException
async def verify_token(x_token: Annotated[str, Header()]):
    if x_token != "fake-super-secret-token":
        raise HTTPException(status_code=400, detail="X-Token header invalid")

async def verify_key(x_key: Annotated[str, Header()]):
    if x_key != "fake-super-secret-key":
        raise HTTPException(status_code=400, detail="X-Key header invalid")
    return x_key
@app.get("/checked-items/" , dependencies= [Depends(verify_token) , Depends(verify_key)] ) # dependency injection 
async def read_items():
    return [{"item": "Foo"}, {"item": "Bar"}]

# yield dependencies work like a setup → use → cleanup pattern.
def connect_DB():
    pass
async def get_DB():
    db = connect_DB()
    try: 
        db.connect() 
        yield db
    except Exception as e:
        print("DB connection/use failed:", e)
        raise
    finally :
        db.close()
@app.get('/get-me/')
async def ge_user(db = Depends(get_DB)):
    return {"HELLO" , "AKASH" ,"DB CONNECTION"}


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
# store the model in the application's state
    model = request.app.state.embedding_model

    vector = model.embed(text)

    return {
        "embedding": vector
    }