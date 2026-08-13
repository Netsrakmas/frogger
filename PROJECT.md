# Frogger — a Tunic-like with a frog

**Phase:** 2 — build (Track A, milestones A1-A8 done; next is A9 juice + audio)
**Stack:** dual-track: (A) Vite + Three.js + TS (primary), (B) Godot 4 web export (comparison)
**Repo:** github.com/netsrakmas/frogger
**Live:** https://netsrakmas.github.io/frogger/ — deployed 2026-08-12 (GitHub reports success; see the ship note on verification)
**Updated:** 2026-08-12

## One-liner
A triple-A-polish demo of a Tunic-like isometric action-adventure starring a frog with a tongue attack and pickable weapons — overworld + dungeon + boss, with collectible manual pages in a cryptic glyph language.

## Phase log
- 0 idee — skipped by explicit user decision (verdict: build). User committed to building via gauntlet prompting.
- 1 plan — done. RESEARCH.md (3 angles: spec craft, Tunic visual grammar, architecture + feel numbers) and PROMPT.md (dual-track master spec, milestones A1–A10, B1–B5, C1) written. Spec-only per user request; build not started.
- 2 build — in progress. **A1–A8 done** (see milestone log). Next: A9 juice + audio.
- 3 art — not started
- 4 test — not started
- 5 ship — deployed via Actions. Publish confirmed by GitHub; end-to-end live check still owed (this container cannot reach github.io).

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

**A2 — combat core — DONE 2026-08-11.** Gates: `tests/a2.mjs` **28/28**, plus
A1's `gate.mjs` **25/25** and `feel.mjs` **51/51** still green.
- Weapons are data: Stick (2-hit) and Sword (3-hit, found in the world), frame
  data per swing, combo length read from the weapon rather than a constant.
- Bog Beetle Guard: front shield turns any blow inside BEETLE_SHIELD_ARC, tracks
  at BEETLE_TURN_RATE, and **stops turning once committed to a windup** - so the
  designed answer is to bait the telegraph and go round the shoulder. Verified
  both ways with an angle control on each: a frontal blow measured 0 deg off its
  facing and did nothing; the flank measured 180 deg off and landed. Mashing the
  shield is punished (it re-winds up) but the telegraph is never shortened.
- Hard lock-on: toggle, strafing (0.1 deg drift over 40 frames of sidestep),
  drops on death or beyond LOCKON_DROP_RANGE, letterbox tell.
- Death loop is real now: coins drop from kills, dying leaves a ghost holding
  the purse where you fell, one retrieval, and a second death abandons it.
  Shrines heal to full, refill the meadow, and move the checkpoint.
- HUD gained a purse and weapon chip drawn with a stroked numeral set - the
  build still ships no font, so every digit is drawn (rule 12).
- Three test-harness bugs found and fixed while writing the gate, each of which
  had produced a false result: a flank test that let the guard turn round before
  measuring, `probeHit` used as if it damaged enemies (it damages the player),
  and counting *rendered frames* to wait for a *simulation* event - above 60 fps
  several frames can pass with no sim step at all.

**A3 — the tongue — DONE 2026-08-11.** Gate: `tests/a3.mjs` **16/16**, one
scripted test per row of section 4's mass-rule table. A1/A2 gates still green.
- Row 1 (items): vacuumed from 5 u, well past the 1.8 u walk-over magnet.
- Row 2 (light): pulled in, carried 0.62 u in front of the frog, and throwable -
  a thrown Sporeling took the Beetle Guard from 5 hp to 3 and died doing it, so
  both parties take the damage the spec asks for.
- Row 3 (medium): not liftable. Dragged 3.84 u -> 2.27 u, staggered, and **spun
  from 0 deg to 177 deg off its facing** - the shield ends up pointing away, and
  the follow-up blow then lands. This is the Beetle's designed opener.
