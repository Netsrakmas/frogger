/**
 * CROAK - the tongue. PROMPT.md section 4, the signature verb.
 *
 * ONE button, and what happens is decided by what it hits:
 *
 *   item / coin / page   vacuumed to the frog from full range. Free delight.
 *   light enemy          comes to you and ends up in your mouth. Throw it.
 *   medium enemy         cannot be lifted, but CAN be dragged off balance and
 *                        spun round - which is how a Beetle Guard's shield ends
 *                        up pointing the wrong way.
 *   heavy / grapple post you go to IT, and attacking on arrival is the lunge
 *                        slash the whole mechanic is built around.
 *
 * This file owns the rope: aiming, the tip's flight out and back, and which of
 * the four rows applies. What each row DOES belongs to the thing on the other
 * end - enemies resolve their own mass rule in onTongue(), pickups answer
 * lure(). That is what keeps a fifth row from having to be added here.
 */

import * as THREE from 'three';
import type {
  Damageable,
  Enemy,
  GameContext,
  GrapplePost,
  Lever,
  Pickup,
  TongueOutcome,
} from '../core/types';
import {
  TONGUE_EXTEND_SPEED,
  TONGUE_OVERSHOOT,
  TONGUE_RANGE,
  TONGUE_RETRACT_SPEED,
} from '../core/constants';
import { material } from '../render/materials';

const TAU = Math.PI * 2;
const EPS = 1e-4;
/** Where the tongue leaves the frog's head. */
export const MOUTH_HEIGHT = 0.62;
const TONGUE_WIDTH = 0.085;
/** The tip is fatter than the rope, so a whiff still reads as a tongue. */
const TIP_RADIUS = 0.1;
/** Aim assist: how far off the facing a target may sit and still be taken. */
const AIM_CONE = Math.PI * 0.42;
/** A tighter cone when the player is holding aim, so posts can be picked out. */
const AIM_CONE_PRECISE = Math.PI * 0.16;

export type TongueTarget =
  | { kind: 'enemy'; enemy: Enemy; position: THREE.Vector3 }
  | { kind: 'pickup'; pickup: Pickup; position: THREE.Vector3 }
  | { kind: 'post'; post: GrapplePost; position: THREE.Vector3 }
  | { kind: 'lever'; lever: Lever; position: THREE.Vector3 }
  | { kind: 'miss'; position: THREE.Vector3 };

