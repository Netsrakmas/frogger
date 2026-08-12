/**
 * CROAK - the things you pick up. PROMPT.md section 5 (DEATH) and section 3.
 *
 * Three kinds share one body because they share one rule: they sit in the
 * world, they drift to the frog when it is close, and they vanish into it.
 *   coin   - one unit of the purse, scattered by a kill
 *   ghost  - the purse you dropped when you died, waiting where you fell
 *   weapon - the Sword, sitting in a secret until someone finds it
 *
 * The ghost is the only one that matters to the loop: it holds everything the
 * last death cost, and dying again while it is out there is what loses it for
 * good. That rule lives in game.ts, which owns the run; this file only knows
 * how to be a thing on the ground.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  GameContext,
  Pickup,
  PickupKind,
  Rng,
} from '../core/types';
import type { WeaponId } from '../core/constants';
import {
  COIN_MAGNET_RANGE,
  COIN_MAGNET_SPEED,
  COIN_PICKUP_RANGE,
  COIN_SETTLE,
  SQUASH_RECOVER,
} from '../core/constants';
import { material } from '../render/materials';

const TAU = Math.PI * 2;
const EPS = 1e-4;

const COIN_RADIUS = 0.11;
const COIN_THICKNESS = 0.03;
const GHOST_RADIUS = 0.3;
const SPIN_RATE = 2.4;
const BOB_RATE = 3.0;
const BOB_AMPLITUDE = 0.05;
const HOVER = 0.22;
/** Coins burst outward from a kill, then fall back and settle. */
const SCATTER_SPEED = 2.6;
const SCATTER_GRAVITY = -9.0;

// -------------------------------------------------------------------- coins

/** A thin faceted disc, edge-on to the camera so it reads as a coin, not a dot. */
function buildCoinGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    COIN_RADIUS,
    COIN_RADIUS,
    COIN_THICKNESS,
    7,
  );
  geometry.rotateX(Math.PI * 0.5);
  return geometry;
}

export function createCoin(
  scene: THREE.Scene,
  position: THREE.Vector3,
  rng: Rng,
): Pickup {
  const geometry = buildCoinGeometry();
  const mesh = new THREE.Mesh(geometry, material('gold', { emissive: true }));
  mesh.castShadow = false;
  scene.add(mesh);

  const pos = position.clone();
  const groundY = position.y;
  const angle = rng.next() * TAU;
  const speed = rng.range(SCATTER_SPEED * 0.4, SCATTER_SPEED);
  const velocity = new THREE.Vector3(
    Math.sin(angle) * speed,
    SCATTER_SPEED * 0.7,
    Math.cos(angle) * speed,
  );
  const spinPhase = rng.next() * TAU;

  let age = 0;
  let collected = false;
  let settled = false;
  /** The tongue caught it: come in from wherever, no magnet range. */
  let lured = false;

  mesh.position.copy(pos);

  return {
    root: mesh,
    kind: 'coin' as PickupKind,
    value: 1,
    lure(): void {
      lured = true;
      settled = true;
    },
    get alive(): boolean {
      return !collected;
    },
    get position(): THREE.Vector3 {
      return pos;
    },

    update(dt: number, ctx: GameContext): void {
      if (collected) return;
      age += dt;

      if (!settled) {
        velocity.y += SCATTER_GRAVITY * dt;
        pos.addScaledVector(velocity, dt);
        if (pos.y <= groundY) {
          pos.y = groundY;
          settled = true;
        }
      }

      // Inert for a beat, so a kill's spray is visible before it is absorbed -
      // unless a tongue asked for it, which overrides the wait and the range.
      if ((lured || age >= COIN_SETTLE) && ctx.player.alive) {
        const dx = ctx.player.position.x - pos.x;
        const dz = ctx.player.position.z - pos.z;
        const distance = Math.hypot(dx, dz);
        if (distance <= COIN_PICKUP_RANGE) {
          collected = true;
          ctx.progress.add(1);
          ctx.spawnFx('coinPop', new THREE.Vector3(pos.x, pos.y + HOVER, pos.z));
          mesh.visible = false;
          return;
        }
        if ((lured || distance <= COIN_MAGNET_RANGE) && distance > EPS) {
          const pull = Math.min(distance, COIN_MAGNET_SPEED * (lured ? 2.2 : 1) * dt);
          pos.x += (dx / distance) * pull;
          pos.z += (dz / distance) * pull;
        }
      }

      const hover = settled
        ? HOVER + Math.sin(age * BOB_RATE + spinPhase) * BOB_AMPLITUDE
        : 0;
      mesh.position.set(pos.x, pos.y + hover, pos.z);
      mesh.rotation.y = age * SPIN_RATE + spinPhase;
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
    },
  };
}

