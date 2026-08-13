/**
 * CROAK - Lilypond Downs, greybox. PROMPT.md section 6, zone 1.
 *
 * Correct shapes, correct palette, no decoration: this exists to prove the
 * character controller against real terrain. Everything is generated from the
 * seeded Rng, so the same seed always yields the same meadow (section 10's
 * determinism gate) - there is no Math.random here and never will be.
 *
 * Two geometry sets are built side by side: a faceted VISUAL set merged down to
 * one mesh per palette role for the 150-draw-call budget, and a low-poly
 * COLLISION set merged into a single BVH-backed mesh. Collision skips every
 * canopy, trades each round trunk for a prism, and carries no decoration.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';
import { MAX_SLOPE, STEP_HEIGHT } from '../core/constants';
import type { Level, Rng, SpawnPoint } from '../core/types';
import type { PaletteRole } from '../render/palette';
import { material } from '../render/materials';
import { TO_CAMERA } from './viewaxis';

// --------------------------------------------------------------- bvh install
// three-mesh-bvh extends three's prototypes rather than subclassing, so this
// has to happen exactly once per page - a second install is harmless but a
// missing one turns every shapecast into a silent undefined.

let bvhInstalled = false;

export function installBvh(): void {
  if (bvhInstalled) return;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  bvhInstalled = true;
}

// -------------------------------------------------------------------- layout
// Level-design numbers, not gameplay tunables: they describe this one zone, so
// they live with it rather than in core/constants.ts. The two that DO derive
// from gameplay (ramp/steep angles, step rise) are expressed against the
// controller's own limits so retuning the controller retunes the test terrain.

const MAP_SIZE = 46;
/** ~0.96 u facets: big enough to read as faceted low-poly under flat shading. */
const GROUND_SEGMENTS = 48;
/**
 * The meadow is the one thing collision does NOT decimate. Halving it measured
 * 0.19 u of sink where the pond rim curves - a fifth of the frog - so the
 * walking surface matches the drawn one exactly and the savings come from the
 * props instead.
 */
const COLLIDER_SEGMENTS = GROUND_SEGMENTS;

const MEADOW_AMPLITUDE = 0.45;
const MEADOW_SCALE = 9.0;
const MEADOW_DETAIL_SCALE = 3.6;
/** Power of two so the wrap can be a mask, and >> the map so it never repeats. */
const NOISE_PERIOD = 64;

interface Disc {
  x: number;
  z: number;
  radius: number;
}

/** Blend width for every radial falloff in the zone: pads, basin, shoreline. */
const PAD_FEATHER = 3.0;

const PLAYER_START = { x: 0, z: 9 };

/**
 * Build pads. The meadow noise fades to nothing inside these, so a ramp foot or
 * a staircase always meets ground at a known height instead of a random one -
 * a 0.3 u bump under a ramp foot is the difference between a walkable ramp and
 * a wall. Kept as tight as each feature allows: every extra metre of pad is a
 * metre of meadow that stops undulating.
 */
const SPAWN_PAD: Disc = { x: PLAYER_START.x, z: PLAYER_START.z, radius: 6 };
/** Sized to reach the ramp foot, the steep-face foot and the plateau's datum. */
const TERRACE_PAD: Disc = { x: -8.3, z: -2.3, radius: 8 };
const STAIR_PAD: Disc = { x: 10, z: 13, radius: 4 };

const POND: Disc = { x: 12, z: -5, radius: 4.5 };
const POND_DEPTH = 1.5;
/**
 * Wider than the basin so the whole shoreline is noise-free. A ragged rim would
 * poke through the water quad in patches, which reads as a bug, not a shore.
 */
const POND_PAD: Disc = { x: POND.x, z: POND.z, radius: POND.radius + 1.5 };

const FLAT_PADS: readonly Disc[] = [SPAWN_PAD, TERRACE_PAD, STAIR_PAD, POND_PAD];

/** Water sits shallow enough to wade, with a dry muddy rim above it. */
const WATER_LEVEL = 0.5;
const WATER_RADIUS = 5.0;
const WATER_OPACITY = 0.72;
const BED_RADIUS = POND.radius - 0.15;
const BED_LIFT = 0.03;
const WATER_SEGMENTS = 16;
const BED_SEGMENTS = 12;

const PLATEAU = { x: -10, z: -8, sizeX: 10, sizeZ: 9, top: 2.4, bury: 1.4 };

/** Comfortably under MAX_SLOPE - the ramp must always be walkable. */
const RAMP_ANGLE = MAX_SLOPE * 0.4;
/** Comfortably over MAX_SLOPE - the controller must always reject this face. */
const STEEP_ANGLE = MAX_SLOPE * 1.2;
const RAMP_WIDTH = 3.4;
const STEEP_WIDTH = 4.0;
/**
 * Thick enough that both slabs are solid earth down to below the meadow. A thin
 * tilted slab leaves a crawlspace underneath, which the player will find.
 */
