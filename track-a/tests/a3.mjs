#!/usr/bin/env node
/**
 * CROAK - milestone A3 gate: the tongue (PROMPT.md section 4).
 *
 * One scripted test per row of the mass-rule table, plus the traversal the
 * mechanic exists to enable and the arrival slash it is built around:
 *
 *   row 1  item / coin      vacuumed from full range
 *   row 2  light enemy      pulled in and carried, then thrown as a weapon
 *   row 3  medium enemy     yanked, staggered, and SPUN so its shield faces away
 *   row 4  grapple post     the frog travels, and attacking on arrival slashes
 *
 * Run: node tests/a3.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4176;
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
const DEG = 180 / Math.PI;

const HELPERS = `
const CAM_YAW = Math.PI / 4;
window.__a3 = {
  async waitFor(pred, limit = 900) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      if (pred(c)) return i;
      await c.frames(1);
    }
    return -1;
  },
  beetle() { return window.__croak.enemies().find((e) => e.kind === 'beetleGuard') || null; },
  spore() { return window.__croak.enemies().find((e) => e.kind === 'sporeling') || null; },
  /** Press until the verb is actually entered - a slow frame can age a buffer out. */
  async verb(action, states, limit = 60) {
    const c = window.__croak;
    const want = Array.isArray(states) ? states : [states];
    for (let i = 0; i < limit; i++) {
      c.press(action);
      await c.frames(1);
      c.release(action);
      if (want.includes(c.sample().playerState)) return true;
      await c.frames(1);
    }
    return false;
  },
  /**
   * The stick is in SCREEN space and the rig rotates it by the camera yaw
   * (relativeMove: world = rotate(stick, -yaw)), so a stick of
   * (sin(phi - yaw), cos(phi - yaw)) walks the frog along world heading phi.
   * Getting this wrong points the frog 45 degrees off and every tongue test
   * silently measures a whiff.
   */
  stickFor(worldAngle, magnitude) {
    const a = worldAngle - CAM_YAW;
    return [Math.sin(a) * magnitude, Math.cos(a) * magnitude];
  },
  /** Stand at \`angle\` around a point, at \`radius\`, looking at it. */
  async faceFrom(target, angle, radius) {
    const c = window.__croak;
    c.teleportPlayer(
      target[0] + Math.sin(angle) * radius,
      target[1],
      target[2] + Math.cos(angle) * radius,
    );
    await c.frames(2);
    for (let i = 0; i < 90; i++) {
      const p = c.sample().playerPos;
      // Recomputed every step: both bodies are still moving.
      const want = Math.atan2(target[0] - p[0], target[2] - p[2]);
      const off = Math.abs(((c.sample().facing - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (off < 0.06) {
        c.setMove(0, 0);
        await c.frames(1);
        return true;
      }
      const stick = window.__a3.stickFor(want, 0.05);
      c.setMove(stick[0], stick[1]);
      await c.frames(1);
    }
    c.setMove(0, 0);
    return false;
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
    console.error('a3 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a3 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    let page = await openPage(browser);

    // ---------------------------------------------------- 0. reach and range
    const reach = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      // Face empty meadow so nothing is caught: this measures the rope itself.
      c.teleportPlayer(0, 0, 0);
      await c.frames(4);
      const fired = await a.verb('tongue', 'tongue', 40);
      let peak = 0;
      for (let i = 0; i < 90; i++) {
        peak = Math.max(peak, c.sample().tongueReach);
        if (c.sample().playerState !== 'tongue') break;
        await c.frames(1);
      }
      return { fired, peak, back: c.sample().tongueReach, state: c.sample().playerState };
    });
    check('0a', 'the tongue fires as its own state', reach.fired, 'true', reach.fired === true);
    check(
      '0b',
      'a whiff reaches TONGUE_RANGE and comes back',
      `out to ${fmt(reach.peak)} u, back to ${fmt(reach.back)} u`,
      `~${IMPL.TONGUE_RANGE} u out, 0 back`,
      reach.peak >= IMPL.TONGUE_RANGE * 0.9 && reach.back <= 0.01,
    );

    // ------------------------------------------- row 1: items from full range
    const vacuum = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      const sword = c.pickupList().find((p) => p.kind === 'weapon');
      if (!sword) return { ok: false };
      // Stand well outside the ordinary pickup magnet, inside tongue range.
      // Approached from +z: the pond's grapple posts sit on the -z side and a
      // post at 2 u legitimately outranks an item at 5 u, which would make this
      // a test of the scoring rule rather than of the vacuum.
      const dist = 5.0;
      await a.faceFrom(sword.pos, 0, dist);
      const before = c.sample().weapon;
      await a.verb('tongue', 'tongue', 40);
      const got = await a.waitFor((k) => k.sample().weapon === 'sword', 300);
      return { ok: true, dist, before, after: c.sample().weapon, got: got >= 0 };
    });
    check(
      'r1',
      'row 1: an item is vacuumed in from well beyond the walk-over range',
      vacuum.ok
        ? `tongued from ${fmt(vacuum.dist)} u (magnet is ${IMPL.COIN_MAGNET_RANGE} u): ${vacuum.before} -> ${vacuum.after}`
        : 'no item in the level',
      'item collected',
      vacuum.ok && vacuum.got && vacuum.after === 'sword' && vacuum.dist > IMPL.COIN_MAGNET_RANGE * 2,
    );

    // ------------------------------------ row 2: light enemy pulled and thrown
    await page.close();
    page = await openPage(browser);

    const carry = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      const s = a.spore();
      if (!s) return { ok: false };
      const dist = 4.0;
      c.teleportPlayer(s.pos[0], s.pos[1], s.pos[2] - dist);
      await c.frames(4);
      await a.faceFrom(s.pos, Math.PI, dist);
      const startGap = Math.hypot(
        s.pos[0] - c.sample().playerPos[0],
        s.pos[2] - c.sample().playerPos[2],
      );
      await a.verb('tongue', 'tongue', 40);
      const grabbed = await a.waitFor((k) => k.sample().carrying !== null, 300);
      const held = c.sample().carrying;
      const cur = a.spore();
      const gap = cur
        ? Math.hypot(cur.pos[0] - c.sample().playerPos[0], cur.pos[2] - c.sample().playerPos[2])
        : -1;
      return { ok: true, startGap, grabbed: grabbed >= 0, held, gap };
    });
    check(
      'r2a',
      'row 2: a light enemy is pulled in and ends up carried',
      carry.ok ? `grabbed from ${fmt(carry.startGap)} u, carrying "${carry.held}"` : 'no sporeling',
      'carrying it',
      carry.ok && carry.grabbed && carry.held === 'sporeling',
    );
    check(
      'r2b',
      'a carried body rides with the frog rather than staying put',
      carry.ok ? `${fmt(carry.gap)} u from the frog` : 'n/a',
      '< 1 u',
      carry.ok && carry.gap >= 0 && carry.gap < 1.0,
    );

    const thrown = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      if (c.sample().carrying === null) return { ok: false };
      const beetle = a.beetle();
      const before = beetle ? beetle.hp : -1;
      // Line the throw up on the guard and hurl it.
      if (beetle) await a.faceFrom(beetle.pos, Math.PI, 3.0);
      c.press('attack');
      await c.frames(1);
      c.release('attack');
      const let_go = await a.waitFor((k) => k.sample().carrying === null, 200);
      await c.frames(60);
      const after = a.beetle() ? a.beetle().hp : -1;
      const spore = a.spore();
      return { ok: true, released: let_go >= 0, before, after, sporeHp: spore ? spore.hp : 0 };
    });
    check(
      'r2c',
      'a carried body can be thrown',
      thrown.ok ? `carrying -> released: ${thrown.released}` : 'nothing was being carried',
      'released',
      thrown.ok && thrown.released,
    );
    check(
      'r2d',
      'the thrown body damages BOTH parties (section 4)',
      thrown.ok
        ? `guard ${thrown.before} -> ${thrown.after}, thrown sporeling left on ${thrown.sporeHp} hp`
        : 'n/a',
      'both take damage',
      thrown.ok && thrown.after < thrown.before && thrown.sporeHp < IMPL.SPORELING.hp,
    );

    // ------------------------------- row 3: medium enemy yanked and turned
    await page.close();
    page = await openPage(browser);

    const yank = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      const b = a.beetle();
      if (!b) return { ok: false };
      const dist = 4.5;
      // Stand square in FRONT of the shield - the worst place to be.
      c.teleportPlayer(
        b.pos[0] + Math.sin(b.facing) * dist,
        b.pos[1],
        b.pos[2] + Math.cos(b.facing) * dist,
      );
      await c.frames(4);
      await a.faceFrom(b.pos, b.facing, dist);

      const before = a.beetle();
      const p0 = c.sample().playerPos;
      const facingBefore = before.facing;
      const gapBefore = Math.hypot(before.pos[0] - p0[0], before.pos[2] - p0[2]);
      const offBefore = Math.abs(
        ((Math.atan2(p0[0] - before.pos[0], p0[2] - before.pos[2]) - facingBefore + Math.PI * 3) %
          (Math.PI * 2)) - Math.PI,
      );

      await a.verb('tongue', 'tongue', 40);
      await a.waitFor((k) => {
        const g = window.__a3.beetle();
        return g && g.state === 'stagger';
      }, 200);
      await c.frames(6);

      const after = a.beetle();
      const p1 = c.sample().playerPos;
      const gapAfter = Math.hypot(after.pos[0] - p1[0], after.pos[2] - p1[2]);
      const offAfter = Math.abs(
        ((Math.atan2(p1[0] - after.pos[0], p1[2] - after.pos[2]) - after.facing + Math.PI * 3) %
          (Math.PI * 2)) - Math.PI,
      );
      return {
        ok: true,
        gapBefore,
        gapAfter,
        offBefore,
        offAfter,
        state: after.state,
        carrying: c.sample().carrying,
        hp: after.hp,
      };
    });
    check(
      'r3a',
      'row 3: a medium enemy is NOT carried - it is too heavy to lift',
      yank.ok ? `carrying ${String(yank.carrying)}` : 'no guard',
      'null',
      yank.ok && yank.carrying === null,
    );
    check(
      'r3b',
      'it is dragged toward the frog and staggered',
      yank.ok ? `${fmt(yank.gapBefore)} u -> ${fmt(yank.gapAfter)} u, state "${yank.state}"` : 'n/a',
      `pulled ~${IMPL.TONGUE_YANK_DISTANCE} u, staggered`,
      yank.ok && yank.gapAfter < yank.gapBefore - 0.4,
    );
    check(
      'r3c',
      'THE OPENER: the yank spins the shield away from the frog',
      yank.ok
        ? `blow angle ${fmt(yank.offBefore * DEG, 0)} deg -> ${fmt(yank.offAfter * DEG, 0)} deg off its facing`
        : 'n/a',
      `inside ${fmt(IMPL.BEETLE_SHIELD_ARC * DEG, 0)} deg -> outside it`,
      yank.ok &&
        yank.offBefore <= IMPL.BEETLE_SHIELD_ARC &&
        yank.offAfter > IMPL.BEETLE_SHIELD_ARC,
    );

    const opened = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      // Cash the opener in: the front should now be hittable.
      const before = a.beetle().hp;
      await a.verb('attack', 'attack', 12);
      await c.frames(30);
      return { before, after: a.beetle() ? a.beetle().hp : 0 };
    });
    check(
      'r3d',
      'and the blow that follows the yank actually lands',
      `hp ${opened.before} -> ${opened.after}`,
      'hp drops',
      opened.after < opened.before,
    );

    // --------------------------- row 4: grapple post, travel + arrival slash
    await page.close();
    page = await openPage(browser);

    const pull = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      const post = c.posts()[0];
      if (!post) return { fired: false, pulled: false, travelled: 0 };
      const reach = 5.5;
      await a.faceFrom(post.pos, Math.PI, reach);
      const p0 = c.sample().playerPos.slice();
      // A pull is short and fast, so watch the whole window rather than
      // polling for one instant of it.
      const seen = new Set();
      c.press('tongue');
      await c.frames(1);
      c.release('tongue');
      for (let i = 0; i < 200; i++) {
        seen.add(c.sample().playerState);
        await c.frames(1);
      }
      const p1 = c.sample().playerPos;
      return {
        fired: seen.has('tongue'),
        pulled: seen.has('tonguePull'),
        travelled: Math.hypot(p1[0] - p0[0], p1[2] - p0[2]),
        states: [...seen].join('/'),
      };
    });
    check(
      'r4a',
      'row 4: an anchored post pulls the FROG, not the post',
      pull.pulled
        ? `entered tonguePull and travelled ${fmt(pull.travelled)} u`
        : `never entered tonguePull (fired: ${pull.fired})`,
      'the frog travels',
      pull.pulled && pull.travelled > 2.0,
    );

    const lunge = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a3;
      // Same post again, this time attacking mid-flight.
      const post = c.posts()[0];
      await a.faceFrom(post.pos, Math.PI, 5.5);
      await a.verb('tongue', ['tongue', 'tonguePull'], 40);
      const pulling = await a.waitFor((k) => k.sample().playerState === 'tonguePull', 200);
      if (pulling < 0) return { ok: false };
      // Claim the slash while still in flight.
      c.press('attack');
      await c.frames(1);
      c.release('attack');
      const slashed = await a.waitFor((k) => k.sample().playerState === 'attack', 400);
      return { ok: true, slashed: slashed >= 0 };
    });
    check(
      'r4b',
      'THE MOVE: attacking mid-haul spends the momentum as an arrival slash',
      lunge.ok ? `arrival slash fired: ${lunge.slashed}` : 'never got into a pull',
      'attack state on landing',
      lunge.ok && lunge.slashed,
    );
    check(
      'r4c',
      'the arrival slash hits harder than an ordinary swing',
      `lunge ${IMPL.LUNGE_SLASH.damage} vs sword opener ${IMPL.WEAPONS.sword.swings[0].damage}`,
      'lunge damage is higher',
      IMPL.LUNGE_SLASH.damage > IMPL.WEAPONS.sword.swings[0].damage,
    );

    // ------------------------------------------------------------- hygiene
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
  console.log('\nCROAK milestone A3 gate - the tongue\n');
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
  if (passed !== checks.length) {
    console.log('\nFAILED:');
    for (const c of checks.filter((x) => !x.pass)) {
      console.log(`  ${c.id} ${c.name}\n     measured ${c.measured}\n     expected ${c.expected}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  stopServer();
  console.error(err);
  process.exit(1);
});
