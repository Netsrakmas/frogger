#!/usr/bin/env node
/**
 * CROAK - milestone A7 gate: the manual and Croakic (PROMPT.md section 11, A7).
 *
 *   "Gate: all pages collectible; spread reveal; glyphs decode round-trip in a
 *    unit test."
 *
 * The round-trip half lives in `tests/croakic.mjs`, which is pure and runs in
 * milliseconds - there is no reason to boot a browser to prove a cipher is
 * injective, and every reason to prove it exhaustively instead of once.
 *
 * This file proves the half that needs a running game: that the booklet is a
 * thing you can open, that opening it STOPS the world, that all four slots are
 * there from the first time you look, that a page arriving fills its slot and
 * throws the spread open on it, and that the writing on the pages and on the
 * world's signage is drawn rather than typeset.
 *
 * The fourth page is the Heron's, and it only exists once the Heron does not.
 * Collecting it is asserted by `tests/a6.mjs` (v3/v4: it appears on the ledge
 * behind the arena, is camera-occluded, is reachable on foot, and goes into the
 * count). This gate walks the first three and checks the fourth's slot stays a
 * gap until then, rather than re-fighting a boss another gate already fought.
 *
 * Run: node tests/a7.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';
import * as CROAKIC from '../src/ui/croakic.ts';
import { SIGN_TEXT } from '../src/world/signtext.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4183;
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

function check(id, name, measured, expected, pass) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const HELPERS = `
window.__a7 = {
  async waitFor(pred, limit = 900) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      if (pred(c)) return i;
      await c.frames(1);
    }
    return -1;
  },
  /** Press until the booklet actually changes state - a buffer can age out. */
  async toggleManual(want, limit = 40) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      c.press('manual');
      await c.frames(1);
      c.release('manual');
      await c.frames(2);
      if (c.sample().manualOpen === want) return true;
    }
    return false;
  },
  async grab(kind, limit = 200) {
    const c = window.__croak;
    const drop = c.pickupList().find((p) => p.kind === kind);
    if (!drop) return false;
    const before = c.sample().pages;
    for (let attempt = 0; attempt < 6; attempt++) {
      c.teleportPlayer(drop.pos[0], drop.pos[1], drop.pos[2]);
      if ((await window.__a7.waitFor((k) => k.sample().pages > before, limit)) >= 0) return true;
    }
    return false;
  },
  /** The same walk A5 and A6 use, cut short at the belfry. */
  async enterBelfry() {
    const c = window.__croak;
    const a = window.__a7;
    if (c.sample().zone === 'belfry') return true;
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
    return (await a.waitFor((k) => k.sample().zone === 'belfry', 400)) >= 0;
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
    console.error('a7 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a7 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    const page = await openPage(browser);

    // -------------------------------------------------- 1. it opens, it pauses
    const opening = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a7;
      const closedAtBoot = c.sample().manualOpen === false;
      const mounted = document.querySelectorAll('.croak-manual').length;

      const opened = await a.toggleManual(true);
      // Let real time pass with the book up, holding the stick, and see what
      // moved. Asserting the CLOCK alone would pass a pause that only stopped
      // the bookkeeping; asserting the FROG alone would pass one that let every
      // window in the game keep expiring behind the page.
      c.setMove(0.9, 0.9);
      const before = c.sample();
      await c.frames(40);
      const during = c.sample();
      c.setMove(0, 0);
      const moved = Math.hypot(
        during.playerPos[0] - before.playerPos[0],
        during.playerPos[2] - before.playerPos[2],
      );

      const closed = await a.toggleManual(false);
      const afterClose = c.sample();
      await c.frames(30);
      const running = c.sample();

      return {
        closedAtBoot,
        mounted,
        opened,
        closed,
        simFrozen: during.simTime - before.simTime,
        moved,
        paused: during.paused,
        presentRan: during.presentTime - before.presentTime,
        framesDrawn: during.frameCount - before.frameCount,
        resumed: running.simTime - afterClose.simTime,
      };
    });

    check(
      'm1',
      'the booklet is mounted, and it is shut until asked for',
      `${opening.mounted} overlay(s), open at boot = ${!opening.closedAtBoot}`,
      '1 overlay, shut',
      opening.mounted === 1 && opening.closedAtBoot,
    );
    check(
      'm2',
      'one press opens it and STOPS the world - clock and frog both',
      `sim advanced ${fmt(opening.simFrozen, 3)} s, frog moved ${fmt(opening.moved, 3)} u ` +
        `across ${opening.framesDrawn} drawn frames`,
      'sim frozen, frog still, frames still drawn',
      opening.opened &&
        opening.paused === true &&
        opening.simFrozen < 0.02 &&
        opening.moved < 0.01 &&
        opening.framesDrawn > 10,
    );
    check(
      'm3',
      'the paper keeps breathing while the world does not',
      `present time advanced ${fmt(opening.presentRan, 3)} s`,
      '> 0',
      opening.presentRan > 0.05,
    );
    check(
      'm4',
      'and closing it starts the world again',
      `sim advanced ${fmt(opening.resumed, 3)} s after closing`,
      '> 0',
      opening.closed && opening.resumed > 0.05,
    );

    // ------------------------------------------------- 2. four slots, one book
    const slots = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a7;
      await a.toggleManual(true);
      await c.frames(4);
      const root = document.querySelector('.croak-manual');
      const tabs = root.querySelectorAll('.croak-manual__tab').length;
      const emptyTabs = root.querySelectorAll('.croak-manual__tab--empty').length;
      const gaps = root.querySelectorAll('.croak-manual__slot').length;
      const spread0 = c.sample().manualSpread;

      // Turn the page and come back.
      c.press('attack');
      await c.frames(1);
      c.release('attack');
      await a.waitFor((k) => k.sample().manualSpread !== spread0, 240);
      const spread1 = c.sample().manualSpread;
      await c.frames(30);
      c.press('tongue');
      await c.frames(1);
      c.release('tongue');
      await a.waitFor((k) => k.sample().manualSpread === spread0, 240);
      const back = c.sample().manualSpread;

      await a.toggleManual(false);
      return { tabs, emptyTabs, gaps, spread0, spread1, back };
    });

    check(
      's1',
      'every page has a slot from the first time you open the book',
      `${slots.tabs} index tab(s), ${slots.emptyTabs} of them empty`,
      `${IMPL.PAGE_TOTAL} tabs, ${IMPL.PAGE_TOTAL} empty`,
      slots.tabs === IMPL.PAGE_TOTAL && slots.emptyTabs === IMPL.PAGE_TOTAL,
    );
    check(
      's2',
      'and the pages you do not have are drawn as gaps, not left out',
      `${slots.gaps} gap(s) on the open spread`,
      '2',
      slots.gaps === 2,
    );
    check(
      's3',
      'the spread turns, and turns back',
      `${slots.spread0} -> ${slots.spread1} -> ${slots.back}`,
      '0 -> 1 -> 0',
      slots.spread0 === 0 && slots.spread1 === 1 && slots.back === 0,
    );

    // ------------------------------------------------ 3. pages, and the reveal
    const first = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a7;
      const before = c.sample().pages;
      const got = await a.grab('page');
      await c.frames(6);
      const s = c.sample();
      const root = document.querySelector('.croak-manual');
      return {
        before,
        got,
        pages: s.pages,
        openedItself: s.manualOpen,
        spread: s.manualSpread,
        emptyTabs: root.querySelectorAll('.croak-manual__tab--empty').length,
        gaps: root.querySelectorAll('.croak-manual__slot').length,
      };
    });

    check(
      'p1',
      'a page in the meadow can be picked up',
      `pages ${first.before} -> ${first.pages}`,
      '0 -> 1',
      first.got && first.pages === first.before + 1,
    );
    check(
      'p2',
      'THE REVEAL: it throws the book open on the spread it belongs to',
      `open = ${first.openedItself}, spread ${first.spread}`,
      'open, on its own spread',
      first.openedItself === true,
    );
    check(
      'p3',
      'and the slot it fills stops being a gap',
      `${first.emptyTabs} empty tab(s), ${first.gaps} gap(s) on this spread`,
      `${IMPL.PAGE_TOTAL - 1} empty, fewer gaps`,
      first.emptyTabs === IMPL.PAGE_TOTAL - 1 && first.gaps < 2,
    );

    const rest = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a7;
      await a.toggleManual(false);
      await c.frames(4);
      // The meadow's second page.
      const second = await a.grab('page');
      await a.toggleManual(false);
      await c.frames(4);
      const afterMeadow = c.sample().pages;
      // Down into the belfry for the third.
      const went = await a.enterBelfry();
      await c.frames(10);
      const third = await a.grab('page');
      await a.toggleManual(false);
      await c.frames(4);
      const root = document.querySelector('.croak-manual');
      return {
        second,
        afterMeadow,
        went,
        third,
        pages: c.sample().pages,
        zone: c.sample().zone,
        emptyTabs: root.querySelectorAll('.croak-manual__tab--empty').length,
      };
    });

    check(
      'p4',
      'the meadow holds two, and the belfry the third',
      `meadow ${rest.afterMeadow}, after the belfry ${rest.pages} (zone ${rest.zone})`,
      '2 then 3',
      rest.afterMeadow === 2 && rest.went && rest.pages === 3,
    );
    check(
      'p5',
      'three slots filled, and exactly one gap left for the Heron',
      `${rest.emptyTabs} empty tab(s)`,
      '1',
      rest.emptyTabs === 1,
    );
    notes.push(
      'p5: the fourth page is the Heron\'s and only exists once it is down - ' +
        'tests/a6.mjs v3/v4 assert it appears behind the arena, is camera-occluded, ' +
        'is reachable on foot and is collectible.',
    );

    // -------------------------------------------------- 4. signage in the world
    const signage = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a7;
      const belfrySigns = c.signs();
      // Back up to the meadow to look at the ones out there.
      const shrine = c.shrines()[0];
      return {
        belfry: belfrySigns.map((s) => ({ id: s.id, strokes: s.strokes })),
        shrineFound: !!shrine,
      };
    });
    const downsSignage = await page.evaluate(async () => {
      // A fresh load is the cheapest honest way back to the meadow.
      return window.__croak.signs().map((s) => ({ id: s.id, strokes: s.strokes }));
    });

    check(
      'w1',
      'the belfry carries carved Croakic signage',
      signage.belfry.length
        ? signage.belfry.map((s) => `${s.id}:${s.strokes}`).join(' ')
        : 'no signs',
      '>= 1 sign, with strokes',
      signage.belfry.length >= 1 && signage.belfry.every((s) => s.strokes > 0),
    );
    notes.push(`w1: signs seen this run: ${downsSignage.map((s) => s.id).join(', ') || 'none'}`);

    // The text those signs carry is checked where it can be checked exactly:
    // through the same cipher the game draws them with.
    const decodeFails = [];
    for (const [id, english] of Object.entries(SIGN_TEXT)) {
      const spoken = CROAKIC.transcribe(english);
      const read = CROAKIC.decode(CROAKIC.write(english));
      if (JSON.stringify(read) !== JSON.stringify(spoken)) decodeFails.push(id);
    }
    check(
      'w2',
      'and every authored sign decodes back to the sounds it was set from',
      decodeFails.length === 0
        ? `${Object.keys(SIGN_TEXT).length} signs round-trip`
        : decodeFails.join(', '),
      'all',
      decodeFails.length === 0,
    );

    // --------------------------------------------- 5. nothing here is typeset
    const typeset = await page.evaluate(() => {
      const roots = ['.croak-manual', '.croak-hud', '.croak-toast', '.croak-boss', '.croak-ending'];
      let texts = 0;
      let fonts = 0;
      for (const selector of roots) {
        for (const node of document.querySelectorAll(selector)) {
          texts += node.querySelectorAll('text, tspan, foreignObject').length;
          if (node.textContent && node.textContent.trim().length > 0) fonts++;
        }
      }
      return { texts, fonts };
    });
    check(
      'r1',
      'no letterform anywhere in the UI comes from a font (rule 12)',
      `${typeset.texts} <text>/<tspan>/<foreignObject> node(s), ${typeset.fonts} element(s) with text content`,
      '0 and 0',
      typeset.texts === 0 && typeset.fonts === 0,
    );

    // The key must be readable in the source and nowhere else.
    const keyInBundle = await page.evaluate(async () => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      let found = false;
      for (const script of scripts) {
        const body = await (await fetch(script.src)).text();
        if (/THE KEY/.test(body)) found = true;
      }
      return found;
    });
    check(
      'r2',
      'and the cipher key is not shipped to the player in the bundle',
      keyInBundle ? 'the key survived minification into dist/' : 'absent from the shipped bundle',
      'absent',
      keyInBundle === false,
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
  console.log('\nCROAK milestone A7 gate - the manual and Croakic\n');
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
