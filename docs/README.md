# MERIDIAN

*field manual · vol. i*

A 31-week, self-hosted study tracker for going from **React Native + Django (1 YOE)** to
**AI Engineer (GenAI / LLM applications) at 10–14 LPA**.

> The display name lives in one place: `meta.title` in `data/index.json`. Change it there and the
> browser tab, header and shell prompt all follow. Rename the repo to match and nothing breaks.

Static site. No server, no database, no paid tools. Every learning resource linked in it is free.

```
Sep 2026 ──────────────────────────────────────────────── Apr 2027
 W0   M1          M2          M3     ▓▓▓ gap ▓▓▓  M4       M5          M6          M7
setup foundation  retrieval   judge   (3 weeks)   harden   agents      production  interview
      async       RAG+evals   traces              CI evals guardrails  deploy      + offers
      FastAPI     ↑ the       LLM-as-             + APPLY  MCP         mobile app  negotiate
      tool loop     resume    judge                                    ships
                    line
```

## What it does

Open it and the top of the page is **tonight**: today's block of tasks, a timer, hours logged
today, and a row of dots for the days you showed up this week. Below that, the week. The header
says whether you're **on track** — planned hours expected by today vs hours actually ticked,
with the 3-week park excluded so it never reads as falling behind.

Every week ends in a **deliverable** with a link field. Paste the repo, commit, screenshot or live
URL, and the **notebook** view (⌕) turns those into a ship log — your portfolio index, built as a
side effect of doing the work. The **self-check** on each week has an answer box; from week 1, a
past one resurfaces in the tonight strip each day as spaced recall. The notebook also collects
every per-task note and answer, searchable.

The four ship-points — W4, W8, W20, W24 — are starred. Finishing a week or unlocking the next one
says so.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly won't work — `file://` blocks `fetch`, so the roadmap JSON can't load.

## Deploy to GitHub Pages

```bash
git init && git add -A && git commit -m "meridian"
gh repo create meridian --public --source=. --push
# Settings → Pages → Source: deploy from branch `main`, folder `/ (root)`
```

Live at `https://<you>.github.io/meridian/`.

## How storage works

GitHub Pages is static — it can serve files but never write them. So the site splits its data in two,
and keeps the curriculum in one file per chapter:

```
data/
├── index.json           meta, principles, chapter order
├── chapters/
│   ├── m0.json          Boot          · W0
│   ├── m1.json          Foundation    · W1-4
│   ├── m2.json          Retrieval     · W5-8
│   ├── m3.json          Judge + park  · W9-12
│   ├── m4.json          Harden        · W13-16
│   ├── m5.json          Agents        · W17-20
│   ├── m6.json          Production    · W21-24
│   └── m7.json          Interview     · W25-30
└── progress.json        ← the only file the site writes
```

| | what | where | who writes it |
|---|---|---|---|
| **curriculum** | weeks, tasks, links, code | `data/index.json` + `data/chapters/*.json` | you, via `git commit` |
| **progress** | checkboxes, notes, time logs | `localStorage` → `data/progress.json` | the site |

Chapters load in parallel at boot, so splitting them costs nothing at runtime and means editing
one month never touches another month's diff.

Writes hit `localStorage` instantly, so the site is fast and works offline. Four seconds after
you stop clicking, it commits a merged `data/progress.json` to the repo through the GitHub
Contents API. Open the site on your phone and it pulls that file back down.

Merging is **per-key, last-write-wins**: every checkbox and note carries its own timestamp, so
editing on your laptop and phone in the same day merges instead of one overwriting the other.

### Enabling sync

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new)
2. Repository access: **only this repo**. Permissions: **Contents → Read and write**. Nothing else.
3. Paste it into ⚙ in the site.

The token lives only in that browser's `localStorage` and is never written into the repo. Paste it
once per device. If you'd rather not use a token at all, **Export / Import JSON** in the same panel
does the same job manually.

## Editing the curriculum

Add a task, swap a resource, move a week — edit the chapter's JSON and commit. No build step.
To add a chapter, drop `data/chapters/m8.json` in and append `"m8"` to `chapters` in `index.json`.

```jsonc
{
  "id": "w07", "n": 7, "phase": "m2",
  "start": "2026-10-19", "end": "2026-10-25",
  "title": "RETRIEVAL EVALS — the differentiator week",
  "why":   "why this week exists at all",
  "hours": 15,
  "tasks":     [{ "id": "w07.1", "t": "task text", "h": 4, "d": 1, "dEnd": 2 }],
  "resources": [{ "type": "blog|video|doc|course|repo", "label": "...", "url": "..." }],
  "code":      [{ "lang": "python", "label": "...", "body": "..." }],
  "deliverable": "what exists at the end of the week",
  "checkpoint":  "the question you should be able to answer"
}
```

`h` is hours. `d` is the day the task starts on (`1`=Mon … `5`=Fri, `6`=Weekend) and `dEnd` is set
only when a task is too big for one evening, so the UI can show `MON–TUE` instead of pretending a
4-hour task fits in a 2-hour weeknight. Days are derived from `h` against a 2h × 5 nights + 4.5h
weekend budget — change an `h` and re-run the day assignment, or just hand-edit `d`.

Weeks lock at 🔒 until the previous week is 60% done. It's a marker, not a gate — locked weeks
still open, and **unlock anyway** clears it.

## The two projects

**Project A — AI mobile app** (ships week 24). React Native front end, FastAPI + RAG backend,
deployed, live demo video. This is the differentiator: ML-bootcamp candidates cannot build this.

**Project B — agentic system with an eval harness** (ships week 20). Documented before/after
metrics table in the README, plus a red-team pass rate.

## The three things that decide the outcome

1. **Evals.** Everyone has a RAG chatbot. Almost nobody can say *"recall@5 went from 0.61 to 0.84
   after I added reranking."* That sentence beats any certificate. Weeks 7, 8, 9 and 14.
2. **Retrieval.** When an AI feature feels dumb it's the retriever, not the model. Diagnosing that
   is the core craft.
3. **Ship at work.** One AI feature at your current job puts *production* on your resume instead
   of *personal project*. Week 0 lists the candidate workflows; week 14 is the pitch.

## License

MIT for the code. The linked resources belong to their authors.
