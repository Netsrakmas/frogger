/**
 * CROAK - the camera rig. PROMPT.md section 2.
 *
 * Orthographic and IMMUTABLE to the player: pitch and yaw are authored per
 * zone, zoom is frustum height and nothing else. The whole diorama read
 * depends on that angle never moving, so this file exposes no rotate/zoom
 * verb at all - only a yaw setter for authored per-zone overrides.
 */

import * as THREE from 'three';
import type { CameraRig } from '../core/types';
import {
  CAM_DISTANCE,
  CAM_FAR,
  CAM_FOLLOW_LAMBDA,
  CAM_LOCKON_LAMBDA,
  CAM_LOCKON_PITCH_DELTA,
  CAM_NEAR,
  CAM_PITCH,
  CAM_VIEW_HEIGHT,
  CAM_YAW,
  SHAKE_CAP,
  SHAKE_DECAY,
  SHAKE_FREQ,
  SHAKE_MAX_OFFSET,
  SHAKE_MAX_ROLL,
} from '../core/constants';

// ------------------------------------------------------------- rig tuning
// Rig-shape numbers rather than feel tunables: they describe how the rig is
// wired, not how the game plays, so they sit with the rig.

/** Decorrelated noise channels: camera roll, then the two camera-plane axes. */
const CH_ROLL = 0;
const CH_OFFSET_X = 1327;
const CH_OFFSET_Y = 8093;

/** Camera-local axes. -Z is the look direction; +Z is the roll axis. */
const LOCAL_ROLL_AXIS = new THREE.Vector3(0, 0, 1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

// -------------------------------------------------------------------- noise

/** Integer hash -> [-1, 1]. Deterministic, so shake replays with the seed. */
function hash1(n: number): number {
  let h = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 2147483647.5 - 1;
}

/** Quintic fade - C2 continuous, so the shake has no visible corners. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 1D value noise. Shake needs *smooth continuous* noise, not white noise: a
 * fresh random offset every frame reads as a strobe, while a wandering curve
 * reads as an impact. Math.random is forbidden here (section 9 rule 7) and a
 * noise library would be a dependency for twelve lines.
 */
function valueNoise(x: number, channel: number): number {
  const i = Math.floor(x);
  const t = fade(x - i);
  const a = hash1(i + channel);
  const b = hash1(i + 1 + channel);
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------- rig

export function createCameraRig(width: number, height: number): CameraRig {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAM_NEAR, CAM_FAR);
  camera.name = 'croakCamera';
  // The rig drives the quaternion directly, so three's lookAt-style up vector
  // is never consulted; leaving it default keeps the object inspectable.

  let yaw = CAM_YAW;
  let cosYaw = Math.cos(yaw);
  let sinYaw = Math.sin(yaw);

  let pitchOffset = 0;
  let trauma = 0;
  let shakeClock = 0;
  let hasFocus = false;

  const focus = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const settled = new THREE.Quaternion();
  const rollSpin = new THREE.Quaternion();
  const axis = new THREE.Vector3();

  function reframe(w: number, h: number): void {
    const px = Math.max(1, h);
    const aspect = Math.max(1, w) / px;
    const halfHeight = CAM_VIEW_HEIGHT * 0.5;
    const halfWidth = halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }

  reframe(width, height);

  return {
    camera,

    get trauma(): number {
      return trauma;
    },

    /**
     * Screen stick -> ground plane. This is a plain 2D rotation of (x, z) by the
     * rig's yaw, which is why it survives setYaw: "up" tracks whatever angle the
     * zone authored instead of a baked-in 45-degree basis.
     */
    relativeMove(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
      return out.set(x * cosYaw + z * sinYaw, 0, z * cosYaw - x * sinYaw);
    },

    update(dt: number, target: THREE.Vector3, lockOn: boolean): void {
      const step = dt > 0 ? dt : 0;

      trauma = Math.max(0, trauma - SHAKE_DECAY * step);
      shakeClock += step * SHAKE_FREQ;

      // Frame-rate-independent damping throughout: a fixed per-frame lerp
      // factor would make the follow tighter at 144 Hz than at 60.
      const wantPitch = lockOn ? CAM_LOCKON_PITCH_DELTA : 0;
      pitchOffset +=
        (wantPitch - pitchOffset) * (1 - Math.exp(-CAM_LOCKON_LAMBDA * step));

      if (hasFocus) {
        focus.lerp(target, 1 - Math.exp(-CAM_FOLLOW_LAMBDA * step));
      } else {
        // First frame has no history to damp against; damping from the origin
        // would fly the camera across the level while the player waits.
        focus.copy(target);
        hasFocus = true;
      }

      euler.set(CAM_PITCH + pitchOffset, yaw, 0);
      settled.setFromEuler(euler);

      // Ortho: CAM_DISTANCE changes nothing about framing, only what sits in
      // front of the near plane. Pull back along the view axis, never down it.
      axis.copy(LOCAL_FORWARD).applyQuaternion(settled);
      camera.position.copy(focus).addScaledVector(axis, -CAM_DISTANCE);
      camera.quaternion.copy(settled);

      // Shake is applied ON TOP of the settled transform, recomputed from
      // scratch every frame. Integrating it into the rig's own state is how
      // shake turns into permanent drift after a busy fight.
      const shake = trauma * trauma;
      if (shake > 0) {
        // Rotational-only (Eiserloh, GDC 2016): a 3D camera translated in world
        // space punches through geometry and breaks parallax. Roll is the real
        // rotation; the camera-plane slide is the ortho equivalent of a small
        // pitch/yaw nudge, and it never moves along the view axis.
        rollSpin.setFromAxisAngle(
          LOCAL_ROLL_AXIS,
          SHAKE_MAX_ROLL * shake * valueNoise(shakeClock, CH_ROLL),
        );
        camera.quaternion.multiply(rollSpin);

        let nx = valueNoise(shakeClock, CH_OFFSET_X);
        let ny = valueNoise(shakeClock, CH_OFFSET_Y);
        // Two independent axes at full amplitude would reach sqrt(2) * the cap
        // diagonally; clamp the vector, not each component.
        const len = Math.hypot(nx, ny);
        if (len > 1) {
          nx /= len;
          ny /= len;
        }
        const amp = SHAKE_MAX_OFFSET * shake;
        axis.copy(LOCAL_RIGHT).applyQuaternion(settled);
        camera.position.addScaledVector(axis, nx * amp);
        axis.copy(LOCAL_UP).applyQuaternion(settled);
        camera.position.addScaledVector(axis, ny * amp);
      }

      camera.updateMatrixWorld();
    },

    addTrauma(amount: number): void {
      if (amount <= 0) return;
      trauma = Math.min(SHAKE_CAP, trauma + amount);
    },

    resize(w: number, h: number): void {
      reframe(w, h);
    },

    setYaw(next: number): void {
      yaw = next;
      cosYaw = Math.cos(next);
      sinYaw = Math.sin(next);
    },
  };
}