// -------------------------------------------------------------------- ghost

/**
 * What death costs, standing where it happened. Bigger and calmer than a coin
 * so it reads across the meadow: this is a place you have to get back to.
 */
export function createGhost(
  scene: THREE.Scene,
  position: THREE.Vector3,
  value: number,
): Pickup {
  const bodyGeo = new THREE.SphereGeometry(GHOST_RADIUS, 7, 5);
  const tailGeo = new THREE.ConeGeometry(GHOST_RADIUS * 0.8, GHOST_RADIUS * 1.2, 7);
  tailGeo.rotateX(Math.PI);
  tailGeo.translate(0, -GHOST_RADIUS * 0.75, 0);
  const geometry = mergeGeometries([bodyGeo, tailGeo]);
  bodyGeo.dispose();
  tailGeo.dispose();

  const mesh = new THREE.Mesh(
    geometry,
    material('hazeSky', { emissive: true, transparent: true, opacity: 0.82 }),
  );
  scene.add(mesh);

  const pos = position.clone();
  let age = 0;
  let collected = false;
  let lured = false;

  return {
    root: mesh,
    kind: 'ghost' as PickupKind,
    value,
    lure(): void {
      lured = true;
    },
    get alive(): boolean {
      return !collected;
    },
    get position(): THREE.Vector3 {
      return pos;
    },

    update(dt: number, ctx: GameContext): void {
      if (collected) return;
      age += dt;

      if (ctx.player.alive) {
        const dx = ctx.player.position.x - pos.x;
        const dz = ctx.player.position.z - pos.z;
        const distance = Math.hypot(dx, dz);
        // A tongue can reel your own purse back to you across the gap that
        // killed you, which is exactly the fantasy the mechanic should sell.
        if (lured && distance > EPS) {
          const pull = Math.min(distance, COIN_MAGNET_SPEED * 2.2 * dt);
          pos.x += (dx / distance) * pull;
          pos.z += (dz / distance) * pull;
        }
        if (distance <= GHOST_RADIUS + ctx.player.hurtRadius) {
          collected = true;
          ctx.progress.add(value);
          ctx.hud.toast('coins', value);
          ctx.spawnFx('coinPop', new THREE.Vector3(pos.x, pos.y + HOVER, pos.z));
          mesh.visible = false;
          return;
        }
      }

      mesh.position.set(
        pos.x,
        pos.y + GHOST_RADIUS + Math.sin(age * BOB_RATE * 0.6) * BOB_AMPLITUDE * 1.6,
        pos.z,
      );
      mesh.rotation.y = age * SPIN_RATE * 0.3;
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
    },
  };
}

// -------------------------------------------------------------- page / key

/**
 * A folded leaf of the manual, or the belfry key. Both are single tokens that
 * exist to be found, so they share a body and differ only in what they are
 * worth and what they look like. A7 turns the pages into the booklet itself.
 */
