from google import genai
# uv add google-genai
# uv run  python 01gemini_multiturn_conversation.py

import os
from dotenv import load_dotenv
load_dotenv()

print("first turn ")
api_key = os.getenv("GENERAL_LEARN_KEY")

client = genai.Client(
     api_key=api_key
)

interaction1 = client.interactions.create(
    model="gemini-3.8-flash",
    input="I have 2 dogs in my house.",
)
print(interaction1.output_text)
print("second turn ")
interaction2 = client.interactions.create(
    model="gemini-3.8-flash",
    input="How many paws are in my house?",
    previous_interaction_id=interaction1.id,
)
print(interaction2.output_text)