/**
 * CROAK - seeded RNG. PROMPT.md section 1/9: `Math.random` is forbidden in
 * gameplay. Every stream in the game descends from the one recorded seed, so
 * "same seed => same spawns/drops" is a property of the whole build.
 */

import type { Rng } from './types';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Child seeds hash the label against the PARENT SEED, never the parent's
 * current state: adding a `fork()` call site anywhere must not shift any other
 * stream's sequence, or the determinism gate would break on every edit.
 */
function hashLabel(label: string, seed: number): number {
  let h = (FNV_OFFSET_BASIS ^ seed) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = (h ^ label.charCodeAt(i)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  // Avalanche the result: sibling labels ("spawn:0"/"spawn:1") differ by one
  // bit after FNV, and mulberry32 would echo that in its first few draws.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: 32 bits of state, ~2^32 period, fast enough to call per-frame. */
export function createRng(seed: number): Rng {
  const rootSeed = seed >>> 0;
  let state = rootSeed | 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed: rootSeed,
    next,
    range(min: number, max: number): number {
      return min + next() * (max - min);
    },
    int(minInclusive: number, maxExclusive: number): number {
      const span = maxExclusive - minInclusive;
      if (span <= 0) return minInclusive;
      return minInclusive + Math.floor(next() * span);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error('rng.pick: empty list');
      }
      return items[Math.floor(next() * items.length)];
    },
    fork(label: string): Rng {
      return createRng(hashLabel(label, rootSeed));
    },
  };
}
