/**
 * CROAK - the Heron's arena. PROMPT.md section 6, zone 3.
 *
 * The belfry's roof, which is where the tower stopped being a tower. A circular
 * flooded deck open to the sky, ringed by a broken parapet, with four stanchions
 * of the fallen bell frame standing in a ring inside it. Those four are grapple
 * posts, and they are the room's whole argument:
 *
 *   phase 2 puts the Heron in the middle and turns the air outward. The gust is
 *   worst at the centre - past halfway in it beats MOVE_SPEED outright - so the
 *   deck cannot be walked across. The posts sit exactly at that halfway ring, so
 *   the way in is post -> haul -> the Heron itself (heavy, so the tongue anchors
 *   and the FROG travels) -> arrival slash. Traversal and damage are the same
 *   act, which is the thing A3 was teaching all along.
 *
 * The far parapet is left at full height and the camera-side one is cut down,
 * the same cutaway the belfry uses. That is not only so the deck is visible: the
 * far wall is what hides the ledge behind it, where the last manual page appears
 * once the Heron is down. The gap in that wall is spanned by a fallen lintel
 * high enough to walk under and low enough to sit in the camera's eyeline, so
 * the ledge stays occluded even through the doorway that reaches it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Level, Rng, SecretSpot, SpawnPoint } from '../core/types';
import { ARENA_POST_RING, ARENA_RADIUS } from '../core/constants';
import { material } from '../render/materials';
import { installBvh } from './level';
import { TO_CAMERA } from './viewaxis';

// -------------------------------------------------------------------- layout

const DECK_Y = 0;
const DECK_THICKNESS = 1.4;
const WATER_Y = DECK_Y + 0.09;
const WATER_SEGMENTS = 30;

const RIM_SEGMENTS = 24;
const RIM_HEIGHT = 2.6;
const RIM_THICKNESS = 1.1;
/** Camera-side merlons, cut down so the deck is not drawn behind a wall. */
const PARAPET_HEIGHT = 0.85;
/** Collision is always this tall, whatever is drawn: the deck is closed. */
const RIM_COLLIDE = 5.0;

/** The doorway in the far wall, as a half-angle. */
const NOTCH_HALF = 0.3; // rad
const LINTEL_LOW = 1.9;
const LINTEL_HIGH = 3.8;

/** The ledge behind the arena, and the page that appears on it. */
const LEDGE_AT = 15.6;
const LEDGE_RADIUS = 3.0;

const ENTRY_Z = 10.6;
const POST_COUNT = 4;

/** Where the Heron starts: off-centre, so phase 1 is a chase and not a duel. */
const HERON_SPOT = { x: 0, z: -5.0 };

interface Piece {
  visual: THREE.BufferGeometry;
  collide: THREE.BufferGeometry | null;
  role: 'ruinCool' | 'stoneShade' | 'stoneLit' | 'dungeonGlow';
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  if (yaw !== 0) geometry.rotateY(yaw);
  geometry.translate(x, y, z);
  return geometry;
}

/** A slab with an underside, so the capsule solver has volume to push out of. */
function disc(
  radius: number,
  thickness: number,
  y: number,
  x = 0,
  z = 0,
  segments = 26,
): THREE.BufferGeometry {
  const shape = new THREE.CircleGeometry(radius, segments);
  shape.rotateX(-Math.PI / 2);
  const top = shape.clone();
  top.translate(x, y, z);
  const bottom = shape.clone();
  bottom.rotateX(Math.PI);
  bottom.translate(x, y - thickness, z);
  shape.dispose();
  const merged = mergeGeometries([top, bottom]);
  top.dispose();
  bottom.dispose();
  return merged;
}

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % (Math.PI * 2);
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI;
}

/** Straight away from the camera on the ground plane: the arena's blind side. */
const NOTCH_ANGLE = Math.atan2(-TO_CAMERA.x, -TO_CAMERA.z);

