/**
 * CROAK - boot. PROMPT.md section 9 rule 13: the first screen is the GAME.
 *
 * There is no menu and no landing page. The veil in index.html is a paint
 * guard, not a screen: it dismisses itself the moment a real frame exists, so
 * the player's first input can drive the frog within a second of load.
 */

import { DEFAULT_SEED } from './core/constants';
import { createGame } from './game';
import type { Game } from './game';
import { createTestApi } from './testapi';

/** Comfortably past the veil's 380 ms CSS transition, as a belt-and-braces cut. */
const VEIL_CUT_MS = 600;

const params = new URLSearchParams(window.location.search);

/** Never in a plain production load: the harness is not shipped UI (rule 12). */
const TEST_ENABLED = import.meta.env.DEV || params.get('test') === '1';

/** A seed override makes a reported run reproducible from its URL alone. */
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isFinite(seedParam) ? seedParam >>> 0 : DEFAULT_SEED;

/**
 * The opening letter is part of every real load. Only an explicit ?test=1
 * boot suppresses it - the harness's hundred sim-driven measurements must not
 * each begin by reading the mail - and ?letter=1 puts it back so the story
 * gate can boot WITH it and measure it like everything else.
 */
const SHOW_LETTER = params.get('letter') === '1' || params.get('test') !== '1';

const canvasParent = document.getElementById('app') ?? document.body;
const hudParent = document.getElementById('hud');
const veil = document.getElementById('boot');

let game: Game | null = null;
let veilTimer = 0;

function dismissVeil(): void {
  if (veil === null || veil.classList.contains('gone')) return;
  veil.classList.add('gone');
  // Remove the node rather than leaving a transparent full-screen div sitting
  // over the canvas swallowing nothing forever.
  veil.addEventListener('transitionend', () => veil.remove(), { once: true });
  veilTimer = window.setTimeout(() => veil.remove(), VEIL_CUT_MS);
}

/**
 * A lost context is not an error: the browser reclaims GPU memory on its own
 * schedule. Stop stepping while it is gone - three restores its own resources
 * on the restore event - and pick the loop back up afterwards.
 */
function onContextLost(event: Event): void {
  // Without preventDefault the restore event never fires at all.
  event.preventDefault();
  if (game !== null) game.stop();
}

function onContextRestored(): void {
  if (game !== null) game.start();
}

function teardown(): void {
  const instance = game;
  game = null;
  if (veilTimer !== 0) {
    window.clearTimeout(veilTimer);
    veilTimer = 0;
  }
  if (instance === null) return;

  instance.canvas.removeEventListener('webglcontextlost', onContextLost);
  instance.canvas.removeEventListener('webglcontextrestored', onContextRestored);
  instance.dispose();
  window.__croak = undefined;
}

function boot(): void {
  // A hot reload that boots on top of a live game leaves two rAF loops and two
  // sets of input listeners driving one canvas (section 10's remount gate).
  if (game !== null) teardown();

  let instance: Game;
  try {
    instance = createGame(canvasParent, hudParent, seed, { letter: SHOW_LETTER });
  } catch (err) {
    // The veil is the only surface that exists this early, and it can only
    // draw: a shipped build carries no font (rule 12) and stays silent on the
    // console (section 10). So the mark goes out and the fault stroke goes
    // over it - "this did not start", without claiming to know why.
    if (veil !== null) veil.classList.add('fault');
    // A build that cannot construct is a development problem, and swallowing
    // the reason here is how a missing dependency or a revision mismatch ends
    // up looking like a graphics-driver story. Production stays quiet.
    if (import.meta.env.DEV) throw err;
    return;
  }

  game = instance;
  instance.canvas.addEventListener('webglcontextlost', onContextLost);
  instance.canvas.addEventListener('webglcontextrestored', onContextRestored);

  if (TEST_ENABLED) window.__croak = createTestApi(instance);

  const off = instance.onFrame(() => {
    off();
    dismissVeil();
  });

  instance.start();
}

boot();

if (import.meta.hot) {
  import.meta.hot.dispose(teardown);
}
