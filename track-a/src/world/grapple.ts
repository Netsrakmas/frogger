/**
 * CROAK - grapple posts. PROMPT.md section 4's bottom row.
 *
 * A weathered post with a worn ring at the top: something a tongue can get a
 * grip on. It has no behaviour beyond looking grippable and lighting up when
 * the tongue is considering it - the haul itself belongs to the frog, and the
 * arrival slash belongs to the swing that follows it.
 *
 * They exist to be chained. Posts placed across water are the only way over,
 * which is what turns the tongue from a combat verb into a traversal one.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, GrapplePost } from '../core/types';
import { makeOutline, material } from '../render/materials';

const POST_RADIUS = 0.16;
const POST_HEIGHT = 1.5;
const RING_RADIUS = 0.26;
const RING_TUBE = 0.05;
const GLOW_RATE = 3.4;
const HIGHLIGHT_RATE = 12.0;

export function createGrapplePost(
  scene: THREE.Scene,
  id: string,
  position: THREE.Vector3,
): GrapplePost {
  const root = new THREE.Group();
  root.name = `grapple:${id}`;
  root.position.copy(position);

  const postGeo = new THREE.CylinderGeometry(
    POST_RADIUS * 0.82,
    POST_RADIUS,
    POST_HEIGHT,
    6,
  );
  postGeo.translate(0, POST_HEIGHT * 0.5, 0);
  const capGeo = new THREE.CylinderGeometry(POST_RADIUS * 1.25, POST_RADIUS * 1.1, 0.1, 6);
  capGeo.translate(0, POST_HEIGHT, 0);
  const bodyGeo = mergeGeometries([postGeo, capGeo]);
  postGeo.dispose();
  capGeo.dispose();

  const body = new THREE.Mesh(bodyGeo, material('stoneShade', { flatShading: true }));
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // The ring is the read: a thing shaped like a handhold, at tongue height.
  const ringGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 5, 10);
  ringGeo.rotateX(Math.PI * 0.5);
  ringGeo.translate(0, POST_HEIGHT + 0.16, 0);
  const ring = new THREE.Mesh(ringGeo, material('gold', { emissive: true }));
  ring.castShadow = true;
  root.add(ring);

  const outline = makeOutline(body);
  root.add(outline);

  scene.add(root);

  const pos = position.clone();
  let age = 0;
  let highlight = 0;
  let want = 0;

  return {
    root,
    id,
    get alive(): boolean {
      return true;
    },
    get position(): THREE.Vector3 {
      return pos;
    },

    setHighlighted(active: boolean): void {
      want = active ? 1 : 0;
    },

    update(dt: number, _ctx: GameContext): void {
      age += dt;
      highlight += (want - highlight) * Math.min(1, HIGHLIGHT_RATE * dt);
      // Idles with a slow turn; snaps brighter and larger when it is the one
      // the tongue would take, so the player can aim without a crosshair.
      ring.rotation.y = age * GLOW_RATE * 0.2;
      ring.scale.setScalar(1 + highlight * 0.28);
      ring.position.y = Math.sin(age * GLOW_RATE) * 0.02 * (1 + highlight * 3);
    },

    dispose(): void {
      root.removeFromParent();
      bodyGeo.dispose();
      ringGeo.dispose();
      outline.geometry.dispose();
    },
  };
}
