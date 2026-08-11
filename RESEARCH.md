# RESEARCH.md — evidence trail for the frog Tunic-like

## Addendum 2026-08-11 — Angle 1: spec/prompt craft for AI-built games

### Gauntlet (milestone-gated) prompting vs one-shot
Consensus across practitioner reports: **one-shot is marketing; milestone-gated with verification loops is what ships.**

- "A real game is not one prompt… The truth is 500 small, smart prompts." A documented multiplayer 3D game took ~500 prompts / 20 hours (ziva.sh/blogs/vibe-coding-games; tejaskulkarni.substack.com/p/vibe-coding-a-3d-game-using-ai).
- **Harper Reed's three-file workflow** (confirmed via Simon Willison's summary): (1) idea honing → `spec.md`; (2) planning → `prompt_plan.md` with right-sized, individually testable steps + `todo.md` checklist; (3) execution — one prompt at a time, tests gate each step. (harper.blog/2025/02/16/my-llm-codegen-workflow-atm; simonwillison.net/2025/Feb/21/)
- **GitHub Spec Kit** formalizes it: `/specify → /clarify → /plan → /tasks → /implement`, each phase a reviewed Markdown artifact. Rationale: "LLMs are good at writing code but bad at holding a large, fuzzy intent across many steps." (github.com/github/spec-kit)
- **chrislaupama/threejs-game-studio** — richest public reference for a game-specific gauntlet. Tiered workflow (checkpoints → focused fixes → full games → premium/showcase passes → release candidates) and **"requires browser evidence before making quality claims"** (Playwright canvas inspection, screenshots, bot playtests). (github.com/chrislaupama/threejs-game-studio)
- Godot equivalents gate via headless runs: Randroids-Dojo/Godot-Claude-Skills (GdUnit4 headless + PlayGodot e2e), haxqer/godot-skill (headless GUT/GdUnit4).
- Key practitioner insight: "clean markdown specs of the rules served as 'ground truth'… **The model was not the bottleneck; the verification loop was.**" (chierhu.medium.com/claude-code-for-game-development-7a88fcd19992)
- Session hygiene: keep a project preamble (engine, renderer, platform, current milestone, three-line concept) at the top of every session.

**Synthesized workflow pattern:**
```
PROMPT.md            – concept, tech stack, locked style bible, non-goals
milestones           – numbered, each with its own prompt + validation gate
todo/checkbox state  – survives context resets
Per-milestone gate:  build passes → headless/Playwright run → zero console
                     errors → screenshot vs style bible → scorecard
                     self-rating → only then next milestone
```

### Anchoring visual style so output isn't generic
- Lock the art bible before generating anything: camera angle, palette, lighting, proportions, material rules, negative prompts. (seeles.ai consistent-ai-game-assets-workflow)
- **Named references work as compression** — "Monument Valley isometric levels", "Hades style" measurably narrow output.
- **Material kit of named shared roles, not one-off colors** (threejs-game-studio technical-art.md, verbatim): e.g. `bodyPrimary, bodySecondary, trim, hazard, reward, emissiveSignal, groundContact`. "Readability beats palette consistency" — threats/rewards must differ by *shape and motion*, not only hue.
- "You cannot just prompt the agent for 'good graphics'… the agent needs to see the exact implementation" → include concrete render-pipeline recipes in the spec. (scottstts/Threejs-Awesome-Graphics-Agent-Skills)
- Forbidden-list practice: AI defaults to indigo/purple gradients (Tailwind bias); explicit "never use" rules are the documented fix.