- Row 4 (anchored): the frog travels instead (4.80 u), and attacking mid-haul
  spends the momentum as the arrival slash (3 damage vs the sword's 2).
- Grapple posts placed as a chain across the pond, so the tongue is traversal
  as well as combat.
- Harness bug worth recording: the test drove the stick in SCREEN space without
  rotating by the camera's 45 deg yaw, which pointed the frog 45 deg off and made
  three rows silently measure a whiff. The fix is in `stickFor()`.

**A4 — Lilypond Downs — DONE 2026-08-11.** Gate: `tests/a4.mjs` **15/15**.
All earlier gates still green (feel 51/51, a2 28/28, a3 16/16, gate 25/25).
- Six authored secrets, three of them **hidden by the camera rather than by a
  lock**. The gate does not take that claim on trust: it casts along the
  camera's own view axis and asserts geometry is in the way for all three, and
  asserts the other three are genuinely in the open as a control. That control
  caught a real defect — a secret I had marked camera-hidden was standing in
  plain sight, and has been moved into the plateau's shadow.
- Spitter Fly: holds station ~5.8 u away over water where a sword cannot follow,
  telegraphs before spitting, and is answered by the tongue dragging it out of
  the air. It is the enemy that makes the tongue necessary rather than optional.
- Gating: bramble refuses the Stick through 12 swings and yields to the Sword;
  the belfry door refuses 12 interactions without the key, opens with it, and
  consumes it.
- Two shrines, two collectible manual pages, grapple chain across the pond.
- Real bug found by the gate: the once-per-swing set for gates was never reset
  between swings, so only a swing's *first* frame ever registered on bramble and
  every later blow silently did nothing.

**Controls — keyboard, gamepad and touch — DONE 2026-08-11.** Gate:
`tests/controls.mjs` **14/14**. Keyboard and gamepad were already in from A1;
this adds the mobile layer. Every source drives the same InputSystem, so a
touch roll is buffered, consumed and i-framed exactly like a keyed one.
- Floating virtual stick (re-centres under a drifting thumb), five drawn
  buttons sized 56–76 px, all above the 44 px touch-target floor.
- Verified with real synthesised touch events, not by inspecting the DOM:
  dragging the stick moved the frog 3.70 u and released cleanly to idle, and
  the roll/attack/tongue/lock-on buttons each entered their real state.
- The layer does not mount on a desktop pointer at all (asserted: 0 buttons in
  the DOM), so it can never swallow a mouse click.

**A5 — The Sunken Belfry — DONE 2026-08-12.** Gate: `tests/a5.mjs` **19/19**.
All earlier gates green (feel 51/51, a2 28/28, a3 16/16, a4 15/15,
controls 14/14, gate 25/25).
- **Second zone, with real zone plumbing**: the belfry door is a way in, not an
  animation. A zone swap tears the old world down and builds the new one, and
  is deferred to the end of a step so nothing swaps underneath a loop that is
  still walking it. Three descending floors in one shaft (landing / flooded
  ring / vault), verified strictly descending.
- **The sluice puzzle**: four levers on pillars out in water the frog cannot
  cross. The gate measures that all four can be thrown *with the tongue from
  the walkway*, and that the way down opens only once the basin has actually
  drained. The signature verb is the solution to a room, not just to a fight.
- **Shield + block**: guard costs 0.3 stamina per blow, only covers the front,
  and an empty bar lets the hit through for MORE than never guarding. Measured
  with front/back aimed probes rather than a fixed direction.
- **Drowned Knight**: swings twice, and the second blow lands while a roll is
  still recovering — the rhythm the Shield answers. 43 f opening telegraph.
- Camera-side walls are cut to a parapet (collision stays full height). Without
  it the fixed -40 deg camera sits behind the tower wall and the room is
  literally unviewable — the diorama cutaway Monument Valley and Tunic use.
- **Real bug fixed on the way**: gates were visual-only. Bramble and the belfry
  door could be walked straight through, so every lock in A4 was decorative.
  Shut gates now push the frog out analytically.
- **Second real bug**: one "camera-hidden" secret was hidden by a *randomly
  placed* prop. Changing the rng stream moved the prop and the secret stood in
  the open. Cover is authored now, and only where terrain does not already do
  the job — a first attempt that blanket-placed blocks dropped one onto the
  plateau and slowed the movement gate to 4.72 u/s.
- Known flake: a3's grapple row failed once in ~6 runs (timing on the pull
  window); 16/16 on three consecutive runs since.

**A6 — The Heron — DONE 2026-08-12.** Gate: `tests/a6.mjs` **20/20**. Every
earlier gate re-run against the same build and green: gate 25/25, feel 51/51,
a2 28/28, a3 16/16, a4 15/15, a5 19/19, controls 14/14.
- **Third zone, and the demo now has an ending.** The vault door the sluice
  puzzle opens leads onto the belfry's flooded roof. The gate walks the whole
  demo to get there — sword, key, belfry door, four levers, vault — and then
  kills the boss on one life using nothing but the verbs a player has.
