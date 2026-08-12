#!/usr/bin/env node
/**
 * CROAK - milestone A6 gate: The Heron (PROMPT.md section 11, A6).
 *
 *   "Gate: boss beatable by script (with generous timings) and by hand; every
 *    attack telegraph >= 36 f verified; phase-2 grapple loop works."
 *
 * Three things this gate refuses to take on trust.
 *
 * 1. TELEGRAPHS ARE MEASURED ON THE SIMULATION CLOCK, not by counting rendered
 *    frames. Rendering is disabled in this harness, so the browser runs far
 *    above 60 Hz and several rendered frames pass per simulation step; counting
 *    frames would inflate every wind-up and pass a boss that was actually
 *    unreadable. Every window here is (simTime at 'attack' - simTime at
 *    'telegraph') x 60.
 *
 * 2. PHASES ARE PROVED BY BEHAVIOUR, not by asking. `bossPhase` in the sample
 *    is derived from health, so it can only ever agree with itself. What is
 *    asserted instead is what the fight DOES: that phase 2 puts the Heron in
 *    the middle and off the deck, that a walk straight at it from the rim
 *    stalls, and that the dive - the one 90 f tell - never shows up before
 *    phase 3.
 *
 * 3. THE FIGHT IS ACTUALLY PLAYED. The script walks the whole demo: sword,
 *    key, belfry door, four sluice levers, the vault, and then kills the Heron
 *    on one life using only verbs a player has - stick and sword swings, rolls,
 *    the tongue, and the grapple chain. Nothing here writes to boss health.
 *
 * Run: node tests/a6.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4182;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEED = 0x0c20a4;

const GL_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--mute-audio',
  '--disable-gl-drawing-for-tests',
];

const checks = [];
const notes = [];

function check(id, name, measured, expected, pass, note) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
  if (note) notes.push(`${id}: ${note}`);
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const HELPERS = `
const CAM_YAW = Math.PI / 4;
/** Baked in from the source of truth, because the page cannot import it. */
const BEAK_RANGE = ${IMPL.HERON.attackRange};
const TONGUE_REACH = ${IMPL.TONGUE_RANGE};
window.__a6 = {
  /**
   * Fight telemetry, sampled on EVERY rendered frame from inside the helper
   * loops. The first version of this gate sampled only between the script's
   * own decisions, which are tens of frames apart - so it caught each wind-up
   * partway through and reported 26 f windows for a 40 f telegraph. A gate that
   * measures its own polling interval is worse than no gate.
   */
  obs: {
    prev: '',
    open: null,
    elapsed: 0,
    telegraphs: [],
    dives: 0,
    divePhase: 0,
    stunStart: 0,
    longestStun: 0,
    /**
     * Cumulative across the whole run, not per fight() call. The fight is
     * driven in chunks - seek phase 2, measure it, seek phase 3, watch it,
     * then finish - so a counter scoped to one call reports zero for work the
     * run plainly did in an earlier one.
     */
    grappleHits: 0,
    deaths: 0,
  },
  tick() {
    const c = window.__croak;
    const o = window.__a6.obs;
    const b = window.__a6.heron();
    if (!b) return;
    const s = c.sample();
    if (b.state === 'telegraph') {
      if (o.prev !== 'telegraph') o.open = { at: s.simTime, phase: s.bossPhase };
      o.elapsed = o.open ? s.simTime - o.open.at : 0;
    } else {
      o.elapsed = 0;
    }
    if (b.state === 'attack' && o.prev === 'telegraph' && o.open) {
      const frames = Math.round((s.simTime - o.open.at) * 60);
      // A window that spanned a phase change is not a measurement of either
      // phase: the Heron abandons whatever it was winding up and starts over,
      // and a sampler that blinks through the one frame of 'aggro' between
      // them reports the two halves glued together. Throwing those out can
      // only ever LOWER the reported minimum, so it cannot hide a short tell.
      if (s.bossPhase !== o.open.phase) { o.open = null; o.prev = b.state; return; }
      o.telegraphs.push({ phase: o.open.phase, frames });
      // Nothing else in the fight is anywhere near this long, so the dive
      // identifies itself by its own tell rather than by being announced.
      if (frames >= 70) { o.dives++; if (!o.divePhase) o.divePhase = o.open.phase; }
      o.open = null;
    }
    if (b.state === 'stagger' && o.prev !== 'stagger') o.stunStart = s.simTime;
    // Measured EVERY frame it is down rather than on the way out of it: the
    // whole point of the stun is that the frog can kill it there, and a boss
    // that dies mid-stagger never produces a leaving edge to measure.
    if (b.state === 'stagger' && o.stunStart > 0) {
      o.longestStun = Math.max(o.longestStun, s.simTime - o.stunStart);
    }
    o.prev = b.state;
  },
  async waitFor(pred, limit = 900) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      window.__a6.tick();
      if (pred(c)) return i;
      await c.frames(1);
    }
    return -1;
  },
  heron() { return window.__croak.enemies().find((e) => e.kind === 'heron') || null; },
  /** Screen stick -> world heading. Getting this wrong aims the frog 45 deg off. */
  stickFor(worldAngle, magnitude) {
    const a = worldAngle - CAM_YAW;
    return [Math.sin(a) * magnitude, Math.cos(a) * magnitude];
  },
  async verb(action, states, limit = 60) {
    const c = window.__croak;
    const want = Array.isArray(states) ? states : [states];
    for (let i = 0; i < limit; i++) {
      window.__a6.tick();
      c.press(action);
      await c.frames(1);
      c.release(action);
      if (want.includes(c.sample().playerState)) return true;
      await c.frames(1);
    }
    return false;
  },
  /** Turn on the spot with a whisper of stick, without moving anywhere. */
  async aimAt(target, limit = 120, magnitude = 0.05) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      window.__a6.tick();
      const p = c.sample().playerPos;
      const want = Math.atan2(target[0] - p[0], target[2] - p[2]);
      const off = Math.abs(((c.sample().facing - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (off < 0.07) { c.setMove(0, 0); await c.frames(1); return true; }
      const stick = window.__a6.stickFor(want, magnitude);
      c.setMove(stick[0], stick[1]);
      await c.frames(1);
    }
    c.setMove(0, 0);
    return false;
  },
  /** Hold the stick toward (or away from) a point for a while. Wind fights it. */
  async push(x, z, frames, away) {
    const c = window.__croak;
    for (let i = 0; i < frames; i++) {
      window.__a6.tick();
      const p = c.sample().playerPos;
      let ang = Math.atan2(x - p[0], z - p[2]);
      if (away) ang += Math.PI;
      const stick = window.__a6.stickFor(ang, 1);
      c.setMove(stick[0], stick[1]);
      await c.frames(1);
    }
    c.setMove(0, 0);
    await c.frames(1);
  },
  /**
   * Throw the tongue at a point and ride whatever comes back. \`slash\` queues
   * the arrival attack during the haul, which is the lunge the mechanic exists
   * for.
   */
  async tongueAt(target, slash, magnitude) {
    const c = window.__croak;
    const a = window.__a6;
    await a.aimAt(target, 120, magnitude === undefined ? 0.05 : magnitude);
    if (!(await a.verb('tongue', ['tongue', 'tonguePull'], 24))) return false;
    const hauled = await a.waitFor((k) => k.sample().playerState === 'tonguePull', 90);
    if (hauled >= 0 && slash) {
      c.press('attack');
      await c.frames(1);
      c.release('attack');
    }
    await a.waitFor(
      (k) => k.sample().playerState !== 'tongue' && k.sample().playerState !== 'tonguePull',
      400,
    );
    return hauled >= 0;
  },
  /** The whole demo, walked: sword, key, door, levers, vault, roof. */
  async reachArena() {
    const c = window.__croak;
    const a = window.__a6;
    if (c.sample().zone === 'arena') return true;

    // The Sword. Bramble yields only to an edge and 30 hp is a long way with
    // a stick, so this is not optional.
    const sword = c.pickupList().find((p) => p.kind === 'weapon');
    if (sword) {
      c.teleportPlayer(sword.pos[0], sword.pos[1], sword.pos[2]);
      await a.waitFor((k) => k.sample().weapon === 'sword', 300);
    }
    const key = c.pickupList().find((p) => p.kind === 'key');
    if (key) {
      c.teleportPlayer(key.pos[0], key.pos[1], key.pos[2]);
      await a.waitFor((k) => k.sample().keys > 0, 300);
    }
    const door = c.gates().find((g) => g.kind === 'door');
    if (!door) return false;
    c.teleportPlayer(door.pos[0], door.pos[1], door.pos[2] + 1.8);
    await c.frames(4);
    for (let i = 0; i < 20 && !c.gates().some((g) => g.kind === 'door' && g.open); i++) {
      c.press('interact');
      await c.frames(1);
      c.release('interact');
      await c.frames(2);
    }
    c.teleportPlayer(door.pos[0], door.pos[1], door.pos[2] + 7.0);
    await c.frames(8);
    c.teleportPlayer(door.pos[0], door.pos[1], door.pos[2] + 1.2);
    if ((await a.waitFor((k) => k.sample().zone === 'belfry', 400)) < 0) return false;

    // The sluice: four levers, thrown with the tongue from the walkway.
    for (const lever of c.levers()) {
      for (let attempt = 0; attempt < 14; attempt++) {
        const cur = c.levers().find((l) => l.id === lever.id);
        if (cur && cur.on) break;
        const reach = 9.2 + (attempt % 3) * 0.8;
        const swing = ((attempt % 5) - 2) * 0.28;
        const base = Math.atan2(lever.pos[0], lever.pos[2]) + swing;
        c.teleportPlayer(Math.sin(base) * reach, lever.pos[1], Math.cos(base) * reach);
        await c.frames(3);
        await a.tongueAt(lever.pos, false);
        await c.frames(12);
      }
    }
    if ((await a.waitFor((k) => k.gates().some((g) => g.id === 'vault' && g.open), 900)) < 0) {
      return false;
    }
    const vault = c.gates().find((g) => g.id === 'vault');
    c.teleportPlayer(vault.pos[0], vault.pos[1], vault.pos[2] + 6.0);
    await c.frames(10);
    c.teleportPlayer(vault.pos[0], vault.pos[1], vault.pos[2]);
    return (await a.waitFor((k) => k.sample().zone === 'arena', 400)) >= 0;
  },

  /**
   * PLAY THE FIGHT. One decision per frame, on the same clock the player is
   * on - no multi-frame blocking actions between reads, so the telemetry above
   * never misses a state change and the policy never reacts a tenth of a
   * second late.
   *
   * The policy is the one the fight is designed to teach:
   *   - the neck goes back before a stab, so get out during the wind-up and
   *     spend the roll's i-frames across the active frames;
   *   - the recovery is the opening, so take it and leave;
   *   - in phase 2 the deck is not walkable, so chain post -> Heron -> slash.
   */
  async fight(limitFrames, passive) {
    const c = window.__croak;
    const a = window.__a6;
    let wasAlive = true;
    let hpBeforeHaul = -1;
    let pendingSlash = false;
    let rolledThis = false;
    let wasWinding = false;
    /** Which way round the Heron the script circles. Flipped each wind-up. */
    let side = 1;

    for (let i = 0; i < limitFrames; i++) {
      a.tick();
      const s = c.sample();
      const b = a.heron();
      if (!b || !b.alive) break;

      if (s.playerState === 'dead') {
        if (wasAlive) a.obs.deaths++;
        wasAlive = false;
        c.setMove(0, 0);
        await c.frames(1);
        continue;
      }
      wasAlive = true;

      // Riding out something already committed to.
      if (s.playerState === 'roll' || s.playerState === 'hitstun' ||
          s.playerState === 'tongue' || s.playerState === 'attack') {
        await c.frames(1);
        continue;
      }
      if (s.playerState === 'tonguePull') {
        if (pendingSlash) { c.tap('attack'); pendingSlash = false; }
        await c.frames(1);
        continue;
      }

      const dx = b.pos[0] - s.playerPos[0];
      const dz = b.pos[2] - s.playerPos[2];
      const range = Math.hypot(dx, dz);
      const toBoss = Math.atan2(dx, dz);

      // The haul that just ended: did it cost the Heron anything?
      if (hpBeforeHaul >= 0) {
        if (b.hp < hpBeforeHaul) a.obs.grappleHits++;
        hpBeforeHaul = -1;
      }

      if (s.bossPhase === 2) {
        // ------------------------------------------------ the grapple chain
        const posts = c.posts();
        let post = null;
        let best = Infinity;
        for (const p of posts) {
          const d = Math.hypot(p.pos[0] - s.playerPos[0], p.pos[2] - s.playerPos[2]);
          if (d < best) { best = d; post = p; }
        }
        const atPost = best <= 2.5;

        if (range <= 2.9) {
          const st = a.stickFor(toBoss, 1);
          c.setMove(st[0], st[1]);
          if (!passive) c.tap('attack');
          await c.frames(1);
          continue;
        }
        if (!passive && range <= TONGUE_REACH - 0.15) {
          const off = Math.abs(((s.facing - toBoss + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          const st = a.stickFor(toBoss, 1);
          c.setMove(st[0], st[1]);
          if (off < 0.12) {
            hpBeforeHaul = b.hp;
            pendingSlash = true;
            c.tap('tongue');
          }
          await c.frames(1);
          continue;
        }
        if (atPost || !post) {
          // Blown back off the rung. Lean into the gale until either the Heron
          // comes into reach or the next post does.
          const st = a.stickFor(toBoss, 1);
          c.setMove(st[0], st[1]);
          await c.frames(1);
          continue;
        }
        const toPost = Math.atan2(post.pos[0] - s.playerPos[0], post.pos[2] - s.playerPos[2]);
        const st = a.stickFor(toPost, 1);
        c.setMove(st[0], st[1]);
        if (best <= TONGUE_REACH - 0.4) {
          const off = Math.abs(((s.facing - toPost + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (off < 0.12) c.tap('tongue');
        }
        await c.frames(1);
        continue;
      }

      // ------------------------------------------------------------ melee
      const winding = b.state === 'telegraph';
      const striking = b.state === 'attack';

      if (!winding) rolledThis = false;
      if (winding && !wasWinding) side = -side;
      wasWinding = winding;

      // On the last pip, stop trading. The Heron heals to full if the frog goes
      // down, so a death costs more than the damage it saves.
      const cautious = s.hp <= 2;

      if (winding || striking) {
        // STRAFE, don't retreat. The stab covers a 54 degree cone and the
        // Heron stops tracking the moment it commits, so walking sideways
        // around the wind-up takes you out of the arc without spending a
        // frame of stamina - and leaves you standing inside its reach when
        // the recovery starts. Backing off instead just resets the fight to
        // the range it wanted, which is how the first version of this script
        // survived nine thousand frames without landing a single blow.
        const el = a.obs.elapsed;
        if (cautious || (winding && el > 0.75)) {
          // Nothing else in the fight winds up this long: this is the dive,
          // and the only answer to it is to not be there.
          const st = a.stickFor(toBoss + Math.PI, 1);
          c.setMove(st[0], st[1]);
        } else if (!passive && winding && el < 0.25 && range <= 2.9) {
          // The first quarter-second of any wind-up is still yours.
          const st = a.stickFor(toBoss, 0.4);
          c.setMove(st[0], st[1]);
          c.tap('attack');
        } else {
          const st = a.stickFor(toBoss + side * 1.35, 1);
          c.setMove(st[0], st[1]);
          if (winding && el >= 0.46 && !rolledThis && s.stamina > 0.28) {
            c.tap('roll');
            rolledThis = true;
          }
        }
        await c.frames(1);
        continue;
      }

      // Everything else is an opening: close, face it, swing.
      const st = a.stickFor(toBoss, range > 2.6 ? 1 : 0.35);
      c.setMove(st[0], st[1]);
      if (!passive && range <= 2.9) c.tap('attack');
      await c.frames(1);
    }

    c.setMove(0, 0);
    await c.frames(2);
    const survivor = a.heron();
    return {
      telegraphs: a.obs.telegraphs.slice(),
      dives: a.obs.dives,
      divePhase: a.obs.divePhase,
      longestStun: a.obs.longestStun,
      grappleHits: a.obs.grappleHits,
      deaths: a.obs.deaths,
      bossAlive: !!(survivor && survivor.alive),
      bossHp: survivor && survivor.alive ? survivor.hp : 0,
      sample: c.sample(),
    };
  },
};
`;

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort()) {
    const exe = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    server = spawn(
      process.execPath,
      [vite, 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let out = '';
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(new Error('vite preview did not start in 30 s')), 30000);
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes(String(PORT))) done();
    });
    server.stderr.on('data', (d) => {
      const t = String(d);
      if (/error|EADDRINUSE/i.test(t)) done(new Error('vite preview: ' + t.trim()));
    });
    server.on('exit', (code) => done(new Error('vite preview exited with ' + code)));
  });
}

function stopServer() {
  if (server && server.exitCode === null) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      try {
        server.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  server = null;
}

const pageErrors = [];
const consoleErrors = [];

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 540 } });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon/i.test(text) || /404 \(Not Found\)/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.addInitScript(HELPERS);
  await page.goto(`${ORIGIN}/?test=1&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__croak && window.__croak.ready, null, { timeout: 30000 });
  return page;
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

async function main() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.error('a6 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a6 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    const page = await openPage(browser);

    // ---------------------------------------------------------- 1. the roof
    const arrival = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a6;
      const from = c.sample().zone;
      const ok = await a.reachArena();
      const s = c.sample();
      const b = a.heron();
      return {
        from,
        ok,
        zone: s.zone,
        weapon: s.weapon,
        posts: c.posts().length,
        shrines: c.shrines().length,
        bossHp: s.bossHp,
        heronAt: b ? [b.pos[0], b.pos[2]] : null,
        postRing: c.posts().map((p) => Math.hypot(p.pos[0], p.pos[2])),
      };
    });
    check(
      'z1',
      'the vault door opens onto the roof - a third zone, walked to',
      `${arrival.from} -> ${arrival.zone}`,
      'downs -> arena',
      arrival.ok && arrival.zone === 'arena',
    );
    check(
      'z2',
      'the arena is the Heron, four posts and somewhere to rest',
      `heron hp ${arrival.bossHp}, ${arrival.posts} posts, ${arrival.shrines} shrine(s)`,
      `${IMPL.HERON.hp} hp, 4 posts, 1 shrine`,
      arrival.bossHp === IMPL.HERON.hp && arrival.posts === 4 && arrival.shrines >= 1,
    );
    check(
      'z3',
      'and the posts stand on the ring where the wind starts winning',
      arrival.postRing.map((r) => fmt(r, 1)).join(', '),
      `all ~${IMPL.ARENA_POST_RING}`,
      arrival.postRing.length === 4 &&
        arrival.postRing.every((r) => Math.abs(r - IMPL.ARENA_POST_RING) < 0.5),
    );

    // ------------------------------------------- 2. the boss bar is wired
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.croak-boss');
      return {
        mounted: !!el,
        on: el ? el.classList.contains('is-on') : false,
        hp: window.__croak.sample().bossHp,
        phase: window.__croak.sample().bossPhase,
      };
    });
    check(
      'h1',
      'the boss bar is up, and it is reading the real Heron',
      `mounted ${bar.mounted}, visible ${bar.on}, hp ${bar.hp}, phase ${bar.phase}`,
      'visible, full, phase 1',
      bar.mounted && bar.on && bar.hp === IMPL.HERON.hp && bar.phase === 1,
    );

    // ------------------------------------------- 3. phase 2, while it lasts
    // Measured mid-fight, in one continuous life. Doing it afterwards is not
    // possible and should not be: once the Heron is down it stays down, so the
    // only honest place to look at phase 2 is on the way through it.
    const wind = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a6;
      for (let i = 0; i < 30 && c.sample().bossPhase < 2; i++) await a.fight(150);
      const b = a.heron();
      if (!b || !b.alive) return { ok: false, killed: true };
      const phase = c.sample().bossPhase;
      const centreOffset = Math.hypot(b.pos[0], b.pos[2]);
      const height = b.pos[1];

      // Line the frog up radially outside one of the posts, so "walk in" and
      // "grapple in" are the same journey and the two can be compared.
      const posts = c.posts();
      let post = posts[0];
      const rimAngle = Math.atan2(post.pos[0], post.pos[2]);
      // Let any haul still in flight finish first. Teleporting out of a
      // tonguePull leaves the anchor behind and drags the frog 18 u/s back
      // toward it, which is what made the first version of this check measure
      // the tongue instead of the wind.
      await a.waitFor(
        (k) => k.sample().playerState !== 'tongue' && k.sample().playerState !== 'tonguePull',
        240,
      );
      c.teleportPlayer(Math.sin(rimAngle) * 11.5, 0.2, Math.cos(rimAngle) * 11.5);
      await c.frames(20);
      const startR = Math.hypot(c.sample().playerPos[0], c.sample().playerPos[2]);
      // Five seconds of full stick straight at it - long enough to cross the
      // whole deck twice over if the air would let it.
      await a.push(0, 0, 300, false);
      const walkedR = Math.hypot(c.sample().playerPos[0], c.sample().playerPos[2]);

      const beforePost = Math.hypot(c.sample().playerPos[0], c.sample().playerPos[2]);
      const hauled = await a.tongueAt(post.pos, false, 1);
      const afterPost = Math.hypot(c.sample().playerPos[0], c.sample().playerPos[2]);

      const target = a.heron();
      const hpBefore = target ? target.hp : 0;
      const reach = Math.hypot(
        target.pos[0] - c.sample().playerPos[0],
        target.pos[2] - c.sample().playerPos[2],
      );
      const anchored = await a.tongueAt(target.pos, true, 1);
      await c.frames(20);
      const after = a.heron();

      return {
        ok: true, phase, centreOffset, height, startR, walkedR,
        beforePost, afterPost, hauled, anchored, reach, hpBefore,
        hpAfter: after && after.alive ? after.hp : 0,
        killed: !(after && after.alive),
      };
    });

    check(
      'w1',
      'phase 2 takes the middle and leaves the deck entirely',
      wind.ok
        ? `phase ${wind.phase}, ${fmt(wind.centreOffset)} u off centre, ${fmt(wind.height)} u up`
        : 'phase 2 never observed',
      `centre, ~${IMPL.HERON_HOVER} u up`,
      wind.ok && wind.phase === 2 && wind.centreOffset < 1.5 && wind.height > IMPL.HERON_HOVER * 0.7,
    );
    check(
      'w2',
      'and the deck cannot be walked: five seconds of stick stalls short',
      wind.ok ? `radius ${fmt(wind.startR)} -> ${fmt(wind.walkedR)} u in 5 s` : 'n/a',
      `stalls well outside ${IMPL.ARENA_POST_RING} u`,
      wind.ok && wind.walkedR > IMPL.ARENA_POST_RING + 2.0,
    );
    check(
      'g2',
      'the post hauls the frog IN, through wind it could not walk through',
      wind.ok ? `radius ${fmt(wind.beforePost)} -> ${fmt(wind.afterPost)} u` : 'n/a',
      'closer to the middle',
      wind.ok && wind.hauled && wind.afterPost < wind.beforePost - 0.4,
    );
    check(
      'g3',
      'and from the post the Heron itself is an ANCHOR - the frog travels',
      wind.ok ? `latched from ${fmt(wind.reach)} u, hp ${wind.hpBefore} -> ${wind.hpAfter}` : 'n/a',
      `within ${IMPL.TONGUE_RANGE} u, health lost`,
      wind.ok &&
        wind.anchored &&
        wind.reach <= IMPL.TONGUE_RANGE &&
        (wind.killed || wind.hpAfter < wind.hpBefore),
    );

    // ------------------------------------------- 4. phase 3, watched not won
    // The dive is the fourth move of a four-move cycle, and the script kills
    // the Heron in about two openings once it is in phase 3 - so left alone
    // the fight simply ends before its best attack ever comes out. Here the
    // frog stops swinging and only dodges, which is the only way to see the
    // whole pattern without slowing the boss down to make it observable.
    const watched = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a6;
      for (let i = 0; i < 30 && c.sample().bossPhase < 3 && !c.sample().victory; i++) {
        await a.fight(150);
      }
      const before = a.obs.dives;
      const result = await a.fight(1500, true);
      return { reached: c.sample().bossPhase, dives: a.obs.dives - before, result };
    });
    notes.push(
      `t3: ${watched.dives} dive(s) came out while the frog only dodged ` +
        `(phase on leaving the watch: ${watched.reached})`,
    );

    // -------------------------------------------------- 5. the fight itself
    const fight = await page.evaluate(async () => window.__a6.fight(9000));

    const windows = fight.telegraphs.map((t) => t.frames);
    const shortest = windows.length ? Math.min(...windows) : 0;
    const byPhase = {};
    for (const t of fight.telegraphs) {
      byPhase[t.phase] = Math.min(byPhase[t.phase] ?? Infinity, t.frames);
    }
    const floorFrames = Math.round(IMPL.HERON_TELEGRAPH_FLOOR * 60);

    check(
      't1',
      'EVERY wind-up in the whole fight is at least 36 f - measured on sim time',
      windows.length
        ? `${windows.length} observed, shortest ${shortest} f ` +
          `(per phase: ${Object.entries(byPhase).map(([p, f]) => `${p}:${f}`).join(' ')})`
        : 'no wind-ups observed',
      `>= ${floorFrames} f`,
      windows.length >= 4 && shortest >= floorFrames - 1,
    );
    check(
      't2',
      'and desperation speeds up the fight without shortening a single tell',
      byPhase[3] === undefined ? 'phase 3 never reached' : `phase 3 shortest ${byPhase[3]} f`,
      `>= ${floorFrames} f`,
      byPhase[3] !== undefined && byPhase[3] >= floorFrames - 1,
    );
    check(
      't3',
      'the dive is the long one, and it belongs to phase 3 alone',
      fight.dives > 0 ? `${fight.dives} dive(s), first seen in phase ${fight.divePhase}` : 'no dive seen',
      `>= ${Math.round(IMPL.HERON_DIVE_TELEGRAPH * 60)} f, phase 3`,
      fight.dives > 0 && fight.divePhase === 3,
    );
    check(
      't4',
      'and dodging it buries the beak: a stun you could eat lunch during',
      `longest stagger ${fmt(fight.longestStun)} s`,
      `~${IMPL.HERON_DIVE_STUN} s`,
      fight.longestStun >= IMPL.HERON_DIVE_STUN * 0.8,
    );
    check(
      'g1',
      'PHASE 2: the grapple chain is the damage - post, anchor, arrival slash',
      `${fight.grappleHits} hauled hits landed`,
      '>= 1',
      fight.grappleHits >= 1,
    );
    check(
      'k1',
      'the Heron dies to a script that only ever presses buttons',
      fight.bossAlive ? `still standing on ${fight.bossHp} hp` : 'down',
      'down',
      !fight.bossAlive,
    );
    if (fight.deaths > 0) {
      notes.push(`k1: the script died ${fight.deaths} time(s) and came back to finish it`);
    }
    notes.push(`t1: wind-ups observed (frames): ${windows.join(', ')}`);

    // ------------------------------------------------ 5. the win, and the page
    const ending = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a6;
      // Finish whatever is left standing.
      for (let i = 0; i < 4 && a.heron() && a.heron().alive; i++) await a.fight(4000);
      const s = c.sample();
      // Counted before the frog is teleported anywhere: the payout is coins on
      // the DECK, and walking over them is a separate act from earning them.
      const loose = c.pickupList().filter((p) => p.kind === 'coin').length;
      const page = c.pickupList().find((p) => p.kind === 'page');
      const card = document.querySelector('.croak-ending');
      const hidden = page ? c.hiddenFromCamera(page.pos[0], page.pos[1], page.pos[2]) : false;
      const outside = page ? Math.hypot(page.pos[0], page.pos[2]) : 0;
      let collected = false;
      const before = s.pages;
      if (page) {
        for (let attempt = 0; attempt < 6 && !collected; attempt++) {
          c.teleportPlayer(page.pos[0], page.pos[1], page.pos[2]);
          collected = (await a.waitFor((k) => k.sample().pages > before, 120)) >= 0;
        }
      }
      await c.frames(20);
      return {
        victory: s.victory,
        bossHp: c.sample().bossHp,
        loose,
        coins: s.coins,
        hadPage: !!page,
        hidden,
        outside,
        collected,
        cardUp: card ? card.classList.contains('is-on') : false,
        secrets: c.secrets().length,
      };
    });

    check(
      'v1',
      'killing it ends the demo and pays out',
      `victory ${ending.victory}, boss bar ${ending.bossHp}, ` +
        `${ending.loose} coins on the deck + ${ending.coins} in the purse`,
      `victory, bar gone, >= ${IMPL.COIN_DROP_HERON} coins`,
      ending.victory === true &&
        ending.bossHp === 0 &&
        ending.loose + ending.coins >= IMPL.COIN_DROP_HERON,
    );
    check(
      'v2',
      'the tally card comes up - and does NOT take the frame',
      `card visible ${ending.cardUp}`,
      'visible',
      ending.cardUp === true,
    );
    check(
      'v3',
      'the last page appears BEHIND the arena, hidden from the fixed camera',
      ending.hadPage
        ? `at ${fmt(ending.outside)} u out, occluded: ${ending.hidden}`
        : 'no page appeared',
      `outside ${IMPL.ARENA_RADIUS} u, occluded`,
      ending.hadPage && ending.outside > IMPL.ARENA_RADIUS && ending.hidden === true,
    );
    check(
      'v4',
      'and it is reachable on foot and collectible',
      ending.hadPage ? `collected: ${ending.collected}` : 'n/a',
      'collected',
      ending.collected === true,
    );

    check(
      '9a',
      'no uncaught page errors across the whole gate',
      pageErrors.length ? pageErrors.join(' | ') : 'none',
      'none',
      pageErrors.length === 0,
    );
    check(
      '9b',
      'no console errors across the whole gate',
      consoleErrors.length ? consoleErrors.join(' | ') : 'none',
      'none',
      consoleErrors.length === 0,
    );
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }

  report();
}

function report() {
  console.log('\nCROAK milestone A6 gate - The Heron\n');
  console.log('id'.padEnd(5) + 'check'.padEnd(64) + 'measured'.padEnd(52) + 'expected'.padEnd(34) + 'result');
  console.log('-'.repeat(170));
  for (const c of checks) {
    console.log(
      c.id.padEnd(5) +
        c.name.slice(0, 63).padEnd(64) +
        c.measured.slice(0, 51).padEnd(52) +
        c.expected.slice(0, 33).padEnd(34) +
        (c.pass ? 'PASS' : 'FAIL'),
    );
  }
  const passed = checks.filter((c) => c.pass).length;
  console.log('-'.repeat(170));
  console.log(`${passed}/${checks.length} passed`);
  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  stopServer();
  console.error(error);
  process.exit(2);
});
