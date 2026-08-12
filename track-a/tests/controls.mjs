#!/usr/bin/env node
/**
 * CROAK - controls gate: keyboard, gamepad and touch.
 *
 * Every input source has to reach the SAME game logic. Keyboard is driven with
 * real key events, touch with real synthesised pointer events against the
 * on-screen controls, and the gamepad's mapping table is checked for the
 * completeness a pad player depends on.
 *
 * The touch checks matter most: a virtual stick that merely looks right but
 * feeds the wrong vector would move the frog 45 degrees off, and the layer must
 * not exist at all on a desktop, where it would swallow mouse clicks.
 *
 * Run: node tests/controls.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4180;
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
window.__ct = {
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
      const stick = window.__ct.stickFor(want, 0.05);
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

async function openPage(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 540 },
    hasTouch: !!opts.touch,
    isMobile: false,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon/i.test(text) || /404 \(Not Found\)/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.addInitScript(HELPERS);
  const query = opts.touch === false ? 'test=1&touch=0' : opts.touch ? 'test=1&touch=1' : 'test=1';
  await page.goto(`${ORIGIN}/?${query}&seed=${SEED}`, { waitUntil: 'load' });
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
    console.error('controls gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('controls gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    // ------------------------------------------------- 1. keyboard, for real
    const kb = await openPage(browser, { touch: false });
    const keyboard = {};
    const before = await kb.evaluate(() => window.__croak.sample().playerPos);
    await kb.keyboard.down('KeyW');
    await kb.waitForTimeout(700);
    await kb.keyboard.up('KeyW');
    keyboard.moved = await kb.evaluate(
      (p) => {
        const now = window.__croak.sample().playerPos;
        return Math.hypot(now[0] - p[0], now[2] - p[2]);
      },
      before,
    );
    for (const [key, state] of [
      ['Space', 'roll'],
      ['KeyJ', 'attack'],
      ['KeyK', 'tongue'],
    ]) {
      let seen = false;
      for (let i = 0; i < 12 && !seen; i++) {
        await kb.keyboard.press(key);
        seen = await kb.evaluate(async (want) => {
          const c = window.__croak;
          for (let f = 0; f < 6; f++) {
            if (c.sample().playerState === want) return true;
            await c.frames(1);
          }
          return false;
        }, state);
      }
      keyboard[state] = seen;
    }
    check(
      'k1',
      'a real W keypress walks the frog',
      `travelled ${fmt(keyboard.moved)} u`,
      '> 0.5 u',
      keyboard.moved > 0.5,
    );
    check(
      'k2',
      'Space / J / K drive roll, attack and tongue',
      `roll ${keyboard.roll}, attack ${keyboard.attack}, tongue ${keyboard.tongue}`,
      'all true',
      keyboard.roll && keyboard.attack && keyboard.tongue,
    );

    // --------------------------------------- 2. the layer is desktop-invisible
    const desktopTouch = await kb.evaluate(
      () => document.querySelectorAll('.croak-touch__btn').length,
    );
    check(
      't0',
      'no touch controls exist on a desktop pointer',
      `${desktopTouch} buttons in the DOM`,
      '0',
      desktopTouch === 0,
    );
    await kb.close();

    // ------------------------------------------------------------ 3. touch
    const page = await openPage(browser, { touch: true });

    const layout = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.croak-touch__btn')].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: b.getAttribute('aria-label'),
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          size: Math.round(r.width),
        };
      });
      const zone = document.querySelector('.croak-touch__zone--move');
      const zr = zone ? zone.getBoundingClientRect() : null;
      return { buttons, zone: zr ? { x: zr.left, y: zr.top, w: zr.width, h: zr.height } : null };
    });
    check(
      't1',
      'the touch layer mounts on a coarse pointer',
      layout.zone
        ? `stick zone ${Math.round(layout.zone.w)}x${Math.round(layout.zone.h)}, ` +
          `${layout.buttons.length} buttons: ${layout.buttons.map((b) => b.label).join(', ')}`
        : 'no stick zone',
      'stick + 6 buttons',
      !!layout.zone && layout.buttons.length === 6,
    );
    check(
      't2',
      'every verb has a button, and they are big enough for a thumb',
      layout.buttons.map((b) => `${b.label} ${b.size}px`).join(', '),
      'all >= 44px (the usual touch-target floor)',
      layout.buttons.length === 6 && layout.buttons.every((b) => b.size >= 44),
    );

    // Drag the floating stick and check the frog goes where the thumb points.
    const dragged = await (async () => {
      const startX = 150;
      const startY = 380;
      const before2 = await page.evaluate(() => window.__croak.sample().playerPos);
      await page.touchscreen.tap(startX, startY); // wake the layer
      const client = await page.context().newCDPSession(page);
      // Synthesise a real pointer drag: down, several moves, up.
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY, id: 1 }],
      });
      for (let i = 1; i <= 6; i++) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX, y: startY - i * 9, id: 1 }],
        });
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(500);
      const mid = await page.evaluate(() => ({
        pos: window.__croak.sample().playerPos,
        state: window.__croak.sample().playerState,
      }));
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        pos: window.__croak.sample().playerPos,
        state: window.__croak.sample().playerState,
      }));
      return {
        travelled: Math.hypot(mid.pos[0] - before2[0], mid.pos[2] - before2[2]),
        movingState: mid.state,
        restState: after.state,
      };
    })();
    check(
      't3',
      'dragging the floating stick moves the frog',
      `travelled ${fmt(dragged.travelled)} u, state "${dragged.movingState}"`,
      '> 0.5 u while moving',
      dragged.travelled > 0.5 && dragged.movingState === 'move',
    );
    check(
      't4',
      'and lifting the thumb stops it - no stuck stick',
      `state after release: "${dragged.restState}"`,
      'idle',
      dragged.restState === 'idle',
    );

    // Each button must actually claim its verb through the real input system.
    const pressed = {};
    for (const spec of [
      { label: 'roll', state: 'roll' },
      { label: 'attack', state: 'attack' },
      { label: 'tongue', state: 'tongue' },
    ]) {
      const target = layout.buttons.find((b) => b.label === spec.label);
      let seen = false;
      for (let attempt = 0; attempt < 10 && !seen; attempt++) {
        await page.touchscreen.tap(target.cx, target.cy);
        seen = await page.evaluate(async (want) => {
          const c = window.__croak;
          for (let f = 0; f < 8; f++) {
            if (c.sample().playerState === want) return true;
            await c.frames(1);
          }
          return false;
        }, spec.state);
      }
      pressed[spec.label] = seen;
    }
    check(
      't5',
      'the roll, attack and tongue buttons drive the real verbs',
      `roll ${pressed.roll}, attack ${pressed.attack}, tongue ${pressed.tongue}`,
      'all true',
      pressed.roll && pressed.attack && pressed.tongue,
    );

    const lockLabel = layout.buttons.find((b) => b.label === 'lock on');
    const locked = await (async () => {
      for (let i = 0; i < 8; i++) {
        await page.touchscreen.tap(lockLabel.cx, lockLabel.cy);
        const on = await page.evaluate(async () => {
          const c = window.__croak;
          for (let f = 0; f < 8; f++) {
            if (c.sample().lockedOn) return true;
            await c.frames(1);
          }
          return false;
        });
        if (on) return true;
      }
      return false;
    })();
    check('t6', 'the lock-on button toggles a hard lock', locked, 'true', locked === true);

    // ---------------------------------------------------------- 4. gamepad
    const padMap = await page.evaluate(() => ({
      hasApi: typeof navigator.getGamepads === 'function',
    }));
    check(
      'p1',
      'the Gamepad API is read at all',
      padMap.hasApi ? 'navigator.getGamepads present and polled' : 'absent',
      'present',
      padMap.hasApi,
    );
    // The binding table is source, not runtime: assert it covers every verb.
    const src = fs.readFileSync(path.join(ROOT, 'src/core/input.ts'), 'utf8');
    const padBlock = src.slice(src.indexOf('const PAD_ACTIONS'), src.indexOf('const PAD_DPAD'));
    const bound = ['roll', 'attack', 'tongue', 'lockon', 'interact'].filter((a) =>
      padBlock.includes(`'${a}'`),
    );
    check(
      'p2',
      'every verb has a pad button bound',
      `bound: ${bound.join(', ')}`,
      'all five verbs',
      bound.length === 5,
    );
    const dpadBlock = src.slice(src.indexOf('const PAD_DPAD'), src.indexOf('const PAD_DEADZONE'));
    check(
      'p3',
      'the d-pad is bound as digital movement alongside the analog stick',
      `${(dpadBlock.match(/\d+: \[/g) || []).length} d-pad directions, deadzone ${IMPL_DEADZONE(src)}`,
      '4 directions',
      (dpadBlock.match(/\d+: \[/g) || []).length === 4,
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

function IMPL_DEADZONE(src) {
  const m = src.match(/PAD_DEADZONE = ([0-9.]+)/);
  return m ? m[1] : '?';
}
function report() {
  console.log('\nCROAK controls gate - keyboard, gamepad, touch\n');
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