- **Every wind-up in the fight is measured on the SIMULATION clock**, not by
  counting rendered frames, and the shortest one anywhere across three phases
  is 36 f. Phase 3's haste (x0.72) would put a stab at 28.8 f on its own;
  `HERON_TELEGRAPH_FLOOR` is what stops "harder" from meaning "less readable".
  The dive measures its full 90 f, and dodging it left the beak in the deck for
  **2.98 s** of the 3 s the spec asks for.
- **Phase 2 is a traversal problem, and the gate measures it as one.** The Heron
  holds the middle (0.55 u off centre, 1.71 u up). Five seconds of full stick
  straight at it from the rim gets from 12.31 u to 9.77 u and stalls — the gust
  beats MOVE_SPEED well outside the posts. The tongue then does what legs
  cannot: post haul 9.77 -> 5.54 u, and from there the Heron itself is an
  ANCHOR, so the frog travels and spends the flight as the arrival slash.
  That is section 4's bottom row finally being the only way through a room.
- The last manual page appears 15.60 u out on a ledge behind the far wall once
  the Heron is down, camera-occluded (asserted with the same view-axis cast A4
  uses), reachable on foot through a doorway spanned by a fallen lintel.
- **Four real defects found by the gate, all fixed:**
  1. **The dive could not be dodged at all.** Locking its target at 60% of a
     90 f tell left 0.6 s of running — 3.0 u at MOVE_SPEED — against a 3.4 u
     blast. You could read it, sprint, and still be inside it.
  2. **A grapple post you are standing on outranked everything else in the
     aim.** From the rung you had just hauled to, the tongue kept re-grabbing
     it, so the Heron could not be anchored from its own arena's posts and
     phase 2 had no exit. `GRAPPLE_MIN_RANGE`.
  3. **The gale had no falloff at the parapet** and pushed the frog out through
     the doorway in the far wall, onto the ledge, out of the fight — leaving the
     Heron alone in the room.
  4. **A point-blank feather volley was a shotgun**: five feathers, 1 damage
     each, against 6 hp, for a wind-up shared with everything else. Feathers are
     a zoning move now; up close it reaches for the beak instead.
- **Three harness bugs, each of which had produced a false reading:** telemetry
  sampled only between the script's own decisions reported 26 f for a 40 f
  telegraph (the gate was measuring its own polling interval); teleporting the
  frog out of a `tonguePull` left the anchor behind and hauled it back at
  18 u/s, so the "walk into the wind" check was measuring the tongue; and a
  first fight policy that backed off from every wind-up survived 9000 frames
  without landing a single blow, because the Heron simply walks back to its own
  reach. Strafing round the committed cone is the answer — which is also how the
  fight is designed to be played.
- Note on retries: the Heron heals to full if the frog dies or rests at the
  arena shrine, so `k1` is a one-life kill, not an attrition win.
- **A fifth defect, caught by the A4 and A5 gates rather than by A6's.**
  Generalising the single hard-coded belfry door into a doorway table dropped a
  subtlety the original had: a SHUT door must not arm the transition. Without
  that, the frame the key turned was the frame the frog was thrown through the
  door it was standing at to unlock it — A4 read the door as still locked
  because the game was already in the belfry answering about the wrong world,
  and A5's whole descent ran from a bad position and lost three checks. Arming
  is now per door and a shut door never arms it. Worth recording because the
  A6 gate was green through all of it: a new gate says nothing about the ones
  it did not run.
- Known flake, host-load dependent: on a heavily loaded run A3's whiff row read
  the tongue's reach as 5.42 u instead of 7.00 u. The sampler polls on rendered
  frames, and a rendered frame can cover several simulation steps when the host
  is contended, so the 12-frame extension can be sampled past its own peak.
  16/16 on a quiet re-run with the reach at exactly 7.00 u. The measurement
  wants a peak-tracking hook rather than a poll; noted for A10.

**A7 — Manual + Croakic — DONE 2026-08-12.** Gates: `tests/croakic.mjs`
**17/17** (pure, no browser) and `tests/a7.mjs` **18/18**. Every earlier gate
re-run against the same build and green: gate 25/25, feel 51/51, a2 28/28,
a3 16/16, a4 15/15, a5 19/19, a6 20/20, controls 14/14.
- **Croakic is a real cipher, not a doodle.** An original hexagon-frame
  phonemic script: six outer edges spell the vowel, five inner spokes the
  consonant, a dot under the glyph reverses the reading order, and a word rides
  one continuous midline. The key ships as a comment in `src/ui/croakic.ts` and
  the gate asserts it is NOT in the shipped bundle.