### Acceptance criteria an agent can self-check
Best public model: threejs-game-studio quality-gates.md + quality-scorecard.md. Verbatim examples:
- "Real input drives the primary verb within roughly five seconds"
- "Build, browser, console/page errors, screenshot, and nonblank canvas pass"
- "Clean-load sustained human play pass of roughly two minutes"
- "Randomness is seeded in gameplay and deterministic capture paths"
- "The post-disabled scene remains readable"
- "A development remount/restart does not create a second loop, duplicate input handler, stale physics body"
- Rubric self-scoring: 10 categories (art direction, hero, enemies, rewards, world, materials, lighting, VFX, UI/HUD, perf evidence) scored 0–3; **Premium = every category ≥2 and average ≥2.3**.
- Determinism: all RNG through a seeded generator, never `Math.random`; separate simulation/presentation/real clocks.
- Numeric feel criteria: primary verb visibly responds <100 ms; input buffer 100–150 ms; coyote time 90–140 ms.

### Known AI failure modes (3D web + Godot)
Three.js: flat single-AmbientLight lighting; missing tone mapping/color management (baseline: `outputColorSpace = SRGBColorSpace`, ACESFilmic, exposure 1.0); no post-processing or bloom-as-makeup; mixing WebGL/WebGPU recipes; hallucinating APIs from the wrong revision (pin the revision); uncapped DPR; duplicate render loops after hot-reload; floaty controls; feedback bloat ("shake with no decay: nauseating"). Prescribed feel numbers (game-feel.md): hitstop 60–90 ms at 0.05 timescale; squash 0.85–0.9 impact / 1.15 jump (volume-preserving); trauma² screenshake capped at 1.0 (pickup 0.15 / hit 0.4 / explosion 0.7); FOV punch +4–8°; keep render loop alive during hitstop; ±6% pitch variance on repeated SFX.

Godot: GDScript API hallucination (~850 niche classes); Godot 3 signal syntax that "does nothing in Godot 4"; Python idioms; C# names in GDScript; heavy generation in `_ready()` without await. Fix = grounded references + headless verification (`godot --headless` + GdUnit4/GUT), not better ad-hoc prompts.

Cross-cutting: "an AI agent cannot tell you that the jump feels floaty" → the spec must convert feel into checkable numbers. Juice priority by impact/effort: screenshake → hitstop → particles → sound → squash-stretch.

### Distilled FORBIDDEN LIST (for the spec)
1. No default Three.js materials on gameplay objects — named material-kit roles only.
2. No one-off hex colors — locked palette only; a new color is a spec change.
3. No blue-purple/indigo gradient defaults anywhere (the canonical "AI made this" tell).
4. No missing tone mapping/color management — ACESFilmic + sRGB output, exposure recorded.
5. No single-AmbientLight lighting; no fixing dark spots by stacking lights; everything grounded (real or blob shadow).
6. No zero-post builds and no bloom-as-makeup; post-disabled scene must stay readable.
7. No `Math.random` in gameplay — seeded RNG; sim time ≠ wall clock.
8. No floaty controls — verb responds <100 ms, easing on all motion, input buffered, verbs never gated behind animation completion.
9. No dry hits — impact fires visual+audio+camera on the same frame; never undecaying shake.
10. No identical repeated sounds — ±6% pitch/volume variance.
11. No silhouette clones — hero/threat/reward distinct by shape and motion at gameplay zoom.
12. No debug UI in deliverables; zero console errors is a gate.
13. No landing-page-first builds — first screen is the game; verb drives within ~5 s.
14. No inconsistent camera/outline grammar — one fixed isometric angle, one outline treatment.
15. No remote/CDN assets at runtime — procedural or project-local only.

Access notes: proxy 403'd harper.blog, mrphilgames.com and several blogs; content confirmed via search excerpts and secondary summaries. GitHub/raw fetches all succeeded — threejs-game-studio is the highest-fidelity source.

## Addendum 2026-08-11 — Angle 2: Tunic's visual grammar

