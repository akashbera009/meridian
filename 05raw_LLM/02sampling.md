# Sampling parameters

`temperature`, `top_p`, `top_k`, `max_tokens`, `stop_sequences` — and knowing when `temperature=0` is the wrong choice.

**Task:** w03.2 · **Budget:** 1 hour · You do not need the mathematics yet. You need to read a request and explain every parameter in it.

---

## The one idea underneath all five

An LLM does not write a sentence. It writes **one token**, then looks at everything so far and writes the next one.

At each step it produces a probability for every token it could emit:

```text
"I have 2 dogs"
        │
        ▼
  what comes next?

  "and"    ████████████████████  40%
  "at"     ██████████            20%
  "they"   ███████▌              15%
  "which"  ██▌                    5%
  ...
```

The model gives you that distribution. **Sampling is how you pick one token out of it.**

That is the whole foundation. Every parameter below is a knob on that picking step — except `max_tokens` and `stop_sequences`, which decide when to stop picking.

---

## 1. `temperature` — how adventurous the pick is

Temperature reshapes the distribution before the pick.

| Low temperature | High temperature |
|---|---|
| Sharpens the peaks | Flattens the curve |
| Likely tokens get *more* likely | Unlikely tokens get a real chance |
| Predictable, repeatable | Varied, surprising |

Same prompt — *"Give me a name for a banking app"* — at three settings:

```text
temperature = 0            temperature = 1          temperature = 2
  SecureBank                 Vaultly                  MoonVault
  SecureBank                 Finora                   QuantumPockets
  SecureBank                 BankNest                 BananaBank
                             MoneyFlow                Zestcoin??
```

Low temperature is not "smarter". It is **narrower**.

### The part that's actually on the checkpoint

> *Know when `temperature=0` is wrong.*

This does **not** mean "never use 0". It means: stop treating low randomness as automatically safer.

**`temperature=0` is right when there is one correct answer:**

- Classification and routing
- Extraction into a schema
- Structured output / JSON
- Code generation and data transformation
- Anything you will write tests against

Classify `"Your order has shipped."` into `billing / shipping / refund / complaint`, and you want `shipping` every single time. A category that flickers between runs is a bug, not creativity.

**`temperature=0` is wrong when you need range:**

- Brainstorming and ideation
- Creative writing, naming, copy
- **Generating N alternatives in one go**
- Anything where you'll pick the best of several

Ask for *20 startup ideas* at temperature 0 and you get twenty variations of one idea. The model keeps walking its single most-likely path.

```text
temperature 0    →  "I want the same answer every time"
higher           →  "I want different answers to choose from"
```

> **The trap worth remembering:** temperature 0 is *not* a guarantee of identical output. Batching, hardware and floating-point non-determinism mean you can still get drift between runs. It means "as deterministic as this stack can manage", not "reproducible".

---

## 2. `top_p` — how many candidates are even allowed

Temperature changes the *shape* of the distribution. `top_p` **truncates** it: throw away the long tail, then pick from what's left.

Sort the tokens by probability and add them up until you cross `top_p`. That group is the pool. Everything else gets probability zero.

```text
token    prob     running total
─────────────────────────────────
A        40%      40%
B        25%      65%
C        15%      80%   ← crosses 0.70 here
─────────────────────────────────  ✂  top_p = 0.70 cuts here
D        10%
E         5%
F         3%
G         2%
```

With `top_p = 0.70` the pool is **A, B, C** — C is included because you keep adding until you *cross* the threshold, so the pool is the smallest set whose total is at least 70%.

With `top_p = 1.0`, nothing is cut. Every token stays eligible.

> The number is a **share of probability mass, not a count of tokens.** When the model is confident, `top_p=0.9` might keep 2 tokens. When it's unsure, the same 0.9 might keep 50. The pool resizes itself based on how certain the model is — that's the whole point of it.

---

## 3. `top_k` — keep exactly this many candidates

Same idea as `top_p`, but it counts instead of measuring. Sort by probability, **keep the top K, bin the rest.**

Same distribution as before, with `top_k = 3`:

