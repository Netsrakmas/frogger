/**
 * CROAK - the character controller. PROMPT.md section 1: no physics engine.
 *
 * The frog is a capsule (PLAYER_RADIUS x PLAYER_HEIGHT) resolved against the
 * level's BVH with three-mesh-bvh's shapecast, in the manner of the library's
 * own characterMovement example: gather the triangles inside the capsule's
 * bounds, take the deepest overlap, and push the capsule out along it.
 *
 * Two deliberate departures from that example, both because it does not climb
 * stairs. Contacts are classified by the TRIANGLE's normal rather than by the
 * escape direction - a step's top face and its front face hand back the same
 * escape vector at their shared edge, and only the normal says which one the
 * frog is allowed to stand on. And the capsule is pushed one contact at a time,
 * deepest first, instead of accumulating pushes mid-traversal, so the result
 * does not depend on the order the BVH happens to visit triangles in.
 *
 * `position` is the FEET of the capsule, not its centre: everything else in the
 * game (spawn points, model roots, ground-plane combat) reasons about where a
 * character stands. The frog is not the only thing solved here - the enemies
 * walk on the same collider, with their own radius and height.
 *
 * Fully deterministic: fixed iteration counts, no clock reads, no randomness.
 */

import * as THREE from 'three';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import type { CharacterController } from '../core/types';
import {
  GRAVITY,
  GROUND_SNAP,
  MAX_SLOPE,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
  TERMINAL_VELOCITY,
} from '../core/constants';

// ---------------------------------------------------------------- tolerances
// Solver slack, not feel. Every gameplay tunable comes from core/constants;
// these numbers exist only because a float solver needs somewhere to round.

/** Contacts pushed out per resolve. A corner needs more than one. */
const SOLVER_PASSES = 5;
/**
 * Contacts are noticed this far outside the capsule but only pushed against
 * when they actually overlap, so a resting frog keeps reporting its floor
 * instead of flickering between touching and not touching it.
 */
const CONTACT_SKIN = 0.004;
/** Halvings in the landing search. 0.35 u / 2^6 lands within a quarter skin. */
const DESCEND_STEPS = 6;
/** Below this a vector has no usable direction left. */
const TINY = 1e-6;
const MIN_MOVE_SQ = 1e-12;
/**
 * Never advance further than half a body per resolve, or thin walls get
 * tunnelled. Derived from the capsule actually being solved, not from the
 * frog's radius: the same solver carries enemies, and a smaller body needs a
 * shorter stride to stay inside its own skin.
 */
const SUBSTEP_FRACTION = 0.5;
const MAX_SUBSTEPS = 4;
/** Cap on widening a flattened wall push, so a grazing normal cannot fling. */
const WALL_PUSH_LIMIT = 2;
/** Forward progress below this counts as blocked when deciding to try a step. */
const PROGRESS_EPS = 1e-4;

export interface ControllerOptions {
  radius?: number;
  height?: number;
  gravity?: number;
  /** Anything steeper than this is a wall: you slide, you do not climb. */
  maxSlope?: number;
  stepHeight?: number;
  groundSnap?: number;
}

interface BvhGeometry {
  boundsTree?: MeshBVH;
}

