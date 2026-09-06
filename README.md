# akashbera009 / meridian

Personal project workspace.

| path | what | live |
|---|---|---|
| [`docs/`](docs/) | **MERIDIAN** — 31-week field manual, self-hosted study tracker | [akashbera009.github.io/meridian](https://akashbera009.github.io/meridian/) |

`docs/` is the GitHub Pages source (Settings → Pages → branch `main`, folder `/docs`).

## Branches

The two branches hold different things and do not merge into each other.

| branch | holds | rule |
|---|---|---|
| `main` | the notes — MERIDIAN itself: roadmap, progress, notes, embedded labs | **`docs/` only.** No source folders, ever — it is the Pages deploy surface. |
| `dev` | the code — the learning work, one folder per topic | No restriction. Carries the topic folders *and* a copy of `docs/`. |

Learning code is written on `dev` and committed there. When a piece of it is
worth keeping as a reference, it gets embedded into the roadmap JSON on `main`
as a read-only lab — copied in, not linked. So the same code can exist in both
places: the working copy on `dev`, the frozen snapshot inside `docs/data/`.

**`main` is the source of truth for `docs/`.** Site edits are committed on
`main` and deploy from there; `dev`'s copy of `docs/` is a stale leftover and
may lag behind. Never edit the site on `dev`.
