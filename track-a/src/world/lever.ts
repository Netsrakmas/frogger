/**
 * CROAK - sluice levers. PROMPT.md section 6, the belfry's floor 2.
 *
 * The whole reason these exist is that they are OUT OF REACH. They stand on
 * pillars in flooded water the frog cannot cross, so the only way to throw one
 * is the tongue - which turns the signature verb from a combat trick into the
 * solution to a room. A lever you could walk up to and press would teach
 * nothing.
 *
 * The lever knows only whether it is up or down. What that means - which
 * sluice, what water level, which door - belongs to the room watching them.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, Lever } from '../core/types';
import { SQUASH_RECOVER, TRAUMA_HIT } from '../core/constants';
import { makeOutline, material } from '../render/materials';

const HOUSING_RADIUS = 0.3;
const HOUSING_HEIGHT = 0.5;
const HANDLE_LENGTH = 0.78;
const HANDLE_RADIUS = 0.07;
/** Swing between up and down, in radians from vertical. */
const THROW_ANGLE = Math.PI * 0.42;
const SWING_RATE = 9.0;

export function createLever(
  scene: THREE.Scene,
  id: string,
  position: THREE.Vector3,
  startOn = false,
): Lever {
  const root = new THREE.Group();
  root.name = `lever:${id}`;
  root.position.copy(position);

  const baseGeo = new THREE.CylinderGeometry(
    HOUSING_RADIUS,
    HOUSING_RADIUS * 1.2,
    HOUSING_HEIGHT,
    6,
  );
  baseGeo.translate(0, HOUSING_HEIGHT * 0.5, 0);
  const housing = new THREE.Mesh(baseGeo, material('ruinCool', { flatShading: true }));
  housing.castShadow = true;
  housing.receiveShadow = true;
  root.add(housing);

  // The handle is the whole read at gameplay zoom, so it is long and heavy.
  const shaftGeo = new THREE.CylinderGeometry(HANDLE_RADIUS, HANDLE_RADIUS, HANDLE_LENGTH, 5);
  shaftGeo.translate(0, HANDLE_LENGTH * 0.5, 0);
  const knobGeo = new THREE.SphereGeometry(HANDLE_RADIUS * 2.1, 6, 5);
  knobGeo.translate(0, HANDLE_LENGTH, 0);
  const handleGeo = mergeGeometries([shaftGeo, knobGeo]);
  shaftGeo.dispose();
  knobGeo.dispose();

  const handle = new THREE.Mesh(handleGeo, material('gold', { emissive: true }));
  handle.castShadow = true;
  handle.position.y = HOUSING_HEIGHT * 0.8;
  root.add(handle);

  const outline = makeOutline(housing);
  root.add(outline);
  scene.add(root);

  const pos = position.clone();
  let on = startOn;
  let swing = startOn ? THROW_ANGLE : -THROW_ANGLE;

  return {
    root,
    id,
    get alive(): boolean {
      return true;
    },
    get position(): THREE.Vector3 {
      return pos;
    },
    get on(): boolean {
      return on;
    },

    pull(ctx: GameContext): void {
      on = !on;
      ctx.addTrauma(TRAUMA_HIT * 0.4);
      ctx.spawnFx('tongueHit', new THREE.Vector3(pos.x, pos.y + HANDLE_LENGTH, pos.z));
    },

    update(dt: number, _ctx: GameContext): void {
      const want = on ? THROW_ANGLE : -THROW_ANGLE;
      swing += (want - swing) * Math.min(1, SWING_RATE * dt);
      handle.rotation.x = swing;
      // A thrown lever settles with a little weight rather than snapping.
      handle.scale.y += (1 - handle.scale.y) * Math.min(1, SQUASH_RECOVER * dt);
    },

    dispose(): void {
      root.removeFromParent();
      baseGeo.dispose();
      handleGeo.dispose();
      outline.geometry.dispose();
    },
  };
}
