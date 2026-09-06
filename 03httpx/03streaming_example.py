import json
import httpx
import asyncio

# Ollama's native /api/chat endpoint streams newline-delimited JSON objects
# by default (stream=True is the default unless you pass stream=False).
# Each line is one token/chunk of the response, not the whole reply at once.

OLLAMA_URL = "http://localhost:11434/api/chat"


async def stream_chat(prompt: str, model: str = "llama3.2:3b"):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }

    async with httpx.AsyncClient(timeout=None) as client:
        # client.stream() gives you the response incrementally instead of
        # buffering the whole body in memory before returning it.

        # async with guarantees client.aclose() gets called automatically
        # when the block exits, even if an exception is raised inside
        async with client.stream("POST", OLLAMA_URL, json=payload) as response:
            # checks the HTTP status code (not the JSON content) and raises an exception
            # if it's an error status (4xx or 5xx)
            response.raise_for_status()

            full_reply = ""
            # response.aiter_lines() is a method used to 
            # iterate over the response data line-by-line.
            async for line in response.aiter_lines():
                #  "how big is one line": it's not 2 words or 10 words — it's one token's worth of text
                if not line:
                    continue

                # sample chunk
                # {   "model": "llama3.2:3b", 
                #     "created_at": "...", 
                #     "message": 
                #     {   
                #         "role": "assistant", 
                #         "content": "Hello" 
                #     }, 
                #     "done": False
                # }

                # Extract only the 'content' part from the 'message' key.
                chunk = json.loads(line)
                token = chunk["message"]["content"]

                # flush=True: Forces Python to send the text to your screen immediately. 
                # Normally, Python saves text in a temporary holding area (a buffer) to 
                # save computer energy
                print(token, end="", flush=True)

                full_reply += token

                if chunk.get("done"):
                    break

    print()  # newline after streaming finishes
    return full_reply


async def main():
    reply = await stream_chat("Explain what a race condition is in one sentence.")
    print("\n--- full reply ---")
    print(reply)


if __name__ == "__main__":
    asyncio.run(main())


