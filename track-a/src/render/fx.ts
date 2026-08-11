/**
 * CROAK - the particle pool. PROMPT.md sections 5, 8 and 9 rule 9.
 *
 * Every impact has to fire a visual on the frame it lands, and combat runs
 * against a 150-draw-call budget, so particles are pre-allocated instances of
 * four merged batches - one per palette role - that never allocate, sort or
 * grow once the game is running. Worst case the whole system is four draws;
 * an idle frame is zero, because an empty batch turns itself invisible.
 *
 * `update` integrates whatever dt the caller hands it. That is deliberate: the
 * loop keeps feeding FX real time through hitstop (section 5, "particles keep
 * running") while the simulation is frozen, and this module must not have an
 * opinion about which clock it is being driven by.
 */

import * as THREE from 'three';
import type { FxKind, Rng } from '../core/types';
import type { PaletteRole } from './palette';
import { DEFAULT_SEED } from '../core/constants';
import { createRng } from '../core/rng';
import { material } from './materials';

// ------------------------------------------------------------- style tuning
// Presentation numbers for the look of the puffs, kept beside the emitters
// they describe the way materials.ts keeps its look numbers. No gameplay rule
// reads any of them.

const TAU = Math.PI * 2;
const EPS = 1e-6;
/** Shard geometry is modelled along +Z, then rotated onto its travel vector. */
const FORWARD = new THREE.Vector3(0, 0, 1);
/**
 * Fraction of full size a particle already has on its spawn frame. Never zero:
 * the roll's dust cloud IS the i-frame tell, and a tell that takes three frames
 * to fade up is three frames of lie.
 */
const POP_FLOOR = 0.45;
/** Ring emitters break their own symmetry by this much, in radians. */
const RING_JITTER = 0.22;
/** Ring radius varies per particle so the ring never reads as a stamped decal. */
const RADIUS_MIN = 0.72;
const RADIUS_MAX = 1.18;
/** Puff tumble rate, radians/s. */
const SPIN_MAX = 6.0;

// -------------------------------------------------------------------- pools

type GroupName = 'dustWarm' | 'dustPale' | 'spore' | 'spark';

interface GroupSpec {
  role: PaletteRole;
  /** Shards orient to their travel vector; puffs tumble on all three axes. */
  shard: boolean;
  emissive: boolean;
  capacity: number;
}

/**
 * One batch per palette role. Splitting warm ground dust from pale air dust is
 * the whole reason a footstep and a roll read as different events at gameplay
 * zoom - section 9 rule 11 asks for shape and motion, and this is the cheapest
 * place to also give them separate value.
 */
const GROUPS: Record<GroupName, GroupSpec> = {
  dustWarm: { role: 'stoneLit', shard: false, emissive: false, capacity: 72 },
  dustPale: { role: 'hazeSky', shard: false, emissive: false, capacity: 56 },
  spore: { role: 'canopy', shard: false, emissive: false, capacity: 84 },
  spark: { role: 'gold', shard: true, emissive: true, capacity: 48 },
};

interface Emitter {
  group: GroupName;
  count: number;
  /** Ring emitters fan out on the ground plane; cone emitters follow `dir`. */
  ring: boolean;
  radius: number;
  /** Spawn height above the requested point. */
  height: number;
  /** How far below the spawn point a particle may fall before it beaches. */
  floorDrop: number;
  speedMin: number;
  speedMax: number;
  riseMin: number;
  riseMax: number;
  sizeMin: number;
  sizeMax: number;
  lifeMin: number;
  lifeMax: number;
  /** Final size as a multiple of the spawn size. Below 1 the puff collapses. */
  growth: number;
  /** Fraction of the life spent swelling in from POP_FLOOR. */
  pop: number;
  /** Velocity damping, per second. High drag is what makes dust settle. */
  drag: number;
  gravity: number;
  /** Cone half-spread, radians. Unused by ring emitters. */
  spread: number;
  /** Ring push along `dir` - negative kicks the ring out behind the mover. */
  bias: number;
}

