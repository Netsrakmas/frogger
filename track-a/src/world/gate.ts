/**
 * CROAK - the two things that stand in your way. PROMPT.md section 6.
 *
 *   bramble  a thicket only an edge gets through, so it is really a lock whose
 *            key is the Sword. Hitting it with the Stick tells you that in the
 *            only way the game ever tells you anything: it does nothing.
 *   door     the belfry. Locked until you have found the key in the ruins.
 *
 * Both withdraw their collision the instant they open, so the level's BVH does
 * not have to be rebuilt - the gate simply stops being consulted. Nothing here
 * knows what is on the far side; that is the level's business.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Gate, GameContext } from '../core/types';
import {
  BRAMBLE_HP,
  DOOR_INTERACT_RANGE,
  SQUASH_RECOVER,
  TRAUMA_HIT,
} from '../core/constants';
import { makeOutline, material } from '../render/materials';

const EPS = 1e-4;
const BRAMBLE_RADIUS = 1.15;
const DOOR_WIDTH = 2.2;
const DOOR_HEIGHT = 2.8;
const DOOR_THICKNESS = 0.35;
const OPEN_RATE = 2.2;

/** A snarl of angular thorn clumps: unmistakably not a wall, and not a bush. */
function buildBramble(): { mesh: THREE.Mesh; outline: THREE.Mesh } {
  const parts: THREE.BufferGeometry[] = [];
  // Deterministic arrangement - no rng needed, and the same thicket every run.
  const clumps = [
    [0, 0.42, 0, 1.0],
    [0.55, 0.3, 0.2, 0.72],
    [-0.5, 0.34, -0.25, 0.8],
    [0.2, 0.62, -0.5, 0.62],
    [-0.28, 0.58, 0.45, 0.66],
  ];
  for (const [x, y, z, scale] of clumps) {
    const clump = new THREE.IcosahedronGeometry(BRAMBLE_RADIUS * 0.42 * scale, 0);
    clump.translate(x, y, z);
    parts.push(clump);
  }
  // Thorns: thin spikes that make the silhouette read as hostile.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const spike = new THREE.ConeGeometry(0.06, 0.5, 4);
    spike.rotateZ(Math.PI * 0.5);
    spike.rotateY(angle);
    spike.translate(
      Math.sin(angle) * BRAMBLE_RADIUS * 0.6,
      0.5 + (i % 3) * 0.16,
      Math.cos(angle) * BRAMBLE_RADIUS * 0.6,
    );
    parts.push(spike);
  }
  // Icosahedrons come out non-indexed and cones come out indexed, and
  // mergeGeometries refuses a mixture. Normalising to non-indexed is the
  // cheaper direction and matches the flat-shaded look these want anyway.
  const flattened = parts.map((part) => (part.index === null ? part : part.toNonIndexed()));
  const geometry = mergeGeometries(flattened);
  for (const part of parts) part.dispose();
  for (const part of flattened) if (!parts.includes(part)) part.dispose();
  const mesh = new THREE.Mesh(geometry, material('canopy', { flatShading: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, outline: makeOutline(mesh) };
}

function buildDoor(): { mesh: THREE.Mesh; outline: THREE.Mesh } {
  const slab = new THREE.BoxGeometry(DOOR_WIDTH, DOOR_HEIGHT, DOOR_THICKNESS);
  slab.translate(0, DOOR_HEIGHT * 0.5, 0);
  const band = new THREE.BoxGeometry(DOOR_WIDTH * 1.04, 0.16, DOOR_THICKNESS * 1.3);
  band.translate(0, DOOR_HEIGHT * 0.66, 0);
  const band2 = band.clone();
  band2.translate(0, -DOOR_HEIGHT * 0.36, 0);
  const geometry = mergeGeometries([slab, band, band2]);
  slab.dispose();
  band.dispose();
  band2.dispose();
  const mesh = new THREE.Mesh(geometry, material('ruinCool', { flatShading: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, outline: makeOutline(mesh) };
}

export function createGate(
  scene: THREE.Scene,
  id: string,
  kind: 'bramble' | 'door',
  position: THREE.Vector3,
  yaw = 0,
): Gate {
  const root = new THREE.Group();
  root.name = `gate:${id}`;
  root.position.copy(position);
  root.rotation.y = yaw;

  const built = kind === 'bramble' ? buildBramble() : buildDoor();
  root.add(built.mesh);
  root.add(built.outline);
  scene.add(root);

  const pos = position.clone();
  const radius = kind === 'bramble' ? BRAMBLE_RADIUS : DOOR_WIDTH * 0.6;
  let hp = kind === 'bramble' ? BRAMBLE_HP : 1;
  let open = false;
  /** Drives the dissolve; collision is gone long before the visual is. */
  let fade = 0;
  let shake = 0;

  return {
    root,
    id,
    kind,
    get alive(): boolean {
      return true;
    },
    get position(): THREE.Vector3 {
      return pos;
    },
    get open(): boolean {
      return open;
    },
    get blocking(): boolean {
      return !open;
    },

    inRange(from: THREE.Vector3): boolean {
      const limit = kind === 'door' ? DOOR_INTERACT_RANGE : radius + 0.6;
      return Math.hypot(from.x - pos.x, from.z - pos.z) <= limit;
    },

    /**
     * `cuts` is the weapon's own claim about having an edge. A Stick reports
     * false and is answered with a shudder and nothing else, which is the whole
     * lesson: the wall is not tougher, your stick is blunt.
     */
    strike(damage: number, cuts: boolean, ctx: GameContext): boolean {
      if (open || kind !== 'bramble') return false;
      shake = 1;
      if (!cuts) return false;
      hp = Math.max(0, hp - Math.max(1, damage));
      ctx.spawnFx('brambleCut', new THREE.Vector3(pos.x, pos.y + 0.6, pos.z));
      if (hp > 0) return true;
      open = true;
      ctx.addTrauma(TRAUMA_HIT);
      return true;
    },

    get blockRadius(): number {
      return radius;
    },

    /** A mechanism opened it - no key spent, no edge required. */
    release(ctx: GameContext): void {
      if (open) return;
      open = true;
      ctx.addTrauma(TRAUMA_HIT);
      ctx.spawnFx('shrineRest', new THREE.Vector3(pos.x, pos.y + 0.4, pos.z));
    },

    unlock(ctx: GameContext): boolean {
      if (open || kind !== 'door') return false;
      if (!ctx.progress.spendKey()) return false;
      open = true;
      ctx.addTrauma(TRAUMA_HIT);
      ctx.spawnFx('shrineRest', new THREE.Vector3(pos.x, pos.y + 0.4, pos.z));
      return true;
    },

    update(dt: number, _ctx: GameContext): void {
      shake = Math.max(0, shake - dt * 6);
      if (open && fade < 1) fade = Math.min(1, fade + OPEN_RATE * dt);

      // Bramble collapses into the ground; the door swings back into its frame.
      if (kind === 'bramble') {
        const scale = Math.max(EPS, 1 - fade);
        built.mesh.scale.setScalar(scale);
        built.outline.scale.setScalar(scale);
      } else {
        const swing = fade * Math.PI * 0.62;
        built.mesh.rotation.y = swing;
        built.outline.rotation.y = swing;
      }
      root.position.set(
        pos.x + Math.sin(shake * 40) * 0.04 * shake,
        pos.y,
        pos.z,
      );
      built.mesh.scale.y +=
        (1 - built.mesh.scale.y) * Math.min(1, SQUASH_RECOVER * dt) * (open ? 0 : 1);
    },

    dispose(): void {
      root.removeFromParent();
      built.mesh.geometry.dispose();
      built.outline.geometry.dispose();
    },
  };
}
