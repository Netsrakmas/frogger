/**
 * CROAK - the leaf cookie. PROMPT.md section 8: "animated leaf-cookie on the
 * key light in the overworld".
 *
 * Not a cookie texture. Three's DirectionalLight has no projector slot, and
 * faking one means either a second light (forbidden, section 9 rule 5) or a
 * decal that slides over geometry instead of wrapping it. So the dapple here is
 * a REAL shadow: a canopy of scattered leaves hanging over the meadow, cast by
 * the same single key light that casts everything else, drifting slowly.
 *
 * THE CANOPY IS NEVER DRAWN. It sits between the camera and the world and would
 * cover the entire frame if it were. `colorWrite = false` and
 * `depthWrite = false` make it contribute nothing to the colour or depth
 * buffer while still going through the shadow pass at full strength - shadows
 * are rendered with the depth material, which neither flag touches.
 *
 * Layers cannot do this job, which is worth writing down: three's shadow pass
 * tests each object against the MAIN camera's layers, not the shadow camera's,
 * so hiding the canopy from the camera by layer would hide it from the shadow
 * map too and leave the meadow flat.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rng } from '../core/types';
import {
  CANOPY_DRIFT,
  CANOPY_HEIGHT,
  CANOPY_LEAF_MAX,
  CANOPY_LEAF_MIN,
  CANOPY_LEAVES,
  CANOPY_SPAN,
} from '../core/constants';

export interface Canopy {
  readonly mesh: THREE.Mesh;
  /** Drifts on PRESENT time, so the dapple keeps moving through a freeze. */
  update(presentTime: number, focus: THREE.Vector3): void;
  dispose(): void;
}

/**
 * @param rng the run's generator. The leaf scatter is part of the recorded
 *   seed like everything else, so two loads dapple the ground identically.
 */
export function createCanopy(scene: THREE.Scene, rng: Rng): Canopy {
  const stream = rng.fork('canopy');
  const leaves: THREE.BufferGeometry[] = [];

  for (let i = 0; i < CANOPY_LEAVES; i++) {
    const size = stream.range(CANOPY_LEAF_MIN, CANOPY_LEAF_MAX);
    // Four-sided discs rather than quads: a leaf shadow with corners reads as
    // a box, and a box overhead reads as architecture rather than as a tree.
    const leaf = new THREE.CircleGeometry(size * 0.5, 5);
    leaf.rotateX(-Math.PI / 2);
    leaf.rotateY(stream.range(0, Math.PI * 2));
    // Scattered rather than gridded, and deliberately allowed to overlap: the
    // gaps between clumps are the light, and even gaps read as a stencil.
    leaf.translate(
      stream.range(-CANOPY_SPAN * 0.5, CANOPY_SPAN * 0.5),
      stream.range(-0.6, 0.6),
      stream.range(-CANOPY_SPAN * 0.5, CANOPY_SPAN * 0.5),
    );
    leaves.push(leaf);
  }

  const geometry = mergeGeometries(leaves.map((leaf) => leaf.toNonIndexed()));
  for (const leaf of leaves) leaf.dispose();

  const material = new THREE.MeshBasicMaterial();
  material.colorWrite = false;
  material.depthWrite = false;
  // A LEAF HAS TO BE DOUBLE-SIDED OR IT CASTS NOTHING. three renders the shadow
  // pass with `shadowSide`, which defaults to BackSide for a FrontSide
  // material - so a flat disc whose front face is turned toward the light gets
  // back-face culled out of the shadow map entirely. The first version of this
  // canopy hung 150 leaves over the meadow and changed the ground's contrast by
  // 0.6 of a luma step, which is another way of saying it did nothing at all.
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'leafCanopy';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  // Instances live in one merged buffer far from the origin, so the batch's
  // own bounds are meaningless to a cull test against the shadow frustum.
  mesh.frustumCulled = false;
  mesh.position.y = CANOPY_HEIGHT;
  scene.add(mesh);

  return {
    mesh,

    update(presentTime: number, focus: THREE.Vector3): void {
      // Two drifts at different rates on the two axes, so the pattern never
      // repeats on a visible beat. The canopy also follows the player, because
      // it only has to cover the shadow frustum and not the whole world.
      const wrap = CANOPY_SPAN * 0.5;
      const driftX = (presentTime * CANOPY_DRIFT) % wrap;
      const driftZ = (presentTime * CANOPY_DRIFT * 0.62) % wrap;
      mesh.position.set(
        Math.round(focus.x / wrap) * wrap + driftX,
        CANOPY_HEIGHT,
        Math.round(focus.z / wrap) * wrap + driftZ,
      );
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
