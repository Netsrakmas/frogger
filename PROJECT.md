# Frogger — a Tunic-like with a frog

**Phase:** 2 — build (Track A, milestone A1 done; next is A2 combat core)
**Stack:** dual-track: (A) Vite + Three.js + TS (primary), (B) Godot 4 web export (comparison)
**Repo:** github.com/netsrakmas/frogger
**Live:** not deployed
**Updated:** 2026-08-11

## One-liner
A triple-A-polish demo of a Tunic-like isometric action-adventure starring a frog with a tongue attack and pickable weapons — overworld + dungeon + boss, with collectible manual pages in a cryptic glyph language.

## Phase log
- 0 idee — skipped by explicit user decision (verdict: build). User committed to building via gauntlet prompting.
- 1 plan — done. RESEARCH.md (3 angles: spec craft, Tunic visual grammar, architecture + feel numbers) and PROMPT.md (dual-track master spec, milestones A1–A10, B1–B5, C1) written. Spec-only per user request; build not started.
- 2 build — in progress. **A1 done** (see milestone log). Next: A2 combat core.
- 3 art — not started
- 4 test — not started
- 5 ship — not started

## Milestone log

**A1 — vertical slice greybox — DONE 2026-08-11.** `track-a/`, three r185 pinned.
Gates: `npm test` (tests/gate.mjs) **25/25**, `node tests/feel.mjs` **51/51**,
`tsc --noEmit` clean, `npm run build` clean.
- Verified: zero console/page errors, zero non-local requests, canvas non-blank,
  real keyboard drives the verb <5 s, 52 peak draw calls (budget 150), bit-exact
  determinism across two loads, remount leaves one rAF loop / one canvas / no
  program growth, death is not terminal.
- Feel measured against §5, not asserted: roll 26 f, distance 3.001 u, i-frames
  cover frames 0–13 and the second half is vulnerable, input buffer survives
  145 ms and drops at 150 ms, hitstop freezes sim while render keeps running,
  trauma decays to exactly 0, sporeling telegraph 36 f.
- **Not verified here: the 60 fps target.** This container has no GPU
  (SwiftShader rasterises on CPU, ~5 fps at 720p), so the gate reports fps as
  UNVERIFIED rather than passing it, and asserts the game's own main-thread
  frame cost against the 16.67 ms budget instead. Needs one run on a real GPU.
- Deviations: soak is 20 s, spec asks 120 s (`GATE_SUSTAIN_SECONDS` overrides).
- Two defects found and fixed after the build agents finished: roll i-frames
  opened one frame late (the commit frame was vulnerable while the dust already
  promised safety), and `feel.mjs` read constants from source while the browser
  ran a stale `dist/`, which produced a false green — it now refuses to run
  against a stale build.

## Open questions
- Which of the two stacks wins after comparison (decided in/after phase 2).

## Decisions locked
- Protagonist is a frog: tongue attack (pull small enemies / pull self to anchors / grab items) + weapon pickups like Tunic. Why: the user's core concept.
- Demo scope: one overworld zone + one small dungeon + one boss (~15 min). Why: classic vertical slice, chosen by user.
- Manual mechanic included: 3–5 collectible pages in cryptic frog-glyph language. Why: Tunic's signature identity, chosen by user.
- Dual-track spec: same game design, two implementations (Three.js and Godot 4 web) to compare. Why: user wants the comparison; Three.js fits the existing art/test/ship pipeline, Godot cannot run in this remote environment (no binary, no Godot MCP here).
