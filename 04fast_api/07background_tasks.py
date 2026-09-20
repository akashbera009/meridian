from fastapi import BackgroundTasks, FastAPI
import asyncio
app = FastAPI()

async def write_notification(email: str, message=""):
    with open("log.txt", mode="w") as email_file:
        content = f"notification for {email}: {message}"
        await asyncio.sleep(5)
        email_file.write(content)

@app.get("/send-notification/{email}")
async def send_notificaion(email:str , background_tasks: BackgroundTasks):
    background_tasks.add_task(write_notification , email , 'hello all')
    return {"message" : "notification will be sent , check log file after 5 sec"}