export function createController(
  collider: THREE.Mesh,
  start: THREE.Vector3,
  opts: ControllerOptions = {},
): CharacterController {
  const radius = opts.radius ?? PLAYER_RADIUS;
  const height = Math.max(opts.height ?? PLAYER_HEIGHT, radius * 2);
  const gravity = opts.gravity ?? GRAVITY;
  const stepHeight = opts.stepHeight ?? STEP_HEIGHT;
  const groundSnap = opts.groundSnap ?? GROUND_SNAP;
  /** A face this vertical or better is standable. */
  const walkLimit = Math.cos(opts.maxSlope ?? MAX_SLOPE);
  const maxSubstep = radius * SUBSTEP_FRACTION;

  const position = start.clone();
  let velocityY = 0;
  let grounded = false;

  // Scratch. Allocating inside move() would hand the collector a per-frame
  // sawtooth right where the frame budget is tightest.
  const segment = new THREE.Line3();
  const centre = new THREE.Vector3();
  const worldBox = new THREE.Box3();
  const localBox = new THREE.Box3();
  const worldTri = new ExtendedTriangle();
  const triPoint = new THREE.Vector3();
  const capPoint = new THREE.Vector3();
  const escape = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const bestEscape = new THREE.Vector3();
  const beforeMove = new THREE.Vector3();
  const plainResult = new THREE.Vector3();
  const toWorld = new THREE.Matrix4();
  const toLocal = new THREE.Matrix4();

  let bvh: MeshBVH | null = null;

  // Written by the probe, read by the movement passes.
  let bestDepth = 0;
  let bestScore = 0;
  let contactFloor = false;
  let contactWall = false;
  let contactCeiling = false;
  /** Highest contact the frog is allowed to treat as a step rather than a wall. */
  let supportLimit = 0;

  /**
   * Resolved on first use, not at construction: the level owns the collider's
   * BVH, and it may finish building it after the player has been created.
   */
  function tree(): MeshBVH {
    if (bvh === null) {
      const geometry = collider.geometry as THREE.BufferGeometry & BvhGeometry;
      bvh = geometry.boundsTree ?? new MeshBVH(geometry);
    }
    return bvh;
  }

  /**
   * Re-read once per move rather than cached at construction: a level that is
   * parented or repositioned after the player exists must not leave the solver
   * testing against where its geometry used to be.
   */
  function syncTransform(): void {
    collider.updateWorldMatrix(true, false);
    toWorld.copy(collider.matrixWorld);
    toLocal.copy(toWorld).invert();
  }

  const boundsCheck = (box: THREE.Box3): boolean => box.intersectsBox(localBox);

  const triangleCheck = (candidate: ExtendedTriangle): void => {
    // The BVH stores triangles in collider space; lifting them to world space
    // keeps every slope test honest under a transformed or scaled level.
    worldTri.a.copy(candidate.a).applyMatrix4(toWorld);
    worldTri.b.copy(candidate.b).applyMatrix4(toWorld);
    worldTri.c.copy(candidate.c).applyMatrix4(toWorld);
    worldTri.needsUpdate = true;

    const distance = worldTri.closestPointToSegment(segment, triPoint, capPoint);
    if (distance > radius + CONTACT_SKIN) return;

    worldTri.getNormal(normal);
    escape.subVectors(capPoint, triPoint);
    if (escape.lengthSq() < TINY) {
      // The capsule axis runs through the face, so the closest points coincide
      // and carry no direction. The face normal is all that is left.
      segment.getCenter(centre);
      if (normal.dot(centre.sub(triPoint)) < 0) normal.negate();
      escape.copy(normal);
    } else {
      escape.normalize();
      if (normal.dot(escape) < 0) normal.negate();
    }

    const overlap = radius - distance;
    let depth = overlap;
    // A walkable face low enough to step onto is a floor, whatever direction
    // the capsule has to leave it in. Everything else is a wall or a ceiling.
    const supportive = normal.y >= walkLimit && triPoint.y <= supportLimit;

    if (supportive) {
      contactFloor = true;
    } else if (normal.y <= -walkLimit) {
      contactCeiling = true;
    } else {
      contactWall = true;
      if (escape.y > 0) {
        // Steeper than MAX_SLOPE, or too high to step onto. Flattening the
        // escape means the capsule is shoved out sideways while gravity keeps
        // working on it: the frog slides instead of ratcheting up the face.
        const horizontal = Math.hypot(escape.x, escape.z);
        if (horizontal <= TINY) return;
        depth = Math.min(depth / horizontal, depth * WALL_PUSH_LIMIT);
        escape.set(escape.x / horizontal, 0, escape.z / horizontal);
      }
    }

    // Deepest OVERLAP wins - ranking on the flattened distance instead would
    // let a step's front face outbid its own top face, which is the whole
    // difference between climbing a kerb and being stopped by one. A floor
    // takes the tie, because at an edge both faces report the same overlap.
    const score = supportive && overlap > 0 ? overlap + CONTACT_SKIN : overlap;
    if (score > bestScore) {
      bestScore = score;
      bestDepth = depth;
      bestEscape.copy(escape);
    }
  };

  /**
   * Deepest overlap between the capsule at `position` and the collider, without
   * moving anything. Returns the penetration depth - zero or less means free -
   * and leaves the escape direction and the contact flags behind it.
   */
  function probe(): number {
    const geometry = tree();

    segment.start.set(position.x, position.y + radius, position.z);
    segment.end.set(position.x, position.y + height - radius, position.z);
    supportLimit = position.y + stepHeight;

    bestScore = 0;
    bestDepth = 0;
    contactFloor = false;
    contactWall = false;
    contactCeiling = false;

    worldBox.makeEmpty();
    worldBox.expandByPoint(segment.start);
    worldBox.expandByPoint(segment.end);
    worldBox.min.addScalar(-(radius + CONTACT_SKIN));
    worldBox.max.addScalar(radius + CONTACT_SKIN);
    localBox.copy(worldBox).applyMatrix4(toLocal);

    geometry.shapecast({
      intersectsBounds: boundsCheck,
      intersectsTriangle: triangleCheck,
    });

    return bestDepth;
  }

  /** Push the capsule out of the collider, one contact at a time. */
  function resolve(): void {
    for (let pass = 0; pass < SOLVER_PASSES; pass++) {
      if (probe() <= 0) return;
      position.addScaledVector(bestEscape, bestDepth);
    }
    probe(); // leave the flags describing where the capsule ended up
  }

  /**
   * Lower the capsule by up to `maxDrop` and stop the instant it touches down.
   * A search rather than a drop-and-depenetrate: from inside a step, the escape
   * direction cannot tell the top face from the front face, and the frog spends
   * the rest of its life shoved back off a 30 cm kerb.
   *
   * Returns true only if it landed on something standable, and restores the
   * starting height when it did not.
   */
  function descend(maxDrop: number): boolean {
    const base = position.y;
    if (maxDrop <= 0) return false;

    position.y = base - maxDrop;
    if (probe() <= 0) {
      position.y = base;
      return false; // nothing within reach: a ledge, not a step
    }

    let free = 0;
    let blocked = maxDrop;
    for (let i = 0; i < DESCEND_STEPS; i++) {
      const mid = (free + blocked) * 0.5;
      position.y = base - mid;
      if (probe() > 0) blocked = mid;
      else free = mid;
    }

    // Settle from just inside the surface: the remaining overlap is a fraction
    // of the skin, so the push cannot drag the capsule sideways.
    position.y = base - blocked;
    resolve();
    if (contactFloor) return true;

    position.y = base;
    resolve();
    return false;
  }

  /**
   * Horizontal motion. The plain attempt already slides along walls; the retry
   * exists only for steps, which present a vertical face no amount of sliding
   * gets over. Lift, advance, land - and keep the result only if it found
   * standable ground AND got further than the plain attempt, so a real wall or
   * a ledge falls back instead of teleporting the frog.
   */
  function applyHorizontal(dx: number, dz: number, canStep: boolean): void {
    beforeMove.copy(position);
    position.x += dx;
    position.z += dz;
    resolve();

    if (!canStep || !contactWall) return;

    const wanted = dx * dx + dz * dz;
    const plainGain =
      (position.x - beforeMove.x) * dx + (position.z - beforeMove.z) * dz;
    if (plainGain >= wanted - PROGRESS_EPS) return;
    plainResult.copy(position);

    position.set(beforeMove.x, beforeMove.y + stepHeight, beforeMove.z);
    resolve();
    const lift = position.y - beforeMove.y;
    if (lift < stepHeight - PROGRESS_EPS) {
      // Something overhead ate the lift; there is no room to step.
      position.copy(plainResult);
      return;
    }

    position.x += dx;
    position.z += dz;
    resolve();

    const landed = descend(position.y - beforeMove.y);
    const stepGain =
      (position.x - beforeMove.x) * dx + (position.z - beforeMove.z) * dz;
    if (!landed || stepGain <= plainGain + PROGRESS_EPS) {
      position.copy(plainResult);
    }
  }

  function move(displacement: THREE.Vector3, dt: number): void {
    if (dt <= 0) return;
    syncTransform();

    const reach = Math.max(
      Math.hypot(displacement.x, displacement.z),
      Math.abs(displacement.y) + Math.abs(velocityY) * dt,
    );
    const steps = Math.min(
      MAX_SUBSTEPS,
      Math.max(1, Math.ceil(reach / maxSubstep)),
    );
    const stepDt = dt / steps;
    const dx = displacement.x / steps;
    const dy = displacement.y / steps;
    const dz = displacement.z / steps;

    for (let i = 0; i < steps; i++) {
      const wasGrounded = grounded;
      // Standing still still accrues a frame of gravity, which is what keeps a
      // resting capsule a fraction of a millimetre inside its floor and its
      // ground contact alive.
      if (wasGrounded && velocityY < 0) velocityY = 0;
      // Terminal velocity is a tunnelling guard as much as a feel rule: the
      // sweep only ever takes MAX_SUBSTEPS bites, so an unbounded fall would
      // eventually cover more ground in one frame than the capsule can see.
      velocityY = Math.max(TERMINAL_VELOCITY, velocityY + gravity * stepDt);

      if (dx * dx + dz * dz > MIN_MOVE_SQ) applyHorizontal(dx, dz, wasGrounded);
      position.y += velocityY * stepDt + dy;
      resolve();

      if (contactFloor && velocityY <= 0) {
        grounded = true;
        velocityY = 0;
      } else {
        if (contactCeiling && velocityY > 0) velocityY = 0;
        grounded = false;
        // Downslope stick: without it a frog running off the crest of a ramp
        // launches itself and stair-steps down the far side.
        if (wasGrounded && velocityY <= 0 && descend(groundSnap)) {
          grounded = true;
          velocityY = 0;
        }
      }
    }
  }

  function teleport(to: THREE.Vector3): void {
    syncTransform();
    position.copy(to);
    velocityY = 0;
    resolve();
    grounded = contactFloor;
    // A spawn point authored a hair above its floor should stand on it, not
    // spend the first frames of the game falling.
    if (!grounded && descend(groundSnap)) grounded = true;
  }

  return {
    get position(): THREE.Vector3 {
      return position;
    },
    get grounded(): boolean {
      return grounded;
    },
    get velocityY(): number {
      return velocityY;
    },
    move,
    teleport,
  };
}
