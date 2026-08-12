/**
 * CROAK - world signage. PROMPT.md section 7: "all world signage ... is real
 * English encoded in Croakic".
 *
 * A leaning slab with the writing CARVED into it rather than painted on: each
 * stroke of each glyph is a thin box standing slightly proud of the face, all
 * merged into one mesh so a whole sentence costs one draw call. No texture, no
 * canvas, no font - the same rule the rest of the game is built under, and the
 * reason the glyphs stay crisp at any zoom.
 *
 * What the signs say is a hint, not decoration. A player who never breaks the
 * cipher still gets "somebody wrote something here, so something is here".
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Entity, GameContext } from '../core/types';
import { layout, write } from '../ui/croakic';
import { makeOutline, material } from '../render/materials';
import { SIGN_TEXT } from './signtext';

export { SIGN_TEXT };

const SLAB_W = 2.5;
const SLAB_H = 1.9;
const SLAB_D = 0.22;
const POST_H = 0.55;
/** Glyph height in world units, and how far the carving stands proud. */
const GLYPH_H = 0.3;
const RELIEF = 0.045;
const STROKE_W = 0.045;
const LEAN = -0.13;

/** One stroke as a thin box lying in the slab's face plane. */
function strokeBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  z: number,
): THREE.BufferGeometry {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const geometry = new THREE.BoxGeometry(Math.max(length, STROKE_W), STROKE_W, RELIEF);
  geometry.rotateZ(Math.atan2(dy, dx));
  geometry.translate((x1 + x2) * 0.5, (y1 + y2) * 0.5, z);
  return geometry;
}

/**
 * A sign. `text` is plain English; it reaches the player as Croakic and nothing
 * anywhere in the build ever renders it as letters.
 */
export function createSign(
  scene: THREE.Scene,
  id: string,
  position: THREE.Vector3,
  yaw: number,
): Entity {
  const text = SIGN_TEXT[id] ?? '';
  const root = new THREE.Group();
  root.name = `sign:${id}`;
  root.position.copy(position);
  root.rotation.set(LEAN, yaw, 0);

  const slabGeo = new THREE.BoxGeometry(SLAB_W, SLAB_H, SLAB_D);
  slabGeo.translate(0, POST_H + SLAB_H * 0.5, 0);
  const postGeo = new THREE.CylinderGeometry(0.11, 0.14, POST_H * 2, 6);
  postGeo.translate(0, POST_H * 0.4, 0);
  const bodyGeo = mergeGeometries([slabGeo.toNonIndexed(), postGeo.toNonIndexed()]);
  slabGeo.dispose();
  postGeo.dispose();

  const body = new THREE.Mesh(bodyGeo, material('stoneShade', { flatShading: true }));
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // The writing. Two lines at most: a slab is a slab.
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const half = Math.ceil(words.length / 2);
  const lines = words.length > 3 ? [words.slice(0, half), words.slice(half)] : [words];

  const carved: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = layout(write(lines[i].join(' ')));
    // Fit the line to the slab and centre it, so a long sentence just gets
    // smaller rather than running off the stone.
    const scale = Math.min(GLYPH_H, (SLAB_W - 0.32) / Math.max(line.width, 0.001));
    const offsetX = -(line.width * scale) * 0.5;
    const offsetY = POST_H + SLAB_H * (lines.length === 1 ? 0.5 : 0.66 - i * 0.32);
    const z = SLAB_D * 0.5 + RELIEF * 0.5;
    for (const stroke of line.strokes) {
      carved.push(
        strokeBox(
          offsetX + stroke.x1 * scale,
          offsetY - stroke.y1 * scale,
          offsetX + stroke.x2 * scale,
          offsetY - stroke.y2 * scale,
          z,
        ),
      );
    }
    for (const dot of line.dots) {
      const pip = new THREE.BoxGeometry(STROKE_W * 1.6, STROKE_W * 1.6, RELIEF);
      pip.translate(offsetX + dot.x * scale, offsetY - dot.y * scale, z);
      carved.push(pip);
    }
  }

  const geometries: THREE.BufferGeometry[] = [bodyGeo];
  if (carved.length > 0) {
    const merged = mergeGeometries(carved.map((c) => c.toNonIndexed()));
    for (const part of carved) part.dispose();
    const writing = new THREE.Mesh(merged, material('gold', { flatShading: true }));
    writing.castShadow = false;
    root.add(writing);
    geometries.push(merged);
  }

  const outline = makeOutline(body);
  root.add(outline);
  geometries.push(outline.geometry);

  scene.add(root);

  return {
    root,
    alive: true,
    update(_dt: number, _ctx: GameContext): void {
      /* a sign says the same thing every frame */
    },
    dispose(): void {
      root.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}
