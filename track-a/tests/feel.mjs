#!/usr/bin/env node
/**
 * CROAK - THE FEEL GATE.
 *
 * PROMPT.md section 10: "Feel gate (numbers are checkable): roll i-frames
 * measured by scripted overlap test; hitstop/shake/knockback assert against
 * section 5 constants; input buffer verified by scripted 140 ms-early press."
 *
 * This file proves the section 5 numbers are IMPLEMENTED, not merely written
 * down. Nothing here reads a number out of the game and prints it back: every
 * row of the table is measured from the running build through `window.__croak`
 * (the ?test=1 harness), against two independent sources of truth:
 *
 *   SPEC - the numbers typed into PROMPT.md section 5, hardcoded below.
 *   IMPL - src/core/constants.ts, imported directly (node strips the types).
 *
 * Check 0 asserts SPEC == IMPL, so a constants file that drifts from the spec
 * fails the gate even if the engine implements the constants faithfully.
 *
 * HARNESS ENVIRONMENT - stated, because these numbers are timing numbers:
 *   - There is no GPU here; Chromium rasterises through SwiftShader, which
 *     renders this scene (2048 shadow map + MSAA) at ~12 fps and would pace the
 *     rAF loop far below the fixed step. The game's own CPU work is 1.2 ms per
 *     frame, so the harness runs Chromium with --disable-gl-drawing-for-tests:
 *     every draw call is still issued, counted and culled in JS, only the
 *     rasterisation is skipped. Nothing about the simulation changes.
 *   - Two environments, because different checks want different clocks:
 *       FAST   uncapped rAF (~1 kHz). The fixed-step accumulator never
 *              clamps, so sim time tracks wall time exactly, and a press can be
 *              injected at a chosen wall-clock offset to ~1 ms - which is the
 *              only way to run the "140 ms early" press the spec asks for
 *              instead of rounding it to the nearest 16.7 ms frame.
 *       V60    vsync-locked 60 fps, one sim step per rendered frame: the
 *              shipping frame rate, used to re-confirm the three checks that
 *              are about wall-clock feel (response, buffer, hitstop).
 *   - Every verb goes through the real input system (injectPress) and every hit
 *     through the real Player.takeHit. There is no path into the state machines
 *     that skips game logic.
 *
 * Run: node tests/feel.mjs      (needs a current dist/: npm run build)
 * Exits non-zero if any check fails.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 640, height: 360 };

const TICK = 1 / 60;
/** The loop's own spiral guard: a frame longer than this loses simulation time. */
const MAX_FRAME_TIME = TICK * IMPL.MAX_STEPS_PER_FRAME;

// --------------------------------------------------------------------- spec
// PROMPT.md section 5, transcribed by hand. Frames at 60 fps.

const SPEC = {
  MOVE_SPEED: 5.0,
  ROLL_DURATION_F: 26,
  // Frame indices are 0-based, so frame 0 IS the commit frame. i-frames open on
  // it (the Souls rule) and cover 14 of the roll's 26 frames: 0..13.
  ROLL_IFRAME_FIRST_F: 0,
  ROLL_IFRAME_LAST_F: 13,
  ROLL_IFRAME_COUNT_F: 14,
  ROLL_DISTANCE: 3.0,
  ROLL_STAMINA: 0.27,
  STAMINA_REGEN_DELAY: 0.8,
  STAMINA_REGEN_DELAY_EMPTY: 1.5,
  ZERO_STAMINA_DMG_MULT: 1.5,
  INPUT_BUFFER_F: 9,
  LIGHT_WINDUP_F: 7,
  LIGHT_ACTIVE_F: 5,
  LIGHT_RECOVERY_F: 12,
  ENEMY_TELEGRAPH_MIN_F: 36,
  HITSTOP_LIGHT_F: 4,
  SHAKE_DECAY: 1.2,
  SHAKE_CAP: 1.0,
  TRAUMA_PLAYER_HURT: 0.4,
};

/** First frame of a light attack on which a roll may cancel it. */
const CANCEL_F = Math.round(
  (IMPL.LIGHT_ATK.windup + IMPL.LIGHT_ATK.active + IMPL.LIGHT_ATK.rollCancelFrom) * 60,
);

/** Flat plateau top (level.ts PLATEAU: y=2.4, 10x9 u), 20 u from every enemy. */
const PLATEAU = { x: -10, y: 2.45, z: -8 };
/**
 * The duel: a prop-free meadow spot far enough from the spawn crowd that only
 * the nearest sporeling is inside its aggro range and comes over alone.
 */
const DUEL = { x: 6, z: 3 };

// ------------------------------------------------------------------- checks

const checks = [];
const notes = [];

function check(id, name, measured, expected, pass, note) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
  if (note) notes.push(`${id}: ${note}`);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : String(n));
const ms = (s) => `${(s * 1000).toFixed(1)} ms`;

// ------------------------------------------------------------ in-page tools

/**
 * Helpers live in the page so a poll loop costs one rAF tick instead of one CDP
 * round trip. They only ever touch the public __croak surface.
 */
const HELPERS = `
window.__h = {
  step(s) { return Math.round(((s || window.__croak.sample()).simTime) * 60); },
  async frame() { await window.__croak.frames(1); return window.__croak.sample(); },
  async until(pred, maxSec) {
    const limit = maxSec === undefined ? 20 : maxSec;
    const t0 = window.__croak.sample().presentTime;
    for (;;) {
      const s = await this.frame();
      if (pred(s)) return s;
      if (s.presentTime - t0 > limit) {
        throw new Error('feel: until() timed out after ' + limit + 's, last=' + JSON.stringify(s));
      }
    }
  },
  untilStep(n, maxSec) { return this.until((s) => this.step(s) >= n, maxSec); },
  steps(n, maxSec) { return this.untilStep(this.step() + n, maxSec); },
  /** Free, vulnerable, unfrozen: the only safe place to start a measurement. */
  free(maxSec) {
    return this.until(
      (s) => s.playerState === 'idle' && !s.invulnerable && s.hitstopRemaining === 0,
      maxSec,
    );
  },
  async park(p) {
    window.__croak.setMove(0, 0);
    window.__croak.teleportPlayer(p.x, p.y, p.z);
    await this.until((s) => s.grounded && s.playerState === 'idle', 10);
    await this.steps(4);
  },
  /**
   * One buffered-roll-cancel trial. Starts a light attack, injects a roll
   * press the requested amount before the first legally cancellable frame,
   * and reports whether it survived - plus the age the press ACTUALLY had
   * when the game looked at it, on the same clock the input system ages on.
   */
  async bufferTrial(cancelF, early) {
    const c = window.__croak;
    await this.free(12);
    c.startTrace();
    c.press('attack');
    const a = await this.until((s) => s.playerState === 'attack', 3);
    c.release('attack');
    const attackStep = this.step(a);
    const cancelStep = attackStep + cancelF;

    let p;
    if (early.frames !== undefined) {
      // Frame-quantised variant for the locked-60 environment.
      p = await this.untilStep(cancelStep - early.frames, 3);
    } else {
      p = await this.until((s) => s.presentTime >= a.presentTime + cancelF / 60 - early.ms / 1000, 3);
    }
    c.press('roll');
    const pressTime = p.presentTime;
    const pressStep = this.step(p);

    let cancelTime = null;
    let fired = false;
    let firedStep = null;
    await this.until((s) => {
      if (cancelTime === null && this.step(s) >= cancelStep) cancelTime = s.presentTime;
      if (s.playerState === 'roll') {
        fired = true;
        firedStep = this.step(s);
        return true;
      }
      return this.step(s) >= attackStep + 40;
    }, 4);
    c.release('roll');
    c.stopTrace();
    // Which attack frame the roll actually started on comes from the per-STEP
    // trace, not from the step counter at the end of a rendered frame: one
    // frame can carry two steps, and that would misreport the cancel frame.
    const trace = c.trace();
    let firstAttack = -1;
    let firstRoll = -1;
    for (let i = 0; i < trace.length; i++) {
      if (firstAttack < 0 && trace[i].playerState === 'attack') firstAttack = i;
      if (firstAttack >= 0 && firstRoll < 0 && trace[i].playerState === 'roll') firstRoll = i;
    }
    const offset = firstRoll < 0 ? null : firstRoll - firstAttack;
    await this.until((s) => s.playerState === 'idle', 6);
    return {
      label: early.frames !== undefined ? early.frames + ' f' : early.ms + ' ms',
      ageMs: cancelTime === null ? null : (cancelTime - pressTime) * 1000,
      fired,
      pressedDuringAttack: pressStep >= attackStep,
      firedAtCancelFrame: fired && offset === cancelF,
      cancelOffsetF: offset,
      firedStepOffset: fired ? firedStep - attackStep : null,
    };
  },
  /**
   * Per-frame film of a landed hit: hitstop, trauma decay, hp. It films a
   * quiet stretch FIRST - a hitstop is a gap between two simulation steps, so
   * the freeze is only measurable against a step that came before it.
   */
  async filmHit(seconds) {
    const c = window.__croak;
    const film = [];
    const snap = (s) => ({
      p: s.presentTime, sim: s.simTime, fc: s.frameCount,
      tr: s.trauma, hs: s.hitstopRemaining, hp: s.hp, st: s.playerState,
    });
    const t0 = c.sample().presentTime;
    for (let i = 0; i < 20000; i++) {
      const s = await this.frame();
      film.push(snap(s));
      if (s.presentTime - t0 > 0.2) break;
    }
    const before = c.sample();
    const landed = c.probeHit(1);
    const hitAt = before.presentTime;
    for (let i = 0; i < 20000; i++) {
      const s = await this.frame();
      film.push(snap(s));
      if (s.presentTime - hitAt > seconds) break;
    }
    return { hpBefore: before.hp, hpAfter: c.sample().hp, landed, hitAt, film };
  },
};
`;