### Style vocabulary + anchors
Industry shorthand: **"soft low-poly diorama"**, "toy world / toyetic", "tilt-shift tabletop", "pastel and sunkissed". Anchors and what each contributes:
- **Monument Valley** — diorama framing, fixed impossible viewpoint (Shouldice cited it: "a game like that, but… exploring a larger space").
- **Link's Awakening remake (2019)** — the toyetic miniature look: glossy toy character in a tilt-shift world.
- **Death's Door** — sibling diorama isometric action-adventure; darker desaturated pole of the style.
- **A Short Hike** — the cozy warm-lit soft-low-poly pole.
- **Wind Waker** (saturated innocence), **Hades** (fixed isometric camera) adjacent.
- **Zelda II NES manual** — anchor for the 2D graphic-design layer.

### Camera
- Orthographic presentation (the game can blend/flip to perspective for moments — Noclip Developer Breakdown, youtube.com/watch?v=A5A7uoJAOvY).
- No official angles; standard 3D-isometric band reproduces the read: **pitch ~30–35°, yaw ~45°, orthographic**; yaw is authored per zone.
- Camera is immutable for the player (lock-on tilts it slightly). Orthographic depth-loss is *deliberately exploited*: "the isometric perspective makes it very easy to hide little secret paths" (Shouldice). Hidden walkways run behind foreground geometry; parallel depths collapse to the same screen position.
- Key talk: GDC 2023, Shouldice, "TUNIC: This Was Here the Whole Time" (secrets as "loose ends"). NOTE: an "Eric Billingsley GDC 2022 Environment Design" talk could NOT be verified — do not cite.

### Lighting & rendering recipe (the core chord)
- Shouldice: "realtime simulation of **bounced light**… combined with **color correction to add richness to shadows** and a **screenspace gradient of additive glow**." (gamedeveloper.com interview)
- **Flat color on low-poly geometry; lighting does ALL the texturing** — no texture maps carrying detail.
- Observed feature set: soft shadows, volumetric/diffuse light shafts, DoF blurring the background (living-diorama focus), bloom only from deliberate luminescent sources, dappled light via animated leaf-shadow **light cookies** on the directional light.
- Per-area identity rule (Billingsley): each zone gets a distinct dominant hue family under the same light recipe.

### Derived palette (NO official values exist — approximation, mark as derived)
| Role | Hex |
|---|---|
| Grass green (lit) | #8FBF56 |
| Grass green (shade) | #4E8A4E |
| Canopy/deep foliage | #2E6B45 |
| Water teal (shallow) | #5FD3C8 |
| Water blue (deep) | #2B8FB5 |
| Warm stone (lit) | #E8D5A8 |
| Warm stone (shade) | #B08D6E |
| Cool ruin stone | #8E9BAF |
| Golden accent | #F2C14E |
| Fox orange (→ frog role) | #E8944A |
| Tunic green | #4FA64F |
| Sky/fog haze | #CDE8EA |
| Dungeon dark | #22283F |
| Dungeon glow accent | #6FE3FF |

Shadows graded blue/violet-rich, never grey-black; highlights warm; pastel-capped highlights over saturated mids; no pure white or black.

### Trunic script (the cryptic language) — how it actually works
- A **phonemic cipher for spoken English**: glyphs on a hexagon frame; **outer edge lines = vowel sounds (~18)**, **inner radial lines = consonant sounds (~24)**; one glyph = consonant+vowel, consonant read first unless a small circle below reverses order; voiced/unvoiced pairs are vertical flips; words strung on a continuous horizontal midline (no spaces). (tunic.fandom.com/wiki/Tunic_Script, omniglot.com/conscripts/trunic.htm)
- Design intent: text that looks legible-adjacent and IS genuinely decodable.

### In-game manual conventions
- Modeled on the **Zelda II NES booklet**. Physical-first workflow: real booklet folded/ripped/taped/stained, scanned per page, used as illustration canvas.
- Layout: two-page spreads; halftone print look; hand-drawn illustrations with bold outlines; annotated maps with dotted routes; body text in the cipher script with a few English words; **hand-scrawled pen margin notes by a "previous owner", highlighter marks, coffee stains, tape, torn edges**. Manual = tutorial + map + meta-puzzle.