- The unit test does not settle for one sentence surviving a round trip: it
  walks all 39 phonemes, **all 1521 ordered pairs**, and 4000 seeded multi-word
  strings, because the property that matters is that the cipher is injective
  and the greedy syllable packing is always undoable.
- The English-to-phoneme step is documented as ONE WAY and is not asserted to
  round trip. There is no way back from /r ay t/ to "wright" rather than
  "right", so the guarantee is kept at the phoneme layer where it can be.
- **Four authored pages**, all four slots visible from the first time the book
  is opened — the collection hook is the hole, not the reward. Body text is
  Croakic; the margin notes are plain English drawn letter by letter in
  `penscript.ts`, because §7 wants them readable and rule 12 forbids a font.
  The gate asserts **zero** `<text>`/`<tspan>`/`<foreignObject>` nodes and zero
  text content anywhere in the UI.
- **The pause is a real pause.** Opening the book stops the simulation clock
  outright rather than just skipping the world update: `simTime` is what every
  window in the game is measured against, and time spent reading is not time
  the frog lived through. The gate holds the stick down while the book is up
  and measures both — 0.000 s of sim and 0.000 u of travel across 40 drawn
  frames — because asserting the clock alone would pass a pause that only
  stopped the bookkeeping.
- Signage is carved, not textured: every stroke of every glyph is a thin box,
  merged so a whole sentence costs one draw call. Same no-asset rule as the
  rest of the build.
- Deviation worth recording: the fourth page is the Heron's and only exists
  once it is down, so `a7` walks the first three and asserts exactly one slot
  is still a gap; `a6` v3/v4 already assert the fourth appears behind the
  arena, is camera-occluded, is reachable on foot and is collectible. All four
  are covered, across two gates rather than one.
- **Two older gates caught the new behaviour and were right to.** A4 collected
  one page and then stalled, because the reveal now throws the book open and
  the book pauses the world - a player shuts it and walks on, so the gate does
  too. The controls gate failed with "6 !== 7" when the manual button arrived,
  which told me a count had changed and nothing about whether the right buttons
  were there; it names the seven verbs now, so a button going MISSING still
  fails it. Neither was a defect in the game, and neither was papered over.

**A8 — Render pass — DONE 2026-08-13.** Gate: `tests/a8.mjs` **15/15**.
Landed in two rounds: the chain itself (13/15, four render defects found and
fixed), then the last two checks resolved in the review round below — the
bloom measurement needed a sim freeze that renders without drawing an overlay,
and the manual-pause work produced exactly that hook (`setFrozen`). With both
screenshots taken inside a freeze, the only thing that differs is the bloom
toggle, so the changed pixels ARE the halo: 0.102% of the open meadow moves
(thresholded — nothing there glows) against 0.588% at a gold shrine.

- **What landed:** the pmndrs post chain as ONE merged EffectPass (bloom, ACES,
  vignette, additive sky gradient, SMAA); an animated leaf cookie that is a real
  shadow rather than a texture; the no-pure-black floor; honest draw-call
  accounting. 90 draw calls with post on against the 150 budget, 64 without.
- **Four real defects the gate caught:**
  1. **The composer silently dropped tone mapping.** three only applies
     `renderer.toneMapping` when drawing to the CANVAS; the first thing a
     composer does is render to a target. The meadow survived it because it is
     bright. The belfry went to **rgb(6,6,4)** - a black screen with a HUD
     floating on it. ACES lives in the chain now, and the renderer's own ACES is
     handed back whenever the chain is switched off.
  2. **The canopy cast nothing.** three renders the shadow pass with
     `shadowSide`, which defaults to BackSide for a FrontSide material, so 150
     flat leaves whose front faces were turned toward the light were back-face
     culled out of the shadow map. It changed the ground's contrast by 0.6 of a
     luma step - which is to say it did nothing.
  3. **No floor under the darks.** A vignette will multiply a dark dungeon
     corner to zero however carefully the toon ramp was tuned, so section 2's
     "no pure black anywhere" now has one place that guarantees it.
  4. **Emissive materials were too dim to bloom.** `EMISSIVE_INTENSITY` was 0.9
     under a comment claiming it was "bright enough to clear a 0.85 threshold".
     dungeonGlow's linear luminance is 0.638 and gold's is 0.571, so nothing in
     the game had ever crossed the cut. Now 2.0, and the constant sits beside
     BLOOM_THRESHOLD because the two only mean anything together.