const SLOPE_THICKNESS = 2.8;
const SLOPE_FOOT_EXTEND = 0.5;

/** Each step must clear under STEP_HEIGHT or the staircase stops being one. */
const STEP_RISE = STEP_HEIGHT * 0.86;
const STAIR = { x: 10, width: 3.0, tread: 0.9, front: 15.6, back: 9.9, count: 3 };
const STAIR_BURY = 1.2;

/** Too tall to step, so the controller has to slide along it. */
const WALL = { x: -3, z: 5.5, width: 7.0, height: 0.9, depth: 0.7, bury: 0.6 };

const TREE_COUNT = 44;
const RUIN_COUNT = 18;
const RUIN_ROLES: readonly PaletteRole[] = ['stoneLit', 'stoneShade', 'ruinCool'];
const RUIN_BURY = 0.4;
/** Half-extent props may occupy: leaves room for a canopy to stay over ground. */
const PROP_MARGIN = 20.5;
const TREE_SPACING = 2.4;
const RUIN_SPACING = 2.9;
const PROP_ATTEMPTS = 1600;

/**
 * Props stay out of these: the greybox has to stay walkable to be a test. These
 * cover the whole play envelope, not just the build pads - a tree in the ramp's
 * approach would invalidate the one traversal this level exists to prove.
 */
const PLAY_KEEPOUT: readonly Disc[] = [
  { x: PLAYER_START.x, z: PLAYER_START.z, radius: 9 },
  { x: -10, z: -4.5, radius: 11.5 },
  { x: STAIR_PAD.x, z: STAIR_PAD.z, radius: 6.5 },
  { x: POND.x, z: POND.z, radius: 9 },
];

/**
 * Collision-only rim just outside the meadow. Nothing about a greybox should
 * end in an infinite fall, and an invisible boundary costs 48 triangles.
 */
const RIM_INSET = 0.5;
const RIM_HEIGHT = 4.0;
const RIM_THICKNESS = 1.0;

const SPORELING_SPOTS: readonly { x: number; z: number }[] = [
  { x: 3.5, z: 7.5 },
  { x: -4.0, z: 11.5 },
  { x: 1.5, z: 14.0 },
];
/**
 * A1's slice ships one Sporeling (section 11). The rest of the roster stays
 * here as authored placement so A2 raises a count rather than redesigning the
 * meadow - and so the greybox never becomes three-on-one against a stick.
 */
const ACTIVE_SPORELINGS = 1;

/**
 * A2's authored beats, laid out as a first lesson rather than a scattering:
 * the shrine sits behind the frog so resting is discovered by walking back;
 * the Sporeling is met first; the Beetle Guard stands further out, far enough
 * that you arrive at it having already learned to read a telegraph; and the
 * Sword is off to one side, so the fight is winnable with the stick but much
 * better if you went looking first. A4 replaces this with the real zone.
 */
const BEETLE_SPOTS: readonly { x: number; z: number }[] = [{ x: -6.0, z: 2.5 }];
const SHRINE_SPOTS: readonly { id: string; x: number; z: number }[] = [
  { id: 'downs', x: 1.5, z: 12.5 },
  // The second sits by the belfry door, so the walk back after a death in the
  // dungeon's doorway is short enough to stay a lesson rather than a punishment.
  { id: 'belfrygate', x: 4.4, z: -12.2 },
];
/**
 * A4's authored zone. Six secrets, of which THREE are hidden by the camera
 * rather than by a door - Tunic's actual trick. At a fixed -40 degree pitch and
 * 45 degree yaw, anything standing between the camera and a patch of ground
 * hides that ground completely, and the orthographic projection means the gap
 * never opens up as you approach. So a path behind the plateau's shoulder, a
 * hollow behind the big ruin, and the ledge under the waterfall are all simply
 * invisible until walked into. They are marked here as OCCLUDED so the gate can
 * assert the count rather than trusting the level designer's memory.
 */
interface Secret {
  id: string;
  x: number;
  z: number;
  /** Hidden by geometry between the camera and the spot, not by a lock. */
  occluded: boolean;
  /**
   * Needs a mass placed in front of it. Most occluded secrets are hidden by
   * terrain that is already there for its own reasons - the plateau hides two
   * of them - and dropping a block in front of those would just be furniture in
   * the middle of the play space. Only the one with nothing naturally in the
   * way gets built cover, and A4's gate re-measures all three either way.
   */
  cover?: boolean;
  reward: string;
}

