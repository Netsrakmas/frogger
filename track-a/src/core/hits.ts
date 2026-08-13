/**
 * CROAK - the vertical half of a hit. PROMPT.md section 1 (analytic combat).
 *
 * Every melee overlap in the game is a disc test on the ground plane plus THIS
 * interval test on the up axis. It exists because the discs alone made height
 * meaningless: a deck-level sword swing connected with a Heron hovering
 * HERON_HOVER overhead, and a Sporeling on the belfry's ground floor could
 * bite a frog standing a whole storey above it.
 *
 * The shape is deliberately simple - the attacker swings through a window from
 * STRIKE_REACH_DOWN below its feet to `reachUp` above them, and the victim is
 * a vertical interval from its feet to its hurtHeight - because every player
 * and enemy position in the game is a FOOT position. One shared function, so
 * no entity can quietly disagree about what "in reach" means vertically.
 */

import type * as THREE from 'three';
import { HURT_HEIGHT, STRIKE_REACH_DOWN, STRIKE_REACH_UP } from './constants';

interface HeightTarget {
  readonly position: THREE.Vector3;
  /** Vertical extent of the hurt volume, feet up. Defaults to HURT_HEIGHT. */
  readonly hurtHeight?: number;
}

/**
 * True when the attacker's swing window overlaps the target's hurt interval.
 *
 * @param attackerY the attacker's FOOT height.
 * @param reachUp how far above its feet this particular blow reaches - the
 *   arrival slash passes LUNGE_SLASH's tall window here, everything else
 *   takes the default.
 */
export function inStrikeHeight(
  attackerY: number,
  target: HeightTarget,
  reachUp: number = STRIKE_REACH_UP,
  reachDown: number = STRIKE_REACH_DOWN,
): boolean {
  const foot = target.position.y;
  const top = foot + (target.hurtHeight ?? HURT_HEIGHT);
  return foot <= attackerY + reachUp && top >= attackerY - reachDown;
}
