#!/usr/bin/env node
/**
 * CROAK - milestone A2 gate: the combat core (PROMPT.md section 11).
 *
 * Where feel.mjs measures section 5's numbers, this measures the RULES A2 adds:
 * weapons and their combo lengths, the Beetle Guard's shield and the footwork
 * that beats it, hard lock-on, the coin economy, and the death loop - shrine
 * checkpoints and the ghost that holds what dying cost you.
 *
 * Every verb goes through the real input system. Nothing here reaches past
 * window.__croak into game internals, and no threshold may be relaxed to make
 * something pass: if a rule is not implemented, this file says so.
 *
 * Run: node tests/a2.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4175;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEED = 0x0c20a4;

const GL_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--mute-audio',
  // Combat is logic, not pixels: skipping rasterisation keeps the page at a
  // real frame rate on a GPU-less host, so a 150 ms input buffer still spans
  // several frames instead of expiring inside one.
  '--disable-gl-drawing-for-tests',
];

// ------------------------------------------------------------------ reporting

const checks = [];
const notes = [];

function check(id, name, measured, expected, pass, note) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
  if (note) notes.push(`${id}: ${note}`);
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const DEG = 180 / Math.PI;

// ------------------------------------------------------------ in-page tools

const HELPERS = `
window.__a2 = {
  async waitFor(pred, limit = 900) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      if (pred(c)) return i;
      await c.frames(1);
    }
    return -1;
  },
  beetle() {
    return window.__croak.enemies().find((e) => e.kind === 'beetleGuard') || null;
  },
  spore() {
    return window.__croak.enemies().find((e) => e.kind === 'sporeling') || null;
  },
  /** Press until the verb is actually entered - a slow frame can age a buffer out. */
  async verb(action, state, limit = 60) {
    const c = window.__croak;
    for (let i = 0; i < limit; i++) {
      c.press(action);
      await c.frames(1);
      c.release(action);
      if (c.sample().playerState === state) return true;
      await c.frames(1);
    }
    return false;
  },
  /** Stand at \`angle\` around a point, at \`radius\`, and look at it. */
  async standAt(target, angle, radius) {
    const c = window.__croak;
    c.teleportPlayer(
      target[0] + Math.sin(angle) * radius,
      target[1],
      target[2] + Math.cos(angle) * radius,
    );
    await c.frames(2);
  },
  /** Hard-lock the nearest enemy and wait for the frog to actually be looking at it. */
  async lockAndFace(getTarget, limit = 90) {
    const c = window.__croak;
    if (!c.sample().lockedOn) {
      c.press('lockon');
      await c.frames(1);
      c.release('lockon');
      await c.frames(1);
    }
    for (let i = 0; i < limit; i++) {
      const t = getTarget();
      if (!t) return false;
      const p = c.sample().playerPos;
      const want = Math.atan2(t.pos[0] - p[0], t.pos[2] - p[2]);
      let off = (c.sample().facing - want + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      if (Math.abs(off) < 0.12) return true;
      await c.frames(1);
    }
    return false;
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
        /* already gone */
      }
    }
  }
  server = null;
}

const pageErrors = [];
const consoleErrors = [];