### Visual-grammar rules that make it read as Tunic (vs generic low-poly)
1. Light does the texturing (flat albedo under painterly light).
2. Rich colored shadows (warm-light/cool-shadow is the core chord).
3. Orthographic toy-world discipline (no perspective distortion).
4. Tiny character, big diorama (scale contrast + shallow DoF = tilt-shift).
5. Big readable silhouettes (angular trees, clay-like blocky architecture).
6. Camera as content (authored occlusion hides real paths).
7. Saturated-but-soft; bloom only where meaning is (glow = importance).
8. Per-zone palette identity under one light recipe.
9. The 2D layer is analog (hand-drawn, scanned, stained, halftoned).

## Addendum 2026-08-11 — Angle 3: architecture + game-feel numbers (both stacks)

Numbers marked [sourced] have a named source; [synth] = starting values synthesized from adjacent sourced data.

### Combat feel numbers
- **Dodge roll:** DS1/DS3 fast roll ≈ 13 i-frames @30fps (~433 ms) [sourced]; Hades dash fully invulnerable, cancelled by attacking mid-dash [sourced]; **Tunic: invulnerable for roughly the first half of the roll, dust cloud = the i-frame tell; empty-stamina rolls still work but you take extra damage** [sourced]. [synth @60fps]: roll 24–30 f total, i-frames 1–16 (~250 ms), distance 2.5–3.5× character radius, stamina ~25–30% of bar, regen delay ~800 ms (1.5 s from zero).
- **Telegraphs:** casual reaction rule of thumb 0.25 s+; real enemy attacks run 1.0–1.6 s full motion, hit active 0.5–0.7 s in [sourced]. [synth]: enemy telegraph ≥30–45 f (500–750 ms) with flash + audio at windup start.
- **Player attacks [synth]:** light slash windup 6–8 f, active 4–6 f, recovery 10–14 f (~350 ms), 3-hit combo, roll-cancellable in recovery; heavy windup 20–30 f.
- **Hit-stop:** generic guidance 40–80 ms [sourced]; Smash formula frames = ⌊dmg×0.65+6⌋, applies to both parties [sourced]. [synth]: light 3–4 f, heavy/kill 6–8 f; freeze both, particles keep running.
- **Screenshake:** Eiserloh GDC 2016 trauma model — trauma∈[0,1], shake = trauma², Perlin noise displacement, **rotational-only recommended in 3D**, always clamp [sourced]. [synth iso-ortho]: max offset 0.3–0.5 u, max roll 1–2°, decay 1.0–1.5/s, noise 15–25 Hz; +0.2 light hit / +0.4 player hurt / +0.6 boss slam.
- **Input buffer 100–150 ms; coyote 83–133 ms** [sourced: gamejuice.co.uk]. Celeste forgiveness kit: buffering, coyote, corner correction [sourced].
- **Stamina anchor:** DS3 regen 45/s, ~4–5 rolls per bar [sourced].
- **Lock-on [synth]:** soft-lock scoring `angle×w1 + dist×w2` in ~60° cone, 8–10 u range; attacks magnetize (rotate + lunge ≤1.5 u) — the Tunic/Death's Door feel.

### Tongue/grapple — reference taxonomy and the MASS RULE
- **Frogun** (closest reference): tongue-as-grapple sticks to walls/points and reels player in; grabs items/enemies and pulls them to player to carry/throw; chain-grapples; optional aim mode [sourced].
- **Death's Door hookshot:** pulls player to target; **melee during the pull = wide powerful arrival slash** — the most-praised interaction [sourced]. Sekiro: marked grapple points, grapple attack converts momentum into a strike [sourced]. Doom Eternal Meat Hook: pull-self-to-enemy as combat mobility [sourced].
- **Mass rule** (consistent pattern): target lighter than player → pull target to you (arrives stunned/held); heavier/anchored → pull yourself to it, arrival feeds an attack; medium [synth] → stagger + yank 1–2 u.
- [synth] tuning: range 6–8 u (~3–4 body lengths), extend 30–40 u/s (max range in ~0.2 s), retract 20–30 u/s, whiff recovery ~15 f, player-pull travel 15–20 u/s, attack-during-pull = lunge slash; item/page pickup at full range.

