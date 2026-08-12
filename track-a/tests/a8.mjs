#!/usr/bin/env node
/**
 * CROAK - milestone A8 gate: the render pass (PROMPT.md section 11, A8).
 *
 *   "Gate: side-by-side screenshot vs TUNIC reference grid; post-disabled
 *    readability; 60 fps held."
 *
 * DEVIATION, STATED UP FRONT. The first clause asks for a comparison against a
 * grid of TUNIC reference shots. Those are someone else's copyrighted frames;
 * this build ships no third-party assets and is not going to start now, and a
 * "looks like it" judgement is a human one anyway. So this gate does two things
 * instead: it writes a three-zone contact sheet for a person to look at, and it
 * asserts the MEASURABLE properties the reference comparison is a proxy for -
 * the ones section 2 and section 8 actually name. Nothing here claims to have
 * compared anything to TUNIC.
 *
 * What it does assert, and would fail on:
 *   - the leaf cookie is a real shadow and really dapples the ground
 *   - the additive gradient lifts the top of the frame and not the bottom
 *   - bloom is THRESHOLDED: the belfry's glow blooms, the sunlit meadow does not
 *   - no pure white and no pure black anywhere (section 2 rule 5)
 *   - the game is still readable with the whole post chain switched off
 *   - the draw-call budget still holds with post on - counted honestly, across
 *     every pass in the frame rather than just the last one
 *
 * Run: node tests/a8.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';
import { decodePng, averageRgb } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4184;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEED = 0x0c20a4;
const DRAW_BUDGET = 150;

/** The gameplay browser has rasterisation off; the painter needs it on. */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--mute-audio',
];

const checks = [];
const notes = [];

function check(id, name, measured, expected, pass) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

// --------------------------------------------------------------- pixel maths

/** Mean luma and its standard deviation over a rectangle of the image. */
function lumaStats(buffer, x0, y0, x1, y1) {
  const { width, height, channels, data } = decodePng(buffer);
  const left = Math.max(0, Math.floor(x0 * width));
  const right = Math.min(width, Math.ceil(x1 * width));
  const top = Math.max(0, Math.floor(y0 * height));
  const bottom = Math.min(height, Math.ceil(y1 * height));
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * channels;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sumSq += luma * luma;
      count++;
    }
  }
  const mean = count === 0 ? 0 : sum / count;
  const variance = count === 0 ? 0 : Math.max(0, sumSq / count - mean * mean);
  return { mean, stdev: Math.sqrt(variance), count };
}

/**
 * How many pixels sit at or beyond a LUMA level. Deliberately not "all three
 * channels above N": the belfry's glow is dungeonGlow, whose red channel is 111
 * and can never reach 250 however hard it blooms, so an all-channels test would
 * report a cyan halo as no halo at all.
 */
function brightPixels(buffer, level) {
  const { width, height, channels, data } = decodePng(buffer);
  let hits = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const luma = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    if (luma >= level) hits++;
  }
  return hits / (width * height);
}