export interface TongueView {
  readonly root: THREE.Object3D;
  /** Draw the rope from the mouth to `tip`. */
  aim(from: THREE.Vector3, tip: THREE.Vector3): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * The rope is one box scaled along its length rather than a rebuilt ribbon:
 * a tongue is a straight thing under tension, and one matrix is cheaper than
 * regenerating geometry every frame inside the 150-call budget.
 */
export function createTongueView(scene: THREE.Scene): TongueView {
  const root = new THREE.Group();
  root.name = 'tongue';

  const ropeGeo = new THREE.BoxGeometry(TONGUE_WIDTH, TONGUE_WIDTH, 1);
  // Anchored at the mouth end so scaling z grows it outward.
  ropeGeo.translate(0, 0, 0.5);
  const rope = new THREE.Mesh(ropeGeo, material('tongue'));
  rope.castShadow = false;
  root.add(rope);

  const tipGeo = new THREE.SphereGeometry(TIP_RADIUS, 7, 5);
  const tip = new THREE.Mesh(tipGeo, material('tongue'));
  root.add(tip);

  root.visible = false;
  scene.add(root);

  const delta = new THREE.Vector3();

  return {
    root,

    aim(from: THREE.Vector3, tipAt: THREE.Vector3): void {
      delta.subVectors(tipAt, from);
      const length = delta.length();
      root.position.copy(from);
      if (length > EPS) {
        root.lookAt(tipAt);
      }
      rope.scale.z = Math.max(EPS, length);
      tip.position.set(0, 0, length);
    },

    setVisible(visible: boolean): void {
      root.visible = visible;
    },

    dispose(): void {
      root.removeFromParent();
      ropeGeo.dispose();
      tipGeo.dispose();
    },
  };
}

// ------------------------------------------------------------------- aiming

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

/**
 * Pick what the tongue would take. Enemies and posts outrank loose items,
 * because a player mid-fight who reaches out is reaching for the fight - but a
 * coin sitting closer than any of them still wins, which is what makes hoovering
 * up a payout feel like the tongue obeying you rather than fighting you.
 */
export function pickTongueTarget(
  ctx: GameContext,
  from: THREE.Vector3,
  facing: number,
  precise: boolean,
): TongueTarget {
  const cone = precise ? AIM_CONE_PRECISE : AIM_CONE;
  let best: TongueTarget | null = null;
  let bestScore = Infinity;

  const consider = (position: THREE.Vector3, make: () => TongueTarget, bias: number): void => {
    const dx = position.x - from.x;
    const dz = position.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (distance > TONGUE_RANGE) return;
    const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
    if (off > cone) return;
    // Distance decides, with a thumb on the scale for things worth grabbing.
    const score = distance * bias + off * 0.6;
    if (score >= bestScore) return;
    bestScore = score;
    best = make();
  };

  for (const enemy of ctx.enemies) {
    if (!enemy.alive || enemy.held) continue;
    consider(enemy.position, () => ({ kind: 'enemy', enemy, position: enemy.position }), 0.8);
  }
  for (const post of ctx.grapplePosts) {
    consider(post.position, () => ({ kind: 'post', post, position: post.position }), 0.8);
  }
  // Levers outrank everything: a lever is only ever placed where the player
  // cannot reach it, so a tongue pointed at one is never pointed at it by
  // accident.
  for (const lever of ctx.levers) {
    consider(lever.position, () => ({ kind: 'lever', lever, position: lever.position }), 0.55);
  }
  for (const pickup of ctx.pickups) {
    if (!pickup.alive) continue;
    consider(pickup.position, () => ({ kind: 'pickup', pickup, position: pickup.position }), 1.0);
  }

  if (best !== null) return best;

  // Nothing in reach: the tongue still goes out its full length and comes back,
  // because a whiff the player can see is what teaches the range.
  return {
    kind: 'miss',
    position: new THREE.Vector3(
      from.x + Math.sin(facing) * TONGUE_RANGE,
      from.y,
      from.z + Math.cos(facing) * TONGUE_RANGE,
    ),
  };
}

// ---------------------------------------------------------------- resolution

export interface TongueResolution {
  outcome: TongueOutcome;
  /** Set when the frog is the one that has to travel. */
  anchor: THREE.Vector3 | null;
  held: Enemy | null;
}

/** Apply the mass rule at the moment the tip arrives. */
export function resolveTongue(
  target: TongueTarget,
  from: THREE.Vector3,
  ctx: GameContext,
): TongueResolution {
  switch (target.kind) {
    case 'pickup': {
      target.pickup.lure();
      return { outcome: 'none', anchor: null, held: null };
    }
    case 'lever': {
      target.lever.pull(ctx);
      return { outcome: 'none', anchor: null, held: null };
    }
    case 'post': {
      return { outcome: 'anchor', anchor: target.post.position.clone(), held: null };
    }
    case 'enemy': {
      const outcome = target.enemy.onTongue(from, ctx);
      if (outcome === 'held') {
        return { outcome, anchor: null, held: target.enemy };
      }
      if (outcome === 'anchor') {
        return { outcome, anchor: target.enemy.position.clone(), held: null };
      }
      return { outcome, anchor: null, held: null };
    }
    case 'miss':
    default:
      return { outcome: 'none', anchor: null, held: null };
  }
}

/** Tip travel for one step, out then back. Returns the new reach. */
export function advanceReach(
  reach: number,
  target: number,
  extending: boolean,
  dt: number,
): number {
  if (extending) {
    // A little past the mark, then settle: the overshoot is what makes it read
    // as elastic rather than telescopic.
    const limit = target * (1 + TONGUE_OVERSHOOT);
    return Math.min(limit, reach + TONGUE_EXTEND_SPEED * dt);
  }
  return Math.max(0, reach - TONGUE_RETRACT_SPEED * dt);
}

export type { Damageable };
