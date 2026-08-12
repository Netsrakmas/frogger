/**
 * Which way the camera sits from any point, on the ground plane.
 *
 * The rig pulls back along a FIXED view axis (section 2: the camera is
 * immutable), so this is a constant of the whole game. Level code uses it to
 * place cover deliberately - a secret that is hidden because a randomly placed
 * tree happened to land in front of it is not a secret, it is luck, and it
 * stops being hidden the next time the generator is touched.
 */

import * as THREE from 'three';
import { CAM_PITCH, CAM_YAW } from '../core/constants';

const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(
  new THREE.Quaternion().setFromEuler(new THREE.Euler(CAM_PITCH, CAM_YAW, 0)),
);

const length = Math.hypot(axis.x, axis.z) || 1;

/** Unit vector on the ground plane pointing from the world toward the camera. */
export const TO_CAMERA = { x: -axis.x / length, z: -axis.z / length };
