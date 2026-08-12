#!/usr/bin/env node
/**
 * CROAK - live deployment check.
 *
 * The build passing locally says nothing about the deployed one: the usual
 * failure is a page that returns 200 and renders nothing, because an asset path
 * that worked from the project root 404s under a Pages subpath. So this drives
 * the REAL live URL in a real browser and asserts the same things the local
 * gate does - no console errors, no failed requests, a canvas with actual
 * pixels in it, and input that moves the frog.
 *
 * Usage: node tests/live.mjs [url]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_UNDER_TEST = process.argv[2] ?? 'https://netsrakmas.github.io/frogger/';

const GL_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--mute-audio',
];

const checks = [];
const notes = [];
const check = (name, measured, expected, pass) =>
  checks.push({ name, measured: String(measured), expected: String(expected), pass: !!pass });

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort()) {
    const exe = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

/** Enough pixel variance to prove the canvas is a scene, not a flat fill. */
async function canvasVariance(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return -1;
    const off = document.createElement('canvas');
    off.width = 160;
    off.height = 90;
    const ctx = off.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(canvas, 0, 0, off.width, off.height);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  });
}

async function run(browser, url, label, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 720 },
    hasTouch: !!opts.touch,
    // A fresh context each time, so nothing is served from a warm cache.
    bypassCSP: false,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  const external = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!r.ok() && r.status() !== 304) failed.push(`${r.status()} ${r.url()}`);
    if (u.origin !== new URL(url).origin && u.protocol !== 'data:') external.push(u.origin);
  });

  const response = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const status = response ? response.status() : 0;

  // The boot veil lifts on the first rendered frame; if it never lifts, the
  // page "loaded" but the game did not.
  let booted = false;
  try {
    await page.waitForFunction(
      () => {
        const veil = document.getElementById('boot');
        return !veil || veil.classList.contains('gone') || !document.body.contains(veil);
      },
      null,
      { timeout: 45000 },
    );
    booted = true;
  } catch {
    booted = false;
  }

  await page.waitForTimeout(1500);
  const variance = await canvasVariance(page);

  // Drive the real thing: hold a key and see whether anything happens on screen.
  const beforeShot = await page.screenshot({ clip: { x: 320, y: 140, width: 640, height: 440 } });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);
  const afterShot = await page.screenshot({ clip: { x: 320, y: 140, width: 640, height: 440 } });
  const moved = Buffer.compare(beforeShot, afterShot) !== 0;

  const touchButtons = await page.evaluate(
    () => document.querySelectorAll('.croak-touch__btn').length,
  );

  const shot = path.join(HERE, 'shots', `live-${label}.png`);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });

  await context.close();
  return {
    status,
    booted,
    variance,
    moved,
    touchButtons,
    consoleErrors,
    pageErrors,
    failed,
    external: [...new Set(external)],
    shot,
  };
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), args: GL_ARGS });
  try {
    console.log(`\nCROAK live check\n  ${URL_UNDER_TEST}\n`);

    const desktop = await run(browser, URL_UNDER_TEST, 'desktop');
    check('the live URL responds 200', desktop.status, '200', desktop.status === 200);
    check(
      'the game actually boots (the veil lifts on the first frame)',
      desktop.booted ? 'veil lifted' : 'veil never lifted - page loaded but the game did not start',
      'boots',
      desktop.booted,
    );
    check(
      'the canvas has a real scene in it, not a flat fill',
      `luminance sigma ${desktop.variance.toFixed(2)}`,
      '> 4',
      desktop.variance > 4,
    );
    check(
      'a real keypress changes what is on screen',
      desktop.moved ? 'frame changed under held W' : 'nothing moved',
      'changes',
      desktop.moved,
    );
    check(
      'zero console errors on the live page',
      desktop.consoleErrors.length ? desktop.consoleErrors.join(' | ') : 'none',
      'none',
      desktop.consoleErrors.length === 0,
    );
    check(
      'zero page errors',
      desktop.pageErrors.length ? desktop.pageErrors.join(' | ') : 'none',
      'none',
      desktop.pageErrors.length === 0,
    );
    check(
      'no failed requests (this is where subpath 404s show up)',
      desktop.failed.length ? desktop.failed.slice(0, 3).join(' | ') : 'none',
      'none',
      desktop.failed.length === 0,
    );
    check(
      'no third-party origins fetched at runtime',
      desktop.external.length ? desktop.external.join(', ') : 'none',
      'none',
      desktop.external.length === 0,
    );
    check(
      'the touch layer stays absent on a desktop pointer',
      `${desktop.touchButtons} buttons`,
      '0',
      desktop.touchButtons === 0,
    );

    // A phone-sized, touch-capable context: the layer must appear here.
    const mobile = await run(browser, URL_UNDER_TEST, 'mobile', {
      touch: true,
      viewport: { width: 414, height: 896 },
    });
    check(
      'it boots on a phone-sized touch viewport too',
      mobile.booted ? `booted, canvas sigma ${mobile.variance.toFixed(2)}` : 'veil never lifted',
      'boots',
      mobile.booted && mobile.variance > 4,
    );
    check(
      'and the on-screen controls appear there',
      `${mobile.touchButtons} buttons`,
      '6',
      mobile.touchButtons === 6,
    );
    check(
      'no console errors on mobile either',
      mobile.consoleErrors.length ? mobile.consoleErrors.join(' | ') : 'none',
      'none',
      mobile.consoleErrors.length === 0,
    );

    notes.push(`screenshots: ${desktop.shot}, ${mobile.shot}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const width = 62;
  console.log('check'.padEnd(width) + 'measured'.padEnd(46) + 'expected'.padEnd(12) + 'result');
  console.log('-'.repeat(width + 66));
  for (const c of checks) {
    console.log(
      c.name.slice(0, width - 2).padEnd(width) +
        c.measured.slice(0, 44).padEnd(46) +
        c.expected.slice(0, 10).padEnd(12) +
        (c.pass ? 'PASS' : 'FAIL'),
    );
  }
  const passed = checks.filter((c) => c.pass).length;
  console.log('-'.repeat(width + 66));
  console.log(`${passed}/${checks.length} passed`);
  for (const n of notes) console.log(`  - ${n}`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