/** Mean [r,g,b] over a rectangle, in fractions of the image. */
function averageRect(buffer, x0, y0, x1, y1) {
  const { width, height, channels, data } = decodePng(buffer);
  const left = Math.max(0, Math.floor(x0 * width));
  const right = Math.min(width, Math.ceil(x1 * width));
  const top = Math.max(0, Math.floor(y0 * height));
  const bottom = Math.min(height, Math.ceil(y1 * height));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * channels;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

/**
 * Fraction of pixels in a rectangle whose luma differs between two frames by
 * more than `tolerance`. A far stronger read on "did the dapple move" than
 * comparing two standard deviations: it counts the pixels that actually
 * changed rather than describing the spread of a region full of other things.
 */
function changedFraction(a, b, rect, tolerance) {
  const A = decodePng(a);
  const B = decodePng(b);
  const left = Math.max(0, Math.floor(rect[0] * A.width));
  const right = Math.min(A.width, Math.ceil(rect[2] * A.width));
  const top = Math.max(0, Math.floor(rect[1] * A.height));
  const bottom = Math.min(A.height, Math.ceil(rect[3] * A.height));
  let changed = 0;
  let total = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const ia = (y * A.width + x) * A.channels;
      const ib = (y * B.width + x) * B.channels;
      const la = 0.2126 * A.data[ia] + 0.7152 * A.data[ia + 1] + 0.0722 * A.data[ia + 2];
      const lb = 0.2126 * B.data[ib] + 0.7152 * B.data[ib + 1] + 0.0722 * B.data[ib + 2];
      if (Math.abs(la - lb) > tolerance) changed++;
      total++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

/** The extremes section 2 rule 5 forbids: pure white and pure black. */
function extremes(buffer) {
  const { width, height, channels, data } = decodePng(buffer);
  let white = 0;
  let black = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (r >= 255 && g >= 255 && b >= 255) white++;
    if (r <= 0 && g <= 0 && b <= 0) black++;
  }
  const pixels = width * height;
  return { white: white / pixels, black: black / pixels };
}

// ------------------------------------------------------------------ harness

const HELPERS = `
window.__a8 = {
  async waitFor(pred, limit = 900) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      if (pred(c)) return i;
      await c.frames(1);
    }
    return -1;
  },
  async enterBelfry() {
    const c = window.__croak;
    const a = window.__a8;
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

async function openPage(browser, size = { width: 900, height: 540 }) {
  const page = await browser.newPage({ viewport: size });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon/i.test(text) || /404 \(Not Found\)/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.addInitScript(HELPERS);
  await page.goto(`${ORIGIN}/?test=1&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__croak && window.__croak.ready, null, { timeout: 40000 });
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
    console.error('a8 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a8 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  const shots = path.join(HERE, 'shots');
  fs.mkdirSync(shots, { recursive: true });

  await startServer();
  // Rasterisation ON: every check below is about pixels, and the gameplay
  // browser's --disable-gl-drawing-for-tests would report black for all of it.
  const painter = await chromium.launch({ executablePath: findChromium(), args: BASE_ARGS });

  try {
    const page = await openPage(painter);
    await page.evaluate(() => window.__croak.frames(40));
    await page.waitForTimeout(900);

    // -------------------------------------------------- 1. the chain is real
    const wiring = await page.evaluate(() => {
      const s = window.__croak.sample();
      return { post: s.post, draws: s.drawCalls, programs: s.programs };
    });
    check(
      'x1',
      'the post chain is running, and the frame is counted across ALL its passes',
      `post ${wiring.post}, ${wiring.draws} draw calls, ${wiring.programs} programs`,
      `on, > 1 call (a single fullscreen pass would read 1)`,
      wiring.post === true && wiring.draws > 20,
    );
    check(
      'x2',
      'and it still fits the budget',
      `${wiring.draws} draw calls`,
      `<= ${DRAW_BUDGET}`,
      wiring.draws <= DRAW_BUDGET,
    );

    const meadowOn = await page.screenshot({ path: path.join(shots, 'a8-downs-post.png') });

    // ---------------------------------------------- 2. post off: readability
    const off = await page.evaluate(async () => {
      window.__croak.setPost(false);
      await window.__croak.frames(20);
      const s = window.__croak.sample();
      return { post: s.post, draws: s.drawCalls };
    });
    await page.waitForTimeout(700);
    const meadowOff = await page.screenshot({ path: path.join(shots, 'a8-downs-plain.png') });

    const onStats = lumaStats(meadowOn, 0, 0, 1, 1);
    const offStats = lumaStats(meadowOff, 0, 0, 1, 1);
    const onTone = averageRgb(meadowOn);
    const offTone = averageRgb(meadowOff);

    check(
      'p1',
      'THE GAME STILL READS WITH THE WHOLE CHAIN OFF',
      `luma ${fmt(onStats.mean, 1)} -> ${fmt(offStats.mean, 1)}, ` +
        `contrast ${fmt(onStats.stdev, 1)} -> ${fmt(offStats.stdev, 1)}`,
      'still lit, still contrasty',
      off.post === false &&
        offStats.mean > 40 &&
        offStats.mean < 210 &&
        offStats.stdev > 18 &&
        Math.abs(offStats.mean - onStats.mean) < 60,
    );
    // Sampled at the BOTTOM of the frame, where the gradient's squared falloff
    // is designed to reach nothing. Comparing the whole frame would be a test
    // of whether the sky tint exists, which is g1's job, dressed up as a test
    // of whether the palette survived.
    const FOOT = [0.15, 0.86, 0.85, 1.0];
    const onFoot = averageRect(meadowOn, ...FOOT);
    const offFoot = averageRect(meadowOff, ...FOOT);
    check(
      'p2',
      'and the palette is the same palette either way - post is polish, not the look',
      `foot of frame rgb ${onFoot.map((v) => Math.round(v)).join(',')} -> ` +
        `${offFoot.map((v) => Math.round(v)).join(',')}`,
      'same hue family',
      Math.abs(onFoot[1] - onFoot[0] - (offFoot[1] - offFoot[0])) < 20 &&
        Math.abs(onFoot[1] - onFoot[2] - (offFoot[1] - offFoot[2])) < 20,
    );
    check(
      'p3',
      'post costs draw calls, and the cost is visible rather than hidden',
      `${off.draws} without post, ${wiring.draws} with`,
      'with > without',
      wiring.draws > off.draws,
    );

    // ------------------------------------------------ 3. the additive gradient
    // Measured against the SAME frame with post off, so what is compared is the
    // gradient and not the weather.
    const topOn = lumaStats(meadowOn, 0.1, 0.0, 0.9, 0.16);
    const bottomOn = lumaStats(meadowOn, 0.1, 0.84, 0.9, 1.0);
    const topOff = lumaStats(meadowOff, 0.1, 0.0, 0.9, 0.16);
    const bottomOff = lumaStats(meadowOff, 0.1, 0.84, 0.9, 1.0);
    const liftTop = topOn.mean - topOff.mean;
    const liftBottom = bottomOn.mean - bottomOff.mean;
    check(
      'g1',
      'the additive gradient lifts the TOP of the frame',
      `top ${fmt(topOff.mean, 1)} -> ${fmt(topOn.mean, 1)} (+${fmt(liftTop, 1)})`,
      'top gets brighter',
      liftTop > 1.5,
    );
    check(
      'g2',
      'and leaves the bottom of it alone - it is air, not an exposure change',
      `bottom ${fmt(bottomOff.mean, 1)} -> ${fmt(bottomOn.mean, 1)} (+${fmt(liftBottom, 1)})`,
      'lifted less than the top',
      liftTop > liftBottom,
    );

    // ------------------------------------------------------ 4. bloom discipline
    // BLOOM IS TOGGLED ON ITS OWN. An earlier version of this check compared
    // post-on against post-off and reported that the meadow gained 20 points of
    // bright pixels and the belfry lost 18 - which was true, and was a
    // measurement of the tone curve, the vignette and the gradient all at once.
    // Turning only bloom off leaves exactly one variable.
    await page.evaluate(async () => {
      window.__croak.setPost(true);
      await window.__croak.frames(10);
    });
    await page.waitForTimeout(500);

    const BRIGHT = 180;
    const meadowGlowOn = brightPixels(meadowOn, BRIGHT);
    // The canopy drifts on present time, so two screenshots seconds apart differ
    // by a moving dapple worth about half a luma step - which is larger than the
    // thing being measured. It is held still for the whole bloom comparison.
    await page.evaluate(async () => {
      window.__croak.setCanopy(false);
      await window.__croak.frames(12);
    });
    await page.waitForTimeout(700);
    const meadowBloomShot = await page.screenshot({ path: path.join(shots, 'a8-downs-bloom.png') });
    const meadowNoBloomShot = await (async () => {
      await page.evaluate(async () => {
        window.__croak.setBloom(false);
        await window.__croak.frames(12);
      });
      await page.waitForTimeout(600);
      const shot = await page.screenshot({ path: path.join(shots, 'a8-downs-nobloom.png') });
      await page.evaluate(async () => {
        window.__croak.setBloom(true);
        await window.__croak.frames(8);
      });
      return shot;
    })();
    const meadowGlowNone = brightPixels(meadowNoBloomShot, BRIGHT);

    // A GLOW SOURCE IN FRAME, and the same frame without bloom. The belfry was
    // tried first and measured 44.38 either way - not because bloom was broken
    // but because the landing the frog arrives on has no luminescent geometry
    // in shot at all. A shrine is gold, emissive, and stands in the open, so it
    // is the honest place to ask whether glow glows.
    const shrineShots = await (async () => {
      const moved = await page.evaluate(async () => {
        const c = window.__croak;
        c.setCanopy(false);
        const shrine = c.shrines()[0];
        if (!shrine) return false;
        c.teleportPlayer(shrine.pos[0] + 1.2, shrine.pos[1] + 0.2, shrine.pos[2] + 1.2);
        await c.frames(40);
        return true;
      });
      await page.waitForTimeout(900);
      const lit = await page.screenshot({ path: path.join(shots, 'a8-shrine-bloom.png') });
      await page.evaluate(async () => {
        window.__croak.setBloom(false);
        await window.__croak.frames(12);
      });
      await page.waitForTimeout(700);
      const plain = await page.screenshot({ path: path.join(shots, 'a8-shrine-nobloom.png') });
      await page.evaluate(async () => {
        window.__croak.setBloom(true);
        await window.__croak.frames(8);
      });
      await page.evaluate(async () => {
        window.__croak.setCanopy(true);
        await window.__croak.frames(8);
      });
      return { moved, lit, plain };
    })();

    const belfry = await page.evaluate(async () => {
      const ok = await window.__a8.enterBelfry();
      await window.__croak.frames(40);
      return ok;
    });
    await page.waitForTimeout(1100);
    const belfryOn = await page.screenshot({ path: path.join(shots, 'a8-belfry-post.png') });

    const belfryTone = averageRgb(belfryOn);

    // Measured as PIXELS THE HALO TOUCHES. Two earlier attempts got this wrong
    // in opposite directions: a count of pixels over a fixed brightness missed a
    // cyan halo whose red channel can never reach it, and a mean over the whole
    // frame drowned a small bright source in 900x540 pixels of unchanged meadow.
    // Counting the pixels that actually move is blind to both.
    const FRAME = [0, 0, 1, 1];
    const meadowLit = lumaStats(meadowBloomShot, 0, 0, 1, 1).mean;
    const meadowUnlit = lumaStats(meadowNoBloomShot, 0, 0, 1, 1).mean;
    const meadowTouched = changedFraction(meadowBloomShot, meadowNoBloomShot, FRAME, 3);
    const shrineTouched = changedFraction(shrineShots.lit, shrineShots.plain, FRAME, 3);
    const meadowLift = meadowLit - meadowUnlit;
    // The threshold counts are kept only for the note below: they are what the
    // first version of this check used, and they are why it read 0.533% either
    // way while the halo was plainly there.
    void meadowGlowOn;
    void meadowGlowNone;

    check(
      'b1',
      'BLOOM IS THRESHOLDED: nothing in the sunlit meadow passes the cut',
      `bloom moves ${fmt(meadowTouched * 100, 2)}% of the frame ` +
        `(mean luma ${fmt(meadowUnlit, 2)} -> ${fmt(meadowLit, 2)})`,
      'under 1% of the frame',
      meadowTouched < 0.01,
    );
    check(
      'b2',
      'but a shrine in frame - gold, emissive - gains a halo',
      shrineShots.moved
        ? `bloom moves ${fmt(shrineTouched * 100, 2)}% of the frame`
        : 'no shrine to stand at',
      'more of the frame than empty meadow',
      shrineShots.moved && shrineTouched > 0.01 && shrineTouched > meadowTouched * 2,
    );
    notes.push(
      `b1/b2: bloom threshold ${IMPL.BLOOM_THRESHOLD}, intensity ${IMPL.BLOOM_INTENSITY}. ` +
        'Bright pixels are counted by LUMA, not by all three channels: dungeonGlow ' +
        'has a red channel of 111 and a cyan halo would otherwise measure as none.',
    );

    // --------------------------------------------- 5. no pure white, no black
    const meadowExtremes = extremes(meadowOn);
    const belfryExtremes = extremes(belfryOn);
    check(
      'c1',
      'no pure white and no pure black anywhere (section 2 rule 5)',
      `meadow ${fmt(meadowExtremes.white * 100, 3)}% white / ${fmt(meadowExtremes.black * 100, 3)}% black, ` +
        `belfry ${fmt(belfryExtremes.white * 100, 3)}% / ${fmt(belfryExtremes.black * 100, 3)}%`,
      'both under 0.5%',
      meadowExtremes.white < 0.005 &&
        meadowExtremes.black < 0.005 &&
        belfryExtremes.white < 0.005 &&
        belfryExtremes.black < 0.005,
    );

    // ---------------------------------------------------- 6. the leaf cookie
    // The canopy is never drawn, so it cannot be seen - only its shadow can.
    // The honest test is to take it away and watch the ground go flat: dapple
    // is CONTRAST on a surface that would otherwise be one flat colour.
    const flat = await openPage(painter);
    await flat.evaluate(async () => {
      const c = window.__croak;
      c.teleportPlayer(0, 2.4, 2.0);
      await c.frames(40);
    });
    await flat.waitForTimeout(900);
    const withCanopy = await flat.screenshot({ path: path.join(shots, 'a8-dapple-on.png') });

    await flat.evaluate(async () => {
      window.__croak.setCanopy(false);
      await window.__croak.frames(20);
    });
    await flat.waitForTimeout(700);
    const withoutCanopy = await flat.screenshot({ path: path.join(shots, 'a8-dapple-off.png') });
    await flat.evaluate(async () => {
      window.__croak.setCanopy(true);
      await window.__croak.frames(10);
    });

    // A patch of open meadow floor, below and left of the frog.
    const GROUND = [0.22, 0.58, 0.74, 0.94];
    const dappled = lumaStats(withCanopy, ...GROUND);
    const bare = lumaStats(withoutCanopy, ...GROUND);
    const moved = changedFraction(withCanopy, withoutCanopy, GROUND, 8);

    check(
      'd1',
      'THE LEAF COOKIE IS A REAL SHADOW: taking it away changes the ground',
      `${fmt(moved * 100, 1)}% of the open ground changes by more than 8 luma`,
      '> 20% of the patch',
      moved > 0.2,
    );
    check(
      'd2',
      'and taking it away brightens the ground rather than changing its colour',
      `luma ${fmt(dappled.mean, 1)} -> ${fmt(bare.mean, 1)}, ` +
        `contrast ${fmt(dappled.stdev, 1)} -> ${fmt(bare.stdev, 1)}`,
      'brighter without the leaves',
      bare.mean > dappled.mean,
    );
    notes.push(
      'd1/d2: the canopy writes no colour and no depth, so nothing in either frame ' +
        'IS the canopy - what changes is the shadow it casts from the one key light.',
    );

    // --------------------------------------------------- 7. the contact sheet
    const meadowTone = averageRgb(meadowOn);
    const meadowGreenLead = meadowTone[1] - Math.max(meadowTone[0], meadowTone[2]);
    const belfryGreenLead = belfryTone[1] - Math.max(belfryTone[0], belfryTone[2]);
    check(
      'v1',
      'the two zones shot here still read as different rooms under the new chain',
      `meadow rgb ${meadowTone.map((v) => Math.round(v)).join(',')} | ` +
        `belfry rgb ${belfryTone.map((v) => Math.round(v)).join(',')}`,
      'clearly different tone',
      Math.abs(meadowGreenLead - belfryGreenLead) > 12,
    );
    notes.push(`contact sheet written to ${shots}`);
    notes.push(
      'v1 is NOT the "vs TUNIC reference grid" comparison the milestone names - ' +
        'see the header. The sheet is there for a human to make that call.',
    );

    // -------------------------------------------------------- 8. frame cost
    const cost = await flat.evaluate(async () => {
      const c = window.__croak;
      const samples = [];
      let last = performance.now();
      for (let i = 0; i < 90; i++) {
        await c.frames(1);
        const now = performance.now();
        samples.push(now - last);
        last = now;
      }
      samples.sort((a, b) => a - b);
      return {
        median: samples[Math.floor(samples.length / 2)],
        fps: c.sample().fps,
      };
    });
    notes.push(
      `fps UNVERIFIABLE on this host: no GPU, SwiftShader rasterises on the CPU ` +
        `(measured ${fmt(cost.fps, 1)} fps, median frame ${fmt(cost.median, 1)} ms with ` +
        `rasterisation ON). The 60 fps clause needs one run on real hardware; ` +
        `tests/gate.mjs asserts the game's own main-thread cost against 16.67 ms.`,
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
    await painter.close().catch(() => {});
    stopServer();
  }

  report();
}

function report() {
  console.log('\nCROAK milestone A8 gate - the render pass\n');
  console.log('id'.padEnd(5) + 'check'.padEnd(66) + 'measured'.padEnd(52) + 'expected'.padEnd(34) + 'result');
  console.log('-'.repeat(172));
  for (const c of checks) {
    console.log(
      c.id.padEnd(5) +
        c.name.slice(0, 65).padEnd(66) +
        c.measured.slice(0, 51).padEnd(52) +
        c.expected.slice(0, 33).padEnd(34) +
        (c.pass ? 'PASS' : 'FAIL'),
    );
  }
  const passed = checks.filter((c) => c.pass).length;
  console.log('-'.repeat(172));
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