- **The bloom measurement (b1/b2), resolved in the review round.** Three
  attempts failed three different ways, worth recording: pixels over a fixed
  brightness missed a CYAN halo (dungeonGlow's red channel is 111 and can never
  reach 250); mean luma over the whole frame drowned a small source in 900x540
  pixels of unchanged meadow (44.38 either way — the same number twice); and
  diffing two live frames measured the game ANIMATING between them (38% of the
  meadow moves in a second of idle bob and water). The fix is `setFrozen` in
  the test API — the manual's pause without the manual — plus hiding the
  present-time-drifting canopy for the pair, so the two shots differ by the
  bloom toggle alone.
- Also worth knowing: three's ACES and postprocessing's ACES are different fits,
  not the same curve at different exposures. Matching them with a single scale
  was tried (1/0.6, three's own constant) and lands the meadow at luma 202
  against the fallback's 160 while STILL leaving the belfry darker. The chain's
  curve is the shipping look; the fallback's job is to stay readable, and the
  gate asserts exactly that and nothing stronger.
- A9 (juice + audio) and A10 (release candidate) are not started.

**Review round — 2026-08-13.** A full-diff review of the A6–A8 commits found
seven defects; all seven are fixed in this round.
1. **Touch soft-lock in the manual (worst).** The booklet overlay sits above
   the touch controls (z 20 over z 5) with pointer-events on, and had no tap
   handling of its own — a phone player who picked up their first page was
   permanently stuck on the booklet screen, because the only buttons that
   could close it were underneath it. The overlay handles its own taps now:
   outer thirds of the spread turn the page, anywhere else closes. Verified by
   a new a7 check (p2c) that dispatches a real click and asserts the book
   closes, the pause lifts and the sim resumes.
2. **The reveal didn't pause.** `loop.setPaused` was only called on the
   keyboard-toggle path, so picking up a page opened the book while simTime
   kept counting behind it — the exact invariant the A7 gate claims, asserted
   only for the toggle. The pause is now synced to the book's state on every
   tick, and the reveal site pauses immediately. New a7 check (p2b) holds the
   stick through a reveal and measures both clocks.
3. **Unsatisfiable peer dependency.** postprocessing@6.37.8 caps three at
   <0.181 while the project pins 0.185.1; installs only worked with
   --legacy-peer-deps. Upgraded to 6.39.4 (three <0.186) — a fresh
   `npm install` resolve now succeeds with no flags, verified by a clean
   package-lock-only resolve in a scratch dir.
4. **The canopy dapple popped.** The drift wrapped on half the leaf field's
   span, and a random scatter is not periodic in anything — every 91 s of
   drift (and every 16 u walked) the whole dapple snapped to an uncorrelated
   layout. The scatter is now tiled 3x3 so CANOPY_SPAN is a true period, the
   drift is centred, and every wrap moves the mesh by exactly one period. The
   invariance was checked case by case (drift wrap, anchor step both ways):
   the 30 u shadow frustum always lands in the region the translation maps
   onto itself.
5. **'manual' was missing from ACTION_LIST**, so its buffer skipped the
   blur-time releaseAll and the aging loop — a Tab pressed just before losing
   focus could pop the book open minutes later on refocus.
6. **signs() counted the outline as writing.** The probe excluded only
   children[0], so a sign with EMPTY text still reported strokes — the one
   property the probe exists for was never measured. The carving mesh is named
   now and it is the only thing counted, in triangles as documented.
7. **a7's "meadow signage" check never left the belfry.** A comment claimed a
   fresh load was the way back to the meadow, and then read the same page
   again — deleting the meadow's two signs would have passed the whole suite.
   It opens a genuinely fresh page now, and a new check (w1b) asserts the door
   and pond signs exist with carving.

Two suspicious-looking things were checked and are NOT bugs, recorded so they
are not "fixed" later: the doorway-table rewrite did not remove a belfry→downs
return (the belfry never had a return gate), and `spawnEnemies()` reading
`boss`/`victory` above their declarations is fine (the declarations execute
before the first call).

### Playtest round (2026-08-13) — four defects from the user's hands-on pass

The user played the A8 build and reported: cloud shadows far too heavy and not
reading as clouds; height not mattering in combat; trees inside other objects;
no story ("not a viable demo build"). All four addressed in one round, with
PROMPT.md carrying the amendments:

1. **Leaf-cookie → cloud cookie** (`render/canopy.ts`). The 150-leaf scatter
   became ~5 distinct clouds per 64 u tile — lobed puff clusters, big discs
   mid-run and small at the ends, toroidal spacing so the tiled sky keeps its
   gaps. The heaviness fix is a dithered `customDepthMaterial`: a 4×4 Bayer
   alpha cutout (`CANOPY_SHADOW_COVER = 10/16`, one cell per shadow texel,
   world-planar UVs so overlapping puffs punch the SAME holes) makes the
   cloud a partial occluder after PCF, while walls and characters still cast
   full shadows. Measured: shaded ground keeps ~55–65 % of its light (old
   dapple dropped it to the toon ramp's ~25 % dark band). `setCanopyPhase`
   test hook pins the drift so a8 can hunt the phase that parks a cloud in
   frame; d1/d2 rewritten around it (frozen A/B pairs, changed-fraction +
   shaded-ratio, ratio asserted between 0.45 and 0.92).
2. **Vertical hit rule** (`core/hits.ts`). One shared `inStrikeHeight`:
   attacker swings from STRIKE_REACH_DOWN below its feet to reachUp above
   (default STRIKE_REACH_UP 1.3), victim is feet→`hurtHeight` (default 1.0;
   the Heron declares ~2.9). Applied to player strike/strikeGates + soft-lock
   targeting, sporeling/knight/beetle strikes, thrown-body contacts, spitter
   glob, heron stab/slam/feathers. Deliberate exemptions: the tongue (the
   game's anti-air verb), the heron's gust (a downdraft ring — phase 2 gusts
   from the hover), and the arrival slash, which carries
   `LUNGE_SLASH.reachUp = 4.5` so the post→haul→anchor→slash loop can still
   climb a Heron hovering at 1.75.
3. **Scatter vs authored world** (`world/level.ts`). Placement now draws each
   prop's dimensions FIRST, then rejection-samples a position against (a)
   PLAY_KEEPOUT by centre, (b) a new STRUCTURE_KEEPOUT — built from the
   authored tables themselves (wall, door, shrines, secrets, bramble, posts,
   signs, cover block) — by footprint, and (c) other props by footprint
   (canopy radius / box half-diagonal), with tree-tree grove overlap kept at
   TREE_SPACING on purpose. Ruin-ruin and tree-ruin interpenetration is gone.
4. **The story** (`ui/letter.ts` + game/main wiring + hud ending line). An
   opening letter over the live meadow: previous owner's penscript hand + a
   Croakic heading ("for whoever comes after") — whose book this was, what
   the Heron took, why the frog, what done means; signed "- m", the same hand
   as every margin note. Pauses the world exactly like the manual
   (edge-triggered `letterOwnsPause`), any verb or tap dismisses in ONE
   press. Suppressed only on explicit `?test=1` boots; `?letter=1` forces it
   for a7's new story checks (s1–s4: up-at-boot + world held, drawn-not-
   typeset, one-press dismissal + resume, plain-test boot clean). The ending
   card now closes the loop in the same pen: "the sky is quiet again…".

## Open questions
- Which of the two stacks wins after comparison (decided in/after phase 2).
- **Live page not yet verified end-to-end.** The deploy is green and GitHub
  reported `Reported success!` with environment url
  https://netsrakmas.github.io/frogger/, but this container's egress policy
  denies CONNECT to `netsrakmas.github.io` (403 from the agent proxy), so the
  page has never actually been loaded and driven. `track-a/tests/live.mjs` is
  written and ready: run it from any machine with normal internet
  (`node track-a/tests/live.mjs`) and it checks boot, canvas content, input
  response, console errors, failed requests and the mobile control layer.
  Until it has run, treat "it deploys" as proven and "it plays live" as not.

## Decisions locked
- Protagonist is a frog: tongue attack (pull small enemies / pull self to anchors / grab items) + weapon pickups like Tunic. Why: the user's core concept.
- Demo scope: one overworld zone + one small dungeon + one boss (~15 min). Why: classic vertical slice, chosen by user.
- Manual mechanic included: 3–5 collectible pages in cryptic frog-glyph language. Why: Tunic's signature identity, chosen by user.
- Dual-track spec: same game design, two implementations (Three.js and Godot 4 web) to compare. Why: user wants the comparison; Three.js fits the existing art/test/ship pipeline, Godot cannot run in this remote environment (no binary, no Godot MCP here).