const SECRETS: readonly Secret[] = [
  // 1. Behind the waterfall on the plateau's face: the Sword.
  { id: 'waterfall', x: -10.5, z: -12.4, occluded: true, reward: 'sword' },
  // 2. The hollow behind the great ruin, invisible from the fixed camera.
  { id: 'ruinHollow', x: -14.2, z: 6.4, occluded: true, cover: true, reward: 'page:0' },
  // 3. Meadow in the plateau's shadow. Standing just west of the mesa, this
  //    ground is behind 2.4 u of rock on the camera's view axis and simply is
  //    not drawn until you walk into it - the orthographic projection means it
  //    never opens up as you approach either.
  { id: 'plateauShadow', x: -16.5, z: -7.0, occluded: true, reward: 'coins' },
  // 4. Across the pond, reachable only by the grapple chain.
  { id: 'farBank', x: 17.4, z: -7.2, occluded: false, reward: 'page:1' },
  // 5. Behind the bramble the Sword opens.
  { id: 'thicket', x: 13.2, z: 8.6, occluded: false, reward: 'coins' },
  // 6. The old ruin the belfry key sits in.
  { id: 'keepStone', x: -13.0, z: 13.4, occluded: false, reward: 'key' },
];

const SWORD_SPOT = { x: SECRETS[0].x, z: SECRETS[0].z };

/**
 * Authored cover. Every secret marked `occluded` gets a deliberate mass placed
 * between it and the camera, rather than relying on a randomly scattered tree
 * happening to land there - which is exactly how the 'ruinHollow' secret
 * silently stopped being hidden the first time the generator's seed stream
 * moved. Cover is placed on the ground plane along TO_CAMERA, so it stays
 * correct for as long as the camera angle is what section 2 says it is.
 */
const COVER_OFFSET = 3.4;
const COVER_WIDTH = 6.0;
const COVER_HEIGHT = 4.2;
const COVER_DEPTH = 3.0;
const COVER_BURY = 0.5;
const BRAMBLE_SPOTS: readonly { id: string; x: number; z: number }[] = [
  { id: 'thicket', x: 11.6, z: 7.6 },
];
const DOOR_SPOT = { id: 'belfry', x: 2.0, z: -14.6, yaw: 0 };
const SPITTER_SPOTS: readonly { x: number; z: number }[] = [
  // Over the water, where a sword cannot follow.
  { x: 12.2, z: -5.0 },
  { x: 15.0, z: -8.4 },
];
/**
 * A3's grapple chain. Two posts step out across the pond and one waits on the
 * far rim, so the only dry way over is tongue-post-tongue - the moment the verb
 * stops being a combat trick and becomes how you get somewhere.
 */
const GRAPPLE_SPOTS: readonly { id: string; x: number; z: number }[] = [
  { id: 'shore', x: 7.6, z: -4.0 },
  { id: 'stone', x: 11.5, z: -5.4 },
  { id: 'far', x: 15.6, z: -6.6 },
];
/** Spawns sit a hair proud of the ground so the first ground-snap resolves down. */
const SPAWN_CLEARANCE = 0.05;

/**
 * Everything AUTHORED stands somewhere a scattered prop must not. This list is
 * assembled from the authored tables themselves rather than transcribed by
 * hand, because a transcription is how the wall, the belfry door, the shrine
 * beside it and the key ruin all silently went unprotected the first time -
 * the scatter only knew about the play envelope, and trees grew straight
 * through anything that was merely SCENERY. Unlike PLAY_KEEPOUT (tested
 * against a prop's centre, because a canopy overhanging a path is charm, not
 * a bug), these are tested against the prop's own FOOTPRINT, so not even a
 * canopy tip may interpenetrate an authored object.
 */
const STRUCTURE_KEEPOUT: readonly Disc[] = [
  // The wall is long and thin; three discs along its length cover it without
  // sterilising half the meadow around it.
  ...[-1, 0, 1].map((i) => ({
    x: WALL.x + i * WALL.width * 0.33,
    z: WALL.z,
    radius: 1.5,
  })),
  { x: DOOR_SPOT.x, z: DOOR_SPOT.z, radius: 3.2 },
  ...SHRINE_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, radius: 2.2 })),
  ...SECRETS.map((secret) => ({ x: secret.x, z: secret.z, radius: 2.6 })),
  ...BRAMBLE_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, radius: 2.4 })),
  ...GRAPPLE_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, radius: 1.6 })),
  // Signage (the two spots spawned at the bottom of createDowns).
  { x: DOOR_SPOT.x + 2.6, z: DOOR_SPOT.z + 2.2, radius: 1.6 },
  { x: 2.4, z: 5.2, radius: 1.6 },
  // The authored cover block: half its 6x3 diagonal, plus clearance.
  ...SECRETS.filter((secret) => secret.cover === true).map((secret) => ({
    x: secret.x + TO_CAMERA.x * COVER_OFFSET,
    z: secret.z + TO_CAMERA.z * COVER_OFFSET,
    radius: 4.0,
  })),
];

