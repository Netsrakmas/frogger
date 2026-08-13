/**
 * CROAK - the cloud cookie. PROMPT.md section 8 asks for an animated cookie on
 * the key light in the overworld; playtest asked for the shade it throws to
 * read as CLOUDS and to sit lightly. So the field is a handful of distinct
 * cloud shapes - each a run of overlapping discs, big puffs in the middle,
 * small ones at the ends - drifting over a meadow whose base state is full sun.
 *
 * Not a cookie texture. Three's DirectionalLight has no projector slot, and
 * faking one means either a second light (forbidden, section 9 rule 5) or a
 * decal that slides over geometry instead of wrapping it. So the shade here is
 * a REAL shadow: cloud cutouts hanging over the meadow, cast by the same
 * single key light that casts everything else.
 *
 * THE CANOPY IS NEVER DRAWN. It sits between the camera and the world and
 * would cover the frame if it were. `colorWrite = false` and
 * `depthWrite = false` make it contribute nothing to the colour or depth
 * buffer while still going through the shadow pass - which renders with the
 * depth material, and neither flag touches that.
 *
 * THE SHADOW IS HALF A SHADOW, and this is the trick worth writing down. A
 * shadow map is binary per texel: a caster either occludes or it does not, and
 * the first version of this cookie dropped every shaded pixel to the toon
 * ramp's darkest band - the same weight as a building's shadow, which is why
 * it read as far too heavy. Per-light shadow intensity would lighten every
 * shadow in the scene; what we want is one caster, lighter. So the canopy
 * carries a customDepthMaterial whose alphaMap is a Bayer dither at
 * CANOPY_SHADOW_COVER: the cloud is punched full of holes the size of a
 * shadow texel, alphaTest discards them in the shadow pass, and the PCF
 * filter averages the mesh back into a partial occluder. The ground under a
 * cloud keeps most of its key light; the ground under a wall keeps none.
 *
 * Layers cannot do the never-drawn job, which is also worth writing down:
 * three's shadow pass tests each object against the MAIN camera's layers, not
 * the shadow camera's, so hiding the canopy by layer would hide it from the
 * shadow map too and leave the meadow flat.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rng } from '../core/types';
import {
  CANOPY_CLOUDS,
  CANOPY_CLOUD_RX,
  CANOPY_CLOUD_RZ,
  CANOPY_CLOUD_SPACING,
  CANOPY_DRIFT,
  CANOPY_HEIGHT,
  CANOPY_PUFFS_MAX,
  CANOPY_PUFFS_MIN,
  CANOPY_PUFF_MAX,
  CANOPY_PUFF_MIN,
  CANOPY_SHADOW_COVER,
  CANOPY_SPAN,
  SHADOW_EXTENT,
  SHADOW_MAP_SIZE,
} from '../core/constants';

/** Disc resolution. Round enough for a puff, cheap enough to forget. */
const PUFF_SEGMENTS = 8;
/** How many cloud-centre draws before giving up on the spacing rule. */
const CENTRE_ATTEMPTS = 400;
/** Small vertical scatter so coplanar discs never z-fight in the depth pass. */
const PUFF_LIFT = 0.6;

/**
 * The dither pattern, one cell per shadow-map texel. 4x4 Bayer order, so the
 * on-cells are as evenly spread as a 4x4 grid allows and the PCF average is
 * stable across the cloud instead of streaky.
 */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
const DITHER_SIZE = 4;

export interface Canopy {
  readonly mesh: THREE.Mesh;
  /** Drifts on PRESENT time, so the clouds keep moving through a freeze. */
  update(presentTime: number, focus: THREE.Vector3): void;
  /**
   * Test hook: pin the drift to a fixed moment (null resumes the clock). The
   * gate cannot schedule a screenshot against wall time, so it schedules the
   * sky against the screenshot instead.
   */
  setPhase(time: number | null): void;
  dispose(): void;
}