```text
token    prob
──────────────
A        40%   ✓ keep
B        25%   ✓ keep
C        15%   ✓ keep
──────────────  ✂  top_k = 3 cuts here
D        10%   ✗
E         5%   ✗
F         3%   ✗
G         2%   ✗
```

Pool is A, B, C. Always three tokens — **regardless of what the probabilities are.**

### The difference that matters

That "regardless" is the whole story. `top_k` is **fixed-size**; `top_p` is **adaptive**.

| Situation | `top_k = 3` keeps | `top_p = 0.9` keeps |
|---|---|---|
| Model is certain — `A 97%`, rest tiny | A, B, C — drags in 2 junk tokens | just A |
| Model is torn — 40 tokens near-equal | only 3 — throws away good options | ~35 tokens |

So `top_k` misbehaves at both ends. When the model is confident it forces in garbage that should have been cut; when the model is genuinely uncertain it amputates valid choices. `top_p` bends to the distribution's actual shape, which is why it's usually the better default and why you'll see it far more often in real code.

`top_k` is still worth knowing — it's cheap, it's in most APIs, and it's the classic you'll meet in papers and older examples.

> **Heads up:** Anthropic and Gemini expose `top_k`. **OpenAI does not.** It's the first parameter to vanish when you swap providers, so it's a good early test of whether your `llm.py` abstraction is honest — either map it, or refuse it loudly. Silently dropping a parameter the caller set is the worst option.

---

## temperature vs `top_p` vs `top_k`

The distinction to hold onto:

```text
temperature  →  reshapes the probabilities   "how random is the pick?"
top_p        →  cuts by probability mass     "keep the plausible ones"   (adaptive)
top_k        →  cuts by count               "keep exactly K"            (fixed)
```

All three dial randomness. They apply at different stages and they **stack** — `top_k` and `top_p` both cut, then temperature reshapes what survives. That compounding is exactly why tuning several at once teaches you nothing.

**Practical rule: move one, hold the other.** Change temperature and watch. Or change `top_p` and watch. If you move both and the output gets weird, you've learned nothing about which one did it.

Most people tune temperature, leave `top_p` at its default, and never touch `top_k`. That's a fine habit.

---

## 4. `max_tokens` — the output ceiling

```python
max_tokens=1024
```

> Generate **at most** 1024 tokens. Not "generate 1024".

```text
needs 200 tokens   →  200, stops naturally    stop_reason: "end_turn"
needs 800 tokens   →  800, stops naturally    stop_reason: "end_turn"
needs 5000 tokens  →  cut off at 1024         stop_reason: "max_tokens"  ⚠
```

Three things to know:

1. **It counts output only.** Your prompt does not come out of this budget.
2. **Hitting it truncates mid-sentence.** There is no graceful wrap-up. You get half a thought, and if you were parsing JSON, you get invalid JSON.
3. **Always check `stop_reason`.** It is the difference between "the model finished" and "I cut the model off". Silently treating a `max_tokens` response as complete is a real and common bug.

Set it too low to save money and you pay twice — once for the truncated response, once for the retry.

---

## 5. `stop_sequences` — stop when you see this text

> When you generate this exact string, stop immediately.

```python
stop_sequences=["END"]
```

The model writes:

```text
Here are the steps:

1. Install Django
2. Create the project
3. Run migrations

END                        ← generation stops here
Now let's discuss deploy…  ← never generated
```

Notes that matter in practice:

- The stop text itself is normally **not** included in what you get back.
- You can pass several; the first one hit wins.
- `stop_reason` tells you a stop sequence fired, rather than the model finishing on its own.

Useful when you're generating a fixed format and want a hard delimiter — one item of a list, one section, one record — instead of letting the model ramble into the next one.

---

## The whole topic in one picture

