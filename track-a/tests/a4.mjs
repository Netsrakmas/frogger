#!/usr/bin/env node
/**
 * CROAK - milestone A4 gate: Lilypond Downs (PROMPT.md section 11, A4).
 *
 * The zone has to be a ZONE, not a list of props: six authored secrets of which
 * at least three are hidden by the fixed camera rather than by a lock, gates
 * whose keys are things you had to go and find, and an enemy that finally makes
 * the tongue necessary rather than merely available.
 *
 * The occlusion checks are the interesting ones. "Hidden behind something" is
 * measured by casting along the camera's own view axis and asking whether level
 * geometry is in the way - not by trusting the level designer's comment.
 *
 * Run: node tests/a4.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4178;
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
window.__a4 = {
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
      const stick = window.__a4.stickFor(want, 0.05);
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
    console.error('a4 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a4 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    let page = await openPage(browser);

    // ------------------------------------------------------- 1. the secrets
    const secrets = await page.evaluate(() => {
      const c = window.__croak;
      const list = c.secrets();
      return list.map((s) => ({
        ...s,
        reallyHidden: c.hiddenFromCamera(s.pos[0], s.pos[1] + 0.5, s.pos[2]),
      }));
    });
    check(
      's1',
      'the zone holds at least six authored secrets',
      `${secrets.length} secrets: ${secrets.map((s) => s.id).join(', ')}`,
      '>= 6',
      secrets.length >= 6,
    );
    const claimed = secrets.filter((s) => s.occluded);
    check(
      's2',
      'at least three are hidden by the camera rather than by a lock',
      `${claimed.length} marked occluded`,
      '>= 3',
      claimed.length >= 3,
    );
    const verified = claimed.filter((s) => s.reallyHidden);
    check(
      's3',
      'AND geometry really is between the camera and each of them',
      `${verified.length}/${claimed.length} blocked on the view axis` +
        (verified.length < claimed.length
          ? ` (open: ${claimed.filter((s) => !s.reallyHidden).map((s) => s.id).join(', ')})`
          : ''),
      'all of them',
      claimed.length > 0 && verified.length === claimed.length,
    );
    const openSpots = secrets.filter((s) => !s.occluded && s.reallyHidden);
    check(
      's4',
      'and the ones NOT claimed as camera-hidden are genuinely in the open (control)',
      `${openSpots.length} of ${secrets.length - claimed.length} unexpectedly blocked`,
      '0',
      openSpots.length === 0,
    );

    // ------------------------------------------------------- 2. the bramble
    const bramble = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a4;
      const gate = c.gates().find((g) => g.kind === 'bramble');
      if (!gate) return { ok: false };
      await a.faceFrom(gate.pos, Math.PI, 1.6);
      const startWeapon = c.sample().weapon;
      // Stick first: the thicket must refuse it.
      for (let i = 0; i < 12; i++) {
        await a.verb('attack', 'attack', 8);
        await c.frames(20);
      }
      const afterStick = c.gates().find((g) => g.kind === 'bramble').open;

      // Now go and get the Sword, and come back.
      const sword = c.pickupList().find((p) => p.kind === 'weapon');
      if (sword) {
        c.teleportPlayer(sword.pos[0], sword.pos[1], sword.pos[2]);
        await a.waitFor((k) => k.sample().weapon === 'sword', 300);
      }
      await a.faceFrom(gate.pos, Math.PI, 1.6);
      for (let i = 0; i < 18; i++) {
        if (c.gates().find((g) => g.kind === 'bramble').open) break;
        await a.verb('attack', 'attack', 8);
        await c.frames(20);
      }
      const afterSword = c.gates().find((g) => g.kind === 'bramble').open;
      return { ok: true, startWeapon, afterStick, afterSword, weapon: c.sample().weapon };
    });
    check(
      'g1',
      'bramble refuses the Stick, however long you hit it',
      bramble.ok ? `12 swings with the ${bramble.startWeapon}: open = ${bramble.afterStick}` : 'no bramble',
      'still closed',
      bramble.ok && bramble.afterStick === false,
    );
    check(
      'g2',
      'and yields to the Sword - the lock whose key is a weapon',
      bramble.ok ? `after taking the ${bramble.weapon}: open = ${bramble.afterSword}` : 'n/a',
      'open',
      bramble.ok && bramble.afterSword === true,
    );

    // ---------------------------------------------------- 3. the belfry door
    await page.close();
    page = await openPage(browser);

    const door = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a4;
      const gate = c.gates().find((g) => g.kind === 'door');
      if (!gate) return { ok: false };
      c.teleportPlayer(gate.pos[0], gate.pos[1], gate.pos[2] + 1.6);
      await c.frames(4);
      for (let i = 0; i < 12; i++) {
        c.press('interact');
        await c.frames(1);
        c.release('interact');
        await c.frames(2);
      }
      const lockedStill = !c.gates().find((g) => g.kind === 'door').open;
      const keysBefore = c.sample().keys;

      // Fetch the key from the ruin it was hidden in.
      const key = c.pickupList().find((p) => p.kind === 'key');
      if (key) {
        c.teleportPlayer(key.pos[0], key.pos[1], key.pos[2]);
        await a.waitFor((k) => k.sample().keys > 0, 300);
      }
      const keysAfter = c.sample().keys;

      c.teleportPlayer(gate.pos[0], gate.pos[1], gate.pos[2] + 1.6);
      await c.frames(4);
      for (let i = 0; i < 12; i++) {
        if (c.gates().find((g) => g.kind === 'door').open) break;
        c.press('interact');
        await c.frames(1);
        c.release('interact');
        await c.frames(2);
      }
      return {
        ok: true,
        lockedStill,
        keysBefore,
        keysAfter,
        open: c.gates().find((g) => g.kind === 'door').open,
        keysLeft: c.sample().keys,
      };
    });
    check(
      'g3',
      'the belfry door will not open without the key',
      door.ok ? `12 tries with ${door.keysBefore} keys: still locked = ${door.lockedStill}` : 'no door',
      'still locked',
      door.ok && door.lockedStill,
    );
    check(
      'g4',
      'the key is findable and opens it, and is spent doing so',
      door.ok ? `keys ${door.keysBefore} -> ${door.keysAfter} -> ${door.keysLeft}, open = ${door.open}` : 'n/a',
      'opens, key consumed',
      door.ok && door.keysAfter > 0 && door.open === true && door.keysLeft === 0,
    );

    // ------------------------------------------------------ 4. Spitter Flies
    await page.close();
    page = await openPage(browser);

    const spitter = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a4;
      const fly = c.enemies().find((e) => e.kind === 'spitterFly');
      if (!fly) return { ok: false };
      // Walk into its range and see whether it keeps its distance.
      c.teleportPlayer(fly.pos[0], fly.pos[1], fly.pos[2] + 6.0);
      let closest = Infinity;
      let sawTelegraph = false;
      for (let i = 0; i < 260; i++) {
        const cur = c.enemies().find((e) => e.kind === 'spitterFly');
        if (!cur) break;
        const p = c.sample().playerPos;
        closest = Math.min(closest, Math.hypot(cur.pos[0] - p[0], cur.pos[2] - p[2]));
        if (cur.state === 'telegraph') sawTelegraph = true;
        await c.frames(1);
      }
      return { ok: true, closest, sawTelegraph, hover: c.enemies().find((e) => e.kind === 'spitterFly').pos[1] };
    });
    check(
      'e1',
      'the Spitter Fly holds its standoff instead of closing',
      spitter.ok ? `closest approach ${fmt(spitter.closest)} u` : 'no spitter in the zone',
      `>= ${IMPL.SPITTER_STANDOFF - 1.5} u`,
      spitter.ok && spitter.closest >= IMPL.SPITTER_STANDOFF - 1.5,
    );
    check(
      'e2',
      'it telegraphs before it spits',
      spitter.ok ? `telegraph seen: ${spitter.sawTelegraph}` : 'n/a',
      'true',
      spitter.ok && spitter.sawTelegraph,
    );

    const pulled = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a4;
      const fly = c.enemies().find((e) => e.kind === 'spitterFly');
      if (!fly) return { ok: false };
      // Its position is at hover height; teleporting the frog to that y drops
      // it out of the sky mid-turn. Stand on the ground under it instead.
      const ground = c.sample().playerPos[1];
      await a.faceFrom([fly.pos[0], ground, fly.pos[2]], Math.PI, 4.5);
      let grabbed = -1;
      for (let attempt = 0; attempt < 6 && grabbed < 0; attempt++) {
        await a.faceFrom([
          (c.enemies().find((e) => e.kind === 'spitterFly') || fly).pos[0],
          ground,
          (c.enemies().find((e) => e.kind === 'spitterFly') || fly).pos[2],
        ], Math.PI, 4.5);
        await a.verb('tongue', ['tongue', 'tonguePull'], 20);
        grabbed = await a.waitFor((k) => k.sample().carrying !== null, 60);
      }
      return { ok: true, grabbed: grabbed >= 0, carrying: c.sample().carrying };
    });
    check(
      'e3',
      'THE ANSWER: the tongue drags it out of the air',
      pulled.ok ? `carrying "${pulled.carrying}"` : 'n/a',
      'carrying spitterFly',
      pulled.ok && pulled.grabbed && pulled.carrying === 'spitterFly',
    );

    // ------------------------------------------- 5. pages, shrines, payouts
    await page.close();
    page = await openPage(browser);

    const content = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a4;
      const shrines = c.shrines().length;
      const pageDrops = c.pickupList().filter((p) => p.kind === 'page');
      let collected = 0;
      for (const drop of pageDrops) {
        c.teleportPlayer(drop.pos[0], drop.pos[1], drop.pos[2]);
        const got = await a.waitFor((k) => k.sample().pages > collected, 200);
        if (got >= 0) collected++;
        // A7 made a page arriving throw the manual open, and the manual pauses
        // the world - so a player shuts the book before walking on, and so does
        // this. Without it the second page is unreachable behind the first
        // one's reveal, which is exactly what this check caught.
        for (let i = 0; i < 20 && c.sample().manualOpen; i++) {
          c.press('manual');
          await c.frames(1);
          c.release('manual');
          await c.frames(2);
        }
      }
      return { shrines, placed: pageDrops.length, collected, pages: c.sample().pages };
    });
    check(
      'c1',
      'the zone has two shrines',
      `${content.shrines} shrines`,
      '2',
      content.shrines === 2,
    );
    check(
      'c2',
      'two manual pages are placed and collectible',
      `${content.placed} placed, ${content.collected} collected, progress records ${content.pages}`,
      '2 placed and collected',
      content.placed === 2 && content.collected === 2 && content.pages === 2,
    );

    // ------------------------------------------------------------ hygiene
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
  console.log('\nCROAK milestone A4 gate - Lilypond Downs\n');
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
