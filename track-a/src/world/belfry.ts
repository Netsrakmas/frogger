/**
 * CROAK - The Sunken Belfry. PROMPT.md section 6, zone 2.
 *
 * A bell tower that went under. You enter at the top and go DOWN, which is the
 * whole reading of the space: the meadow is bright and open and the belfry is
 * the same world with the light taken out of it. Three terraces inside one
 * shaft rather than three loaded rooms, so the descent is continuous and you
 * can always see the floor you are heading for.
 *
 *   floor 1  the landing. A pit splits it, crossed only by grapple posts, so
 *            the first thing the dungeon asks for is the verb A3 taught.
 *   floor 2  the flooded ring. Four sluice levers stand on pillars out in the
 *            water where the frog cannot walk; the tongue is the only way to
 *            throw them, and throwing all four drains the sluice gate.
 *   floor 3  the vault. Shield, shrine, the last manual page, and the door the
 *            Heron is behind.
 *
 * Per section 2 rule 3 this zone owns a different palette - dungeonDark and
 * dungeonGlow - under the SAME light recipe as the meadow. The identity comes
 * from the material roles, not from a second lighting model.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, Level, Rng, SpawnPoint } from '../core/types';
import { material } from '../render/materials';
import { installBvh } from './level';
import { TO_CAMERA } from './viewaxis';

// -------------------------------------------------------------------- layout

const SHAFT_RADIUS = 17;
const WALL_HEIGHT = 16;
const WALL_THICKNESS = 1.4;

/** Terrace heights. Down is the direction of progress. */
const FLOOR_1 = 0;
const FLOOR_2 = -4.4;
const FLOOR_3 = -8.8;

/** Floor 1 is a disc with a bite taken out of it - that bite is the pit. */
const PIT_HALF_WIDTH = 3.6;
const PIT_FROM_Z = -2.0;
const PIT_TO_Z = 5.0;

const RAMP_WIDTH = 3.6;
const LANDING_INNER = 5.5;

/** The flooded ring: walkway outside, water inside, pillars in the water. */
const WATER_INNER = 7.6;
const WATER_HIGH = FLOOR_2 + 0.55;
const WATER_LOW = FLOOR_3 - 0.35;
const WATER_SEGMENTS = 28;
const DRAIN_RATE = 1.9; // u/s

const LEVER_COUNT = 4;
const LEVER_RING = 5.0;
const PILLAR_RADIUS = 0.55;

/** The sluice the levers open, and the tunnel it guards. */
const SLUICE = { x: 0, z: -9.4 };

const ENTRY = { x: 0, z: 13.2 };

/** Walls on the camera's side are cut down to this instead of removed. */
const PARAPET_HEIGHT = 1.8;