```text
                    LLM
                     │
                     ▼
            predict next token
                     │
                     ▼
        ┌────────────────────────┐
        │  candidate tokens      │
        │                        │
        │  A → 40%               │
        │  B → 25%               │
        │  C → 15%               │
        │  D → 10%               │
        │  …                     │
        └────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      top_k        top_p     temperature
   keep exactly   cut the     reshape the
     K tokens    long tail   probabilities
        │            │            │
     (fixed)    (adaptive)        │
        └────────────┼────────────┘
                     ▼
               pick one token
                     ▼
              append, repeat…
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     max_tokens          stop_sequences
   "never exceed         "stop the moment
    this many"            this appears"
```

---

## How to spend the hour

Do **not** read API docs for an hour. Run things and look at the output.

| Time | Do this |
|---|---|
| 0–10 min | Understand the loop: predict distribution → sample one token → repeat. Nothing more. |
| 10–25 min | **Temperature.** Run the same prompt at `0`, `0.3`, `0.7`, `1.0`. |
| 25–40 min | **`top_p` and `top_k`.** Run `top_p` at `1.0`, `0.9`, `0.5`. Then set `top_k=1` and watch output collapse to one path. Skip the math. |
| 40–50 min | **`max_tokens` + `stop_sequences`.** Deliberately trigger `stop_reason: "max_tokens"` once. |
| 50–60 min | Read a full request and narrate every parameter out loud. |

### Two prompts to run at each temperature

**Prompt A — creative.** *"Give me 10 names for an AI note-taking app."*
Run it three times at `0`. Then three times at `1.0`. Count how many unique names you got in each batch. That number **is** the lesson.

**Prompt B — classification.** *"Classify as positive or negative: 'the delivery was late but the item is perfect'."*
Run five times at `1.0`. If the label ever flips, you've just felt why production classifiers pin temperature to 0.

### You've finished when you can read this and explain every line

```python
client.messages.create(
    model="...",
    messages=[...],
    temperature=0.7,          # moderately varied pick
    top_p=0.9,                # drop the unlikely tail
    top_k=40,                 # …and never consider more than 40
    max_tokens=2048,          # ceiling — check stop_reason!
    stop_sequences=["END"],   # hard delimiter
)
```

---

## Caveat before you memorise anything

**Do not assume every provider exposes these identically.** Names, defaults, valid ranges and interactions differ, and they change:

- Gemini nests them in a `generationConfig` and uses `topP`, `topK`, `maxOutputTokens`, `stopSequences`.
- **`top_k` is not universal** — Anthropic and Gemini have it, OpenAI does not. First casualty of a provider swap.
- Anthropic takes `temperature`, `top_p`, `max_tokens`, `stop_sequences` at the top level — but **newer models restrict or reject sampling parameters**, especially alongside extended thinking. Check the docs for the specific model before assuming a knob exists.
- Providers differ on valid temperature range, so "temperature 2" is not a universal setting.

So learn the **concepts**, which are stable:

```text
temperature     →  randomness of the pick
top_p           →  probability-mass cutoff  (adaptive pool)
top_k           →  fixed-count cutoff       (rigid pool)
max_tokens      →  output ceiling
stop_sequences  →  explicit stop trigger
```

Then look up the exact spelling per provider. This is precisely the mess `llm.py` exists to hide — one interface, four providers, these four ideas mapped onto whatever each one calls them.

---

## Resources

1. **How to generate text** — greedy, beam, top-k, top-p and temperature, with diagrams. The clearest 20 minutes on sampling anywhere.
   <https://huggingface.co/blog/how-to-generate>
2. **Gemini `GenerationConfig`** — the same knobs under Google's names. A lookup, not a read.
   <https://ai.google.dev/api/generate-content#GenerationConfig>

---

## Checkpoint

Answer in your own words, as if to an interviewer:

1. Why is `temperature=0` the right default for an extraction endpoint and the wrong one for "give me 20 taglines"?
2. `top_p=0.9` — does that keep 9 tokens, 90 tokens, or something else? Why can't you tell without seeing the distribution?
3. The model is 97% sure the next token is `A`. What does `top_k=3` let through that `top_p=0.9` correctly throws away?
4. Your JSON parser fails on roughly 1 in 20 responses. How does `stop_reason` help you find out whether sampling is even the problem?