const EMITTERS: Record<FxKind, Emitter> = {
  // A blow turned by the Beetle Guard's shield. Tight, hard and bounced back
  // along the incoming blow, so it reads as "stopped" rather than "landed" -
  // the player must be able to tell a block from a hit without the health bar.
  guardSpark: {
    group: 'spark',
    count: 9,
    ring: false,
    radius: 0.08,
    height: 0,
    floorDrop: 1.0,
    speedMin: 3.4,
    speedMax: 6.2,
    riseMin: 0.9,
    riseMax: 2.1,
    sizeMin: 0.07,
    sizeMax: 0.13,
    lifeMin: 0.16,
    lifeMax: 0.3,
    growth: 0.35,
    pop: 0.06,
    drag: 7.5,
    gravity: -5.0,
    spread: 0.85,
    bias: 0,
  },
  // The little flourish a coin makes going in. Small enough to fire often.
  coinPop: {
    group: 'spark',
    count: 5,
    ring: true,
    radius: 0.1,
    height: 0.1,
    floorDrop: 0.6,
    speedMin: 0.8,
    speedMax: 1.6,
    riseMin: 1.2,
    riseMax: 2.0,
    sizeMin: 0.06,
    sizeMax: 0.1,
    lifeMin: 0.22,
    lifeMax: 0.36,
    growth: 0.5,
    pop: 0.12,
    drag: 4.0,
    gravity: -3.0,
    spread: 0,
    bias: 0,
  },
  // Resting: a slow upward breath of pale light, nothing like an impact.
  shrineRest: {
    group: 'dustPale',
    count: 14,
    ring: true,
    radius: 0.5,
    height: 0.15,
    floorDrop: 0,
    speedMin: 0.25,
    speedMax: 0.7,
    riseMin: 1.4,
    riseMax: 2.6,
    sizeMin: 0.12,
    sizeMax: 0.22,
    lifeMin: 0.9,
    lifeMax: 1.5,
    growth: 1.8,
    pop: 0.25,
    drag: 1.2,
    gravity: 0.6,
    spread: 0,
    bias: 0,
  },
  // The Tunic tell: a low ring that blooms outward and settles almost at once,
  // biased backwards so it reads as ground kicked up by the roll's launch.
  rollDust: {
    group: 'dustWarm',
    count: 10,
    ring: true,
    radius: 0.34,
    height: 0.05,
    floorDrop: 0,
    speedMin: 1.1,
    speedMax: 1.9,
    riseMin: 0.35,
    riseMax: 0.8,
    sizeMin: 0.16,
    sizeMax: 0.26,
    lifeMin: 0.42,
    lifeMax: 0.62,
    growth: 2.6,
    pop: 0.1,
    drag: 5.0,
    gravity: -1.4,
    spread: 0,
    bias: -0.35,
  },
  // Short, bright, gone before the hitstop ends - the spark is punctuation.
  hitSpark: {
    group: 'spark',
    count: 7,
    ring: false,
    radius: 0,
    height: 0,
    floorDrop: 1.0,
    speedMin: 4.5,
    speedMax: 7.5,
    riseMin: 0.6,
    riseMax: 1.6,
    sizeMin: 0.1,
    sizeMax: 0.17,
    lifeMin: 0.14,
    lifeMax: 0.22,
    growth: 0.35,
    pop: 0.06,
    drag: 9.0,
    gravity: -6.0,
    spread: 0.55,
    bias: 0,
  },
  // The sporeling's whole body becoming air: slow, buoyant, and it keeps
  // growing the entire time so the last frame is the widest.
  sporePuff: {
    group: 'spore',
    count: 14,
    ring: true,
    radius: 0.18,
    height: 0.16,
    floorDrop: 0.35,
    speedMin: 0.9,
    speedMax: 1.7,
    riseMin: 1.1,
    riseMax: 2.1,
    sizeMin: 0.13,
    sizeMax: 0.22,
    lifeMin: 0.5,
    lifeMax: 0.85,
    growth: 4.0,
    pop: 0.1,
    drag: 3.2,
    gravity: -0.5,
    spread: 0,
    bias: 0,
  },
  footstep: {
    group: 'dustPale',
    count: 2,
    ring: true,
    radius: 0.1,
    height: 0.03,
    floorDrop: 0,
    speedMin: 0.5,
    speedMax: 0.9,
    riseMin: 0.25,
    riseMax: 0.5,
    sizeMin: 0.08,
    sizeMax: 0.13,
    lifeMin: 0.22,
    lifeMax: 0.34,
    growth: 2.0,
    pop: 0.14,
    drag: 6.0,
    gravity: -1.2,
    spread: 0,
    bias: 0,
  },
  landDust: {
    group: 'dustPale',
    count: 6,
    ring: true,
    radius: 0.22,
    height: 0.04,
    floorDrop: 0,
    speedMin: 1.2,
    speedMax: 2.0,
    riseMin: 0.3,
    riseMax: 0.7,
    sizeMin: 0.11,
    sizeMax: 0.18,
    lifeMin: 0.3,
    lifeMax: 0.45,
    growth: 2.2,
    pop: 0.12,
    drag: 6.5,
    gravity: -1.6,
    spread: 0,
    bias: 0,
  },
};

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Frozen travel direction, for shards that must not wobble as they slow. */
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  floor: number;
  life: number;
  maxLife: number;
  size: number;
  growth: number;
  pop: number;
  drag: number;
  gravity: number;
}

