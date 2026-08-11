/**
 * CROAK - the overworld light recipe. PROMPT.md section 8.
 *
 * Two lights, forever: one hemisphere fill and one shadow-casting key. Adding
 * a third to brighten a corner is on the forbidden list (section 9 rule 5) -
 * dark spots get fixed with the ramp, the fill colour or the geometry.
 */

import * as THREE from 'three';
import {
  FOG_FAR,
  FOG_NEAR,
  SHADOW_BIAS,
  SHADOW_EXTENT,
  SHADOW_MAP_SIZE,
  SHADOW_NORMAL_BIAS,
} from '../core/constants';
import { color } from './palette';

// ------------------------------------------------------------- style tuning
// Look numbers, not gameplay tunables, so they sit with the recipe they serve.

/**
 * Sun direction, authored against the 45-degree camera yaw so a box shows all
 * three toon bands at once: front face lit, side face mid, back face shadow.
 */
const KEY_DIR = new THREE.Vector3(6, 10, 2).normalize();
/** Far enough back that nothing tall clips the shadow camera's near plane. */
const KEY_DISTANCE = SHADOW_EXTENT * 2.5;
const SHADOW_NEAR = 1.0;
/** Warm key against the cool ramp shadow - the whole chord in one number pair. */
const KEY_INTENSITY = 2.6;
/** Fill only. High enough to keep shadows readable, low enough to keep them shadows. */
const HEMI_INTENSITY = 0.9;

export interface LightingKit {
  readonly key: THREE.DirectionalLight;
  update(playerPos: THREE.Vector3): void;
  dispose(): void;
}

export function createLighting(scene: THREE.Scene): LightingKit {
  const haze = color('hazeSky');

  scene.fog = new THREE.Fog(haze, FOG_NEAR, FOG_FAR);
  // Exactly the fog colour, not a scaled version of it: a palette role dimmed
  // by a scalar is a colour section 2 never authorised, and matching the two is
  // also what makes the far edge of the meadow dissolve into haze instead of
  // ending on a visible seam (section 8's faked shallow depth of field).
  scene.background = haze.clone();

  const hemi = new THREE.HemisphereLight(
    haze,
    color('grassShade'),
    HEMI_INTENSITY,
  );
  hemi.name = 'hemiFill';
  scene.add(hemi);

  const key = new THREE.DirectionalLight(color('stoneLit'), KEY_INTENSITY);
  key.name = 'keyLight';
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  key.shadow.bias = SHADOW_BIAS;
  key.shadow.normalBias = SHADOW_NORMAL_BIAS;

  const shadowCam = key.shadow.camera;
  shadowCam.left = -SHADOW_EXTENT;
  shadowCam.right = SHADOW_EXTENT;
  shadowCam.top = SHADOW_EXTENT;
  shadowCam.bottom = -SHADOW_EXTENT;
  shadowCam.near = SHADOW_NEAR;
  shadowCam.far = KEY_DISTANCE + SHADOW_EXTENT * 2;
  shadowCam.updateProjectionMatrix();

  scene.add(key);
  // The target has to be in the graph or its matrixWorld never updates and
  // the shadow camera silently keeps aiming at the origin.
  scene.add(key.target);

  const offset = KEY_DIR.clone().multiplyScalar(KEY_DISTANCE);

  // The light's orientation is fixed, so its view basis can be built once and
  // reused as the frame we snap in.
  const basis = new THREE.Matrix4().lookAt(
    offset,
    new THREE.Vector3(),
    new THREE.Vector3(0, 1, 0),
  );
  const toWorld = new THREE.Quaternion().setFromRotationMatrix(basis);
  const toLight = toWorld.clone().invert();

  /** World size of one shadow-map texel across the fitted frustum. */
  const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
  const center = new THREE.Vector3();

  return {
    key,

    update(playerPos: THREE.Vector3): void {
      // Quantise the shadow camera's centre to whole texels IN LIGHT SPACE.
      // Sliding it continuously re-rasterises every shadow edge each frame,
      // which reads as crawling, shimmering outlines the moment you walk -
      // the loudest failure mode there is in a fixed-angle iso game. All three
      // axes are snapped, so sub-texel movement leaves the map bit-identical
      // instead of dithering depth under the bias.
      center.copy(playerPos).applyQuaternion(toLight);
      center.x = Math.round(center.x / texel) * texel;
      center.y = Math.round(center.y / texel) * texel;
      center.z = Math.round(center.z / texel) * texel;
      center.applyQuaternion(toWorld);

      key.target.position.copy(center);
      key.position.copy(center).add(offset);
      key.target.updateMatrixWorld();
      key.updateMatrixWorld();
    },

    dispose(): void {
      scene.remove(key, key.target, hemi);
      key.shadow.dispose();
      key.dispose();
      hemi.dispose();
      scene.fog = null;
      scene.background = null;
    },
  };
}
