/**
 * CROAK - which world to build. PROMPT.md section 6.
 *
 * One place that knows the zone list, so game.ts can tear a zone down and put
 * another one up without knowing what either of them is made of.
 */

import type { Level, Rng, ZoneId } from '../core/types';
import { createDowns } from './level';
import { createBelfry } from './belfry';

export function createZone(rng: Rng, zone: ZoneId): Level {
  // Each zone forks its own stream, so the belfry's glow placement can never
  // shift the meadow's tree placement (section 10's determinism gate).
  return zone === 'belfry'
    ? createBelfry(rng.fork('zone:belfry'))
    : createDowns(rng.fork('zone:downs'));
}
