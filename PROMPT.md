# PROMPT.md — CROAK: a Tunic-like with a frog

**Master spec for a gauntlet-prompted build. This file is ground truth.** Every build
session starts by reading this file and `PROJECT.md`, announces the current milestone,
and works on exactly one milestone until its gate passes. Evidence before claims.

## Project preamble (paste-at-top-of-session summary)

- **Game:** CROAK — isometric action-adventure demo in the style of TUNIC. You are a
  small frog in a tunic with a tongue that grabs, yanks, and grapples, and you pick up
  weapons found in the world. One overworld zone, one dungeon, one boss, 4 collectible
  manual pages in a cryptic glyph script. ~15 minutes of play.
- **Quality bar:** "triple-A demo" = every scorecard category ≥2, average ≥2.3
  (see §10). Not "works" — *ships*.
- **Tracks:** A = Vite + Three.js + TypeScript (primary). B = Godot 4.x, GDScript,
  **Compatibility renderer, single-threaded web export** (comparison). Same design,
  same numbers, same style bible. Track A lives in `/track-a`, Track B in `/track-b`.
- **Current milestone:** see §11 checklist — first unticked box in the active track.

## 1. Hard tech constraints

### Track A — Three.js
- Vite + TypeScript, `three` pinned to one revision (record it in `package.json` and
  verify `THREE.REVISION` at boot). WebGL renderer (not WebGPU — do not mix TSL/WebGPU
  recipes into GLSL/WebGL code).
- `renderer.outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`,
  `toneMappingExposure = 1.0`. DPR capped at 2.
- Post: **pmndrs `postprocessing`** package (single merged EffectPass), not stock
  EffectComposer jsm passes. Bloom (luminance-thresholded) + Vignette + SMAA. **No SSAO**
  — bake AO into vertex colors.
- Physics: **no physics engine.** three-mesh-bvh capsule shapecast against `COL_` level
  meshes for the character; analytic sphere/arc overlaps in the ground plane for combat
  hitboxes; circle-vs-circle separation for enemies.
- Fixed timestep 1/60 s with accumulator (clamped at 5 steps) + render interpolation.
  Three clocks: `simTime`, `presentTime`, `realDelta`. Hitstop scales sim dt only.
- All RNG through one seeded generator (`mulberry32` or similar). `Math.random` is
  forbidden in gameplay code.
- Assets: procedural or project-local only. Zero runtime network requests.
- Levels: greybox generated in code first; final geometry authored as GLB with
  name-prefix conventions: `COL_` (invisible collision), `SPAWN_<type>`, `TRIGGER_<id>`,
  `GRAPPLE_<id>` (tongue anchor), `PAGE_<n>`, `SHRINE_<id>`.