interface Piece {
  visual: THREE.BufferGeometry;
  collide: THREE.BufferGeometry | null;
  role: 'dungeonDark' | 'ruinCool' | 'stoneShade' | 'dungeonGlow';
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

/** An annulus slab: the terraces are rings, not discs, once the shaft is open. */
function ring(
  inner: number,
  outer: number,
  thickness: number,
  y: number,
  segments = 24,
): THREE.BufferGeometry {
  const shape = new THREE.RingGeometry(inner, outer, segments);
  shape.rotateX(-Math.PI / 2);
  // Extruded by hand: a flat ring has no underside, and the capsule solver
  // needs something with volume to push out of.
  const top = shape.clone();
  top.translate(0, y, 0);
  const bottom = shape.clone();
  bottom.rotateX(Math.PI);
  bottom.translate(0, y - thickness, 0);
  shape.dispose();
  const merged = mergeGeometries([top, bottom]);
  top.dispose();
  bottom.dispose();
  return merged;
}

function disc(radius: number, thickness: number, y: number, segments = 24): THREE.BufferGeometry {
  return ring(0.001, radius, thickness, y, segments);
}

export function createBelfry(rng: Rng): Level {
  installBvh();

  const root = new THREE.Group();
  root.name = 'belfry';

  const pieces: Piece[] = [];
  const add = (
    role: Piece['role'],
    visual: THREE.BufferGeometry,
    collide: THREE.BufferGeometry | null = visual.clone(),
  ): void => {
    pieces.push({ visual, collide, role });
  };

  // ------------------------------------------------------------- the shaft
  // A ring of wall segments rather than a cylinder: flat faces catch the key
  // light as distinct planes, which is what stops a round room reading as a
  // smooth grey tube under toon shading.
  const WALL_SEGMENTS = 16;
  for (let i = 0; i < WALL_SEGMENTS; i++) {
    const angle = (i / WALL_SEGMENTS) * Math.PI * 2;
    const width = (2 * Math.PI * SHAFT_RADIUS) / WALL_SEGMENTS + 0.6;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    // A tower with all four walls up is a tower you cannot see into: at a fixed
    // -40 degree pitch the near wall covers the entire room. So the near side is
    // cut down to a parapet - the diorama cutaway Monument Valley and Tunic
    // both use. It still collides at full height, so the room is closed to the
    // frog even where it is open to the camera.
    const facesCamera = dirX * TO_CAMERA.x + dirZ * TO_CAMERA.z > 0.12;
    const drawnHeight = facesCamera ? PARAPET_HEIGHT : WALL_HEIGHT;
    const base = FLOOR_3 - 2;
    add(
      i % 3 === 0 ? 'ruinCool' : 'dungeonDark',
      box(width, drawnHeight, WALL_THICKNESS, dirX * SHAFT_RADIUS, base + drawnHeight * 0.5, dirZ * SHAFT_RADIUS, angle),
      // Collision always uses the full wall, whatever is drawn.
      box(width, WALL_HEIGHT, WALL_THICKNESS, dirX * SHAFT_RADIUS, base + WALL_HEIGHT * 0.5, dirZ * SHAFT_RADIUS, angle),
    );
  }

  // ------------------------------------------------------------- floor one
  // A full disc, then the pit is cut by simply not covering it: two slabs with
  // a gap between them, which is cheaper and more honest than CSG.
  const landingDepth = 0.8;
  add('dungeonDark', box(SHAFT_RADIUS * 2, landingDepth, SHAFT_RADIUS - PIT_TO_Z + 1, 0, FLOOR_1 - landingDepth * 0.5, (SHAFT_RADIUS + PIT_TO_Z) * 0.5));
  add('dungeonDark', box(SHAFT_RADIUS * 2, landingDepth, SHAFT_RADIUS + PIT_FROM_Z, 0, FLOOR_1 - landingDepth * 0.5, (-SHAFT_RADIUS + PIT_FROM_Z) * 0.5));
  // Side ledges beside the pit, so the pit is a gap and not a wall-to-wall cut.
  for (const side of [-1, 1]) {
    add(
      'dungeonDark',
      box(
        SHAFT_RADIUS - PIT_HALF_WIDTH,
        landingDepth,
        PIT_TO_Z - PIT_FROM_Z,
        side * (SHAFT_RADIUS + PIT_HALF_WIDTH) * 0.5,
        FLOOR_1 - landingDepth * 0.5,
        (PIT_FROM_Z + PIT_TO_Z) * 0.5,
      ),
    );
  }

  // Ramp from the landing down to the flooded ring, on the west side.
  const rampRun = 7.5;
  const rampDrop = FLOOR_1 - FLOOR_2;
  const rampGeo = new THREE.BoxGeometry(RAMP_WIDTH, 1.0, Math.hypot(rampRun, rampDrop) + 0.4);
  rampGeo.rotateX(Math.atan2(rampDrop, rampRun));
  rampGeo.rotateY(Math.PI * 0.5);
  rampGeo.translate(-LANDING_INNER - rampRun * 0.5, (FLOOR_1 + FLOOR_2) * 0.5 - 0.5, 1.0);
  add('ruinCool', rampGeo);

  // ------------------------------------------------------------- floor two
  add('dungeonDark', ring(WATER_INNER, SHAFT_RADIUS, 0.8, FLOOR_2, 28));
  // The basin the water sits in.
  add('dungeonDark', disc(WATER_INNER + 0.2, 0.8, FLOOR_3 - 0.6, 28));

  // Pillars out in the water, one per lever. They are the only things standing
  // in the basin, which is what makes the levers read as unreachable.
  const leverSpots: THREE.Vector3[] = [];
  for (let i = 0; i < LEVER_COUNT; i++) {
    const angle = (i / LEVER_COUNT) * Math.PI * 2 + Math.PI * 0.25;
    const x = Math.sin(angle) * LEVER_RING;
    const z = Math.cos(angle) * LEVER_RING;
    const height = FLOOR_2 + 0.2 - (FLOOR_3 - 0.6);
    const pillar = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS * 1.2, height, 6);
    pillar.translate(x, FLOOR_3 - 0.6 + height * 0.5, z);
    add('ruinCool', pillar);
    leverSpots.push(new THREE.Vector3(x, FLOOR_2 + 0.2, z));
  }

  // Ramp from the flooded ring down into the vault, on the east side.
  const ramp2Run = 7.0;
  const ramp2Drop = FLOOR_2 - FLOOR_3;
  const ramp2 = new THREE.BoxGeometry(RAMP_WIDTH, 1.0, Math.hypot(ramp2Run, ramp2Drop) + 0.4);
  ramp2.rotateX(-Math.atan2(ramp2Drop, ramp2Run));
  ramp2.rotateY(Math.PI * 0.5);
  ramp2.translate(SHAFT_RADIUS - 4.5, (FLOOR_2 + FLOOR_3) * 0.5 - 0.5, -6.5);
  add('ruinCool', ramp2);

  // ----------------------------------------------------------- floor three
  add('dungeonDark', disc(SHAFT_RADIUS - 1.5, 0.9, FLOOR_3, 26));