/** Roles that would only add noise to the shadow map. */
const NO_CAST: readonly PaletteRole[] = ['grassLit', 'waterShallow', 'waterDeep'];

// ------------------------------------------------------------------- terrain

function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

type HeightField = (x: number, z: number) => number;

/**
 * Smooth 2D value noise over a seeded lattice, minus a flat-bottomed pond
 * basin, faded out under every build pad. One function is the authority on
 * ground height: the visual mesh, the collision mesh and every prop's footing
 * all sample it, so nothing can float or sink relative to anything else.
 */
function createHeightField(rng: Rng): HeightField {
  const lattice = new Float32Array(NOISE_PERIOD * NOISE_PERIOD);
  const stream = rng.fork('terrain');
  for (let i = 0; i < lattice.length; i++) lattice[i] = stream.next() * 2 - 1;

  const at = (ix: number, iz: number): number =>
    lattice[(iz & (NOISE_PERIOD - 1)) * NOISE_PERIOD + (ix & (NOISE_PERIOD - 1))];

  const noise = (x: number, z: number): number => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const tx = smoothstep01(x - ix);
    const tz = smoothstep01(z - iz);
    const near = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
    const far = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
    return near + (far - near) * tz;
  };

  return (x: number, z: number): number => {
    let fade = 1;
    for (const pad of FLAT_PADS) {
      const d = Math.hypot(x - pad.x, z - pad.z);
      fade = Math.min(fade, smoothstep01((d - pad.radius) / PAD_FEATHER));
      if (fade === 0) break;
    }

    // Two octaves: one long swell for the diorama's silhouette, one short one
    // so the facets have something to catch light on. The offsets decorrelate
    // them; sampling the same lattice twice in phase just doubles the amplitude.
    const undulation =
      noise(x / MEADOW_SCALE, z / MEADOW_SCALE) * 0.72 +
      noise(x / MEADOW_DETAIL_SCALE + 31.7, z / MEADOW_DETAIL_SCALE + 17.3) * 0.28;

    const toPond = Math.hypot(x - POND.x, z - POND.z);
    const basin = POND_DEPTH * (1 - smoothstep01((toPond - POND.radius) / PAD_FEATHER));

    return undulation * MEADOW_AMPLITUDE * fade - basin;
  };
}

