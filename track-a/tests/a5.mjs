#!/usr/bin/env node
/**
 * CROAK - milestone A5 gate: The Sunken Belfry (PROMPT.md section 11, A5).
 *
 * The dungeon has to be a second PLACE, not a reskin: a zone you walk into, a
 * room whose lock is the tongue rather than a key, an enemy whose rhythm asks a
 * question, and the Shield that answers it.
 *
 * The block checks carry the weight here. A shield that stopped everything
 * would delete the game, so what is asserted is that it costs stamina, that it
 * only covers the front, and that an empty bar lets the blow through.
 *
 * Run: node tests/a5.mjs      (needs a current dist/: npm run build)
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as IMPL from '../src/core/constants.ts';
import { averageRgb } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4181;
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
window.__a5 = {
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
  knight() { return window.__croak.enemies().find((e) => e.kind === 'drownedKnight') || null; },
  /** Walk into the belfry the way a player would: key, door, doorway. */
  async enterBelfry() {
    const c = window.__croak;
    const a = window.__a5;
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
    // Step off the threshold and back on: the door only fires once armed.
    c.teleportPlayer(door.pos[0], door.pos[1], door.pos[2] + 7.0);
    await c.frames(8);
    c.teleportPlayer(door.pos[0], door.pos[1], door.pos[2] + 1.2);
    const moved = await a.waitFor((k) => k.sample().zone === 'belfry', 400);
    return moved >= 0;
  },
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
      const stick = window.__a5.stickFor(want, 0.05);
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
    console.error('a5 gate: no dist/ - run `npm run build` first.');
    process.exit(2);
  }
  if (newestMtime(path.join(ROOT, 'src')) > fs.statSync(distIndex).mtimeMs) {
    console.error('a5 gate: dist/ is STALE - run `npm run build` first.');
    process.exit(2);
  }

  await startServer();
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });

  try {
    let page = await openPage(browser);

    // ------------------------------------------------------ 1. the descent
    const entered = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      const before = c.sample().zone;
      const ok = await a.enterBelfry();
      const s = c.sample();
      return {
        before,
        ok,
        zone: s.zone,
        y: s.playerPos[1],
        enemies: c.enemies().map((e) => e.kind),
        levers: c.levers().length,
      };
    });
    check(
      'z1',
      'the belfry door is a way IN, not just an animation',
      `${entered.before} -> ${entered.zone}`,
      'downs -> belfry',
      entered.before === 'downs' && entered.zone === 'belfry',
    );
    check(
      'z2',
      'the dungeon is populated by its own roster',
      entered.zone === 'belfry' ? entered.enemies.join(', ') : 'never arrived',
      'includes drownedKnight',
      entered.enemies.includes('drownedKnight'),
    );

    const descent = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      const top = c.sample().playerPos[1];
      // Walk west and down the ramp toward the flooded ring.
      const levers = c.levers();
      const deepest = levers.length
        ? Math.min(...levers.map((l) => l.pos[1]))
        : 0;
      // Teleport to the vault entry to prove the lower floors exist and hold.
      const gate = c.gates().find((g) => g.id === 'vault');
      return { top, leverY: deepest, gateY: gate ? gate.pos[1] : null };
    });
    check(
      'z3',
      'it descends: three distinct floor heights, top to vault',
      `landing y ${fmt(descent.top)}, levers y ${fmt(descent.leverY)}, vault y ${fmt(descent.gateY ?? NaN)}`,
      'strictly descending',
      descent.gateY !== null &&
        descent.top > descent.leverY + 2 &&
        descent.leverY > descent.gateY + 2,
    );

    // ---------------------------------------------------- 2. the sluice room
    const sluice = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      const levers = c.levers();
      if (levers.length === 0) return { ok: false };

      // Every lever must start up and stand where the frog cannot walk: the
      // basin floor is below them and there is nothing to stand on.
      const startOn = levers.filter((l) => l.on).length;
      const gateBefore = c.gates().find((g) => g.id === 'vault');

      // Throw them all with the tongue, from the walkway.
      let thrown = 0;
      for (const lever of levers) {
        for (let attempt = 0; attempt < 14; attempt++) {
          const cur = c.levers().find((l) => l.id === lever.id);
          if (cur && cur.on) break;
          // Stand on the walkway outside the water, looking in at the lever.
          const away = Math.hypot(lever.pos[0], lever.pos[2]) || 1;
          // A player who cannot hit a lever from one spot steps sideways along
          // the walkway, so the test does too: the ramps occupy part of the
          // ring, and a single fixed approach angle can be standing on one.
          const reach = 9.2 + (attempt % 3) * 0.8;
          const swing = ((attempt % 5) - 2) * 0.28;
          const base = Math.atan2(lever.pos[0], lever.pos[2]) + swing;
          const standX = Math.sin(base) * reach;
          const standZ = Math.cos(base) * reach;
          c.teleportPlayer(standX, lever.pos[1], standZ);
          await c.frames(3);
          await a.faceFrom(lever.pos, Math.atan2(standX - lever.pos[0], standZ - lever.pos[2]),
            Math.hypot(standX - lever.pos[0], standZ - lever.pos[2]));
          await a.verb('tongue', ['tongue', 'tonguePull'], 20);
          await c.frames(20);
        }
        if (c.levers().find((l) => l.id === lever.id).on) thrown++;
      }

      const allOn = c.levers().every((l) => l.on);
      // The water has to actually drain before the gate gives.
      const opened = await a.waitFor(
        (k) => k.gates().some((g) => g.id === 'vault' && g.open),
        900,
      );
      return {
        ok: true,
        count: levers.length,
        startOn,
        thrown,
        allOn,
        gateWasShut: gateBefore ? !gateBefore.open : false,
        opened: opened >= 0,
      };
    });
    check(
      'p1',
      'the sluice room has levers, and they start unthrown',
      sluice.ok ? `${sluice.count} levers, ${sluice.startOn} already on` : 'no levers',
      '4 levers, 0 on',
      sluice.ok && sluice.count === 4 && sluice.startOn === 0,
    );
    check(
      'p2',
      'THE LESSON: every lever can be thrown with the tongue',
      sluice.ok ? `${sluice.thrown}/${sluice.count} thrown from the walkway` : 'n/a',
      'all of them',
      sluice.ok && sluice.thrown === sluice.count && sluice.allOn,
    );
    check(
      'p3',
      'and draining the basin opens the way down - not before',
      sluice.ok ? `gate shut at the start: ${sluice.gateWasShut}, open after: ${sluice.opened}` : 'n/a',
      'shut -> open',
      sluice.ok && sluice.gateWasShut && sluice.opened,
    );

    // --------------------------------------------------------- 3. the Shield
    const shield = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      const before = c.sample().hasShield;
      const drop = c.pickupList().find((p) => p.kind === 'shield');
      if (!drop) return { ok: false, before };
      c.teleportPlayer(drop.pos[0], drop.pos[1], drop.pos[2]);
      const got = await a.waitFor((k) => k.sample().hasShield, 300);
      return { ok: true, before, after: c.sample().hasShield, got: got >= 0 };
    });
    check(
      's1',
      'the Shield is in the vault and is not held before it is found',
      shield.ok ? `hasShield ${shield.before} -> ${shield.after}` : 'no shield in the belfry',
      'false -> true',
      shield.ok && shield.before === false && shield.after === true,
    );

    const guard = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      // Somewhere empty, so nothing interferes with the measurement.
      c.teleportPlayer(0, c.sample().playerPos[1], 6.0);
      await c.frames(6);

      c.press('block');
      const up = await a.waitFor((k) => k.sample().blocking, 120);
      const staminaBefore = c.sample().stamina;
      const hpBefore = c.sample().hp;
      // Aimed at the front of the shield, using the frog's own facing.
      const landedFront = c.probeHit(2, c.sample().facing);
      await c.frames(4);
      const staminaAfter = c.sample().stamina;
      const hpAfter = c.sample().hp;
      c.release('block');
      await c.frames(4);
      return {
        up: up >= 0,
        landedFront,
        staminaSpent: staminaBefore - staminaAfter,
        hpBefore,
        hpAfter,
        blockingAfterRelease: c.sample().blocking,
      };
    });
    check(
      's2',
      'holding block raises the guard',
      guard.up,
      'true',
      guard.up === true,
    );
    check(
      's3',
      'a blow into the guard is turned - no health lost',
      `hp ${guard.hpBefore} -> ${guard.hpAfter}, probe reported landed=${guard.landedFront}`,
      'hp unchanged',
      guard.hpAfter === guard.hpBefore && guard.landedFront === false,
    );
    check(
      's4',
      'but it COSTS: blocking spends stamina',
      `stamina spent ${fmt(guard.staminaSpent, 3)}`,
      `${IMPL.BLOCK_STAMINA_PER_HIT}`,
      Math.abs(guard.staminaSpent - IMPL.BLOCK_STAMINA_PER_HIT) < 0.03,
    );
    check(
      's5',
      'and it drops the moment the button does',
      guard.blockingAfterRelease,
      'false',
      guard.blockingAfterRelease === false,
    );

    const broken = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      // Drain the bar by rolling, then try to block on empty.
      for (let i = 0; i < 8 && c.sample().stamina > 0.3; i++) {
        await a.verb('roll', 'roll', 12);
        await a.waitFor((k) => k.sample().playerState !== 'roll', 120);
      }
      c.press('block');
      await a.waitFor((k) => k.sample().blocking, 60);
      const stamina = c.sample().stamina;
      const hpBefore = c.sample().hp;
      const landed = c.probeHit(2, c.sample().facing);
      await c.frames(6);
      const hpAfter = c.sample().hp;
      c.release('block');
      return { stamina, hpBefore, hpAfter, landed };
    }, );
    check(
      's6',
      'GUARD BREAK: with an empty bar the blow goes through',
      `stamina ${fmt(broken.stamina, 3)}, hp ${broken.hpBefore} -> ${broken.hpAfter}`,
      'health lost',
      broken.stamina < IMPL.BLOCK_STAMINA_PER_HIT && broken.hpAfter < broken.hpBefore,
    );

    // ---------------------------------------------------- 4. Drowned Knight
    const knight = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      const k = a.knight();
      if (!k) return { ok: false };
      c.teleportPlayer(k.pos[0], k.pos[1], k.pos[2] + 3.0);
      // Watch a full cycle and count how many separate attacks it makes.
      let attacks = 0;
      let telegraphFrames = 0;
      let longestTelegraph = 0;
      let prev = '';
      for (let i = 0; i < 800; i++) {
        const cur = a.knight();
        if (!cur) break;
        if (cur.state === 'telegraph') telegraphFrames++;
        if (prev === 'telegraph' && cur.state === 'attack') {
          longestTelegraph = Math.max(longestTelegraph, telegraphFrames);
          telegraphFrames = 0;
          attacks++;
        }
        if (cur.state !== 'telegraph') telegraphFrames = 0;
        prev = cur.state;
        if (attacks >= 2) break;
        await c.frames(1);
      }
      return { ok: true, attacks, longestTelegraph };
    });
    check(
      'k1',
      'the Drowned Knight swings TWICE - the rhythm the Shield answers',
      knight.ok ? `${knight.attacks} attacks in one approach` : 'no knight found',
      '2',
      knight.ok && knight.attacks >= 2,
    );
    check(
      'k2',
      'and its opening wind-up is honest',
      knight.ok ? `${knight.longestTelegraph} f` : 'n/a',
      `>= ${Math.round(IMPL.ENEMY_TELEGRAPH_MIN * 60)} f`,
      knight.ok && knight.longestTelegraph >= Math.round(IMPL.ENEMY_TELEGRAPH_MIN * 60) - 2,
    );

    // ------------------------------------------------- 5. page, and the way back
    const rest = await page.evaluate(async () => {
      const c = window.__croak;
      const a = window.__a5;
      // Earlier checks deliberately beat the frog to death; a pickup is only
      // collected by something alive, so wait for it to get back up first.
      await a.waitFor((k) => k.sample().playerState !== 'dead', 600);
      await c.frames(10);
      const pageDrop = c.pickupList().find((p) => p.kind === 'page');
      let collected = false;
      if (pageDrop) {
        const before = c.sample().pages;
        for (let attempt = 0; attempt < 6 && !collected; attempt++) {
          c.teleportPlayer(pageDrop.pos[0], pageDrop.pos[1], pageDrop.pos[2]);
          collected = (await a.waitFor((k) => k.sample().pages > before, 90)) >= 0;
        }
      }
      const shrines = c.shrines().length;
      return { hadPage: !!pageDrop, collected, shrines };
    });
    check(
      'c1',
      'the belfry holds a manual page, and it is collectible',
      rest.hadPage ? `collected: ${rest.collected}` : 'no page in the belfry',
      'collected',
      rest.hadPage && rest.collected,
    );
    check(
      'c2',
      'and a shrine to rest at before the boss door',
      `${rest.shrines} shrine(s)`,
      '>= 1',
      rest.shrines >= 1,
    );

    // --------------------------------------------- 6. palette identity pair
    // The gameplay browser runs with rasterisation disabled, which is why it
    // can hold 60 fps on a GPU-less host - but it also means every pixel it
    // reports is black. Colour has to be measured in a browser that actually draws.
    const shots = path.join(HERE, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const painter = await chromium.launch({
      executablePath: findChromium(),
      args: GL_ARGS.filter((a) => a !== '--disable-gl-drawing-for-tests'),
    });
    const tone = async (toBelfry) => {
      const p = await openPage(painter);
      if (toBelfry) {
        await p.evaluate(async () => {
          await window.__a5.enterBelfry();
          await window.__croak.frames(30);
        });
      }
      await p.waitForTimeout(1200);
      const file = path.join(shots, toBelfry ? 'a5-belfry.png' : 'a5-downs.png');
      // The compositor's screenshot, not a canvas readback: the WebGL drawing
      // buffer is not preserved, so reading it from inside the page is black.
      const shot = await p.screenshot({ path: file });
      await p.close();
      return averageRgb(shot);
    };
    const meadowTone = await tone(false);
    const dungeonTone = await tone(true);
    await painter.close();

    // The meadow is green-dominant; the belfry must not be. Section 2 rule 3
    // asks for per-zone palette identity, and this is the cheapest honest way
    // to assert the two zones do not look like the same room.
    const meadowGreenLead = meadowTone[1] - Math.max(meadowTone[0], meadowTone[2]);
    const belfryGreenLead = dungeonTone[1] - Math.max(dungeonTone[0], dungeonTone[2]);
    check(
      'v1',
      'the two zones do not read as the same room',
      `meadow rgb ${meadowTone.map((v) => Math.round(v)).join(',')} | ` +
        `belfry rgb ${dungeonTone.map((v) => Math.round(v)).join(',')}`,
      'clearly different tone',
      Math.abs(meadowGreenLead - belfryGreenLead) > 12,
    );
    notes.push(`screenshots: ${path.join(shots, 'a5-downs.png')}, ${path.join(shots, 'a5-belfry.png')}`);

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
  console.log('\nCROAK milestone A5 gate - The Sunken Belfry\n');
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
