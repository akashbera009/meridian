from ollama import chat

for part in chat(
    model="llama3.2:3b",
    messages=[{"role": "user", "content": "why is the sky blue?"}],
    stream=True,
):
  print(part["message"]["content"], end="", flush=True)
print()