function buildGround(segments: number, height: HeightField): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, height(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ placement

const PLACE_POS = new THREE.Vector3();
const PLACE_QUAT = new THREE.Quaternion();
const PLACE_EULER = new THREE.Euler(0, 0, 0, 'YXZ');
const PLACE_SCALE = new THREE.Vector3(1, 1, 1);
const PLACE_MATRIX = new THREE.Matrix4();

/**
 * Bakes a transform into the geometry. Everything static is merged, and merging
 * only works in one shared space, so pieces are authored in world space from
 * the start rather than parented and flattened later.
 */
function place(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  PLACE_EULER.set(rx, ry, rz);
  PLACE_QUAT.setFromEuler(PLACE_EULER);
  PLACE_POS.set(x, y, z);
  PLACE_MATRIX.compose(PLACE_POS, PLACE_QUAT, PLACE_SCALE);
  geo.applyMatrix4(PLACE_MATRIX);
  return geo;
}

interface Spot {
  x: number;
  z: number;
  /** Widest visual extent from the centre - a canopy tip, a slab corner. */
  footprint: number;
  kind: 'tree' | 'ruin';
}

// --------------------------------------------------------------------- level

export function createDowns(rng: Rng): Level {
  installBvh();

  const height = createHeightField(rng);

  const root = new THREE.Group();
  root.name = 'lilypondDowns';

  const visualGroups = new Map<PaletteRole, THREE.BufferGeometry[]>();
  const collisionParts: THREE.BufferGeometry[] = [];
  const sources = new Set<THREE.BufferGeometry>();

  const addVisual = (geo: THREE.BufferGeometry, role: PaletteRole): void => {
    sources.add(geo);
    const list = visualGroups.get(role);
    if (list === undefined) visualGroups.set(role, [geo]);
    else list.push(geo);
  };

  const addCollision = (geo: THREE.BufferGeometry): void => {
    sources.add(geo);
    collisionParts.push(geo);
  };

  /** Box-shaped things are already collision-simple; one buffer serves both. */
  const addSolid = (geo: THREE.BufferGeometry, role: PaletteRole): void => {
    addVisual(geo, role);
    addCollision(geo);
  };

  // ------------------------------------------------------------------ ground
  addVisual(buildGround(GROUND_SEGMENTS, height), 'grassLit');
  addCollision(buildGround(COLLIDER_SEGMENTS, height));

  // -------------------------------------------------------------------- pond
  // The surface quad is deliberately NOT collidable: the player wades in, the
  // basin floor carries them. The bed underneath is.
  const pondFloor = height(POND.x, POND.z);

  const bed = new THREE.CircleGeometry(BED_RADIUS, BED_SEGMENTS);
  bed.rotateX(-Math.PI / 2);
  addSolid(place(bed, POND.x, pondFloor + BED_LIFT, POND.z), 'waterDeep');

  const surface = new THREE.CircleGeometry(WATER_RADIUS, WATER_SEGMENTS);
  surface.rotateX(-Math.PI / 2);
  addVisual(place(surface, POND.x, pondFloor + WATER_LEVEL, POND.z), 'waterShallow');

  // ---------------------------------------------------------------- plateau
  const terraceY = height(PLATEAU.x, PLATEAU.z);
  const plateauSouth = PLATEAU.z + PLATEAU.sizeZ * 0.5;
  const plateauEast = PLATEAU.x + PLATEAU.sizeX * 0.5;
  const plateauHeight = PLATEAU.top + PLATEAU.bury;
  addSolid(
    place(
      new THREE.BoxGeometry(PLATEAU.sizeX, plateauHeight, PLATEAU.sizeZ),
      PLATEAU.x,
      terraceY + PLATEAU.top - plateauHeight * 0.5,
      PLATEAU.z,
    ),
    'grassShade',
  );

  // The only way up. Authored from the two ends of its WALKING SURFACE, then
  // sunk half a thickness down its own local up-axis, so the surface the
  // controller touches lands exactly where the geometry says it does.
  const rampRun = PLATEAU.top / Math.tan(RAMP_ANGLE);
  const rampUp = new THREE.Vector3(0, Math.cos(RAMP_ANGLE), Math.sin(RAMP_ANGLE));
  const rampDown = new THREE.Vector3(0, -Math.sin(RAMP_ANGLE), Math.cos(RAMP_ANGLE));
  const rampMid = new THREE.Vector3(
    PLATEAU.x,
    terraceY + PLATEAU.top * 0.5,
    plateauSouth + rampRun * 0.5,
  )
    .addScaledVector(rampDown, SLOPE_FOOT_EXTEND * 0.5)
    .addScaledVector(rampUp, -SLOPE_THICKNESS * 0.5);
  addSolid(
    place(
      new THREE.BoxGeometry(
        RAMP_WIDTH,
        SLOPE_THICKNESS,
        Math.hypot(PLATEAU.top, rampRun) + SLOPE_FOOT_EXTEND,
      ),
      rampMid.x,
      rampMid.y,
      rampMid.z,
      RAMP_ANGLE,
    ),
    'grassShade',
  );

  // The unclimbable face, on the plateau's other flank. Its uphill cap leans
  // back INTO the plateau, so the two solids meet with no seam to squeeze past.
  const steepRun = PLATEAU.top / Math.tan(STEEP_ANGLE);
  const steepUp = new THREE.Vector3(Math.sin(STEEP_ANGLE), Math.cos(STEEP_ANGLE), 0);
  const steepDown = new THREE.Vector3(Math.cos(STEEP_ANGLE), -Math.sin(STEEP_ANGLE), 0);
  const steepMid = new THREE.Vector3(
    plateauEast + steepRun * 0.5,
    terraceY + PLATEAU.top * 0.5,
    PLATEAU.z,
  )
    .addScaledVector(steepDown, SLOPE_FOOT_EXTEND * 0.5)
    .addScaledVector(steepUp, -SLOPE_THICKNESS * 0.5);
  addSolid(
    place(
      new THREE.BoxGeometry(
        Math.hypot(PLATEAU.top, steepRun) + SLOPE_FOOT_EXTEND,
        SLOPE_THICKNESS,
        STEEP_WIDTH,
      ),
      steepMid.x,
      steepMid.y,
      steepMid.z,
      0,
      0,
      -STEEP_ANGLE,
    ),
    'grassShade',
  );

  // -------------------------------------------------------------- staircase
  // Stacked slabs rather than free-standing steps: each slab runs all the way
  // to the back of the flight, so there is no gap under a tread to fall into.
  const stairY = height(STAIR_PAD.x, STAIR_PAD.z);
  for (let i = 0; i < STAIR.count; i++) {
    const top = stairY + STEP_RISE * (i + 1);
    const front = STAIR.front - STAIR.tread * i;
    const depth = front - STAIR.back;
    const slabHeight = top - (stairY - STAIR_BURY);
    addSolid(
      place(
        new THREE.BoxGeometry(STAIR.width, slabHeight, depth),
        STAIR.x,
        top - slabHeight * 0.5,
        front - depth * 0.5,
      ),
      'stoneLit',
    );
  }

  // ------------------------------------------------------------------- wall
  const wallY = height(WALL.x, WALL.z);
  const wallHeight = WALL.height + WALL.bury;
  addSolid(
    place(
      new THREE.BoxGeometry(WALL.width, wallHeight, WALL.depth),
      WALL.x,
      wallY + WALL.height - wallHeight * 0.5,
      WALL.z,
    ),
    'stoneShade',
  );

  // ------------------------------------------------------------------ props
  const occupied: Spot[] = [];

  /**
   * True when a prop of `footprint` may stand at (x, z). PLAY_KEEPOUT is
   * tested against the CENTRE - a canopy leaning over a path is charm - but
   * structures and other props are tested footprint against footprint, so
   * nothing scattered stands inside anything, authored or scattered. The one
   * softness left is tree-against-tree, where `spacing` alone applies:
   * interlocking canopies read as a grove, and a grove is the point of them.
   */
  const clearAt = (
    x: number,
    z: number,
    kind: Spot['kind'],
    footprint: number,
    spacing: number,
  ): boolean => {
    for (const keep of PLAY_KEEPOUT) {
      if (Math.hypot(x - keep.x, z - keep.z) < keep.radius) return false;
    }
    for (const keep of STRUCTURE_KEEPOUT) {
      if (Math.hypot(x - keep.x, z - keep.z) < keep.radius + footprint) {
        return false;
      }
    }
    for (const other of occupied) {
      const need =
        kind === 'tree' && other.kind === 'tree'
          ? spacing
          : Math.max(spacing, footprint + other.footprint);
      if (Math.hypot(x - other.x, z - other.z) < need) return false;
    }
    return true;
  };

  /**
   * The prop's DIMENSIONS are drawn before its position is searched for, so
   * the footprint being tested is the real one rather than a worst case - and
   * so the number of rejected positions can never change what the prop looks
   * like, only where it stands.
   */
  const treeStream = rng.fork('trees');
  let treeBudget = PROP_ATTEMPTS;
  for (let placed = 0; placed < TREE_COUNT && treeBudget > 0; placed++) {
    const yaw = treeStream.range(0, Math.PI * 2);
    const trunk = treeStream.range(1.2, 2.0);
    const canopyRadius = treeStream.range(1.3, 1.9);
    const canopyHeight = treeStream.range(1.9, 2.7);

    let spot: Spot | null = null;
    while (spot === null && treeBudget-- > 0) {
      const x = treeStream.range(-PROP_MARGIN, PROP_MARGIN);
      const z = treeStream.range(-PROP_MARGIN, PROP_MARGIN);
      if (clearAt(x, z, 'tree', canopyRadius, TREE_SPACING)) {
        spot = { x, z, footprint: canopyRadius, kind: 'tree' };
      }
    }
    if (spot === null) break;
    occupied.push(spot);

    const base = height(spot.x, spot.z);
    const shoulder = base + trunk * 0.72;

    // Five radial segments everywhere: enough to read as a cone, few enough
    // that every silhouette edge stays a hard angular line.
    addVisual(
      place(
        new THREE.CylinderGeometry(0.13, 0.2, trunk + 0.4, 5, 1),
        spot.x,
        base + trunk * 0.5 - 0.2,
        spot.z,
        0,
        yaw,
      ),
      'stoneShade',
    );
    addVisual(
      place(
        new THREE.ConeGeometry(canopyRadius, canopyHeight, 5, 1),
        spot.x,
        shoulder + canopyHeight * 0.5,
        spot.z,
        0,
        yaw,
      ),
      'canopy',
    );
    addVisual(
      place(
        new THREE.ConeGeometry(canopyRadius * 0.64, canopyHeight * 0.8, 5, 1),
        spot.x,
        shoulder + canopyHeight * 1.02,
        spot.z,
        0,
        yaw + 0.6,
      ),
      'canopy',
    );
    // Canopies are walk-through; only the trunk exists to the controller.
    addCollision(
      place(
        new THREE.BoxGeometry(0.34, trunk + 1.0, 0.34),
        spot.x,
        base + trunk * 0.5,
        spot.z,
        0,
        yaw,
      ),
    );
  }

  const ruinStream = rng.fork('ruins');
  let ruinBudget = PROP_ATTEMPTS;
  for (let placed = 0; placed < RUIN_COUNT && ruinBudget > 0; placed++) {
    const yaw = ruinStream.range(-0.5, 0.5);
    const kind = ruinStream.int(0, 3);
    const role = ruinStream.pick(RUIN_ROLES);

    let w = 2.0;
    let h = 0.65;
    let d = 2.0; // plinth
    if (kind === 0) {
      w = 0.95;
      h = ruinStream.range(1.6, 3.4); // broken pillar
      d = 0.95;
    } else if (kind === 1) {
      w = ruinStream.range(2.2, 3.6);
      h = 1.3; // fallen wall chunk
      d = 0.85;
    }

    // A box's widest reach is its half-diagonal, whatever its yaw.
    const footprint = Math.hypot(w, d) * 0.5;
    let spot: Spot | null = null;
    while (spot === null && ruinBudget-- > 0) {
      const x = ruinStream.range(-PROP_MARGIN, PROP_MARGIN);
      const z = ruinStream.range(-PROP_MARGIN, PROP_MARGIN);
      if (clearAt(x, z, 'ruin', footprint, RUIN_SPACING)) {
        spot = { x, z, footprint, kind: 'ruin' };
      }
    }
    if (spot === null) break;
    occupied.push(spot);

    const base = height(spot.x, spot.z);
    const blockHeight = h + RUIN_BURY;
    addSolid(
      place(
        new THREE.BoxGeometry(w, blockHeight, d),
        spot.x,
        base + h - blockHeight * 0.5,
        spot.z,
        0,
        yaw,
      ),
      role,
    );
  }

  // ------------------------------------------------------------------ cover
  // A deliberate mass in front of the one camera-hidden secret that has no
  // terrain of its own to hide behind. Placed AFTER the props so nothing
  // scattered can be relied on - relying on a random tree is exactly how this
  // secret silently stopped being hidden when the seed stream moved.
  for (const secret of SECRETS) {
    if (!secret.occluded || secret.cover !== true) continue;
    const cx = secret.x + TO_CAMERA.x * COVER_OFFSET;
    const cz = secret.z + TO_CAMERA.z * COVER_OFFSET;
    addSolid(
      place(
        new THREE.BoxGeometry(COVER_WIDTH, COVER_HEIGHT, COVER_DEPTH),
        cx,
        height(cx, cz) + COVER_HEIGHT * 0.5 - COVER_BURY,
        cz,
      ),
      'ruinCool',
    );
  }

  // -------------------------------------------------------------------- rim
  // Full-length bars, not inset ones: four bars that stop at the inset leave a
  // 0.5 u diagonal notch at each corner, which is almost exactly a frog wide.
  const rimSpan = MAP_SIZE;
  const rimEdge = MAP_SIZE * 0.5 - RIM_INSET;
  for (let i = 0; i < 4; i++) {
    const alongX = i < 2;
    const sign = i % 2 === 0 ? 1 : -1;
    addCollision(
      place(
        new THREE.BoxGeometry(
          alongX ? rimSpan : RIM_THICKNESS,
          RIM_HEIGHT,
          alongX ? RIM_THICKNESS : rimSpan,
        ),
        alongX ? 0 : rimEdge * sign,
        RIM_HEIGHT * 0.5 - POND_DEPTH,
        alongX ? rimEdge * sign : 0,
      ),
    );
  }

  // ------------------------------------------------------------------ merge
  const owned: THREE.BufferGeometry[] = [];

  for (const [role, parts] of visualGroups) {
    const merged = mergeGeometries(parts, false);
    merged.name = `lilypond_${role}`;

    const opts =
      role === 'waterShallow'
        ? { flatShading: true, transparent: true, opacity: WATER_OPACITY }
        : { flatShading: true };

    const mesh = new THREE.Mesh(merged, material(role, opts));
    mesh.name = merged.name;
    mesh.castShadow = !NO_CAST.includes(role);
    mesh.receiveShadow = true;
    root.add(mesh);
    owned.push(merged);
  }

  const colliderGeo = mergeGeometries(collisionParts, false);
  colliderGeo.name = 'COL_lilypondDowns';
  colliderGeo.computeBoundsTree();

  // The collider is never rasterised, so it borrows the terrain's own kit
  // material rather than introducing an unstyled one (section 9 rule 1). Same
  // options as the terrain, so it shares the instance instead of minting one.
  const collider = new THREE.Mesh(
    colliderGeo,
    material('grassShade', { flatShading: true }),
  );
  collider.name = colliderGeo.name;
  collider.visible = false;
  collider.castShadow = false;
  collider.receiveShadow = false;
  root.add(collider);

  for (const geo of sources) geo.dispose();
  sources.clear();

  root.updateMatrixWorld(true);

  // ----------------------------------------------------------------- spawns
  const playerStart = new THREE.Vector3(
    PLAYER_START.x,
    height(PLAYER_START.x, PLAYER_START.z) + SPAWN_CLEARANCE,
    PLAYER_START.z,
  );

  const spawns: SpawnPoint[] = SPORELING_SPOTS.slice(
    0,
    ACTIVE_SPORELINGS,
  ).map((spot) => ({
    type: 'sporeling',
    position: new THREE.Vector3(
      spot.x,
      height(spot.x, spot.z) + SPAWN_CLEARANCE,
      spot.z,
    ),
    // yaw 0 faces +Z, matching Object3D.rotation.y on an untransformed mesh.
    yaw: Math.atan2(playerStart.x - spot.x, playerStart.z - spot.z),
  }));

  for (const spot of BEETLE_SPOTS) {
    spawns.push({
      type: 'beetleGuard',
      position: new THREE.Vector3(
        spot.x,
        height(spot.x, spot.z) + SPAWN_CLEARANCE,
        spot.z,
      ),
      yaw: Math.atan2(playerStart.x - spot.x, playerStart.z - spot.z),
    });
  }

  for (const spot of SHRINE_SPOTS) {
    spawns.push({
      type: `shrine:${spot.id}`,
      position: new THREE.Vector3(spot.x, height(spot.x, spot.z), spot.z),
      yaw: 0,
    });
  }

  for (const spot of SPITTER_SPOTS) {
    spawns.push({
      type: 'spitterFly',
      position: new THREE.Vector3(spot.x, height(spot.x, spot.z), spot.z),
      yaw: 0,
    });
  }

  for (const spot of BRAMBLE_SPOTS) {
    spawns.push({
      type: `bramble:${spot.id}`,
      position: new THREE.Vector3(spot.x, height(spot.x, spot.z), spot.z),
      yaw: 0,
    });
  }

  spawns.push({
    type: `door:${DOOR_SPOT.id}`,
    position: new THREE.Vector3(
      DOOR_SPOT.x,
      height(DOOR_SPOT.x, DOOR_SPOT.z),
      DOOR_SPOT.z,
    ),
    yaw: DOOR_SPOT.yaw,
  });

  // Each secret pays out whatever it was authored to hold.
  for (const secret of SECRETS) {
    if (secret.reward === 'sword') continue; // placed below, with the waterfall
    const at = new THREE.Vector3(secret.x, height(secret.x, secret.z), secret.z);
    if (secret.reward === 'key') {
      spawns.push({ type: 'key', position: at, yaw: 0 });
    } else if (secret.reward.startsWith('page:')) {
      spawns.push({ type: secret.reward, position: at, yaw: 0 });
    } else {
      spawns.push({ type: 'secretCoins', position: at, yaw: 0 });
    }
  }

  for (const spot of GRAPPLE_SPOTS) {
    spawns.push({
      type: `grapple:${spot.id}`,
      position: new THREE.Vector3(spot.x, height(spot.x, spot.z), spot.z),
      yaw: 0,
    });
  }

  // Signage: one at the door you cannot open yet, one at the bramble that only
  // yields to an edge, one at the crossing the tongue is the answer to.
  spawns.push({
    type: 'sign:belfry',
    position: new THREE.Vector3(
      DOOR_SPOT.x + 2.6,
      height(DOOR_SPOT.x + 2.6, DOOR_SPOT.z + 2.2),
      DOOR_SPOT.z + 2.2,
    ),
    yaw: Math.PI,
  });
  spawns.push({
    type: 'sign:pond',
    position: new THREE.Vector3(2.4, height(2.4, 5.2), 5.2),
    yaw: Math.PI * 0.75,
  });

  spawns.push({
    type: 'sword',
    position: new THREE.Vector3(
      SWORD_SPOT.x,
      height(SWORD_SPOT.x, SWORD_SPOT.z),
      SWORD_SPOT.z,
    ),
    yaw: 0,
  });

  return {
    id: 'downs',
    root,
    collider,
    spawns,
    playerStart,
    // Coming back up out of the tower puts you on the doorstep, facing the
    // meadow - never inside the door you just came through.
    entries: {
      start: playerStart.clone(),
      belfry: new THREE.Vector3(
        DOOR_SPOT.x,
        height(DOOR_SPOT.x, DOOR_SPOT.z + 2.6),
        DOOR_SPOT.z + 2.6,
      ),
    },
    secrets: SECRETS.map((secret) => ({
      id: secret.id,
      occluded: secret.occluded,
      position: new THREE.Vector3(secret.x, height(secret.x, secret.z), secret.z),
    })),

    dispose(): void {
      colliderGeo.disposeBoundsTree();
      colliderGeo.dispose();
      for (const geo of owned) geo.dispose();
      owned.length = 0;
      // Materials are shared, cached instances owned by the material kit -
      // disposing them here would strip every other object in the scene.
      root.clear();
    },
  };
}