  // The bell itself, fallen and half-buried: the room's one landmark, and the
  // thing that tells you what this tower used to be.
  const bell = new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  bell.scale(1, 1.25, 1);
  bell.rotateZ(0.5);
  bell.translate(-6.5, FLOOR_3 + 1.2, -4.0);
  add('stoneShade', bell);

  // Glowing growth on the walls: the ONLY light source that reads as light in
  // here, so bloom means "something matters" rather than "it is bright".
  const glowParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const angle = rng.next() * Math.PI * 2;
    const y = FLOOR_3 + rng.range(0.4, 9.0);
    const r = SHAFT_RADIUS - 1.0;
    const blob = new THREE.IcosahedronGeometry(rng.range(0.2, 0.45), 0);
    blob.translate(Math.sin(angle) * r, y, Math.cos(angle) * r);
    glowParts.push(blob);
  }
  const glow = mergeGeometries(glowParts);
  for (const part of glowParts) part.dispose();
  add('dungeonGlow', glow, null);

  // ------------------------------------------------------------ assembly
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

  // Water: a single translucent disc whose height IS the puzzle's state.
  const waterGeo = new THREE.CircleGeometry(WATER_INNER, WATER_SEGMENTS);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    material('waterDeep', { transparent: true, opacity: 0.78 }),
  );
  water.position.y = WATER_HIGH;
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

  const playerStart = new THREE.Vector3(ENTRY.x, FLOOR_1 + 0.1, ENTRY.z);

  // -------------------------------------------------------------- contents
  const spawns: SpawnPoint[] = [
    // Floor 1: the pit crossing, and something waiting on the far side.
    { type: 'grapple:belfry-a', position: new THREE.Vector3(-2.2, FLOOR_1, 6.4), yaw: 0 },
    { type: 'grapple:belfry-b', position: new THREE.Vector3(2.2, FLOOR_1, -1.6), yaw: 0 },
    { type: 'sporeling', position: new THREE.Vector3(-4.0, FLOOR_1 + 0.05, -6.0), yaw: 0 },
    { type: 'drownedKnight', position: new THREE.Vector3(4.5, FLOOR_1 + 0.05, -7.5), yaw: 0 },

    // Floor 2: the sluice room.
    { type: 'drownedKnight', position: new THREE.Vector3(-11.5, FLOOR_2 + 0.05, 2.0), yaw: 0 },
    { type: 'spitterFly', position: new THREE.Vector3(0, FLOOR_2 + 0.05, 0), yaw: 0 },
    { type: 'sign:sluice', position: new THREE.Vector3(-9.6, FLOOR_2, 8.4), yaw: Math.PI * 0.85 },
    { type: 'sluice:vault', position: new THREE.Vector3(SLUICE.x, FLOOR_3 + 0.1, SLUICE.z), yaw: 0 },

    // Floor 3: the vault.
    { type: 'shrine:belfry', position: new THREE.Vector3(6.0, FLOOR_3, 3.0), yaw: 0 },
    { type: 'sign:arena', position: new THREE.Vector3(3.4, FLOOR_3, -7.2), yaw: Math.PI * 0.1 },
    { type: 'shield', position: new THREE.Vector3(-2.0, FLOOR_3 + 0.1, -6.0), yaw: 0 },
    { type: 'page:2', position: new THREE.Vector3(-9.5, FLOOR_3 + 0.1, 4.5), yaw: 0 },
    { type: 'drownedKnight', position: new THREE.Vector3(2.0, FLOOR_3 + 0.05, -2.0), yaw: 0 },
  ];
  for (let i = 0; i < leverSpots.length; i++) {
    spawns.push({ type: `lever:sluice-${i}`, position: leverSpots[i], yaw: 0 });
  }

  // The mechanism: all four levers thrown drains the basin and opens the way.
  let waterY = WATER_HIGH;
  let drained = false;

  return {
    id: 'belfry',
    root,
    collider,
    spawns,
    playerStart,
    secrets: [],
    entries: {
      // Arriving from the meadow: just inside the door, looking down the shaft.
      downs: playerStart.clone(),
      vault: new THREE.Vector3(0, FLOOR_3 + 0.2, 4.0),
    },

    update(dt: number, ctx: GameContext): void {
      const thrown = ctx.levers.filter((lever) => lever.on).length;
      const solved = thrown >= LEVER_COUNT && ctx.levers.length >= LEVER_COUNT;
      const want = solved ? WATER_LOW : WATER_HIGH;
      if (Math.abs(waterY - want) > 1e-3) {
        const step = DRAIN_RATE * dt;
        waterY += Math.max(-step, Math.min(step, want - waterY));
        water.position.y = waterY;
      }
      // The gate opens once the water is actually out of the way, not the
      // instant the last lever moves - the drain has to be seen to be believed.
      if (!drained && solved && waterY <= WATER_LOW + 0.15) {
        drained = true;
        const gate = ctx.gates.find((g) => g.id === 'vault');
        if (gate !== undefined) gate.release(ctx);
      }
    },

    dispose(): void {
      root.removeFromParent();
      colliderGeo.disposeBoundsTree();
      colliderGeo.dispose();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}