### Track B — Godot 4.x
- GDScript only (C# cannot export to web). Godot 4.3+.
- **Compatibility renderer from day one** — Forward+/Mobile do not exist on web. No
  SDFGI, no volumetric fog; test web export every milestone, not at the end.
- Single-threaded web export (no COOP/COEP headers needed; GitHub Pages-safe).
- "Click to start" screen in front of the game (browser audio autoplay policy).
- Player: `CharacterBody3D` + capsule; node-per-state FSM (`enter/exit/physics_update`);
  `AnimationTree` call-method tracks toggle hit/hurtboxes; each attack is a custom
  `Resource` (.tres) holding its frame data. Autoloads only: `SaveManager`,
  `AudioRouter`, `GameEvents`.
- Seeded RNG via one `RandomNumberGenerator` with recorded seed.

### Both tracks
- 60 fps at 1080p on a mid-range laptop. Budget: ≤150 draw calls, merged static
  geometry, exactly one shadow-casting directional light.
- Zero console/parse errors at every gate. No debug UI in deliverables.
- Save = JSON `{seed, spawnShrineId, hp, potions, coins, flags{}, pages[], weapons[]}`
  → `localStorage` (A) / `user://save.json` (B).

## 2. Style bible (LOCKED — changes require explicit user approval)

**Named anchors:** TUNIC (master reference: soft low-poly diorama, camera-as-content),
Monument Valley (diorama framing), Link's Awakening 2019 (toyetic miniature),
Death's Door (dungeon mood pole), A Short Hike (cozy warm pole).

**The core chord (from TUNIC's actual recipe):** flat-color low-poly geometry where
**lighting does all the texturing** — soft bounced-light look, **color-graded rich
shadows (blue/violet-shifted, never grey-black)**, warm highlights, a vertical
screenspace additive glow gradient, dappled light via an animated leaf-shadow cookie
on the directional light, shallow-DoF *feel* (we fake it: background fog haze, no real
DoF pass), bloom **only** from deliberate luminescent sources — glow means meaning.

**Camera:** orthographic, immutable to the player. Pitch −40°, yaw 45° (per-zone yaw
overrides allowed, authored, never player-controlled). Damped lerp follow. Zoom =
frustum height only. Lock-on tilts pitch by −3°. Occlusion is content: secret paths
are hidden behind foreground geometry on purpose.

**Palette (locked, 16 named roles — any new color is a spec change):**

| Role | Hex | Use |
|---|---|---|
| grassLit | #8FBF56 | sunlit meadow |
| grassShade | #4E8A4E | bounce-shaded grass |
| canopy | #2E6B45 | foliage mass, big trees |
| waterShallow | #5FD3C8 | lilypond toy-sea |
| waterDeep | #2B8FB5 | deep water |
| stoneLit | #E8D5A8 | sun-warmed ruins |
| stoneShade | #B08D6E | terracotta ruin shadow |
| ruinCool | #8E9BAF | mossy grey-blue masonry |
| gold | #F2C14E | shrines, treasure, page glow |
| heroBody | #6FBF4B | frog skin |
| heroBelly | #F2E8C9 | frog belly + tunic trim |
| heroTunic | #4FA64F | the tunic |
| tongue | #F4846C | tongue + tongue UI accents |
| hazeSky | #CDE8EA | fog haze, additive screen gradient |
| dungeonDark | #22283F | Sunken Belfry base |
| dungeonGlow | #6FE3FF | belfry luminescence, boss tells |

**Material kit:** every mesh uses a named role from this table via a shared toon
material factory — `MeshToonMaterial` + 3-px ramp texture with `NearestFilter` (A) /
`diffuse_toon, specular_toon` spatial shader (B). Inverted-hull outline on characters
only (dark warm brown `#3A2E28`, not black), uniform width. No one-off colors, no
default materials, no texture maps carrying surface detail.

**Visual-grammar rules (how it reads as Tunic and not generic low-poly):**
1. Tiny character, big diorama — hero ≈ 1 u tall against 4–8 u architecture.
2. Big readable silhouettes; angular trees, clay-like blocky ruins.
3. Per-zone palette identity under one light recipe: overworld = greens/warm stone,
   dungeon = dungeonDark + dungeonGlow, boss arena = both at war.
4. Threats/rewards differ by **shape and motion**, not only hue.
5. Saturated-but-soft: no pure white, no pure black anywhere.
6. The 2D layer (manual, glyphs, HUD accents) is analog: hand-drawn look, halftone,
   paper stains — the digital diorama annotated by a paper artifact.

## 3. The hero and the verbs

Frog knight, ~1 u tall: round body (heroBody), belly patch (heroBelly), little tunic
(heroTunic), oversized eyes, stubby limbs. Silhouette must read at gameplay zoom:
round + squat vs. the world's angular geometry.

**Controls (every source reaches the same logic through one InputSystem):**

| Verb | Keyboard / mouse | Gamepad (standard mapping) | Touch |
|---|---|---|---|
| Move | WASD or arrows | left stick (deadzone 0.22) or d-pad | floating stick, left 46% of screen |
| Roll | Space or Shift | B / circle | roll button |
| Attack | J, Z or left mouse | X / square | attack button (largest, under the thumb) |
| Tongue | K or X | Y / triangle | tongue button |
| Lock-on | L, C or right mouse | LT or right-stick click | lock-on button |
| Block | F or Q (hold) | LB (hold) | block button (hold) |
| Interact | E or Enter | A / cross | interact button |

Touch mounts only on a coarse pointer (or `?touch=1`); on a desktop the layer
does not exist and cannot swallow a click. The stick is deliberately floating
rather than fixed — a fixed pad makes the player hunt for a spot hidden under
their own thumb, and that hunt costs more than the sub-100 ms the primary verb
is allowed.

Verbs (all frame data in §5's constants block):
- **Move** — camera-relative, instant response, slight hop-bob.
- **Roll** — Tunic rules: i-frames for the first half (dust cloud = the tell), costs
  stamina; **at zero stamina rolls still work but incoming damage ×1.5 until the bar
  refills** (forgiveness with a cost).
- **Attack** — with the current weapon. Starts the demo with the **Stick** (2-hit
  combo), finds the **Sword** (3-hit combo, breaks bramble) in an overworld secret,
  finds the **Shield** (hold to block, drains stamina on hit) in the dungeon.
  Attacks magnetize to the soft-lock target (rotate + ≤1.5 u lunge).
- **Tongue** — the signature verb, §4.
- **Lock-on** — soft-lock always on (cone scoring); hard-lock toggle strafes + biases
  camera. Auto-drop at 12 u or 1 s occlusion.
- **Interact** — shrines, pages, chests, doors, signs (signs are written in glyphs).

## 4. The tongue (signature mechanic — the MASS RULE)

One button, context-resolved by target mass, max range 7 u:

| Target | Result |
|---|---|
| Item, coin, manual page | Vacuumed to the frog from full range. Pure delight. |
| Small enemy (lighter than frog) | Pulled to the frog, arrives **held**: throw it (projectile, damages both parties) or spit-release. |
| Medium enemy | Yanked 1.5 u toward you + **staggered 40 f**; breaks shield guards (the Beetle Guard opener). |
| Heavy/anchored enemy, `GRAPPLE_` post | **Pulls the frog to it** at 18 u/s. Attacking during the pull = arrival lunge-slash (the Death's Door move — most-praised interaction in the genre; it must feel amazing). |

Numbers: extend 35 u/s (max range in 0.2 s), retract 25 u/s, whiff recovery 15 f.
Aim: soft-lock assist by default; hold = crosshair aim mode (Frogun's solution).
Grapple posts chain across water gaps. The tongue is tongue-colored (#F4846C), thick,
slightly elastic (overshoot 5% then settle), with a wet *thwip* on fire and *schlorp*
on retract (±6% pitch variance).

## 5. Feel constants (single source of truth — one file per track)

`track-a/src/core/constants.ts` / `track-b/globals/constants.gd`. All gameplay
tunables live here and **nowhere else**. Frames at 60 fps.

```
MOVE_SPEED            5.0 u/s      ACCEL_TIME        4 f
ROLL_DURATION         26 f         ROLL_IFRAMES      1–14 (~233 ms)
ROLL_DISTANCE         3.0 u        ROLL_STAMINA      27% of bar
STAMINA_REGEN_DELAY   800 ms (1500 ms from empty)
ZERO_STAMINA_DMG_MULT 1.5
INPUT_BUFFER          9 f (150 ms) COYOTE            6 f (100 ms)
LIGHT_ATK  windup 7f / active 5f / recovery 12f, roll-cancel in recovery
HEAVY_ATK  windup 24f / active 6f / recovery 18f
ENEMY_TELEGRAPH_MIN   36 f (600 ms), flash + audio cue at windup start
HITSTOP    light 4f both parties / heavy+kill 7f, particles keep running
SHAKE      trauma², Perlin, ROTATIONAL-ONLY, max offset 0.4 u, max roll 1.5°,
           decay 1.2/s; +0.2 hit / +0.4 player hurt / +0.6 boss slam; cap 1.0
KNOCKBACK  small enemy 2.0 u; player 1.2 u + 250 ms stun
TONGUE     range 7 u / extend 35 u/s / retract 25 u/s / whiff 15 f
           pull-self 18 u/s / yank 1.5 u + 40 f stagger
LOCKON     cone 60°, range 9 u, magnetize lunge ≤1.5 u
SQUASH     impact 0.88 / hop 1.15, volume-preserving (counter-axis 1/√s)
SFX        ±6% pitch variance on all repeats
DEATH      drop 20 coins as ghost at death spot, one retrieval chance
SHRINE     rest = full heal + refill potions + respawn regular enemies
```

## 6. World content spec (~15 min of play)

**Zone 1 — Lilypond Downs (overworld).** Meadow + lilypad water + warm-stone ruins.
Teaches by geography, no text tutorials: first screen has a stick, three Sporelings,
and a visible-but-unreachable gold chest (tongue-post lesson planted early). Contains:
6+ authored secrets of which ≥3 use camera occlusion (paths behind foreground
geometry — this is non-negotiable Tunic DNA), the Sword in a secret behind a
waterfall, 2 shrines, 2 manual pages, bramble walls (sword-gated), a locked belfry
door (key in the ruins), grapple-post chains across water.

**Zone 2 — The Sunken Belfry (dungeon).** dungeonDark + dungeonGlow. Flooded bell
tower descending in 3 floors: floor 1 combat + grapple traversal, floor 2 a
switch/water-level puzzle (tongue-yank levers at range), floor 3 the Shield in a
chest + shrine + boss door. 1 manual page. Skeletal frog knights (this belfry is
where the old frog knights drowned) + spore enemies.

**Zone 3 — Boss: The Heron of the Sunken Belfry.** A frog's natural nightmare, huge,
elegant, dungeonGlow-eyed. Arena: circular flooded rooftop, 4 grapple posts.
**Amended in A6:** the posts sit on an *inner* ring (`ARENA_POST_RING`), not on the
rim as first drafted. Phase 2's wind blows outward, so rungs on the rim are rungs in
the direction you are already being pushed — they have to stand inside the radius
where the gust beats `MOVE_SPEED` or the phase has no answer at all.
3 phases: (1) spear-beak stabs + wing gusts, telegraphed ≥36 f; (2) flies to
arena center, wind pushes outward, player must grapple-chain posts to reach and
strike; (3) desperation — faster stabs, feather volleys, one 90 f-telegraph dive that
leaves it stunned 3 s if dodged. Boss HP visible; killing it rolls demo credits +
page-collection tally. 1 manual page hidden behind the arena (post-victory pickup).

**Enemy roster (5):** Sporeling (small, pullable, pops into spore puff), Bog Beetle
Guard (medium, front shield — tongue-yank opens it), Spitter Fly (ranged, hovers over
water, tongue-pullable out of the air), Drowned Knight (dungeon, sword patterns,
teaches shield), The Heron (boss). Every enemy silhouette distinct at gameplay zoom.

## 7. Manual pages + Croakic script

**4 collectible pages** in a pause-menu booklet rendered as a two-page spread with
page-turn animation and paper SFX. Slots for all 4 shown from the start as "?" gaps
(the collection hook). Pickup = full-screen reveal of the completed spread + gold toast.

Aesthetic: NES-manual pastiche (Zelda II energy) — halftone print texture, hand-drawn
bold-outline illustrations, dotted-route annotated maps, coffee stains, tape, torn
edges, and **hand-scrawled pen margin notes by a previous owner** (a fellow frog who
didn't make it; the pen notes are in plain English and are the player's real hints).

Pages: (1) annotated Lilypond map — one dotted route leads to a secret; (2) combat
page — roll i-frame diagram, stamina warning; (3) tongue diagram — the mass rule as
pictures, reveals grapple-chaining; (4) the Heron — anatomy sketch, the dive-stun
hint, and a margin note pointing at one last occlusion secret.

**Croakic script:** an original hexagon-frame phonemic cipher *structurally inspired
by* Trunic (not a copy): outer hexagon edges = vowel sounds, inner spokes =
consonants, consonant read before vowel unless a dot sits below, words strung on a
continuous midline. All world signage and manual body text is real English encoded in
Croakic — decodable by obsessives, atmospheric for everyone else. Ship the cipher key
as a comment in the source, never in the UI.

## 8. Render recipes (per track)

**Track A:** one hemisphere ambient (hazeSky→grassShade, low intensity) + one
directional key with tight-fitted ortho shadow frustum (~30×30 u following the
player, texel-snapped, mapSize 2048, normalBias 0.02) + animated leaf-cookie on the
key light in the overworld. Fullscreen additive vertical gradient (hazeSky at top,
strength ~0.12). Fog: linear, hazeSky. Post: Bloom (threshold 0.85, dungeonGlow and
gold materials get emissive), Vignette (0.25), SMAA. Toon ramp: 3 bands. Shadow color
graded via ramp's dark band toward blue-violet, never grey.

**Track B:** DirectionalLight3D + shadow, WorldEnvironment: ambient from hazeSky,
linear fog, glow (Compatibility-safe settings only), same additive gradient as a
CanvasLayer shader. Toon via `diffuse_toon, specular_toon`. Verify every effect in an
actual web export each milestone — Compatibility on WebGL 2 is the truth, not the
editor viewport.

## 9. FORBIDDEN (hard "never" rules — violating any of these fails the gate)

1. No default/unstyled materials on gameplay objects — material-kit roles only.
2. No colors outside §2's palette (UI included). A new color is a spec change.
3. No blue-purple/indigo gradient defaults anywhere — the canonical AI tell.
4. No missing tone mapping / color management (A); no untested-in-web-export
   rendering features (B).
5. No single-ambient lighting; no stacking lights to fix dark spots; nothing
   floats — every object grounded by real or blob shadow.
6. No bloom-as-makeup; the post-disabled scene must still read correctly.
7. No `Math.random` / unseeded RNG in gameplay; sim time ≠ wall clock.
8. No floaty controls: primary verb responds <100 ms, all motion eased, inputs
   buffered, verbs never gated behind animation completion.
9. No dry hits: every impact fires visual + audio + camera response on the same
   frame; no undecaying screenshake; no shake/flash that hides the next telegraph.
10. No identical repeated SFX (±6% pitch variance minimum).
11. No silhouette clones — hero/enemies/pickups distinct by shape and motion at
    gameplay zoom; no random detail noise on surfaces.
12. No debug UI, console spam, stats panels, or default browser fonts in builds.
13. No landing page — first screen is the game (B: minimal click-to-start for audio,
    styled per §2); input drives the core verb within 5 s of load.
14. No camera grammar breaks: one authored angle per zone, no player rotation, one
    outline treatment everywhere.
15. No runtime network requests. No CDN. Everything local or procedural.
16. No text tutorials — the world and the manual pages teach. (Sign glyphs are
    flavor, pen margin notes are the hint channel.)

## 10. Acceptance gates and scorecard

**Every-milestone gate (both tracks):** build passes; page loads with zero console
errors; canvas non-blank; screenshot taken and squint-checked against §2; real input
drives the milestone's verb within 5 s; 2-minute sustained play with no errors, no
duplicate loops after hot-reload/remount; fps ≥60 at 1080p (measured, stated).
Playwright drives Track A checks (the repo's `test` skill harness); Track B uses the
same Playwright harness against the exported web build (plus
`godot --headless` script checks where useful).

**Determinism gate:** same seed ⇒ same enemy spawns/drops; capture paths replayable.

**Feel gate (numbers are checkable):** roll i-frames measured by scripted
overlap test; hitstop/shake/knockback assert against §5 constants; input buffer
verified by scripted 140 ms-early press.

**Final scorecard (0–3 each, self-scored with evidence, fresh-eyes re-score after):**
art direction, hero, enemies, rewards/pickups, world/levels, materials, lighting,
VFX/juice, UI+manual, performance evidence. **"Triple-A demo" claim requires every
category ≥2 and average ≥2.3.** Score-fix-measure loops until it holds.

## 11. Milestone build order (the gauntlet)

One milestone per session. Tick the box only when the gate passes with evidence.
Track A first to M4, then Track B starts — A's code is the reference for B's feel.

### Track A — Three.js (primary)
- [x] **A1 — Vertical slice greybox.** Vite+TS scaffold, fixed-step loop, seeded RNG,
  ortho camera rig w/ damped follow, BVH capsule controller on a greybox Lilypond
  (code-generated), move + roll with full §5 numbers, stamina bar, palette-correct
  flat materials, one Sporeling that dies to a placeholder attack. *Gate: playable
  end to end, feel gate on roll, 60 fps, zero errors.*
- [x] **A2 — Combat core.** Stick + Sword combos w/ frame data, soft/hard lock-on,
  magnetism, Sporeling + Beetle Guard FSMs w/ telegraphs, HP/damage, hitstop, trauma
  shake, knockback, squash, death/respawn + coin ghost, shrine rest loop.
  *Gate: feel gate full pass; scripted duel vs both enemies; determinism check.*
- [x] **A3 — Tongue.** All four mass-rule rows, grapple posts + chaining, held-throw,
  yank-stagger opens Beetle guard, arrival lunge-slash, crosshair aim mode, item
  vacuum. *Gate: scripted test per table row; the pull-attack must land ≥2 on the
  scorecard's "signature move" squint test.*
- [x] **A4 — World: Lilypond Downs.** Full authored overworld (Blender GLB or
  refined procedural per §1 conventions), 6 secrets (≥3 occlusion), Sword +
  waterfall secret, shrines, key + belfry door, Spitter Fly, 2 pages placed (pickup
  = toast only for now). *Gate: full-zone walkthrough script; secret-path
  screenshots; draw-call budget held.*
- [x] **A5 — The Sunken Belfry.** 3 floors, water-level puzzle, Drowned Knight,
  Shield + block, dungeon palette/lighting recipe, 1 page. *Gate: dungeon clearable
  scripted + by hand; palette identity screenshot pair (overworld vs dungeon).*
- [x] **A6 — The Heron.** 3-phase boss per §6, boss HP UI, credits + tally, final
  page. *Gate: boss beatable by script (with generous timings) and by hand; every
  attack telegraph ≥36 f verified; phase-2 grapple loop works.*
- [ ] **A7 — Manual + Croakic.** Booklet UI, 4 authored pages (canvas-drawn NES
  pastiche per §7), Croakic renderer (text→glyphs), signage, pen-note hint channel.
  *Gate: all pages collectible; spread reveal; glyphs decode round-trip in a unit
  test.*
- [ ] **A8 — Render pass.** Full §8 recipe: toon ramp, outlines, leaf cookie,
  additive gradient, fog, bloom discipline, graded shadows. *Gate: side-by-side
  screenshot vs TUNIC reference grid; post-disabled readability; 60 fps held.*
- [ ] **A9 — Juice + audio.** Procedural/WebAudio SFX set (thwip, schlorp, croak,
  bell, rain of ±6% variance), ambient loops per zone, particles (spore puffs, water
  rings, dust), UI polish, pause menu. *Gate: dry-hit audit — scripted hit log shows
  same-frame visual+audio+camera on every impact type.*
- [ ] **A10 — Release candidate.** Full §10 scorecard with evidence, fresh-eyes
  re-score, perf pass, forbidden-list audit, README. *Gate: scorecard ≥ triple-A
  bar; hand off to `test` skill harness green; then `ship`.*

### Track B — Godot 4 (comparison)
- [ ] **B1 — Slice.** Project setup (Compatibility renderer, web export preset,
  single-threaded), CharacterBody3D + FSM, ortho Camera3D rig, greybox, move + roll
  per §5, click-to-start. *Gate: same as A1 but verified in the exported web build.*
- [ ] **B2 — Combat core.** Parity with A2 (Resources for frame data, AnimationTree
  hitbox tracks). *Gate: A2's gate, in web export.*
- [ ] **B3 — Tongue.** Parity with A3. *Gate: A3's gate, in web export.*
- [ ] **B4 — World import.** Reuse Track A's level geometry (GLB) + conventions;
  overworld + dungeon + boss brought to parity (A4–A6 compressed — the design is
  already proven, this is a port). *Gate: full-game walkthrough in web export.*
- [ ] **B5 — Look + manual + juice + RC.** §7–§9 parity, wasm size logged, scorecard.
  *Gate: A10's gate + load time and export size recorded for the comparison.*

### Comparison report (after both RCs)
- [ ] **C1 — Write `COMPARISON.md`:** fps, load time, bundle/wasm size, dev
  friction notes per milestone, feel parity verdict, which track to continue.

## 12. Gauntlet protocol (how future sessions consume this file)

1. Read `PROJECT.md` + this file. State: track, milestone, gate.
2. Build only that milestone. Constants go in the constants file; new tunables get
   added there, never inlined.
3. Run the gate. **Browser evidence before quality claims** — screenshots + scripted
   assertions, not vibes.
4. Tick the checkbox, update `PROJECT.md`, commit with a descriptive message, push.
5. If a gate can't pass without violating §2 or §9, stop and surface it to the user —
   don't quietly relitigate locked decisions.
