# Frogger — a Tunic-like with a frog

**Phase:** 1 — plan (done; ready for phase 2 build via gauntlet prompting)
**Stack:** dual-track: (A) Vite + Three.js + TS (primary), (B) Godot 4 web export (comparison)
**Repo:** github.com/netsrakmas/frogger
**Live:** not deployed
**Updated:** 2026-08-11

## One-liner
A triple-A-polish demo of a Tunic-like isometric action-adventure starring a frog with a tongue attack and pickable weapons — overworld + dungeon + boss, with collectible manual pages in a cryptic glyph language.

## Phase log
- 0 idee — skipped by explicit user decision (verdict: build). User committed to building via gauntlet prompting.
- 1 plan — done. RESEARCH.md (3 angles: spec craft, Tunic visual grammar, architecture + feel numbers) and PROMPT.md (dual-track master spec, milestones A1–A10, B1–B5, C1) written. Spec-only per user request; build not started.
- 2 build — not started. Next session: Track A milestone A1 per PROMPT.md §11–§12.
- 3 art — not started
- 4 test — not started
- 5 ship — not started

## Open questions
- Which of the two stacks wins after comparison (decided in/after phase 2).

## Decisions locked
- Protagonist is a frog: tongue attack (pull small enemies / pull self to anchors / grab items) + weapon pickups like Tunic. Why: the user's core concept.
- Demo scope: one overworld zone + one small dungeon + one boss (~15 min). Why: classic vertical slice, chosen by user.
- Manual mechanic included: 3–5 collectible pages in cryptic frog-glyph language. Why: Tunic's signature identity, chosen by user.
- Dual-track spec: same game design, two implementations (Three.js and Godot 4 web) to compare. Why: user wants the comparison; Three.js fits the existing art/test/ship pipeline, Godot cannot run in this remote environment (no binary, no Godot MCP here).
