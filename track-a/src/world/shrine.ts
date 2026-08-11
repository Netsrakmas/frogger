/**
 * CROAK - fox shrines, minus the fox. PROMPT.md section 5: "SHRINE rest = full
 * heal + refill potions + respawn regular enemies".
 *
 * A shrine is deliberately dumb. It knows whether it has been lit, whether the
 * frog is close enough to reach it, and how to look pleased about being rested
 * at. What resting actually DOES - the heal, the enemy refill, moving the
 * checkpoint - belongs to game.ts, which owns the run. Keeping the rule out of
 * here is what stops a second shrine in A5 from quietly disagreeing with the
 * first about what a rest means.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Entity, GameContext, Shrine } from '../core/types';
import { SHRINE_INTERACT_RANGE, SQUASH_RECOVER } from '../core/constants';
import { makeOutline, material } from '../render/materials';

const EPS = 1e-4;
const BASE_RADIUS = 0.44;
const BASE_HEIGHT = 0.26;
const PILLAR_HEIGHT = 0.9;
const FLAME_RADIUS = 0.13;
const GLOW_RATE = 2.2;
const PULSE_DECAY = 1.6;

interface ShrineModel {
  visual: THREE.Group;
  flame: THREE.Mesh;
  geometries: THREE.BufferGeometry[];
}

/**
 * A weathered marker stone with a cold flame on top. Unlit it is just stone -
 * the gold only arrives when the shrine is yours, so "claimed" is legible from
 * across the meadow without a single word of UI.
 */
function buildShrine(): ShrineModel {
  const visual = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  const baseGeo = new THREE.CylinderGeometry(BASE_RADIUS, BASE_RADIUS * 1.15, BASE_HEIGHT, 6);
  baseGeo.translate(0, BASE_HEIGHT * 0.5, 0);
  const pillarGeo = new THREE.CylinderGeometry(
    BASE_RADIUS * 0.42,
    BASE_RADIUS * 0.55,
    PILLAR_HEIGHT,
    6,
  );
  pillarGeo.translate(0, BASE_HEIGHT + PILLAR_HEIGHT * 0.5, 0);
  const stoneGeo = mergeGeometries([baseGeo, pillarGeo]);
  baseGeo.dispose();
  pillarGeo.dispose();

  const stone = new THREE.Mesh(stoneGeo, material('ruinCool', { flatShading: true }));
  stone.castShadow = true;
  stone.receiveShadow = true;
  visual.add(stone);
  geometries.push(stoneGeo);

  const flameGeo = new THREE.ConeGeometry(FLAME_RADIUS, FLAME_RADIUS * 2.4, 6);
  flameGeo.translate(0, BASE_HEIGHT + PILLAR_HEIGHT + FLAME_RADIUS * 1.2, 0);
  const flame = new THREE.Mesh(flameGeo, material('stoneShade', { flatShading: true }));
  visual.add(flame);
  geometries.push(flameGeo);

  const outline = makeOutline(stone);
  visual.add(outline);
  geometries.push(outline.geometry);

  return { visual, flame, geometries };
}

export function createShrine(
  scene: THREE.Scene,
  id: string,
  position: THREE.Vector3,
): Shrine & Entity {
  const root = new THREE.Group();
  root.name = `shrine:${id}`;
  const model = buildShrine();
  root.add(model.visual);
  root.position.copy(position);
  scene.add(root);

  const litMaterial = material('gold', { emissive: true, flatShading: true });
  const coldMaterial = model.flame.material as THREE.Material;

  const pos = position.clone();
  let claimed = false;
  let pulse = 0;
  let age = 0;

  return {
    root,
    id,
    get alive(): boolean {
      return true;
    },
    get position(): THREE.Vector3 {
      return pos;
    },
    get claimed(): boolean {
      return claimed;
    },

    inRange(from: THREE.Vector3): boolean {
      return Math.hypot(from.x - pos.x, from.z - pos.z) <= SHRINE_INTERACT_RANGE;
    },

    claim(): void {
      claimed = true;
    },

    pulse(): void {
      pulse = 1;
    },

    update(dt: number, _ctx: GameContext): void {
      age += dt;
      pulse = Math.max(0, pulse - PULSE_DECAY * dt);

      model.flame.material = claimed ? litMaterial : coldMaterial;
      // Lit shrines breathe; a fresh rest sends one bigger swell through it.
      const breath = claimed ? 1 + Math.sin(age * GLOW_RATE) * 0.09 : 1;
      const swell = 1 + pulse * 0.55;
      model.flame.scale.setScalar(Math.max(EPS, breath * swell));
      model.flame.rotation.y = age * 0.8;
      model.visual.scale.y +=
        (1 - model.visual.scale.y) * Math.min(1, SQUASH_RECOVER * dt);
    },

    dispose(): void {
      root.removeFromParent();
      for (const geometry of model.geometries) geometry.dispose();
    },
  };
}