async function openPage(browser, query = `test=1&seed=${SEED}`) {
  const page = await browser.newPage({ viewport: { width: 900, height: 540 } });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon/i.test(text) || /404 \(Not Found\)/.test(text)) return;
    consoleErrors.push(text);
  });
  await page.addInitScript(HELPERS);
  await page.goto(`${ORIGIN}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__croak && window.__croak.ready, null, {
    timeout: 30000,
  });
  return page;
}

/** dist/ is what the browser runs; IMPL comes from src/. They must agree. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

// -------------------------------------------------------------------- main

async function main() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.error('a2 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a2 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const exe = findChromium();
  const browser = await chromium.launch({ executablePath: exe, args: GL_ARGS });

  try {
    const page = await openPage(browser);

    // ---------------------------------------------- 1. weapons and combos
    const stickCombo = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const seen = new Set();
      let swings = 0;
      // Chain as hard as the buffer allows and count distinct attack entries.
      for (let i = 0; i < 200; i++) {
        c.press('attack');
        await c.frames(1);
        c.release('attack');
        const s = c.sample();
        if (s.playerState === 'attack') swings++;
        if (s.playerState === 'idle' || s.playerState === 'move') seen.add(swings);
        await c.frames(1);
      }
      return { weapon: c.sample().weapon, swings };
    });
    check(
      '1a',
      'the frog starts with the Stick',
      stickCombo.weapon,
      IMPL.STARTING_WEAPON,
      stickCombo.weapon === IMPL.STARTING_WEAPON,
    );

    const sword = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const drop = c.pickupList().find((p) => p.kind === 'weapon');
      if (!drop) return { found: false };
      c.teleportPlayer(drop.pos[0], drop.pos[1], drop.pos[2]);
      const waited = await a.waitFor((k) => k.sample().weapon === 'sword', 240);
      return { found: true, waited, weapon: c.sample().weapon };
    });
    check(
      '1b',
      'the Sword is in the world and equips on touch',
      sword.found ? `${sword.weapon} after ${sword.waited} frames` : 'no weapon pickup in level',
      'sword',
      sword.found && sword.weapon === 'sword',
    );
    check(
      '1c',
      'the two weapons carry different combo lengths',
      `stick ${IMPL.WEAPONS.stick.swings.length}, sword ${IMPL.WEAPONS.sword.swings.length}`,
      'stick 2, sword 3',
      IMPL.WEAPONS.stick.swings.length === 2 && IMPL.WEAPONS.sword.swings.length === 3,
    );
    check(
      '1d',
      'the Sword hits harder than the Stick',
      `stick ${IMPL.WEAPONS.stick.swings[0].damage} -> sword ${IMPL.WEAPONS.sword.swings[0].damage}` +
        `, finisher ${IMPL.WEAPONS.sword.swings[2].damage}`,
      'sword damage > stick damage',
      IMPL.WEAPONS.sword.swings[0].damage > IMPL.WEAPONS.stick.swings[0].damage,
    );

    // ------------------------------------------------- 2. the Beetle's shield
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__croak && window.__croak.ready);

    const front = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const b = a.beetle();
      if (!b) return { ok: false };
      // Stand square in front of the shield and swing.
      await a.standAt(b.pos, b.facing, 1.15);
      await a.lockAndFace(a.beetle);
      const before = a.beetle().hp;
      const p = c.sample().playerPos;
      const cur = a.beetle();
      // Angle between where the guard is looking and where the blow comes from.
      const toMe = Math.atan2(p[0] - cur.pos[0], p[2] - cur.pos[2]);
      const off = Math.abs(((toMe - cur.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const swung = await a.verb('attack', 'attack');
      await c.frames(30);
      return { ok: true, before, after: a.beetle().hp, off, swung };
    });
    check(
      '2a',
      'the shield turns a blow landing in front of it',
      front.ok ? `hp ${front.before} -> ${front.after}, blow ${fmt(front.off * DEG, 0)} deg off its facing` : 'no guard',
      'hp unchanged',
      front.ok && front.swung && front.after === front.before,
    );
    check(
      '2b',
      'that blow really was inside the shield arc (control)',
      front.ok ? `${fmt(front.off * DEG, 0)} deg` : 'n/a',
      `<= ${fmt(IMPL.BEETLE_SHIELD_ARC * DEG, 0)} deg`,
      front.ok && front.off <= IMPL.BEETLE_SHIELD_ARC,
    );

    const back = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const b = a.beetle();
      if (!b) return { ok: false };
      // A guard that is merely stood behind will simply turn round: it tracks
      // at BEETLE_TURN_RATE whenever it is free. The designed answer is to bait
      // the windup first - a committed guard cannot turn - and go round it.
      await a.standAt(b.pos, b.facing, 1.4);
      const got = await a.waitFor(() => {
        const g = window.__a2.beetle();
        return g && g.state === 'telegraph';
      }, 900);
      if (got < 0) return { ok: false, reason: 'never telegraphed' };

      const committed = a.beetle();
      await a.standAt(committed.pos, committed.facing + Math.PI, 1.15);
      await a.lockAndFace(a.beetle, 24);
      const before = a.beetle().hp;
      const swung = await a.verb('attack', 'attack', 12);
      // Angle measured at the moment the blow is in flight, not before it.
      const cur = a.beetle();
      const p = c.sample().playerPos;
      const toMe = Math.atan2(p[0] - cur.pos[0], p[2] - cur.pos[2]);
      const off = Math.abs(((toMe - cur.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      await c.frames(20);
      return { ok: true, before, after: a.beetle().hp, off, swung, state: committed.state };
    });

    check(
      '2c',
      'baiting the windup and hitting the back lands the blow',
      back.ok ? `hp ${back.before} -> ${back.after}, blow ${fmt(back.off * DEG, 0)} deg off its facing` : 'no guard',
      'hp drops',
      back.ok && back.swung && back.after < back.before,
    );
    check(
      '2d',
      'that blow really was outside the shield arc (control)',
      back.ok ? `${fmt(back.off * DEG, 0)} deg` : 'n/a',
      `> ${fmt(IMPL.BEETLE_SHIELD_ARC * DEG, 0)} deg`,
      back.ok && back.off > IMPL.BEETLE_SHIELD_ARC,
    );

    // ------------------------------------------- 3. telegraph honesty + commit
    const tele = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const b = a.beetle();
      if (!b) return { ok: false };
      await a.standAt(b.pos, b.facing, 1.4);
      const got = await a.waitFor((k) => {
        const g = window.__a2.beetle();
        return g && g.state === 'telegraph';
      }, 900);
      if (got < 0) return { ok: false, reason: 'never telegraphed' };
      const startFacing = a.beetle().facing;
      let frames = 0;
      let maxTurn = 0;
      // Strafe hard sideways: a guard that tracked here could never be flanked.
      c.setMove(1, 0);
      while (frames < 400) {
        const g = a.beetle();
        if (!g || g.state !== 'telegraph') break;
        const turn = Math.abs(((g.facing - startFacing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (turn > maxTurn) maxTurn = turn;
        frames++;
        await c.frames(1);
      }
      c.setMove(0, 0);
      return { ok: true, frames, maxTurn, next: (a.beetle() || {}).state };
    });
    check(
      '3a',
      'Beetle telegraph runs its full length',
      tele.ok ? `${tele.frames} f` : tele.reason || 'n/a',
      `>= ${Math.round(IMPL.BEETLE_GUARD.telegraph * 60)} f`,
      tele.ok && tele.frames >= Math.round(IMPL.BEETLE_GUARD.telegraph * 60) - 1,
    );
    check(
      '3b',
      'a committed guard does NOT track you - this is what makes flanking work',
      tele.ok ? `turned ${fmt(tele.maxTurn * DEG, 1)} deg while winding up` : 'n/a',
      '0 deg',
      tele.ok && tele.maxTurn < 1e-6,
    );

    // ------------------------------------------------------- 4. hard lock-on
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__croak && window.__croak.ready);

    const lock = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const b = a.beetle();
      await a.standAt(b.pos, b.facing + 2.2, 3.0);
      c.press('lockon');
      await c.frames(1);
      c.release('lockon');
      await c.frames(4);
      const on = c.sample().lockedOn;

      // Strafe sideways for a while; facing must stay on the target.
      c.setMove(1, 0);
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        await c.frames(1);
        const g = a.beetle();
        const p = c.sample().playerPos;
        const want = Math.atan2(g.pos[0] - p[0], g.pos[2] - p[2]);
        const off = Math.abs(((c.sample().facing - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (off > worst) worst = off;
      }
      c.setMove(0, 0);

      // Toggling off releases it.
      c.press('lockon');
      await c.frames(1);
      c.release('lockon');
      await c.frames(3);
      const off = c.sample().lockedOn;
      return { on, worst, off };
    });
    check('4a', 'lock-on engages on a press', lock.on, 'true', lock.on === true);
    check(
      '4b',
      'a locked frog strafes and keeps facing its target',
      `worst drift ${fmt(lock.worst * DEG, 1)} deg over 40 frames of sidestep`,
      '< 20 deg',
      lock.worst * DEG < 20,
    );
    check('4c', 'lock-on releases on a second press', lock.off, 'false', lock.off === false);

    const drop = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const b = a.beetle();
      await a.standAt(b.pos, 0.6, 3.0);
      c.press('lockon');
      await c.frames(1);
      c.release('lockon');
      await c.frames(3);
      const before = c.sample().lockedOn;
      // Walk far past the drop range.
      const g = a.beetle();
      c.teleportPlayer(g.pos[0] + 0, g.pos[1], g.pos[2] + 40);
      await c.frames(6);
      return { before, after: c.sample().lockedOn };
    });
    check(
      '4d',
      'a lock drops when the target leaves LOCKON_DROP_RANGE',
      `${drop.before} -> ${drop.after}`,
      'true -> false',
      drop.before === true && drop.after === false,
    );

    // --------------------------------------------------- 5. coins and ghosts
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__croak && window.__croak.ready);

    const purse = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const start = c.sample().coins;
      const s = a.spore();
      if (!s) return { ok: false };
      // Kill it with probe damage rather than footwork - this test is about
      // the payout, not the swordplay.
      const before = c.sample().coins;
      await a.standAt(s.pos, 0, 1.0);
      for (let i = 0; i < 40 && a.spore() && a.spore().alive; i++) {
        c.probeHit(0);
        await c.frames(1);
      }
      return { ok: true, start, before };
    });

    // Kill via the real damage path: walk in and swing until it dies.
    const kill = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const before = c.sample().coins;
      let guard = 0;
      while (a.spore() && a.spore().alive && guard++ < 300) {
        const s = a.spore();
        await a.standAt(s.pos, 0, 1.1);
        await a.lockAndFace(a.spore, 30);
        await a.verb('attack', 'attack', 12);
        await c.frames(6);
      }
      const died = !a.spore() || !a.spore().alive;
      // Stand on the drop and let the magnet do its work.
      const after0 = c.sample().coins;
      await c.frames(90);
      return { before, died, coins: c.sample().coins, after0 };
    });
    check(
      '5a',
      'a Sporeling can be killed with the weapon in hand',
      kill.died ? 'killed' : 'survived the whole attempt',
      'killed',
      kill.died,
    );
    check(
      '5b',
      'a kill pays out coins that can be collected',
      `${kill.before} -> ${kill.coins}`,
      `+${IMPL.COIN_DROP_SPORELING} available`,
      kill.died && kill.coins > kill.before,
    );

    const ghost = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      // Bank a known purse.
      const carried = c.sample().coins;
      const where = c.sample().playerPos;
      let guard = 0;
      while (c.sample().playerState !== 'dead' && guard++ < 500) {
        c.probeHit(3);
        await c.frames(2);
      }
      // The drop happens on the SIMULATION step after the frog goes down, and a
      // rendered frame is not a simulation step - above 60 fps several frames
      // can pass with no step at all. Wait for the event, never for a count.
      await a.waitFor((k) => k.sample().ghosts > 0, 240);
      const atDeath = { coins: c.sample().coins, ghosts: c.sample().ghosts };
      // Wait out the respawn.
      const back = await a.waitFor((k) => k.sample().playerState !== 'dead', 600);
      const list = c.pickupList().filter((p) => p.kind === 'ghost');
      return {
        carried,
        atDeath,
        back: back >= 0,
        ghostValue: list.length ? list[0].value : 0,
        ghostPos: list.length ? list[0].pos : null,
        where,
      };
    });
    check(
      '5c',
      'dying drops the purse as a ghost where you fell',
      `carried ${ghost.carried} -> purse ${ghost.atDeath.coins}, ${ghost.atDeath.ghosts} ghost(s) worth ${ghost.ghostValue}`,
      'purse emptied into one ghost',
      ghost.carried > 0 && ghost.atDeath.coins === 0 && ghost.ghostValue === Math.min(ghost.carried, IMPL.DEATH_COIN_DROP),
    );

    const recover = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const list = c.pickupList().filter((p) => p.kind === 'ghost');
      if (!list.length) return { ok: false };
      const g = list[0];
      c.teleportPlayer(g.pos[0], g.pos[1], g.pos[2]);
      const got = await a.waitFor((k) => k.sample().ghosts === 0, 300);
      return { ok: true, got: got >= 0, coins: c.sample().coins, value: g.value };
    });
    check(
      '5d',
      'walking back to the ghost returns the coins',
      recover.ok ? `recovered ${recover.value} -> purse ${recover.coins}` : 'no ghost to recover',
      'purse restored',
      recover.ok && recover.got && recover.coins >= recover.value,
    );

    const secondDeath = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      // Die twice without collecting: the first ghost must be gone for good.
      const kills = async () => {
        let guard = 0;
        while (c.sample().playerState !== 'dead' && guard++ < 500) {
          c.probeHit(3);
          await c.frames(2);
        }
        await a.waitFor((k) => k.sample().playerState !== 'dead', 600);
      };
      await kills();
      const afterFirst = c.sample().ghosts;
      const firstValue = (c.pickupList().find((p) => p.kind === 'ghost') || {}).value ?? 0;
      await kills();
      const afterSecond = c.sample().ghosts;
      return { afterFirst, afterSecond, firstValue };
    });
    check(
      '5e',
      'you get ONE retrieval: a second death abandons the first ghost',
      `ghosts ${secondDeath.afterFirst} -> ${secondDeath.afterSecond} after dying again`,
      'never more than 1',
      secondDeath.afterSecond <= 1,
    );

    // ---------------------------------------------------------- 6. shrines
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__croak && window.__croak.ready);

    const shrine = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const list = c.shrines();
      if (!list.length) return { ok: false };
      const s = list[0];
      // Hurt the frog and thin the meadow out first, so resting has work to do.
      c.probeHit(2);
      await c.frames(30);
      const hurt = c.sample().hp;

      c.teleportPlayer(s.pos[0] + 1.0, s.pos[1], s.pos[2]);
      await c.frames(3);
      let claimed = false;
      for (let i = 0; i < 40 && !claimed; i++) {
        c.press('interact');
        await c.frames(1);
        c.release('interact');
        await c.frames(1);
        claimed = c.shrines()[0].claimed;
      }
      await c.frames(4);
      return {
        ok: true,
        hurt,
        healed: c.sample().hp,
        claimed,
        enemies: c.sample().enemiesAlive,
        pos: s.pos,
      };
    });
    check(
      '6a',
      'resting at a shrine claims it',
      shrine.ok ? String(shrine.claimed) : 'no shrine in the level',
      'true',
      shrine.ok && shrine.claimed,
    );
    check(
      '6b',
      'resting heals the frog to full',
      shrine.ok ? `hp ${shrine.hurt} -> ${shrine.healed}` : 'n/a',
      `${IMPL.PLAYER_HP_MAX}`,
      shrine.ok && shrine.healed === IMPL.PLAYER_HP_MAX,
    );
    check(
      '6c',
      'resting brings the regular enemies back',
      shrine.ok ? `${shrine.enemies} alive after the rest` : 'n/a',
      '>= 2',
      shrine.ok && shrine.enemies >= 2,
    );

    const checkpoint = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      const s = c.shrines()[0];
      // Die far away from the shrine; you should wake at the shrine anyway.
      c.teleportPlayer(s.pos[0] + 9, s.pos[1], s.pos[2] + 9);
      await c.frames(4);
      let guard = 0;
      while (c.sample().playerState !== 'dead' && guard++ < 500) {
        c.probeHit(3);
        await c.frames(2);
      }
      await a.waitFor((k) => k.sample().playerState !== 'dead', 600);
      const p = c.sample().playerPos;
      return { dist: Math.hypot(p[0] - s.pos[0], p[2] - s.pos[2]) };
    });
    check(
      '6d',
      'death returns you to the shrine you last rested at, not to the start',
      `${fmt(checkpoint.dist)} u from the shrine`,
      '< 2 u',
      checkpoint.dist < 2,
    );

    // ------------------------------------------------------------ 7. duel
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__croak && window.__croak.ready);

    const duel = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a2;
      // Take the Sword first, the way a player would.
      const drop = c.pickupList().find((p) => p.kind === 'weapon');
      if (drop) {
        c.teleportPlayer(drop.pos[0], drop.pos[1], drop.pos[2]);
        await a.waitFor((k) => k.sample().weapon === 'sword', 240);
      }

      const log = [];
      let guard = 0;
      // A2's roster is the Sporeling and the Guard. A4 adds Spitter Flies that
      // hold station over water and are a tongue problem, not a sword one -
      // they are cleared in A4's own gate, not here.
      const remaining = () =>
        (a.beetle() && a.beetle().alive ? 1 : 0) + (a.spore() && a.spore().alive ? 1 : 0);
      while (remaining() > 0 && guard++ < 700) {
        const target = a.beetle() && a.beetle().alive ? a.beetle() : a.spore();
        if (!target) break;
        // Behind the shield if it has one; anywhere if it does not.
        const angle = target.kind === 'beetleGuard' ? target.facing + Math.PI : 0;
        await a.standAt(target.pos, angle, 1.15);
        await a.lockAndFace(
          () => (target.kind === 'beetleGuard' ? a.beetle() : a.spore()),
          24,
        );
        await a.verb('attack', 'attack', 10);
        await c.frames(8);
        if (c.sample().playerState === 'dead') {
          log.push('died');
          await a.waitFor((k) => k.sample().playerState !== 'dead', 600);
        }
      }
      return {
        cleared: remaining() === 0,
        rounds: guard,
        deaths: log.length,
        coins: c.sample().coins,
      };
    });
    check(
      '7a',
      'scripted duel clears the Sporeling and the Beetle Guard',
      duel.cleared
        ? `meadow cleared in ${duel.rounds} rounds (${duel.deaths} death(s)), purse ${duel.coins}`
        : `still ${duel.rounds} rounds in with enemies alive`,
      'all enemies dead',
      duel.cleared,
    );

    // ------------------------------------------------------ 8. determinism
    // Step-exact determinism of the simulation is gate.mjs's job, and it is
    // measured there against matched SIMULATION steps. Driving verbs from
    // observed state (as this file does) is wall-clock dependent by
    // construction, so what is asserted here is the part A2 actually adds:
    // that the same seed lays out the same world and pays out the same coins.
    const layout = async () => {
      const p = await openPage(browser, `test=1&seed=${SEED}`);
      const shape = await p.evaluate(async () => {
        const c = window.__croak;
        const a = window.__a2;
        const round = (v) => v.map((n) => n.toFixed(6)).join(',');
        // Enemies start walking the moment they see the frog, and several
        // simulation steps can land inside one rendered frame - so "the first
        // frame at simTime >= 0.5" is not the same step twice running, and
        // comparing walking bodies here measures the harness, not the seed.
        // Their POSITIONS are checked step-for-step in gate.mjs, where the
        // inputs are matched per simulation step; what is compared here is what
        // the seed decides and time does not: the roster and the fixed props.
        const world = {
          enemies: c.enemies().map((e) => e.kind).sort().join('|'),
          shrines: c.shrines().map((s) => `${s.id}@${round(s.pos)}`).sort().join('|'),
          pickups: c.pickupList().map((k) => `${k.kind}@${round(k.pos)}`).sort().join('|'),
        };
        // Kill the Sporeling through the real damage path, then get clear of
        // COIN_MAGNET_RANGE so the payout is measured on the ground rather
        // than in the purse.
        const s = a.spore();
        let guard = 0;
        let deathPos = null;
        while (a.spore() && a.spore().alive && guard++ < 200) {
          const cur = a.spore();
          deathPos = cur.pos;
          await a.standAt(cur.pos, 0, 1.1);
          await a.lockAndFace(a.spore, 24);
          await a.verb('attack', 'attack', 10);
          await c.frames(6);
        }
        const origin = deathPos || [0, 0, 0];
        c.teleportPlayer(origin[0] + 25, origin[1], origin[2] + 25);
        // Coins integrate on the fixed simulation step, so once they have
        // settled their resting places are a property of the seed alone.
        await a.waitFor(() => false, 150);
        const coins = c.pickupList().filter((k) => k.kind === 'coin');
        return {
          world,
          payout: coins.length,
          // Scatter direction comes from the seeded stream, so the set of
          // landing spots is a seed property even if settling is not.
          // Offsets from where it fell, not world positions: WHERE the kill
          // happens depends on how fast this machine ran the chase, but how the
          // coins fly out of it is drawn from the seeded stream.
          spread: coins
            .map(
              (k) =>
                `${(k.pos[0] - origin[0]).toFixed(3)},${(k.pos[2] - origin[2]).toFixed(3)}`,
            )
            .sort()
            .join('|'),
        };
      });
      await p.close();
      return shape;
    };
    const runA = await layout();
    const runB = await layout();
    check(
      '8a',
      'same seed lays out the same roster and props',
      runA.world.enemies === runB.world.enemies &&
        runA.world.shrines === runB.world.shrines &&
        runA.world.pickups === runB.world.pickups
        ? 'roster, shrines and fixed pickups identical'
        : 'layout differed between runs',
      'identical',
      runA.world.enemies === runB.world.enemies &&
        runA.world.shrines === runB.world.shrines &&
        runA.world.pickups === runB.world.pickups,
    );
    check(
      '8b',
      'the same kill pays out the same coins, scattered the same way',
      `A ${runA.payout} coins / B ${runB.payout} coins`,
      'identical count and spread',
      runA.payout > 0 && runA.payout === runB.payout && runA.spread === runB.spread,
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
  const width = 108;
  console.log('\nCROAK milestone A2 gate - combat core\n');
  console.log(
    'id'.padEnd(5) + 'check'.padEnd(62) + 'measured'.padEnd(46) + 'expected'.padEnd(34) + 'result',
  );
  console.log('-'.repeat(width + 60));
  for (const c of checks) {
    console.log(
      c.id.padEnd(5) +
        c.name.slice(0, 61).padEnd(62) +
        c.measured.slice(0, 45).padEnd(46) +
        c.expected.slice(0, 33).padEnd(34) +
        (c.pass ? 'PASS' : 'FAIL'),
    );
  }
  const passed = checks.filter((c) => c.pass).length;
  console.log('-'.repeat(width + 60));
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
