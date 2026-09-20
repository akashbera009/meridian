# uv run uvicorn 02dependency_injection:app --reload

from fastapi import FastAPI

app = FastAPI()

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


## dependencies in action 
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
