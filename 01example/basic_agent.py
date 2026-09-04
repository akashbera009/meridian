# Step 1: Tools are just functions

def get_weather(city: str) -> str:
    """Pretend weather lookup. Swap this for a real API call later."""
    fake_data = {
        "bengaluru": "28°C, partly cloudy",
        "london": "14°C, raining (obviously)",
        "tokyo": "22°C, clear skies",
    }
    return fake_data.get(city.lower(), f"No weather data for {city}")


def calculate(expression: str) -> str:
    """Evaluate a math expression. eval() is dangerous in production —
    this is fine for a demo, use a proper math parser for real work."""
    allowed = set("0123456789+-*/(). ")
    if not set(expression) <= allowed:
        return "Error: only basic math characters are allowed"
    try:
        return str(eval(expression))
    except Exception as e:
        return f"Error: {e}"


def search_notes(query: str) -> str:
    """Pretend knowledge base. In real life: your DB, your docs, your API."""
    notes = {
        "deploy": "Deploys go out Tuesdays. Staging must be green first.",
        "oncall": "On-call rotation is weekly, handoff every Monday 10am.",
    }
    for key, value in notes.items():
        if key in query.lower():
            return value
    return "Nothing found in notes."


# A simple registry: tool name -> function
TOOLS = {
    "get_weather": get_weather,
    "calculate": calculate,
    "search_notes": search_notes,
}


# Step 2: Schemas
# schema passed to the model in order to understand the tools

#  "description" => It's the only information the model has when deciding whether to call your tool
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city", 
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"}
                },
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a basic math expression like '23 * 7 + 1'",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string"}
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_notes",
            "description": "Search the internal team notes",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
                "required": ["query"],
            },
        },
    },
]


# Step 3: The loop
import os
import json
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",  # any non-empty string — Ollama ignores it, but the SDK requires something
)
# client = OpenAI(
#     base_url="https://api.groq.com/openai/v1",
#     api_key=os.getenv("GROQ_LEARl_API_KEY"),  # from openrouter.ai/keys
# )

def run_agent(user_message: str, max_turns: int = 10) -> str:
    messages = [
        {
            "role": "system",
            "content": "You are a helpful assistant. Use tools when they "
                       "help. Answer directly when they don't.",
        },
        {"role": "user", "content": user_message},
    ]

    for turn in range(max_turns):
        response = client.chat.completions.create(
            model="llama3.2:3b",
            # model="openai/gpt-oss-120b",
            messages=messages,
            tools=TOOL_SCHEMAS,
        ) 

        msg = response.choices[0].message

        # No tool calls? The model answered. We're done.
        if not msg.tool_calls:
            return msg.content

        # The model wants tools. Log its request into history first.
        messages.append(msg)

        # Execute every tool it asked for, feed results back.
        for tool_call in msg.tool_calls:
            name = tool_call.function.name
            args = json.loads(tool_call.function.arguments)

            print(f"  [turn {turn}] model called {name}({args})")

            if name in TOOLS:
                try:
                    result = TOOLS[name](**args)
                except Exception as e:
                    result = f"Tool crashed: {e}"
            else:
                result = f"Unknown tool: {name}"

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })
        # Loop back: the model now sees the results and decides again.

    return "Agent stopped: hit the max turn limit."


# call the agent 
if __name__ == "__main__":
    question = ("What's the weather in Bengaluru, and if the temperature "
                "in celsius were multiplied by 3, what would you get? "
                "Also, when do deploys go out?")
    print(f"User: {question}\n")
    answer = run_agent(question)
    print(f"\nAgent: {answer}")
    
# run 
# uv run basic_agent.py 