// -------------------------------------------------------------------- setup

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
    // Own process group, and the real vite entry point rather than an npx
    // wrapper: killing the wrapper would leave the server holding the port.
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
      const text = String(d);
      if (/error|EADDRINUSE/i.test(text)) done(new Error('vite preview: ' + text.trim()));
    });
    server.on('exit', (code) => done(new Error('vite preview exited with ' + code)));
  });
}

function stopServer() {
  if (server && server.exitCode === null) {
    try {
      process.kill(-server.pid, 'SIGKILL'); // the whole group, not just the shell
    } catch {
      try {
        server.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  server = null;
}

process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}

const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  // Issue and count every draw, rasterise none of them: the sim is untouched
  // and the rAF loop stops being paced by a software rasteriser.
  '--disable-gl-drawing-for-tests',
];

const launchFast = (exe) =>
  chromium.launch({
    executablePath: exe,
    args: [...GL_ARGS, '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });

const launch60 = (exe) => chromium.launch({ executablePath: exe, args: GL_ARGS });

const pageErrors = [];
const consoleErrors = [];

async function openPage(browser, query) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // The preview server serves no favicon; that 404 is the server's, not the build's.
    if (/favicon/i.test(text) || /404 \(Not Found\)/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.addInitScript(HELPERS);
  await page.goto(`${ORIGIN}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__croak && window.__croak.ready, null, { timeout: 30000 });
  return page;
}

/**
 * Frame pacing of the page, so the table can say what clock it measured on -
 * and so a machine too busy to keep the fixed-step accumulator off its clamp
 * is reported rather than silently believed. Up to three windows are taken and
 * the healthiest is kept: one scheduling hiccup on a shared box says nothing
 * about what the environment is capable of.
 */
async function measurePacing(page) {
  return page.evaluate(
    async ({ plateau, maxFrameTime }) => {
      const c = window.__croak;
      const h = window.__h;
      // Away from the sporelings: a hitstop is a legitimate stall of sim time
      // and would read here as the accumulator falling behind the wall clock.
      await h.park(plateau);
      let best = null;
      for (let w = 0; w < 3; w++) {
        const a = c.sample();
        let prev = a;
        let maxFrame = 0;
        let overruns = 0;
        for (;;) {
          const s = await h.frame();
          const dt = s.presentTime - prev.presentTime;
          if (dt > maxFrame) maxFrame = dt;
          if (dt > maxFrameTime) overruns++;
          prev = s;
          // Seconds long on purpose: a step is 16.7 ms, and a short window
          // would report its own quantisation instead of the drift.
          if (s.presentTime - a.presentTime > 2) break;
        }
        const r = {
          frameMs: ((prev.presentTime - a.presentTime) / (prev.frameCount - a.frameCount)) * 1000,
          simVsWall: (prev.simTime - a.simTime) / (prev.presentTime - a.presentTime),
          maxFrameMs: maxFrame * 1000,
          overruns,
        };
        if (best === null || Math.abs(r.simVsWall - 1) < Math.abs(best.simVsWall - 1)) best = r;
        if (Math.abs(best.simVsWall - 1) < 0.01) break;
      }
      return best;
    },
    { plateau: PLATEAU, maxFrameTime: MAX_FRAME_TIME },
  );
}

// =====================================================================
// SCENARIOS
// =====================================================================

/** One clean roll on flat ground, then 110 idle steps to watch stamina come back. */
async function scenarioRoll(page) {
  return page.evaluate(async ({ plateau }) => {
    const c = window.__croak;
    const h = window.__h;
    await h.park(plateau);
    await h.until((s) => s.stamina >= 0.999, 12);
    c.startTrace();
    await h.steps(4);
    c.setMove(0, -1); // camera-relative "up"; the plateau is flat either way
    c.press('roll');
    await h.until((s) => s.playerState === 'roll', 3);
    c.release('roll');
    c.setMove(0, 0);
    await h.until((s) => s.playerState !== 'roll', 3);
    await h.steps(110, 10);
    const trace = c.trace();
    c.stopTrace();
    return trace;
  }, { plateau: PLATEAU });
}

/** Press -> state change, from a standing start. */
async function scenarioLatency(page) {
  return page.evaluate(async ({ plateau }) => {
    const c = window.__croak;
    const h = window.__h;
    const out = [];
    for (const action of ['roll', 'attack']) {
      await h.park(plateau);
      await h.free(12);
      const before = c.sample();
      c.press(action);
      const after = await h.until((s) => s.playerState === action, 3);
      c.release(action);
      out.push({
        action,
        seconds: after.presentTime - before.presentTime,
        frames: after.frameCount - before.frameCount,
        steps: h.step(after) - h.step(before),
      });
      await h.until((s) => s.playerState === 'idle', 6);
    }
    return out;
  }, { plateau: PLATEAU });
}

/** Cardinals vs diagonals: the classic sqrt(2) bug. */
async function scenarioSpeeds(page) {
  return page.evaluate(async ({ plateau }) => {
    const c = window.__croak;
    const h = window.__h;
    const out = [];
    const dirs = [
      ['cardinal 0,-1', 0, -1],
      ['cardinal 1,0', 1, 0],
      ['diagonal 1,1', 1, 1],
      ['diagonal 1,-1', 1, -1],
      ['diagonal -1,1', -1, 1],
      ['diagonal -1,-1', -1, -1],
    ];
    for (const [label, mx, mz] of dirs) {
      await h.park(plateau);
      c.setMove(mx, mz);
      await h.steps(14); // ACCEL_TIME is 4 f; this is well past full speed
      const a = c.sample();
      await h.steps(18);
      const b = c.sample();
      c.setMove(0, 0);
      out.push({
        label,
        speed: Math.hypot(b.playerPos[0] - a.playerPos[0], b.playerPos[2] - a.playerPos[2]) /
          (b.simTime - a.simTime),
        dy: Math.abs(b.playerPos[1] - a.playerPos[1]),
        grounded: a.grounded && b.grounded,
      });
    }
    return out;
  }, { plateau: PLATEAU });
}

async function scenarioBuffer(page, trials) {
  return page.evaluate(async ({ plateau, cancelF, trials }) => {
    const h = window.__h;
    const out = [];
    for (const early of trials) {
      await h.park(plateau);
      out.push(await h.bufferTrial(cancelF, early));
    }
    return out;
  }, { plateau: PLATEAU, cancelF: CANCEL_F, trials });
}

/** THE HEADLINE GATE: one roll per probed frame, damage attempted on each. */
async function scenarioIframes(page, maxFrame) {
  return page.evaluate(async ({ plateau, maxFrame }) => {
    const c = window.__croak;
    const h = window.__h;

    async function attempt(target, damage) {
      // One probe per roll: a landed probe sets PLAYER_IFRAMES_AFTER_HIT and
      // ends the roll, so a second probe inside the same roll would measure the
      // hit reaction instead of the roll.
      await h.free(14);
      await h.park(plateau);
      await h.free(14);
      c.startTrace();
      await h.steps(3);
      c.press('roll');
      const started = await h.until((s) => s.playerState === 'roll', 3);
      c.release('roll');
      if (target > 0) await h.untilStep(h.step(started) + target, 3);
      const before = c.sample();
      const landed = c.probeHit(damage);
      c.stopTrace();
      const after = c.sample();

      const trace = c.trace();
      let first = -1;
      let last = -1;
      for (let i = 0; i < trace.length; i++) {
        if (trace[i].playerState !== 'roll') continue;
        if (first < 0) first = i;
        last = i;
      }
      return {
        target,
        // The frog's stateTime when the probe reached it, in roll frames. Read
        // back from the trace, never assumed from the request.
        frame: last - first,
        landed,
        invulnerableFlag: before.invulnerable,
        state: before.playerState,
        hpBefore: before.hp,
        hpAfter: after.hp,
      };
    }

    /**
     * If a rendered frame happened to carry two simulation steps the probe
     * lands one roll frame late, which would leave a hole in the sweep. Retry
     * until the probe hits the frame it was aimed at; the row still reports the
     * frame it ACTUALLY landed on.
     */
    async function oneProbe(target, damage) {
      let row = null;
      for (let tries = 0; tries < 4; tries++) {
        row = await attempt(target, damage);
        if (row.frame === target) return row;
      }
      return row;
    }

    const rows = [];
    // damage 0: the i-frame gate is the FIRST thing takeHit() tests, so the
    // return value IS the gate - and the frog survives 26 consecutive probes.
    for (let target = 0; target <= maxFrame; target++) rows.push(await oneProbe(target, 0));
    // Damage-carrying spot checks, to prove that boolean really is damage.
    const verified = [];
    for (const target of [0, 7, 20]) verified.push(await oneProbe(target, 1));
    return { rows, verified };
  }, { plateau: PLATEAU, maxFrame });
}

/** Stamina economy, the zero-stamina forgiveness rule, and its damage cost. */
async function scenarioStamina(page) {
  return page.evaluate(async ({ plateau }) => {
    const c = window.__croak;
    const h = window.__h;
    const out = {};

    await h.park(plateau);
    await h.until((s) => s.stamina >= 0.999, 12);

    // ------------------------------------ hit #1: full bar, unmultiplied
    out.normalHit = await h.filmHit(0.9);

    // ------------------------------------------------ drain the bar dry
    await h.free(14);
    await h.park(plateau);
    out.rolls = [];
    for (let i = 0; i < 5; i++) {
      await h.free(14);
      const before = c.sample();
      c.press('roll');
      const started = await h.until((s) => s.playerState === 'roll', 3);
      c.release('roll');
      out.rolls.push({
        i,
        staminaBefore: before.stamina,
        staminaAfter: started.stamina,
        zeroPenaltyDuring: started.zeroStaminaPenalty,
        state: started.playerState,
        rolled: started.playerState === 'roll',
      });
      await h.until((s) => s.playerState !== 'roll', 3);
    }

    // ------------------------------- hit #2: empty bar, x1.5 damage taken
    const dry = await h.free(14);
    const before2 = c.sample();
    const landed = c.probeHit(1);
    const after2 = c.sample();
    out.zeroHit = {
      stamina: before2.stamina,
      zeroPenalty: before2.zeroStaminaPenalty,
      hpBefore: before2.hp,
      hpAfter: after2.hp,
      landed,
      dryState: dry.playerState,
    };
    return out;
  }, { plateau: PLATEAU });
}

/** Sporeling telegraph, then a trauma burst to test the shake ceiling. */
async function scenarioEnemy(page) {
  return page.evaluate(async ({ duel }) => {
    const c = window.__croak;
    const h = window.__h;
    const out = {};

    // Stand off in the meadow, inside exactly one sporeling's aggro range, and
    // let it walk in. It stops at SPORELING.attackRange, so holding the frog on
    // one spot holds the engagement to one geometry - the enemy never has to
    // re-approach, and the camera, which follows the frog, stops moving.
    c.setMove(0, 0);
    c.teleportPlayer(duel.x, 2.0, duel.z);
    await h.until((s) => s.grounded, 10);
    await h.steps(30);

    // The sporeling's tell shell is a mesh that is only in the scene during
    // telegraph+attack, and its landing dust is a batch that only becomes
    // visible on the first frame of the burst. So three's own draw-call counter
    // shows the windup as a two-rung ladder - +1 when the tell appears, +1 when
    // the burst starts - and the second rung is verifiable independently: it
    // must land exactly one step before the damage.
    const events = [];
    let prev = c.sample();
    const t0 = prev.presentTime;
    let airborne = 0;
    events.push({ st: h.step(prev), dc: prev.drawCalls, hp: prev.hp, p: prev.presentTime });
    for (let i = 0; i < 200000; i++) {
      const s = await h.frame();
      // Horizontal pin only, at whatever height the solver settled on: the
      // knockback is undone without ever taking the frog off the ground, so no
      // landing dust of the frog's own can enter the count, and the camera
      // (which follows the frog) never moves.
      c.teleportPlayer(duel.x, s.playerPos[1], duel.z);
      if (!s.grounded) airborne++;
      if (s.drawCalls !== prev.drawCalls || s.hp !== prev.hp) {
        events.push({ st: h.step(s), dc: s.drawCalls, hp: s.hp, p: s.presentTime });
      }
      prev = s;
      if (s.presentTime - t0 > 12 || s.hp <= 2) break;
    }
    out.telegraph = { events, airborne, hp: c.sample().hp };

    // ------------------------------------------------ trauma burst + cap
    let maxTrauma = 0;
    const burstStart = c.sample().presentTime;
    for (let i = 0; i < 200000; i++) {
      const s = await h.frame();
      maxTrauma = Math.max(maxTrauma, s.trauma);
      if (s.playerState === 'idle' || s.playerState === 'move') c.press('attack');
      else c.release('attack');
      if (s.presentTime - burstStart > 5) break;
    }
    c.release('attack');
    c.setMove(0, 0);

    // Everything must come back to a dead stop: no undecaying screenshake.
    let settled = c.sample();
    const quiet = settled.presentTime;
    for (let i = 0; i < 200000; i++) {
      const s = await h.frame();
      maxTrauma = Math.max(maxTrauma, s.trauma);
      settled = s;
      if (s.presentTime - quiet > 3) break;
    }
    out.burst = {
      maxTrauma,
      finalTrauma: settled.trauma,
      hp: settled.hp,
      state: settled.playerState,
    };
    return out;
  }, { duel: DUEL });
}

/**
 * Determinism. D1 is the spawn brawl with no input at all - pure seed plus step
 * count. D2 is a scripted input sequence on the plateau. Everything that mutates
 * state happens on an ABSOLUTE simulation step, so the two runs are comparable
 * step for step no matter how the wall clock behaved.
 */
async function scenarioDeterminism(page) {
  return page.evaluate(async ({ plateau }) => {
    const c = window.__croak;
    const h = window.__h;
    const out = {};

    out.startStep = h.step();
    c.startTrace();
    await h.steps(150, 20);
    out.d1 = { trace: c.trace() };
    c.stopTrace();

    const TP = 240;
    out.lateStart = h.step() > TP;
    await h.untilStep(TP, 20);
    c.setMove(0, 0);
    c.teleportPlayer(plateau.x, plateau.y, plateau.z);

    await h.untilStep(TP + 30, 10);
    c.startTrace();
    const acts = [];
    const at = async (step, fn, label) => {
      await h.untilStep(step, 10);
      fn();
      acts.push({ a: label, step: h.step() });
    };
    await at(TP + 60, () => c.setMove(1, 0), 'move');
    await at(TP + 90, () => c.press('roll'), 'roll');
    await at(TP + 92, () => c.release('roll'), 'rollUp');
    await at(TP + 130, () => c.setMove(0, 0), 'stop');
    await at(TP + 150, () => c.press('attack'), 'attack');
    await at(TP + 152, () => c.release('attack'), 'attackUp');
    await h.untilStep(TP + 240, 15);
    out.d2 = { acts, trace: c.trace(), alive: c.sample().playerState !== 'dead' };
    c.stopTrace();
    return out;
  }, { plateau: PLATEAU });
}

/** Seed-sensitivity control: meadow height is generated from the seed. */
async function scenarioSeedProbe(page) {
  return page.evaluate(async () => {
    const c = window.__croak;
    const h = window.__h;
    c.setMove(0, 0);
    c.teleportPlayer(2, 1.6, 2);
    await h.until((s) => s.grounded, 10);
    await h.steps(60, 10);
    return { y: c.sample().playerPos[1] };
  });
}

// ==================================================================== main

/**
 * IMPL is read straight from the TypeScript source but the page under test runs
 * dist/. When dist/ is older than src/, every spec-vs-impl row compares new
 * constants against a browser running the old ones, and the suite reports a
 * green build that does not exist. Refuse to run rather than lie.
 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtime(full)
      : fs.statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

async function main() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.error('feel gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }

  const builtAt = fs.statSync(distIndex).mtimeMs;
  const sourceAt = Math.max(
    newestMtime(path.join(ROOT, 'src')),
    fs.statSync(path.join(ROOT, 'index.html')).mtimeMs,
  );
  if (sourceAt > builtAt) {
    console.error(
      `feel gate: dist/ is STALE (src is ${Math.round((sourceAt - builtAt) / 1000)}s newer).\n` +
        '  The constants come from src/ but the browser would run the old bundle,\n' +
        '  so every result would be measured against code that is not under test.\n' +
        '  Run `npm run build` first.',
    );
    process.exit(2);
  }

  await startServer();
  const exe = findChromium();
  const fast = await launchFast(exe);
  const v60 = await launch60(exe);

  try {
    // ---------------------------------------------------- 0. spec vs impl
    const specRows = [
      ['MOVE_SPEED', IMPL.MOVE_SPEED, SPEC.MOVE_SPEED],
      ['ROLL_DURATION f', IMPL.ROLL_DURATION * 60, SPEC.ROLL_DURATION_F],
      ['ROLL_IFRAME_START f', IMPL.ROLL_IFRAME_START * 60, SPEC.ROLL_IFRAME_FIRST_F],
      // END is the half-open upper bound, so it sits one past the last covered frame.
      ['ROLL_IFRAME_END f', IMPL.ROLL_IFRAME_END * 60, SPEC.ROLL_IFRAME_LAST_F + 1],
      ['ROLL_DISTANCE', IMPL.ROLL_DISTANCE, SPEC.ROLL_DISTANCE],
      ['ROLL_STAMINA', IMPL.ROLL_STAMINA, SPEC.ROLL_STAMINA],
      ['STAMINA_REGEN_DELAY', IMPL.STAMINA_REGEN_DELAY, SPEC.STAMINA_REGEN_DELAY],
      ['STAMINA_REGEN_DELAY_EMPTY', IMPL.STAMINA_REGEN_DELAY_EMPTY, SPEC.STAMINA_REGEN_DELAY_EMPTY],
      ['ZERO_STAMINA_DMG_MULT', IMPL.ZERO_STAMINA_DMG_MULT, SPEC.ZERO_STAMINA_DMG_MULT],
      ['INPUT_BUFFER f', IMPL.INPUT_BUFFER * 60, SPEC.INPUT_BUFFER_F],
      ['LIGHT_ATK windup f', IMPL.LIGHT_ATK.windup * 60, SPEC.LIGHT_WINDUP_F],
      ['LIGHT_ATK active f', IMPL.LIGHT_ATK.active * 60, SPEC.LIGHT_ACTIVE_F],
      ['LIGHT_ATK recovery f', IMPL.LIGHT_ATK.recovery * 60, SPEC.LIGHT_RECOVERY_F],
      ['ENEMY_TELEGRAPH_MIN f', IMPL.ENEMY_TELEGRAPH_MIN * 60, SPEC.ENEMY_TELEGRAPH_MIN_F],
      ['SPORELING.telegraph f', IMPL.SPORELING.telegraph * 60, SPEC.ENEMY_TELEGRAPH_MIN_F],
      ['HITSTOP_LIGHT f', IMPL.HITSTOP_LIGHT * 60, SPEC.HITSTOP_LIGHT_F],
      ['SHAKE_DECAY', IMPL.SHAKE_DECAY, SPEC.SHAKE_DECAY],
      ['SHAKE_CAP', IMPL.SHAKE_CAP, SPEC.SHAKE_CAP],
      ['TRAUMA_PLAYER_HURT', IMPL.TRAUMA_PLAYER_HURT, SPEC.TRAUMA_PLAYER_HURT],
    ];
    const drift = specRows.filter(([, impl, spec]) => !near(impl, spec, 1e-9));
    check(
      '0',
      'constants.ts carries PROMPT.md section 5 verbatim',
      drift.length === 0 ? `${specRows.length}/${specRows.length} agree` : drift.map((d) => d[0]).join(', '),
      'all agree',
      drift.length === 0,
    );

    // --------------------------------------------- FAST 1: roll + buffer
    const p1 = await openPage(fast, 'test=1');
    const pacingFast = await measurePacing(p1);
    const rollTrace = await scenarioRoll(p1);
    const latency = await scenarioLatency(p1);
    const speeds = await scenarioSpeeds(p1);
    const buffer = await scenarioBuffer(p1, [
      { ms: 50 }, { ms: 100 }, { ms: 133 }, { ms: 140 }, { ms: 145 },
      { ms: 150 }, { ms: 155 }, { ms: 167 }, { ms: 183 }, { ms: 200 },
    ]);
    await p1.close();

    analyseRoll(rollTrace);
    analyseSpeeds(speeds);
    analyseLatency(latency, '4', 'uncapped');
    analyseBuffer(buffer);

    // ------------------------------------------------ FAST 2: the i-frames
    const p2 = await openPage(fast, 'test=1');
    const iframes = await scenarioIframes(p2, SPEC.ROLL_DURATION_F - 1);
    await p2.close();
    analyseIframes(iframes);

    // ------------------------------------- FAST 3: stamina, hitstop, shake
    const p3 = await openPage(fast, 'test=1');
    const stam = await scenarioStamina(p3);
    await p3.close();
    analyseStamina(stam);
    analyseHitstop(stam.normalHit, '7', 'uncapped');
    analyseShake(stam.normalHit);

    // ------------------------------------------ FAST 4: enemy + shake cap
    const p4 = await openPage(fast, 'test=1');
    const enemy = await scenarioEnemy(p4);
    await p4.close();
    analyseTelegraph(enemy.telegraph);
    analyseBurst(enemy.burst);

    // -------------------------------------------------- FAST 5: determinism
    // The premise of the check is "the SAME injected input sequence". A press
    // is injected between frames, so a rendered frame that happens to carry two
    // simulation steps can push one injection a step late - that breaks the
    // premise, not the game, so the pair is re-run until both halves injected
    // on identical steps.
    let runA;
    let runB;
    let seedA;
    let seedB;
    let attempts = 0;
    do {
      attempts++;
      const pA = await openPage(fast, 'test=1&seed=822436');
      runA = await scenarioDeterminism(pA);
      seedA = await scenarioSeedProbe(pA);
      await pA.close();

      const pB = await openPage(fast, 'test=1&seed=822436');
      runB = await scenarioDeterminism(pB);
      seedB = await scenarioSeedProbe(pB);
      await pB.close();
    } while (
      attempts < 3 &&
      JSON.stringify(runA.d2.acts.map((a) => a.step)) !== JSON.stringify(runB.d2.acts.map((a) => a.step))
    );

    const pC = await openPage(fast, 'test=1&seed=99117');
    const seedC = await scenarioSeedProbe(pC);
    await pC.close();

    analyseDeterminism(runA, runB, seedA, seedB, seedC, attempts);

    // ------------------------- V60: the same wall-clock feel at 60 fps flat
    const p60 = await openPage(v60, 'test=1');
    const pacing60 = await measurePacing(p60);
    const latency60 = await scenarioLatency(p60);
    const buffer60 = await scenarioBuffer(p60, [{ frames: 8 }, { frames: 12 }]);
    const hit60 = await p60.evaluate(async ({ plateau }) => {
      const h = window.__h;
      await h.park(plateau);
      await h.free(12);
      return h.filmHit(0.6);
    }, { plateau: PLATEAU });
    await p60.close();

    analyseLatency(latency60, '4L', '60 fps');
    analyseBuffer60(buffer60);
    analyseHitstop(hit60, '7L', '60 fps');

    check(
      'env',
      'harness clocks (sim must track wall clock, no accumulator clamp)',
      `uncapped ${fmt(pacingFast.frameMs, 2)} ms/frame, 60 fps env ${fmt(pacing60.frameMs, 2)} ms/frame`,
      'sim:wall == 1.00 in both',
      near(pacingFast.simVsWall, 1, 0.03) && near(pacing60.simVsWall, 1, 0.03),
      `sim/wall: uncapped ${fmt(pacingFast.simVsWall, 4)} (worst frame ${fmt(pacingFast.maxFrameMs, 1)} ms, ` +
        `${pacingFast.overruns} over the ${(MAX_FRAME_TIME * 1000).toFixed(0)} ms accumulator clamp), ` +
        `60 fps ${fmt(pacing60.simVsWall, 4)} (worst frame ${fmt(pacing60.maxFrameMs, 1)} ms, ${pacing60.overruns} over)`,
    );

    check(
      '12',
      'no uncaught page errors across the whole gate',
      pageErrors.length === 0 ? 'none' : pageErrors.slice(0, 3).join(' | '),
      'none',
      pageErrors.length === 0,
      consoleErrors.length ? `console errors: ${consoleErrors.slice(0, 3).join(' | ')}` : undefined,
    );
  } finally {
    await fast.close().catch(() => {});
    await v60.close().catch(() => {});
    stopServer();
  }

  report();
}

// ------------------------------------------------------------- analysis

function rollSpan(trace) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < trace.length; i++) {
    if (trace[i].playerState !== 'roll') continue;
    if (first < 0) first = i;
    last = i;
  }
  return { first, last };
}

function analyseIframes({ rows, verified }) {
  // Rows are keyed by the roll frame the probe ACTUALLY landed on, read back
  // out of the trace rather than assumed from the request.
  const byFrame = new Map();
  for (const r of rows) byFrame.set(r.frame, r);
  const frames = [...byFrame.keys()].sort((a, b) => a - b);

  const invulnerable = frames.filter((k) => !byFrame.get(k).landed);
  const firstInv = invulnerable.length ? Math.min(...invulnerable) : NaN;
  const lastInv = invulnerable.length ? Math.max(...invulnerable) : NaN;
  // Contiguous over the frames that were actually probed - and every frame of
  // the roll has to have been probed, or the window has an unmeasured hole.
  const missing = [];
  for (let k = 0; k < SPEC.ROLL_DURATION_F; k++) if (!byFrame.has(k)) missing.push(k);
  const contiguous = frames
    .filter((k) => k >= firstInv && k <= lastInv)
    .every((k) => !byFrame.get(k).landed);

  check(
    '1z',
    'every frame of the roll was probed exactly once',
    missing.length === 0 ? `frames 0..${SPEC.ROLL_DURATION_F - 1}, ${rows.length} rolls` : `missing ${missing.join(',')}`,
    `frames 0..${SPEC.ROLL_DURATION_F - 1}`,
    missing.length === 0,
  );

  check(
    '1a',
    'roll i-frames START (probeHit, one roll per frame)',
    `frame ${firstInv}`,
    `frame ${SPEC.ROLL_IFRAME_FIRST_F} (+/-1)`,
    near(firstInv, SPEC.ROLL_IFRAME_FIRST_F, 1),
  );
  check(
    '1b',
    'roll i-frames END (probeHit, one roll per frame)',
    `frame ${lastInv}`,
    `frame ${SPEC.ROLL_IFRAME_LAST_F} (+/-1)`,
    near(lastInv, SPEC.ROLL_IFRAME_LAST_F, 1),
  );
  check(
    '1c',
    'i-frame window is one contiguous block',
    contiguous ? `frames ${firstInv}..${lastInv} (${invulnerable.length} f)` : invulnerable.join(','),
    'contiguous',
    contiguous && invulnerable.length > 1,
  );

  // The design: the SECOND half of the roll is vulnerable. A roll that i-frames
  // end to end is exactly the failure this check exists to catch.
  const tail = frames.filter((k) => k > lastInv);
  const tailHit = tail.filter((k) => byFrame.get(k).landed);
  check(
    '1d',
    'frog is VULNERABLE again for the rest of the roll',
    tail.length ? `frames ${Math.min(...tail)}..${Math.max(...tail)}: ${tailHit.length}/${tail.length} take damage` : 'none measured',
    `frames ${SPEC.ROLL_IFRAME_LAST_F + 1}..${SPEC.ROLL_DURATION_F - 1} all take damage`,
    tail.length >= 10 && tailHit.length === tail.length,
  );

  // The frame the player commits on must already be covered, or the dust cloud
  // promises safety one frame before it exists.
  const commit = byFrame.get(0);
  check(
    '1e',
    'the commit frame is covered (i-frames open on roll frame 0)',
    commit ? `frame 0 landed: ${commit.landed}` : 'n/a',
    'frame 0 takes no damage',
    Boolean(commit) && !commit.landed,
  );

  const covered = frames.filter((k) => !byFrame.get(k).landed);
  check(
    '1h',
    'i-frame COUNT is unchanged by the phase (still half the roll)',
    `${covered.length} f of ${SPEC.ROLL_DURATION_F}`,
    `${SPEC.ROLL_IFRAME_COUNT_F} f`,
    covered.length === SPEC.ROLL_IFRAME_COUNT_F,
  );

  const flagAgrees = frames.every((k) => byFrame.get(k).invulnerableFlag === !byFrame.get(k).landed);
  check(
    '1f',
    'player.invulnerable agrees with what probeHit actually does',
    flagAgrees ? `agrees on all ${frames.length} probed frames` : 'DISAGREES',
    'agrees',
    flagAgrees,
  );

  const vOk = verified.every((v) => (v.landed ? v.hpAfter < v.hpBefore : v.hpAfter === v.hpBefore));
  check(
    '1g',
    'the probe result is real damage (hp checked at frames 0/7/20)',
    verified.map((v) => `f${v.frame}:${v.hpBefore}->${v.hpAfter}`).join(' '),
    'hp drops only when not i-framed',
    vOk,
  );
}

function analyseRoll(trace) {
  const { first, last } = rollSpan(trace);
  const frames = last - first + 1;
  check(
    '2a',
    'ROLL_DURATION (frames spent in state "roll")',
    `${frames} f`,
    `${SPEC.ROLL_DURATION_F} f (+/-1)`,
    near(frames, SPEC.ROLL_DURATION_F, 1),
  );

  const a = trace[first - 1];
  const b = trace[last];
  const dist = Math.hypot(b.playerPos[0] - a.playerPos[0], b.playerPos[2] - a.playerPos[2]);
  const tol = SPEC.ROLL_DISTANCE * 0.15;
  check(
    '2b',
    'ROLL_DISTANCE travelled (flat plateau)',
    `${fmt(dist)} u`,
    `${fmt(SPEC.ROLL_DISTANCE)} u (+/-15% = ${fmt(tol)})`,
    near(dist, SPEC.ROLL_DISTANCE, tol),
  );

  let flat = 0;
  for (let i = first - 1; i <= last; i++) {
    flat = Math.max(flat, Math.abs(trace[i].playerPos[1] - a.playerPos[1]));
  }
  check(
    '2c',
    'the distance was measured on flat ground',
    `max |dy| ${fmt(flat, 4)} u`,
    '< 0.02 u',
    flat < 0.02,
  );

  let flagFirst = -1;
  let flagLast = -1;
  for (let i = first; i <= last; i++) {
    if (!trace[i].invulnerable) continue;
    if (flagFirst < 0) flagFirst = i - first;
    flagLast = i - first;
  }
  check(
    '2d',
    'i-frame window seen in the per-step trace',
    `frames ${flagFirst}..${flagLast} (${flagLast - flagFirst + 1} f)`,
    `frames ${SPEC.ROLL_IFRAME_FIRST_F}..${SPEC.ROLL_IFRAME_LAST_F} (+/-1)`,
    near(flagFirst, SPEC.ROLL_IFRAME_FIRST_F, 1) && near(flagLast, SPEC.ROLL_IFRAME_LAST_F, 1),
  );

  const cost = trace[first - 1].stamina - trace[first].stamina;
  check(
    '5a',
    'ROLL_STAMINA charged by one roll',
    fmt(cost),
    `${SPEC.ROLL_STAMINA} (+/-0.02)`,
    near(cost, SPEC.ROLL_STAMINA, 0.02),
  );

  let regen = -1;
  for (let i = first + 1; i < trace.length; i++) {
    if (trace[i].stamina > trace[i - 1].stamina + 1e-9) {
      regen = trace[i].simTime - trace[first].simTime;
      break;
    }
  }
  check(
    '5b',
    'STAMINA_REGEN_DELAY (spend -> first regen tick)',
    regen < 0 ? 'never regenerated' : ms(regen),
    `>= ${ms(SPEC.STAMINA_REGEN_DELAY)}`,
    regen >= SPEC.STAMINA_REGEN_DELAY - TICK,
    regen >= 0 ? `regen began ${((regen - SPEC.STAMINA_REGEN_DELAY) * 1000).toFixed(1)} ms after the delay` : undefined,
  );
}

function analyseSpeeds(speeds) {
  const card = speeds.filter((s) => s.label.startsWith('cardinal'));
  const diag = speeds.filter((s) => s.label.startsWith('diagonal'));
  const maxCard = Math.max(...card.map((s) => s.speed));
  const maxDiag = Math.max(...diag.map((s) => s.speed));
  check(
    '10a',
    'MOVE_SPEED on a cardinal',
    `${fmt(maxCard)} u/s`,
    `${fmt(SPEC.MOVE_SPEED)} u/s (+/-2%)`,
    near(maxCard, SPEC.MOVE_SPEED, SPEC.MOVE_SPEED * 0.02),
  );
  check(
    '10b',
    'diagonals never exceed MOVE_SPEED',
    `${fmt(maxDiag)} u/s over 4 diagonals`,
    `<= ${fmt(SPEC.MOVE_SPEED)} u/s`,
    maxDiag <= SPEC.MOVE_SPEED + 1e-3,
    `per direction: ${speeds.map((s) => `${s.label}=${fmt(s.speed, 3)}`).join(', ')}`,
  );
}

function analyseLatency(latency, prefix, envLabel) {
  for (const l of latency) {
    check(
      `${prefix}${l.action === 'roll' ? 'a' : 'b'}`,
      `response: press -> state "${l.action}" (${envLabel})`,
      `${ms(l.seconds)} (${l.steps} sim step, ${l.frames} rendered frame${l.frames === 1 ? '' : 's'})`,
      '< 100 ms',
      l.seconds < 0.1,
    );
  }
}

function analyseBuffer(rows) {
  const fired = rows.filter((r) => r.fired);
  const missed = rows.filter((r) => !r.fired);
  const maxFired = fired.length ? Math.max(...fired.map((r) => r.ageMs)) : NaN;
  const minMissed = missed.length ? Math.min(...missed.map((r) => r.ageMs)) : NaN;
  const at140 = rows.find((r) => r.label === '140 ms');
  const at200 = rows.find((r) => r.label === '200 ms');

  check(
    '3a',
    'roll press 140 ms early still cancels the attack',
    `press aged ${fmt(at140.ageMs, 1)} ms -> ${at140.fired ? 'ROLLED' : 'no roll'}`,
    'rolls (INPUT_BUFFER is 150 ms)',
    at140.fired === true,
  );
  check(
    '3b',
    'roll press 200 ms early is dropped',
    `press aged ${fmt(at200.ageMs, 1)} ms -> ${at200.fired ? 'ROLLED' : 'no roll'}`,
    'no roll (buffer expired)',
    at200.fired === false,
  );
  check(
    '3c',
    'measured INPUT_BUFFER window',
    `${fmt(maxFired, 1)} ms survives / ${fmt(minMissed, 1)} ms does not`,
    `${ms(IMPL.INPUT_BUFFER)} (+/-1 f)`,
    maxFired >= IMPL.INPUT_BUFFER * 1000 - TICK * 1000 &&
      maxFired <= IMPL.INPUT_BUFFER * 1000 + 1 &&
      minMissed > IMPL.INPUT_BUFFER * 1000 - 1,
    `trials: ${rows.map((r) => `${r.label}${r.fired ? '=roll' : '=-'}`).join(' ')}`,
  );
  check(
    '3d',
    'a buffered roll fires on the earliest legal cancel frame',
    fired.length && fired.every((r) => r.firedAtCancelFrame)
      ? `attack frame ${CANCEL_F}, every time (${fired.length} trials)`
      : fired.map((r) => r.cancelOffsetF).join(','),
    `attack frame ${CANCEL_F} (windup ${SPEC.LIGHT_WINDUP_F} + active ${SPEC.LIGHT_ACTIVE_F})`,
    fired.length > 0 && fired.every((r) => r.firedAtCancelFrame),
  );
  check(
    '3e',
    'every buffer press was injected mid-attack, never from idle',
    rows.every((r) => r.pressedDuringAttack) ? 'yes' : 'NO - a press leaked outside the attack',
    'yes',
    rows.every((r) => r.pressedDuringAttack),
  );
}

function analyseBuffer60(rows) {
  const eight = rows.find((r) => r.label === '8 f');
  const twelve = rows.find((r) => r.label === '12 f');
  check(
    '3L',
    'buffer at a locked 60 fps: 8 f early rolls, 12 f early does not',
    `8 f (${fmt(eight.ageMs, 1)} ms) -> ${eight.fired ? 'ROLLED' : 'no roll'}; ` +
      `12 f (${fmt(twelve.ageMs, 1)} ms) -> ${twelve.fired ? 'ROLLED' : 'no roll'}`,
    'roll / no roll',
    eight.fired === true && twelve.fired === false,
  );
}

function analyseStamina(stam) {
  const rolls = stam.rolls;
  const clean = rolls.filter((r) => r.staminaAfter > 0).map((r) => r.staminaBefore - r.staminaAfter);
  check(
    '5c',
    'ROLL_STAMINA is charged on every roll',
    clean.map((c) => fmt(c)).join(', '),
    `${SPEC.ROLL_STAMINA} each (+/-0.02)`,
    clean.length > 1 && clean.every((c) => near(c, SPEC.ROLL_STAMINA, 0.02)),
  );

  const dry = rolls.filter((r) => r.staminaBefore <= 1e-9);
  check(
    '5d',
    "rolling at ZERO stamina still rolls (Tunic's forgiveness)",
    dry.length ? `${dry.length} dry roll(s), state=${dry.map((r) => r.state).join('/')}` : 'bar never emptied',
    'state becomes "roll"',
    dry.length > 0 && dry.every((r) => r.rolled),
  );
  check(
    '5e',
    'an empty bar raises zeroStaminaPenalty',
    dry.length ? String(dry.every((r) => r.zeroPenaltyDuring)) : 'n/a',
    'true',
    dry.length > 0 && dry.every((r) => r.zeroPenaltyDuring),
  );

  const norm = stam.normalHit.hpBefore - stam.normalHit.hpAfter;
  const zero = stam.zeroHit.hpBefore - stam.zeroHit.hpAfter;
  check(
    '6a',
    'ZERO_STAMINA_DMG_MULT on incoming damage',
    `${fmt(zero, 2)} hp vs ${fmt(norm, 2)} hp at full bar = x${fmt(zero / norm, 3)}`,
    `x${SPEC.ZERO_STAMINA_DMG_MULT} (+/-0.02)`,
    norm > 0 && near(zero / norm, SPEC.ZERO_STAMINA_DMG_MULT, 0.02),
  );
  check(
    '6b',
    'the x1.5 hit really was taken on an empty bar',
    `stamina ${fmt(stam.zeroHit.stamina, 3)}, penalty ${stam.zeroHit.zeroPenalty}`,
    'stamina 0, penalty true',
    stam.zeroHit.stamina <= 1e-9 && stam.zeroHit.zeroPenalty === true,
  );
}

function analyseHitstop(hit, prefix, envLabel) {
  const film = hit.film;
  // Sim steps land on a fixed wall-clock cadence; a hitstop shows up as one
  // oversized gap between two consecutive steps.
  let prevAdvance = null;
  const gaps = [];
  for (let i = 1; i < film.length; i++) {
    if (film[i].sim <= film[i - 1].sim) continue;
    if (prevAdvance !== null) gaps.push({ gap: film[i].p - film[prevAdvance].p, from: prevAdvance, to: i });
    prevAdvance = i;
  }
  if (gaps.length < 4) {
    check(`${prefix}a`, `HITSTOP_LIGHT stalls simTime (${envLabel})`, 'too few sim steps sampled', ms(IMPL.HITSTOP_LIGHT), false);
    return;
  }
  const biggest = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const normal = sorted[Math.floor(sorted.length / 2)];
  const stall = biggest.gap - normal;

  check(
    `${prefix}a`,
    `HITSTOP_LIGHT stalls simTime on a landed hit (${envLabel})`,
    `${ms(stall)} (largest sim gap ${ms(biggest.gap)} minus the normal ${ms(normal)})`,
    `${ms(IMPL.HITSTOP_LIGHT)} (+/-1 f)`,
    near(stall, IMPL.HITSTOP_LIGHT, TICK),
  );

  // The forbidden-list item: the render loop must stay alive through the freeze.
  const frozen = film.slice(biggest.from, biggest.to + 1);
  const framesAdvanced = frozen[frozen.length - 1].fc - frozen[0].fc;
  const presentAdvanced = frozen[frozen.length - 1].p - frozen[0].p;
  // Every frozen frame still renders (frameCount +1) and the wall clock never
  // goes backwards. Two rAF callbacks can share a timestamp when the loop is
  // uncapped, so presentTime is required to be non-decreasing across frames
  // and strictly increasing across the freeze as a whole.
  const monotonic = frozen.every(
    (s, i) => i === 0 || (s.fc === frozen[i - 1].fc + 1 && s.p >= frozen[i - 1].p),
  );
  check(
    `${prefix}b`,
    `presentTime + frameCount keep advancing THROUGH the freeze (${envLabel})`,
    `${framesAdvanced} frames rendered across ${ms(presentAdvanced)} of frozen sim`,
    'both advance every frame',
    framesAdvanced > 1 && presentAdvanced > 0 && monotonic,
  );

  check(
    `${prefix}c`,
    `loop.hitstopRemaining is set then drained (${envLabel})`,
    `${film.some((s) => s.hs > 0) ? 'set on the hit' : 'NEVER SET'}, final ${fmt(film[film.length - 1].hs, 4)}`,
    'set, back to 0',
    film.some((s) => s.hs > 0) && film[film.length - 1].hs === 0,
  );
}

function analyseShake(hit) {
  const film = hit.film;
  const peak = Math.max(...film.map((s) => s.tr));
  check(
    '8a',
    'a hit raises camera trauma',
    fmt(peak),
    `~${SPEC.TRAUMA_PLAYER_HURT} (player hurt), <= ${SPEC.SHAKE_CAP}`,
    peak > 0 && peak <= SPEC.SHAKE_CAP + 1e-9 && near(peak, SPEC.TRAUMA_PLAYER_HURT, 0.03),
  );

  const start = film.findIndex((s) => s.tr === peak);
  const seg = [];
  for (let i = start; i < film.length; i++) {
    if (film[i].tr <= 0.02) break;
    seg.push(film[i]);
  }
  let slope = NaN;
  if (seg.length > 4) {
    const n = seg.length;
    const mx = seg.reduce((a, s) => a + s.p, 0) / n;
    const my = seg.reduce((a, s) => a + s.tr, 0) / n;
    let num = 0;
    let den = 0;
    for (const s of seg) {
      num += (s.p - mx) * (s.tr - my);
      den += (s.p - mx) ** 2;
    }
    slope = num / den;
  }
  check(
    '8b',
    'SHAKE_DECAY (trauma per second, on the wall clock)',
    `${fmt(-slope)} /s over ${seg.length} samples`,
    `${SPEC.SHAKE_DECAY} /s (+/-20%)`,
    near(-slope, SPEC.SHAKE_DECAY, SPEC.SHAKE_DECAY * 0.2),
  );

  const zeroAt = film.find((s) => s.p > film[start].p && s.tr === 0);
  const budget = SPEC.TRAUMA_PLAYER_HURT / SPEC.SHAKE_DECAY + 0.05;
  check(
    '8c',
    'trauma decays all the way to zero (no undecaying shake)',
    zeroAt ? `0 after ${ms(zeroAt.p - film[start].p)}` : 'never reached 0',
    `0 within ${ms(budget)}`,
    !!zeroAt && zeroAt.p - film[start].p <= budget,
  );
}

function analyseBurst(burst) {
  check(
    '8d',
    'trauma never exceeds SHAKE_CAP under a hit-spam burst',
    fmt(burst.maxTrauma),
    `<= ${SPEC.SHAKE_CAP}`,
    burst.maxTrauma <= SPEC.SHAKE_CAP + 1e-9 && burst.maxTrauma > 0,
    `the largest single source in A1 is ${IMPL.TRAUMA_PLAYER_HURT} (player hurt); with i-frames between hits the ceiling is not otherwise reachable`,
  );
  check(
    '8e',
    'shake settles to exactly 0 after the burst',
    fmt(burst.finalTrauma),
    '0',
    burst.finalTrauma === 0,
  );
}

function analyseTelegraph(t) {
  const ev = t.events;
  const hpDrops = [];
  for (let i = 1; i < ev.length; i++) if (ev[i].hp < ev[i - 1].hp) hpDrops.push(i);

  if (hpDrops.length < 3) {
    check(
      '9a',
      'sporeling telegraph before its active window',
      `only ${hpDrops.length} enemy hit(s) landed`,
      `>= ${SPEC.ENEMY_TELEGRAPH_MIN_F} f`,
      false,
    );
    return;
  }

  /**
   * Each attack cycle is read as a ladder of single-mesh step-ups in the
   * draw-call count. The top rung is self-checking - the burst's landing dust
   * has to appear exactly one simulation step before the damage it belongs to -
   * and the tell is then the rung sitting the SAME distance below the burst in
   * EVERY cycle. Anything else that touches the count (a prop or a distant
   * sporeling bobbing across the edge of the view frustum, a stray batch) is not
   * locked to this enemy's cycle and drops out of the intersection. Noise can
   * therefore only make this check fail; it cannot make it pass.
   */
  const cycles = [];
  for (let k = 1; k < hpDrops.length; k++) {
    const from = hpDrops[k - 1];
    const to = hpDrops[k];
    const dropStep = ev[to].st;
    const rises = [];
    for (let i = from + 1; i <= to; i++) {
      if (ev[i].dc === ev[i - 1].dc + 1 && ev[i].st <= dropStep - 1) rises.push(ev[i]);
    }
    const burst = rises[rises.length - 1];
    if (!burst || burst.st !== dropStep - 1) continue;
    cycles.push({
      dropStep,
      burstStep: burst.st,
      offsets: rises.slice(0, -1).map((r) => burst.st - r.st),
    });
  }

  const common = cycles.length
    ? cycles[0].offsets.filter((o) => cycles.every((c) => c.offsets.includes(o)))
    : [];
  if (cycles.length < 2 || common.length === 0) {
    check(
      '9a',
      'sporeling telegraph before its active window',
      `no windup common to ${cycles.length} readable cycle(s): ${cycles.map((c) => '[' + c.offsets.join(' ') + ']').join(' ')}`,
      `>= ${SPEC.ENEMY_TELEGRAPH_MIN_F} f`,
      false,
      'the draw-call ladder could not be read, so the tell was never isolated',
    );
    return;
  }

  // Smallest common rung, so a stray extra step-up can only SHORTEN the windup
  // this check is willing to credit the game with.
  const windup = Math.min(...common);
  check(
    '9a',
    'sporeling telegraph: tell appears -> active window opens',
    `${windup} f (${ms(windup / 60)}), identical across ${cycles.length} cycles`,
    `>= ${SPEC.ENEMY_TELEGRAPH_MIN_F} f (${ms(SPEC.ENEMY_TELEGRAPH_MIN_F / 60)})`,
    windup >= SPEC.ENEMY_TELEGRAPH_MIN_F,
    `bursts at sim steps ${cycles.map((c) => c.burstStep).join('/')}, each exactly one step before its damage; ` +
      `tell rungs at ${cycles.map((c) => c.burstStep - windup).join('/')}` +
      (t.airborne ? `; frog left the ground on ${t.airborne} frames` : ''),
  );

  const intervals = [];
  for (let i = 1; i < hpDrops.length; i++) intervals.push(ev[hpDrops[i]].st - ev[hpDrops[i - 1]].st);
  const expected =
    Math.round(IMPL.SPORELING.telegraph * 60) +
    Math.round(IMPL.SPORELING.active * 60) +
    Math.round(IMPL.SPORELING.recovery * 60) +
    2;
  check(
    '9b',
    'sporeling cycle: telegraph + active + recovery',
    `${intervals.join(', ')} f`,
    `${expected} f (+/-2)`,
    intervals.length > 0 && intervals.every((c) => near(c, expected, 2)),
  );
}

function analyseDeterminism(runA, runB, seedA, seedB, seedC, attempts) {
  const FIELDS = ['playerState', 'stamina', 'hp', 'facing', 'grounded', 'enemiesAlive'];

  const compare = (a, b) => {
    const key = (s) => Math.round(s.simTime * 60);
    const mapB = new Map(b.map((s) => [key(s), s]));
    let compared = 0;
    const diffs = [];
    for (const sa of a) {
      const sb = mapB.get(key(sa));
      if (!sb) continue;
      compared++;
      for (const fld of FIELDS) {
        if (sa[fld] !== sb[fld]) diffs.push(`step ${key(sa)} ${fld}: ${sa[fld]} vs ${sb[fld]}`);
      }
      for (let i = 0; i < 3; i++) {
        if (sa.playerPos[i] !== sb.playerPos[i]) {
          diffs.push(`step ${key(sa)} pos[${i}]: ${sa.playerPos[i]} vs ${sb.playerPos[i]}`);
        }
      }
      if (diffs.length > 4) break;
    }
    return { compared, diffs };
  };

  const d1 = compare(runA.d1.trace, runB.d1.trace);
  check(
    '11a',
    'same seed, no input: identical trace (3 sporelings engaging)',
    d1.diffs.length === 0 ? `${d1.compared} steps identical across ${FIELDS.length + 3} fields` : d1.diffs[0],
    'identical',
    d1.compared > 120 && d1.diffs.length === 0,
  );

  const stepsMatch =
    JSON.stringify(runA.d2.acts.map((a) => a.step)) === JSON.stringify(runB.d2.acts.map((a) => a.step));
  const d2 = compare(runA.d2.trace, runB.d2.trace);
  check(
    '11b',
    'same seed + same injected input: identical trace',
    d2.diffs.length === 0 ? `${d2.compared} steps identical, inputs on steps ${runA.d2.acts.map((a) => a.step).join('/')}` : d2.diffs[0],
    'identical',
    stepsMatch && d2.compared > 150 && d2.diffs.length === 0 && runA.d2.alive && runB.d2.alive,
    stepsMatch
      ? attempts > 1
        ? `took ${attempts} attempts to get both runs to inject on identical steps`
        : undefined
      : `after ${attempts} attempts the two runs still injected input on different sim steps`,
  );

  check(
    '11c',
    'the trace is actually seed-sensitive (control)',
    `seed A y=${fmt(seedA.y, 6)}, A again y=${fmt(seedB.y, 6)}, seed C y=${fmt(seedC.y, 6)}`,
    'A == A, C != A',
    seedA.y === seedB.y && seedC.y !== seedA.y,
  );
}

// ---------------------------------------------------------------- report

function report() {
  const w = [5, 60, 50, 34];
  const total = w.reduce((a, b) => a + b) + 8;
  const line = (a, b, c, d) =>
    `${String(a).padEnd(w[0])}${String(b).padEnd(w[1])}${String(c).padEnd(w[2])}${String(d).padEnd(w[3])}`;

  console.log('');
  console.log('='.repeat(total));
  console.log('CROAK FEEL GATE - measured vs PROMPT.md section 5');
  console.log('='.repeat(total));
  console.log(line('#', 'check', 'measured', 'expected') + 'verdict');
  console.log('-'.repeat(total));
  for (const c of checks) {
    console.log(line(c.id, c.name, c.measured, c.expected) + (c.pass ? 'PASS' : 'FAIL'));
  }
  console.log('-'.repeat(total));

  const failed = checks.filter((c) => !c.pass);
  console.log(`${checks.length - failed.length}/${checks.length} passed`);
  if (notes.length) {
    console.log('');
    console.log('notes:');
    for (const n of notes) console.log('  - ' + n);
  }
  if (failed.length) {
    console.log('');
    console.log('FAILED:');
    for (const c of failed) console.log(`  ${c.id} ${c.name}: measured ${c.measured}, expected ${c.expected}`);
  }
  console.log('');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  stopServer();
  console.error('feel gate: harness error');
  console.error(err);
  process.exit(2);
});