### Three.js stack
- **Structure:** lightweight composition, NOT full ECS at demo scale; Entity{root: Object3D, components} + systems; Three objects are views, game state is data. Anti-pattern: extending THREE.Mesh per game class.
- **Loop:** fixed timestep 1/60 accumulator, render interpolation, clamp ~5 steps (Gaffer pattern).
- **Physics:** Option 1 Rapier WASM (~500 KB, KinematicCharacterController built in); Option 2 three-mesh-bvh capsule shapecast on level mesh (official characterMovement example). Combat hitboxes: analytic arc/sphere overlaps in ground plane — no engine needed. Enemies: circle separation.
- **Iso camera:** OrthographicCamera, pitch −30…−55°, yaw 45°, damped follow; zoom via frustum height, never FOV. **Shadows: fit directional shadow frustum tightly (~30×30 u around player, snapped to texel grid), mapSize 2048², normalBias ~0.02.**
- **Toon:** MeshToonMaterial + 3–4 px ramp with NearestFilter; outlines = inverted hull on characters + optional depth-edge full-screen pass. **Post: pmndrs `postprocessing`** (merges effects into one pass) — Bloom + Vignette + SMAA; **skip SSAO** (cost, and flat-shaded toon doesn't need it — bake AO into vertex colors).
- **Levels:** Blender → GLB; name-prefix conventions parsed at load: `COL_` collision, `SPAWN_x`, `TRIGGER_`, `GRAPPLE_`; collision mesh separate and low-poly; greybox in code, real levels in Blender.
- Budget [synth]: ≤150 draw calls, merged static geometry, one shadow light, 60 fps @1080p mid-range laptop.

### Godot 4 stack
- Player = CharacterBody3D + capsule; node-per-state StateMachine (enter/exit/physics_update); AnimationTree call-method tracks toggle hitboxes (frame data lives in animations); attacks as custom Resource .tres. Camera3D orthogonal, fixed rotation. Autoloads only for SaveManager/AudioRouter/GameEvents.
- Toon: `render_mode diffuse_toon, specular_toon` or ramp shader; outline via second pass cull_front inverted hull. Compatibility-renderer-safe.
- **Web export gotchas (critical):**
  1. **Compatibility renderer ONLY (WebGL 2)** — Forward+/Mobile do not work on web. Design for it from day one.
  2. Threads need COOP/COEP headers; **single-threaded export (4.3+) is default/recommended** — works everywhere.
  3. **GitHub Pages can't set headers** → single-threaded export, or PWA/coi-serviceworker shim.
  4. Audio: sample mode = no bus effects; browsers block autoplay → "click to start" screen required.
  5. Safari/iOS: single-threaded works well; threaded historically broken.
  6. Size: engine wasm ~40 MB raw / ~5 MB brotli / ~10 MB gzip; custom template + wasm-opt → ~23 MB.
  7. **C# cannot export to web in Godot 4 — GDScript only.**
  8. Serve .wasm as application/wasm.

### Tunic system patterns
- Shrine checkpoints: resting refills health/potions AND respawns regular enemies (bonfire pattern). Death: respawn at last shrine, drop ~20 coins as ghost at death spot, one retrieval chance.
- Save: serialize {spawnShrineId, stats, flags, pages[], coins} → localStorage (web) / user:// (Godot web = IndexedDB).
- Manual UI: pause-menu two-page spread, pages indexed by world order so gaps show as "? ?" slots (the collection hook), full-screen reveal on pickup, diagrams over text, one page = annotated area map.

Coverage notes: Hades dash seconds and BotW flurry frames unpublished; several primary blogs proxy-blocked, numbers quoted via search extracts.