/** The alpha dither: g (the channel alphaMap reads) is on for `cover` cells. */
function makeDither(cover: number): THREE.DataTexture {
  const cells = DITHER_SIZE * DITHER_SIZE;
  const on = Math.round(cover * cells);
  const data = new Uint8Array(cells * 4);
  for (let i = 0; i < cells; i++) {
    const casts = BAYER4[i] < on;
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = casts ? 255 : 0;
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(
    data,
    DITHER_SIZE,
    DITHER_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.name = 'croakCloudDither';
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param rng the run's generator. The sky is part of the recorded seed like
 *   everything else, so two loads shade the ground identically.
 */
export function createCanopy(scene: THREE.Scene, rng: Rng): Canopy {
  const stream = rng.fork('canopy');

  // ------------------------------------------------------------ cloud layout
  // Centres are rejection-sampled with a TOROIDAL spacing rule: the field is
  // about to be made periodic on CANOPY_SPAN, so a cloud near one edge and a
  // cloud near the opposite edge are near each other in the tiled sky.
  const centres: { x: number; z: number }[] = [];
  const wrapDelta = (a: number, b: number): number => {
    let d = (a - b) % CANOPY_SPAN;
    if (d > CANOPY_SPAN * 0.5) d -= CANOPY_SPAN;
    if (d < -CANOPY_SPAN * 0.5) d += CANOPY_SPAN;
    return d;
  };
  for (
    let tries = 0;
    tries < CENTRE_ATTEMPTS && centres.length < CANOPY_CLOUDS;
    tries++
  ) {
    const x = stream.range(-CANOPY_SPAN * 0.5, CANOPY_SPAN * 0.5);
    const z = stream.range(-CANOPY_SPAN * 0.5, CANOPY_SPAN * 0.5);
    let clear = true;
    for (const other of centres) {
      if (
        Math.hypot(wrapDelta(x, other.x), wrapDelta(z, other.z)) <
        CANOPY_CLOUD_SPACING
      ) {
        clear = false;
        break;
      }
    }
    if (clear) centres.push({ x, z });
  }

  const puffs: THREE.BufferGeometry[] = [];
  for (const centre of centres) {
    // Each cloud lies along its own axis, so the fleet never reads as stamped.
    const heading = stream.range(0, Math.PI * 2);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const count = stream.int(CANOPY_PUFFS_MIN, CANOPY_PUFFS_MAX + 1);
    for (let i = 0; i < count; i++) {
      // Puffs walk the long axis; the middle of the run gets the big ones and
      // the ends get the small ones, which is the whole cumulus silhouette.
      const along = stream.range(-1, 1);
      const across = stream.range(-1, 1) * (1 - Math.abs(along) * 0.55);
      const radius =
        (CANOPY_PUFF_MIN +
          (CANOPY_PUFF_MAX - CANOPY_PUFF_MIN) * (1 - Math.abs(along) * 0.8)) *
        stream.range(0.85, 1.15);
      const px = along * CANOPY_CLOUD_RX;
      const pz = across * CANOPY_CLOUD_RZ;

      const puff = new THREE.CircleGeometry(radius, PUFF_SEGMENTS);
      puff.rotateX(-Math.PI / 2);
      puff.translate(
        centre.x + px * cos - pz * sin,
        stream.range(-PUFF_LIFT, PUFF_LIFT),
        centre.z + px * sin + pz * cos,
      );
      puffs.push(puff);
    }
  }

  // THE FIELD IS MADE PERIODIC, and this is what makes the drift seamless. The
  // update below keeps the mesh near the player by wrapping its position on
  // CANOPY_SPAN, and a wrap is only invisible if translating the cloud field
  // by exactly CANOPY_SPAN maps it onto itself. A single random scatter is not
  // periodic in anything, so the first version of this cookie POPPED: every
  // wrap the whole shade snapped to an uncorrelated layout. Tiling 3x3 makes
  // the span a true period, and the 30 u shadow frustum always sits inside
  // the tiled interior where a one-period translation changes nothing.
  const tiled: THREE.BufferGeometry[] = [];
  for (const puff of puffs) {
    for (let tx = -1; tx <= 1; tx++) {
      for (let tz = -1; tz <= 1; tz++) {
        const copy = puff.clone();
        copy.translate(tx * CANOPY_SPAN, 0, tz * CANOPY_SPAN);
        tiled.push(copy);
      }
    }
    puff.dispose();
  }

  const geometry = mergeGeometries(tiled.map((puff) => puff.toNonIndexed()));
  for (const puff of tiled) puff.dispose();

  // The dither is sampled in the cloud's own ground plane: uv is just local
  // (x, z) over the pattern's world period, so every puff shares one seamless
  // pattern and overlapping puffs punch out the SAME holes - overlap must not
  // fill the dither in, or a two-puff core would cast darker than a wingtip.
  // One pattern cell maps to one shadow-map texel, the scale the PCF filter
  // averages best at; retuning the shadow map retunes this with it.
  const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
  const period = DITHER_SIZE * texel;
  const positions = geometry.getAttribute('position');
  const uvs = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    uvs[i * 2] = positions.getX(i) / period;
    uvs[i * 2 + 1] = positions.getZ(i) / period;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const material = new THREE.MeshBasicMaterial();
  material.colorWrite = false;
  material.depthWrite = false;
  // A DISC HAS TO BE DOUBLE-SIDED OR IT CASTS NOTHING. three renders the
  // shadow pass with `shadowSide`, which defaults to BackSide for a FrontSide
  // material - so a flat disc facing the light gets back-face culled out of
  // the shadow map entirely. (three copies this material's shadowSide onto
  // the custom depth material below, so it is set once, here.)
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;

  const dither = makeDither(CANOPY_SHADOW_COVER);
  const depthMaterial = new THREE.MeshDepthMaterial({
    // What the built-in shadow depth material uses; a custom one must match
    // or the depth compare reads noise.
    depthPacking: THREE.RGBADepthPacking,
    alphaMap: dither,
    alphaTest: 0.5,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cloudCanopy';
  mesh.customDepthMaterial = depthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  // Instances live in one merged buffer far from the origin, so the batch's
  // own bounds are meaningless to a cull test against the shadow frustum.
  mesh.frustumCulled = false;
  mesh.position.y = CANOPY_HEIGHT;
  scene.add(mesh);

  let phaseOverride: number | null = null;

  return {
    mesh,

    update(presentTime: number, focus: THREE.Vector3): void {
      const time = phaseOverride ?? presentTime;
      // Two drifts at different rates on the two axes, so the pattern never
      // repeats on a visible beat. The canopy also follows the player, because
      // it only has to cover the shadow frustum and not the whole world.
      // Everything wraps on CANOPY_SPAN - the field's true period - and the
      // drift is centred so the mesh origin stays within half a span of the
      // player: with the 3x3 tiling that keeps the frustum at least half a
      // span from the tiled edge, so every wrap and every anchor step moves
      // the mesh by exactly one period and the shadows land where they were.
      const wrap = CANOPY_SPAN;
      const driftX = ((time * CANOPY_DRIFT) % wrap) - wrap * 0.5;
      const driftZ = ((time * CANOPY_DRIFT * 0.62) % wrap) - wrap * 0.5;
      mesh.position.set(
        Math.round(focus.x / wrap) * wrap + driftX,
        CANOPY_HEIGHT,
        Math.round(focus.z / wrap) * wrap + driftZ,
      );
    },

    setPhase(time: number | null): void {
      phaseOverride = time;
    },

    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      depthMaterial.dispose();
      dither.dispose();
    },
  };
}