interface Group {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  pool: Particle[];
  active: number;
  shard: boolean;
}

export interface FxSystem {
  spawn(kind: FxKind, position: THREE.Vector3, dir?: THREE.Vector3): void;
  update(dt: number): void;
  dispose(): void;
}

function blankParticle(): Particle {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    rx: 0,
    ry: 0,
    rz: 0,
    spinX: 0,
    spinY: 0,
    spinZ: 0,
    floor: 0,
    life: 0,
    maxLife: 1,
    size: 1,
    growth: 1,
    pop: 1,
    drag: 0,
    gravity: 0,
  };
}

/**
 * Faceted so the toon ramp has edges to band across - a smooth sphere at this
 * size resolves to one flat blob and stops reading as a puff of anything.
 */
function puffGeometry(): THREE.BufferGeometry {
  return new THREE.IcosahedronGeometry(1, 0);
}

/** A spindle: long enough to read as a streak, thin enough to read as a shard. */
function shardGeometry(): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(1, 0).scale(0.32, 0.32, 2.1);
}

/**
 * @param rng optional: pass the run's generator and FX inherit the recorded
 *   seed. Without one the pool still never touches `Math.random` (section 9
 *   rule 7) - it just runs on its own fixed stream.
 */
export function createFx(scene: THREE.Scene, rng?: Rng): FxSystem {
  const stream = (rng ?? createRng(DEFAULT_SEED)).fork('fx');

  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);

  const groups = {} as Record<GroupName, Group>;
  for (const name of Object.keys(GROUPS) as GroupName[]) {
    const spec = GROUPS[name];
    const geometry = spec.shard ? shardGeometry() : puffGeometry();
    const mesh = new THREE.InstancedMesh(
      geometry,
      material(spec.role, { emissive: spec.emissive, flatShading: true }),
      spec.capacity,
    );
    mesh.name = `fx_${name}`;
    // Instances carry the transform, so the batch's own bounds are meaningless
    // and a cull test on them would pop the whole batch off at the screen edge.
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.count = 0;
    root.add(mesh);

    const pool: Particle[] = new Array(spec.capacity);
    for (let i = 0; i < spec.capacity; i++) pool[i] = blankParticle();

    groups[name] = { mesh, geometry, pool, active: 0, shard: spec.shard };
  }

  // Scratch objects hoisted out of the hot path: a burst must not allocate.
  const dummy = new THREE.Object3D();
  const aim = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const perpA = new THREE.Vector3();
  const perpB = new THREE.Vector3();
  const travel = new THREE.Vector3();

  function claim(g: Group): Particle {
    if (g.active < g.pool.length) return g.pool[g.active++];
    // A full pool recycles whatever is closest to dying, so an overflow costs
    // the least visible particle rather than dropping the newest request.
    let worst = 0;
    for (let i = 1; i < g.active; i++) {
      if (g.pool[i].life < g.pool[worst].life) worst = i;
    }
    return g.pool[worst];
  }

  function spawn(
    kind: FxKind,
    position: THREE.Vector3,
    dir?: THREE.Vector3,
  ): void {
    const e = EMITTERS[kind];
    const g = groups[e.group];

    let aimed = false;
    aim.set(0, 1, 0);
    if (dir !== undefined) {
      const length = dir.length();
      if (length > EPS) {
        aim.copy(dir).multiplyScalar(1 / length);
        aimed = true;
      }
    }

    if (!e.ring) {
      // Any vector not parallel to the aim seeds a stable perpendicular basis.
      axis.set(0, 1, 0);
      if (Math.abs(aim.y) > 0.9) axis.set(1, 0, 0);
      perpA.crossVectors(aim, axis).normalize();
      perpB.crossVectors(perpA, aim).normalize();
    }

    const bias = aimed ? e.bias : 0;

    for (let i = 0; i < e.count; i++) {
      const p = claim(g);
      const speed = stream.range(e.speedMin, e.speedMax);
      const rise = stream.range(e.riseMin, e.riseMax);

      if (e.ring) {
        const angle = (i / e.count) * TAU + stream.range(-RING_JITTER, RING_JITTER);
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const radius = e.radius * stream.range(RADIUS_MIN, RADIUS_MAX);
        p.x = position.x + ca * radius;
        p.y = position.y + e.height * stream.range(0.5, 1.5);
        p.z = position.z + sa * radius;
        p.vx = ca * speed + aim.x * bias * speed;
        p.vy = rise;
        p.vz = sa * speed + aim.z * bias * speed;
      } else {
        // Square-rooted radius keeps the cone's density even instead of
        // clumping every shard down the middle.
        const roll = stream.range(0, TAU);
        const spread = Math.sqrt(stream.next()) * e.spread;
        const cr = Math.cos(roll) * spread;
        const sr = Math.sin(roll) * spread;
        p.x = position.x;
        p.y = position.y + e.height;
        p.z = position.z;
        p.vx = (aim.x + perpA.x * cr + perpB.x * sr) * speed;
        p.vy = (aim.y + perpA.y * cr + perpB.y * sr) * speed + rise;
        p.vz = (aim.z + perpA.z * cr + perpB.z * sr) * speed;
      }

      travel.set(p.vx, p.vy, p.vz);
      const moving = travel.length();
      if (moving > EPS) {
        p.dx = travel.x / moving;
        p.dy = travel.y / moving;
        p.dz = travel.z / moving;
      } else {
        p.dx = 0;
        p.dy = 1;
        p.dz = 0;
      }

      p.rx = stream.range(0, TAU);
      p.ry = stream.range(0, TAU);
      p.rz = stream.range(0, TAU);
      p.spinX = stream.range(-SPIN_MAX, SPIN_MAX);
      p.spinY = stream.range(-SPIN_MAX, SPIN_MAX);
      p.spinZ = stream.range(-SPIN_MAX, SPIN_MAX);

      p.floor = position.y - e.floorDrop;
      p.maxLife = stream.range(e.lifeMin, e.lifeMax);
      p.life = p.maxLife;
      p.size = stream.range(e.sizeMin, e.sizeMax);
      p.growth = e.growth;
      p.pop = e.pop;
      p.drag = e.drag;
      p.gravity = e.gravity;
    }
  }

  function update(dt: number): void {
    if (dt <= 0) return;

    for (const name of Object.keys(groups) as GroupName[]) {
      const g = groups[name];
      if (g.active === 0) {
        if (g.mesh.visible) {
          g.mesh.visible = false;
          g.mesh.count = 0;
        }
        continue;
      }

      let n = g.active;
      for (let i = n - 1; i >= 0; i--) {
        const p = g.pool[i];
        p.life -= dt;
        if (p.life <= 0) {
          // Swap-remove: the survivor moved into slot i sits above the cursor
          // and has already been stepped this frame.
          n--;
          g.pool[i] = g.pool[n];
          g.pool[n] = p;
          continue;
        }

        const damping = Math.exp(-p.drag * dt);
        p.vy += p.gravity * dt;
        p.vx *= damping;
        p.vy *= damping;
        p.vz *= damping;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < p.floor) {
          // Dust beaches on the ground and skids instead of tunnelling through
          // it - section 9 rule 5, nothing floats and nothing sinks either.
          p.y = p.floor;
          p.vy = 0;
        }

        p.rx += p.spinX * dt;
        p.ry += p.spinY * dt;
        p.rz += p.spinZ * dt;
      }
      g.active = n;

      if (n === 0) {
        g.mesh.visible = false;
        g.mesh.count = 0;
        continue;
      }

      for (let i = 0; i < n; i++) {
        const p = g.pool[i];
        const t = 1 - p.life / p.maxLife;
        const swell = POP_FLOOR + (1 - POP_FLOOR) * Math.min(1, t / p.pop);
        const scale = p.size * (1 + (p.growth - 1) * t) * swell * (1 - t * t);

        dummy.position.set(p.x, p.y, p.z);
        if (g.shard) {
          travel.set(p.dx, p.dy, p.dz);
          dummy.quaternion.setFromUnitVectors(FORWARD, travel);
        } else {
          dummy.rotation.set(p.rx, p.ry, p.rz);
        }
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        g.mesh.setMatrixAt(i, dummy.matrix);
      }

      g.mesh.count = n;
      g.mesh.visible = true;
      g.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function dispose(): void {
    for (const name of Object.keys(groups) as GroupName[]) {
      const g = groups[name];
      g.mesh.removeFromParent();
      g.mesh.dispose();
      g.geometry.dispose();
    }
    root.removeFromParent();
    // Materials are the kit's; disposeMaterials() releases them for everyone.
  }

  return { spawn, update, dispose };
}
