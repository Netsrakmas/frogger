/**
 * CROAK - the fixed-timestep loop. PROMPT.md section 1: 1/60 s accumulator,
 * clamped at MAX_STEPS_PER_FRAME, render interpolation, and THREE CLOCKS that
 * must never be confused with one another:
 *
 *   simTime     - advances only when the simulation steps. Frozen by hitstop.
 *   presentTime - wall clock across rendered frames. Never frozen (section 9
 *                 rule 7: sim time != wall clock), so UI/particles keep living
 *                 through a freeze.
 *   realDelta   - unscaled seconds since the last rendered frame.
 */

import type { Loop } from './types';
import { MAX_STEPS_PER_FRAME, TICK_DT } from './constants';

/** Spiral-of-death guard: one frame can never bank more work than it can pay off. */
const MAX_FRAME_TIME = TICK_DT * MAX_STEPS_PER_FRAME;
/** fps is an exponential average with this time constant, in seconds. */
const FPS_WINDOW = 1.0;

export interface LoopOptions {
  step: (dt: number) => void;
  render: (alpha: number) => void;
  /**
   * Called once per frame INSTEAD of stepping, while the loop is paused. The
   * pause has to leave one door open or there is no way back out of it: this
   * is where the input that closes the manual gets read.
   */
  whilePaused?: (realDt: number) => void;
}

export function createLoop(opts: LoopOptions): Loop {
  let simTime = 0;
  let presentTime = 0;
  let realDelta = 0;
  let accumulator = 0;
  let frameCount = 0;
  let hitstopRemaining = 0;
  let paused = false;
  let frameTimeAvg = 0;
  let lastNow = 0;
  let rafId = 0;
  let running = false;

  const frame = (now: number): void => {
    if (!running) return;
    // Queue the successor first so a stop() from inside step/render cancels
    // THIS pending id and the loop dies on the same frame it was asked to.
    rafId = requestAnimationFrame(frame);

    realDelta = Math.max(0, (now - lastNow) / 1000);
    lastNow = now;
    presentTime += realDelta;
    frameCount++;

    if (realDelta > 0) {
      const k = 1 - Math.exp(-realDelta / FPS_WINDOW);
      frameTimeAvg =
        frameTimeAvg === 0 ? realDelta : frameTimeAvg + (realDelta - frameTimeAvg) * k;
    }

    if (paused) {
      // A PAUSE IS A FREEZE THAT DOES NOT DRAIN. The simulation clock stops
      // dead - not just the world - because simTime is what every window in
      // the game is measured against, and time spent reading the manual is not
      // time the frog lived through. The accumulator is left alone for the same
      // reason hitstop leaves it alone: resuming must not fire a burst of
      // catch-up steps for time the game deliberately did not live.
      opts.whilePaused?.(realDelta);
    } else if (hitstopRemaining > 0) {
      // Hitstop suspends the SIMULATION only - the frame still renders, and the
      // freeze drains on real time so it lasts the same wall duration at any
      // frame rate. The accumulator is left untouched: resuming must not fire a
      // burst of catch-up steps for time the game deliberately did not live.
      hitstopRemaining = Math.max(0, hitstopRemaining - realDelta);
    } else {
      accumulator = Math.min(accumulator + realDelta, MAX_FRAME_TIME);
      let steps = 0;
      while (accumulator >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
        accumulator -= TICK_DT;
        simTime += TICK_DT;
        steps++;
        opts.step(TICK_DT);
        // An impact inside this step freezes the remainder of the frame, so the
        // freeze starts on the very frame the hit landed (section 9 rule 9).
        if (hitstopRemaining > 0) break;
      }
    }

    opts.render(accumulator / TICK_DT);
  };

  return {
    get simTime(): number {
      return simTime;
    },
    get presentTime(): number {
      return presentTime;
    },
    get realDelta(): number {
      return realDelta;
    },
    get alpha(): number {
      return accumulator / TICK_DT;
    },
    get frameCount(): number {
      return frameCount;
    },
    get fps(): number {
      return frameTimeAvg > 0 ? 1 / frameTimeAvg : 0;
    },
    get paused(): boolean {
      return paused;
    },

    setPaused(value: boolean): void {
      paused = value;
    },

    get hitstopRemaining(): number {
      return hitstopRemaining;
    },
    requestHitstop(seconds: number): void {
      // Overlapping requests take the max, never the sum: two hits in one frame
      // must not stack into a stutter.
      if (seconds > 0 && seconds > hitstopRemaining) hitstopRemaining = seconds;
    },
    start(): void {
      // A remount must never leave two rAF loops alive (section 10 gate).
      if (running) return;
      running = true;
      lastNow = performance.now();
      rafId = requestAnimationFrame(frame);
    },
    stop(): void {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