export function createArena(rng: Rng): Level {
  installBvh();

  const root = new THREE.Group();
  root.name = 'arena';

  const pieces: Piece[] = [];
  const add = (
    role: Piece['role'],
    visual: THREE.BufferGeometry,
    collide: THREE.BufferGeometry | null = visual.clone(),
  ): void => {
    pieces.push({ visual, collide, role });
  };

  // ---------------------------------------------------------------- the deck
  add('stoneLit', disc(ARENA_RADIUS + RIM_THICKNESS, DECK_THICKNESS, DECK_Y, 0, 0, 30));

  // The ledge behind the far wall, joined to the deck by a short causeway that
  // runs out through the doorway.
  add('stoneShade', disc(LEDGE_RADIUS, DECK_THICKNESS, DECK_Y, Math.sin(NOTCH_ANGLE) * LEDGE_AT, Math.cos(NOTCH_ANGLE) * LEDGE_AT, 14));
  add(
    'stoneShade',
    box(
      2.6,
      DECK_THICKNESS,
      LEDGE_AT - ARENA_RADIUS + 2.0,
      Math.sin(NOTCH_ANGLE) * (ARENA_RADIUS + 0.6),
      DECK_Y - DECK_THICKNESS * 0.5,
      Math.cos(NOTCH_ANGLE) * (ARENA_RADIUS + 0.6),
      NOTCH_ANGLE,
    ),
  );

  // ------------------------------------------------------------- the parapet
  for (let i = 0; i < RIM_SEGMENTS; i++) {
    const angle = (i / RIM_SEGMENTS) * Math.PI * 2;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    const width = (2 * Math.PI * ARENA_RADIUS) / RIM_SEGMENTS + 0.5;
    const inNotch = Math.abs(wrapAngle(angle - NOTCH_ANGLE)) < NOTCH_HALF;

    if (inNotch) {
      // The doorway: no wall, but a fallen lintel across it. Overhead for the
      // frog, dead in front of the camera's eyeline for the ledge behind.
      add(
        'ruinCool',
        box(
          width,
          LINTEL_HIGH - LINTEL_LOW,
          RIM_THICKNESS * 1.3,
          dirX * ARENA_RADIUS,
          (LINTEL_LOW + LINTEL_HIGH) * 0.5,
          dirZ * ARENA_RADIUS,
          angle,
        ),
      );
      continue;
    }

    const facesCamera = dirX * TO_CAMERA.x + dirZ * TO_CAMERA.z > 0.12;
    const drawn = facesCamera ? PARAPET_HEIGHT : RIM_HEIGHT;
    // Merlons: every third block stands a little taller, so a ring of identical
    // boxes reads as masonry that has been standing out in the weather.
    const crown = facesCamera ? 0 : (i % 3 === 0 ? 0.55 : 0);
    add(
      i % 4 === 0 ? 'stoneShade' : 'ruinCool',
      box(
        width,
        drawn + crown,
        RIM_THICKNESS,
        dirX * ARENA_RADIUS,
        DECK_Y + (drawn + crown) * 0.5,
        dirZ * ARENA_RADIUS,
        angle,
      ),
      box(
        width,
        RIM_COLLIDE,
        RIM_THICKNESS,
        dirX * ARENA_RADIUS,
        DECK_Y + RIM_COLLIDE * 0.5,
        dirZ * ARENA_RADIUS,
        angle,
      ),
    );
  }

  // ------------------------------------------------------- the bell frame
  // Four stanchions of the frame the bell used to hang from, at the ring where
  // the wind first beats a walk. Each one carries a grapple post.
  const postSpots: THREE.Vector3[] = [];
  for (let i = 0; i < POST_COUNT; i++) {
    const angle = (i / POST_COUNT) * Math.PI * 2 + Math.PI * 0.25;
    const x = Math.sin(angle) * ARENA_POST_RING;
    const z = Math.cos(angle) * ARENA_POST_RING;
    const base = new THREE.CylinderGeometry(0.62, 0.78, 0.55, 6);
    base.translate(x, DECK_Y + 0.27, z);
    add('stoneShade', base);
    postSpots.push(new THREE.Vector3(x, DECK_Y + 0.5, z));
  }

  // The bell itself, upended in the shallows: the landmark that says which
  // tower this roof belongs to.
  const bell = new THREE.SphereGeometry(2.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6);
  bell.scale(1, 1.3, 1);
  bell.rotateZ(2.4);
  bell.translate(-8.4, DECK_Y + 1.0, 5.2);
  add('ruinCool', bell);

  // Weed and glow caught in the flood, scattered on the recorded stream.
  const glowParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = rng.next() * Math.PI * 2;
    const radius = rng.range(3.0, ARENA_RADIUS - 1.2);
    const blob = new THREE.IcosahedronGeometry(rng.range(0.16, 0.34), 0);
    blob.translate(Math.sin(angle) * radius, DECK_Y + 0.12, Math.cos(angle) * radius);
    glowParts.push(blob);
  }
  const glow = mergeGeometries(glowParts);
  for (const part of glowParts) part.dispose();
  add('dungeonGlow', glow, null);

  // -------------------------------------------------------------- assembly
  const byRole = new Map<Piece['role'], THREE.BufferGeometry[]>();
  const colliders: THREE.BufferGeometry[] = [];
  for (const piece of pieces) {
    const list = byRole.get(piece.role) ?? [];
    list.push(piece.visual);
    byRole.set(piece.role, list);
    if (piece.collide !== null) colliders.push(piece.collide);
  }

  const geometries: THREE.BufferGeometry[] = [];
  for (const [role, parts] of byRole) {
    const merged = mergeGeometries(parts.map((p) => (p.index === null ? p : p.toNonIndexed())));
    for (const part of parts) part.dispose();
    const mesh = new THREE.Mesh(
      merged,
      material(role, { flatShading: true, emissive: role === 'dungeonGlow' }),
    );
    mesh.castShadow = role !== 'dungeonGlow';
    mesh.receiveShadow = true;
    root.add(mesh);
    geometries.push(merged);
  }

  // A skin of standing water over the whole deck. It is ankle-deep and purely
  // a read: every step the fight makes is a step in water.
  const waterGeo = new THREE.CircleGeometry(ARENA_RADIUS + RIM_THICKNESS * 0.5, WATER_SEGMENTS);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    material('waterShallow', { transparent: true, opacity: 0.5 }),
  );
  water.position.y = WATER_Y;
  water.receiveShadow = true;
  root.add(water);
  geometries.push(waterGeo);

  const colliderGeo = mergeGeometries(
    colliders.map((c) => (c.index === null ? c : c.toNonIndexed())),
  );
  for (const part of colliders) part.dispose();
  colliderGeo.computeBoundsTree();
  const collider = new THREE.Mesh(colliderGeo);
  collider.visible = false;
  root.add(collider);

  const playerStart = new THREE.Vector3(0, DECK_Y + 0.1, ENTRY_Z);
  const pageSpot = new THREE.Vector3(
    Math.sin(NOTCH_ANGLE) * LEDGE_AT,
    DECK_Y + 0.1,
    Math.cos(NOTCH_ANGLE) * LEDGE_AT,
  );

  // -------------------------------------------------------------- contents
  const spawns: SpawnPoint[] = [
    { type: 'heron', position: new THREE.Vector3(HERON_SPOT.x, DECK_Y, HERON_SPOT.z), yaw: 0 },
    // A shrine on the threshold, so the boss is a thing you may lose to twice.
    { type: 'shrine:arena', position: new THREE.Vector3(0, DECK_Y, ENTRY_Z + 1.4), yaw: 0 },
  ];
  for (let i = 0; i < postSpots.length; i++) {
    spawns.push({ type: `grapple:arena-${i}`, position: postSpots[i], yaw: 0 });
  }

  const secrets: SecretSpot[] = [
    { id: 'heronLedge', occluded: true, position: pageSpot.clone() },
  ];

  return {
    id: 'arena',
    root,
    collider,
    spawns,
    playerStart,
    secrets,
    entries: {
      // Arriving up out of the vault: on the threshold, the deck ahead of you.
      belfry: playerStart.clone(),
      arena: playerStart.clone(),
      /**
       * Not an arrival at all: where the last page appears once the Heron is
       * down. It lives here because `entries` is the only authored point list a
       * Level hands out, and game.ts needs somewhere to put the reward that the
       * arena itself gets to choose.
       */
      victoryPage: pageSpot,
    },

    dispose(): void {
      root.removeFromParent();
      colliderGeo.disposeBoundsTree();
      colliderGeo.dispose();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}