export function createToken(
  scene: THREE.Scene,
  position: THREE.Vector3,
  kind: 'page' | 'key' | 'shield',
  index = 0,
): Pickup {
  const geometry =
    kind === 'shield'
      ? (() => {
          // A kite shield: broad at the shoulder, tapering to a point.
          const face = new THREE.CylinderGeometry(0.28, 0.28, 0.06, 6);
          face.rotateX(Math.PI * 0.5);
          face.scale(1, 1.35, 1);
          const boss = new THREE.SphereGeometry(0.09, 6, 5);
          boss.translate(0, 0.02, 0.05);
          const merged = mergeGeometries([face, boss]);
          face.dispose();
          boss.dispose();
          return merged;
        })()
      : kind === 'page'
      ? (() => {
          // A single leaf with a fold, held upright so it reads at any angle.
          const sheet = new THREE.BoxGeometry(0.34, 0.44, 0.012);
          const fold = new THREE.BoxGeometry(0.1, 0.44, 0.012);
          fold.rotateY(0.5);
          fold.translate(0.2, 0, 0.03);
          const merged = mergeGeometries([sheet, fold]);
          sheet.dispose();
          fold.dispose();
          return merged;
        })()
      : (() => {
          const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6);
          const bow = new THREE.TorusGeometry(0.1, 0.032, 5, 9);
          bow.translate(0, 0.26, 0);
          const bit = new THREE.BoxGeometry(0.14, 0.06, 0.05);
          bit.translate(0.07, -0.16, 0);
          const merged = mergeGeometries([shaft, bow, bit]);
          shaft.dispose();
          bow.dispose();
          bit.dispose();
          return merged;
        })();

  const mesh = new THREE.Mesh(
    geometry,
    material(kind === 'page' ? 'heroBelly' : kind === 'shield' ? 'ruinCool' : 'gold', {
      emissive: kind === 'key',
    }),
  );
  mesh.castShadow = true;
  scene.add(mesh);

  const pos = position.clone();
  let age = 0;
  let collected = false;
  let lured = false;

  return {
    root: mesh,
    kind: kind as PickupKind,
    value: index,
    lure(): void {
      lured = true;
    },
    get alive(): boolean {
      return !collected;
    },
    get position(): THREE.Vector3 {
      return pos;
    },

    update(dt: number, ctx: GameContext): void {
      if (collected) return;
      age += dt;

      if (ctx.player.alive) {
        const dx = ctx.player.position.x - pos.x;
        const dz = ctx.player.position.z - pos.z;
        const distance = Math.hypot(dx, dz);
        if (lured && distance > EPS) {
          const pull = Math.min(distance, COIN_MAGNET_SPEED * 2.2 * dt);
          pos.x += (dx / distance) * pull;
          pos.z += (dz / distance) * pull;
        }
        if (distance <= COIN_PICKUP_RANGE + ctx.player.hurtRadius) {
          collected = true;
          if (kind === 'page') {
            ctx.progress.addPage(index);
            ctx.hud.toast('page', ctx.progress.pages.length);
          } else if (kind === 'shield') {
            ctx.progress.grantShield();
            ctx.hud.toast('shield');
          } else {
            ctx.progress.addKey();
            ctx.hud.toast('key');
          }
          ctx.spawnFx('coinPop', new THREE.Vector3(pos.x, pos.y + 0.5, pos.z));
          mesh.visible = false;
          return;
        }
      }

      mesh.position.set(
        pos.x,
        pos.y + 0.5 + Math.sin(age * BOB_RATE * 0.8) * BOB_AMPLITUDE * 1.5,
        pos.z,
      );
      mesh.rotation.y = age * SPIN_RATE * 0.55;
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
    },
  };
}

// ------------------------------------------------------------------- weapon

/**
 * A weapon waiting to be found. It teaches itself: the blade is the same shape
 * the frog will be swinging a second later, so the pickup needs no words.
 */
export function createWeaponPickup(
  scene: THREE.Scene,
  position: THREE.Vector3,
  weapon: WeaponId,
): Pickup {
  const bladeGeo = new THREE.BoxGeometry(0.07, 0.66, 0.03);
  bladeGeo.translate(0, 0.33, 0);
  const guardGeo = new THREE.BoxGeometry(0.26, 0.05, 0.06);
  const gripGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.2, 6);
  gripGeo.translate(0, -0.1, 0);
  const geometry = mergeGeometries([bladeGeo, guardGeo, gripGeo]);
  bladeGeo.dispose();
  guardGeo.dispose();
  gripGeo.dispose();

  const mesh = new THREE.Mesh(geometry, material('gold', { emissive: true }));
  mesh.castShadow = true;
  scene.add(mesh);

  const pos = position.clone();
  let age = 0;
  let collected = false;
  let flourish = 0;
  let lured = false;

  return {
    root: mesh,
    kind: 'weapon' as PickupKind,
    value: 0,
    lure(): void {
      lured = true;
    },
    get alive(): boolean {
      return !collected;
    },
    get position(): THREE.Vector3 {
      return pos;
    },

    update(dt: number, ctx: GameContext): void {
      if (collected) return;
      age += dt;

      if (ctx.player.alive) {
        const dx = ctx.player.position.x - pos.x;
        const dz = ctx.player.position.z - pos.z;
        const distance = Math.hypot(dx, dz);
        if (lured && distance > EPS) {
          const pull = Math.min(distance, COIN_MAGNET_SPEED * 2.2 * dt);
          pos.x += (dx / distance) * pull;
          pos.z += (dz / distance) * pull;
        }
        if (distance <= COIN_PICKUP_RANGE + ctx.player.hurtRadius) {
          collected = true;
          ctx.player.equip(weapon);
          ctx.hud.toast('weapon');
          ctx.spawnFx('coinPop', new THREE.Vector3(pos.x, pos.y + 0.5, pos.z));
          mesh.visible = false;
          return;
        }
      }

      flourish += (1 - flourish) * Math.min(1, SQUASH_RECOVER * dt);
      mesh.position.set(
        pos.x,
        pos.y + 0.55 + Math.sin(age * BOB_RATE * 0.7) * BOB_AMPLITUDE * 1.4,
        pos.z,
      );
      mesh.rotation.y = age * SPIN_RATE * 0.5;
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
    },
  };
}
