/**
 * CROAK - the Sporeling. PROMPT.md section 6: "small, pullable, pops into
 * spore puff". The first enemy the player ever meets, so it is also the demo's
 * whole lesson in reading a telegraph.
 *
 * The seven-state machine mirrors the frog's: transitions are checked before
 * the state body runs, and the telegraph window is the one thing in the file
 * that nothing is allowed to shorten. Its tell lands on the FIRST frame of the
 * windup and holds for the full SPORELING.telegraph, which is longer than the
 * longest hitstop - so no freeze and no shake can eat the player's reaction
 * time (section 9 rule 9).
 *
 * Every stat comes from SPORELING in core/constants. What lives here is the
 * wiring and the greybox body.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  Damageable,
  Enemy,
  EnemyStateName,
  GameContext,
  HitInfo,
  Level,
  MassClass,
  Rng,
  TongueOutcome,
} from '../core/types';
import {
  COIN_DROP_SPORELING,
  ENEMY_STAGGER,
  HITSTOP_KILL,
  HITSTOP_LIGHT,
  KNOCKBACK_PLAYER,
  KNOCKBACK_SMALL_ENEMY,
  SPORELING,
  SQUASH_HOP,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  TICK_DT,
  TONGUE_THROW_DAMAGE,
  TONGUE_THROW_RANGE,
  TONGUE_THROW_SPEED,
  TRAUMA_HIT,
  TURN_RATE,
} from '../core/constants';
import { makeOutline, material } from '../render/materials';
import { createController } from '../physics/controller';

// ------------------------------------------------------------- style tuning
// Model proportions and presentation, kept beside the model they describe the
// way materials.ts keeps its look numbers. No gameplay rule reads any of them
// except BODY_RADIUS, which is the body itself and therefore the hurt volume.

/** Cap dome radius. The mushroom's widest point, so it is also the hurt disc. */
const CAP_RADIUS = 0.3;
/** Squashed dome: a hemisphere reads as a ball, a squashed one reads as a cap. */
const CAP_SQUASH = 0.72;
const CAP_HEIGHT = 0.34;
const STALK_HEIGHT = 0.3;
const BODY_RADIUS = CAP_RADIUS;
/** Its collision capsule cannot be shorter than its own diameter. */
const BODY_HEIGHT = CAP_RADIUS * 2;
/** Spore puffs leave from the cap, not from the feet. */
const FX_HEIGHT = 0.32;

/** Idle bob: a mushroom breathing. Rate varies per spawn so a group desyncs. */
const BOB_RATE_MIN = 4.4;
const BOB_RATE_MAX = 6.2;
const BOB_AMPLITUDE = 0.03;
const BOB_GAIT_IDLE = 0.45;
const SWAY_RATE = 1.9;
const SWAY_ANGLE = 0.07; // rad

/**
 * The tell shell sits between the body and its ink outline, so a flash floods
 * the creature with light while the silhouette stays drawn.
 */
const SHELL_OFFSET = 0.022;
const SHELL_SWELL = 0.11;
/** Swells this many times across the windup: a heartbeat, not a strobe. */
const TELL_PULSES = 3;
const HURT_FLASH_TIME = 0.11;

/** Each body owns half of an overlap; the neighbour resolves the other half. */
const SEPARATION_SHARE = 0.5;

// -------------------------------------------------------------- solver slack

const TAU = Math.PI * 2;
/** Half a tick. State windows are compared on accumulated floats, not integers. */
const TIME_EPS = TICK_DT * 0.5;
const EPS = 1e-4;
/** Linear ramp-down over the stagger, integrating to exactly KNOCKBACK_SMALL_ENEMY. */
const KNOCKBACK_SPEED = (2 * KNOCKBACK_SMALL_ENEMY) / ENEMY_STAGGER;

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

// -------------------------------------------------------------------- model

/** Bakes a placement into the geometry so parts can be merged by palette role. */
function place(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.BufferGeometry {
  geometry.scale(sx, sy, sz);
  geometry.translate(x, y, z);
  return geometry;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/** Toadstool freckles: [polar angle from the cap's pole, azimuth, radius]. */
const CAP_SPOTS: readonly (readonly [number, number, number])[] = [
  [0.62, 0.35, 0.062],
  [0.95, 2.1, 0.05],
  [0.7, 3.7, 0.058],
  [1.05, 5.15, 0.046],
];

interface SporelingModel {
  visual: THREE.Group;
  shell: THREE.Mesh;
  geometries: THREE.BufferGeometry[];
}

/**
 * A toadstool with feet. The frog is a wide low sphere with its mass at the
 * bottom; this is a thin stalk carrying an overhanging cap, so the two never
 * share a silhouette at gameplay zoom (section 9 rule 11). Parts are merged
 * down to one mesh per palette role: three draws plus two hulls per spawn.
 */
function buildSporeling(): SporelingModel {
  const visual = new THREE.Group();
  visual.name = 'sporelingBody';

  const cap = merge([
    // dome, cut a little past its equator so the underside has a real lip
    place(
      new THREE.SphereGeometry(CAP_RADIUS, 10, 5, 0, TAU, 0, Math.PI * 0.54),
      0,
      CAP_HEIGHT,
      0,
      1,
      CAP_SQUASH,
      1,
    ),
    // skirt: the overhang is what makes the shape read as a mushroom
    place(
      new THREE.CylinderGeometry(CAP_RADIUS, CAP_RADIUS * 0.78, 0.055, 10),
      0,
      CAP_HEIGHT - 0.005,
      0,
    ),
  ]);

  const paleParts: THREE.BufferGeometry[] = [
    // stalk, tapering upward so the cap looks carried rather than balanced
    place(
      new THREE.CylinderGeometry(0.115, 0.155, STALK_HEIGHT, 8),
      0,
      STALK_HEIGHT * 0.5,
      0,
    ),
    // splayed foot: it must sit on the ground, not hover over it
    place(new THREE.SphereGeometry(0.165, 8, 5), 0, 0.04, 0, 1, 0.34, 1),
  ];
  for (const [theta, phi, radius] of CAP_SPOTS) {
    const st = Math.sin(theta);
    paleParts.push(
      place(
        new THREE.SphereGeometry(radius, 6, 4),
        CAP_RADIUS * st * Math.cos(phi),
        CAP_HEIGHT + CAP_RADIUS * CAP_SQUASH * Math.cos(theta),
        CAP_RADIUS * st * Math.sin(phi),
        1,
        0.55,
        1,
      ),
    );
  }
  const pale = merge(paleParts);

  const eyes = merge([
    place(new THREE.SphereGeometry(0.042, 6, 5), 0.062, 0.2, 0.128),
    place(new THREE.SphereGeometry(0.042, 6, 5), -0.062, 0.2, 0.128),
  ]);

  const shellGeometry = merge([
    place(
      new THREE.SphereGeometry(
        CAP_RADIUS + SHELL_OFFSET,
        10,
        5,
        0,
        TAU,
        0,
        Math.PI * 0.54,
      ),
      0,
      CAP_HEIGHT,
      0,
      1,
      CAP_SQUASH,
      1,
    ),
    place(
      new THREE.CylinderGeometry(
        CAP_RADIUS + SHELL_OFFSET,
        CAP_RADIUS * 0.78 + SHELL_OFFSET,
        0.055 + SHELL_OFFSET * 2,
        10,
      ),
      0,
      CAP_HEIGHT - 0.005,
      0,
    ),
    place(
      new THREE.CylinderGeometry(
        0.115 + SHELL_OFFSET,
        0.155 + SHELL_OFFSET,
        STALK_HEIGHT + SHELL_OFFSET,
        8,
      ),
      0,
      STALK_HEIGHT * 0.5,
      0,
    ),
  ]);

  const capMesh = new THREE.Mesh(cap, material('canopy', { flatShading: true }));
  capMesh.name = 'sporelingCap';
  const stalkMesh = new THREE.Mesh(
    pale,
    material('heroBelly', { flatShading: true }),
  );
  stalkMesh.name = 'sporelingStalk';
  const eyeMesh = new THREE.Mesh(eyes, material('dungeonDark'));
  eyeMesh.name = 'sporelingEyes';

  const geometries = [cap, pale, eyes, shellGeometry];

  for (const mesh of [capMesh, stalkMesh, eyeMesh]) {
    // Real shadow only, like the frog: one grounding treatment per character
    // (section 9 rule 5), and for a mushroom the key light's own silhouette is
    // also the tell that says how far away from the player it still is.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    visual.add(mesh);
  }
  // The hulls are clones of our geometry, so this entity owns and releases them.
  for (const mesh of [capMesh, stalkMesh]) {
    const outline = makeOutline(mesh);
    geometries.push(outline.geometry);
    visual.add(outline);
  }

  const shell = new THREE.Mesh(
    shellGeometry,
    material('dungeonGlow', { emissive: true, flatShading: true }),
  );
  shell.name = 'sporelingTell';
  shell.visible = false;
  // The tell is light, not an occluder: it must never darken the ground under
  // the creature the player is trying to read.
  shell.castShadow = false;
  shell.receiveShadow = false;
  visual.add(shell);

  return { visual, shell, geometries };
}

// ---------------------------------------------------------------- sporeling

export function createSporeling(
  scene: THREE.Scene,
  level: Level,
  position: THREE.Vector3,
  rng: Rng,
): Enemy {
  // The same capsule solver the frog uses. Writing x/z and leaving y at its
  // spawn value is what makes an enemy hover over a rise and wade through a
  // dip (section 9 rule 5: nothing floats), and it also let a chase walk
  // straight through the wall it was meant to be blocked by.
  const controller = createController(level.collider, position, {
    radius: BODY_RADIUS,
    height: BODY_HEIGHT,
  });
  controller.teleport(position);

  const root = new THREE.Group();
  root.name = 'sporeling';
  const model = buildSporeling();
  root.add(model.visual);

  scene.add(root);

  // Every per-spawn variation is drawn here, in a fixed order, from the stream
  // the caller handed us: two runs of the same seed animate identically and
  // Math.random never enters gameplay (section 9 rule 7).
  const bobPhase = rng.next() * TAU;
  const bobRate = rng.range(BOB_RATE_MIN, BOB_RATE_MAX);
  const swayPhase = rng.next() * TAU;
  const nudgeAngle = rng.next() * TAU;

  const tellMaterial = material('dungeonGlow', {
    emissive: true,
    flatShading: true,
  });
  const hurtMaterial = material('heroBelly', {
    emissive: true,
    flatShading: true,
  });

  const pos = controller.position;
  /** Everything the state machine wants to move this step, resolved once. */
  const travel = new THREE.Vector3();
  const knockDir = new THREE.Vector3(0, 0, 1);
  const hitDir = new THREE.Vector3();
  const struck = new Set<Damageable>();

  let state: EnemyStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let hp = SPORELING.hp;
  let facing = 0;
  let squash = 1;
  let knockSpeed = 0;
  let hurtFlash = 0;
  let ctxRef: GameContext | null = null;
  /** In the frog's mouth: the tongue owns where it is until it is let go. */
  let held = false;
  let thrownSpeed = 0;
  let thrownLeft = 0;
  const thrownDir = new THREE.Vector3();
  const struckByThrow = new Set<Damageable>();

  root.position.copy(pos);

  function turnToward(target: number, dt: number): void {
    const delta = wrapAngle(target - facing);
    const step = TURN_RATE * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  function enterIdle(): void {
    state = 'idle';
    stateTime = 0;
  }

  function enterAggro(): void {
    state = 'aggro';
    stateTime = 0;
  }

  /**
   * The sacred window. Facing is committed here and never corrected, so the
   * 600 ms the player gets is 600 ms of honest information about where the
   * burst will happen - the enemy cannot quietly re-aim inside its own tell.
   */
  function enterTelegraph(dx: number, dz: number): void {
    if (Math.hypot(dx, dz) > EPS) facing = Math.atan2(dx, dz);
    state = 'telegraph';
    stateTime = 0;
  }

  function enterAttack(ctx: GameContext): void {
    state = 'attack';
    stateTime = 0;
    struck.clear();
    squash = SQUASH_HOP;
    ctx.spawnFx('landDust', pos.clone());
  }

  function enterRecover(): void {
    state = 'recover';
    stateTime = 0;
  }

  function enterStagger(): void {
    state = 'stagger';
    stateTime = 0;
    squash = SQUASH_IMPACT;
    knockSpeed = KNOCKBACK_SPEED;
  }

  function die(): void {
    state = 'dead';
    stateTime = 0;
    knockSpeed = 0;
    // Hidden on the frame it dies; the owner culls it whenever it next sweeps.
    root.visible = false;

    const ctx = ctxRef;
    if (ctx === null) return;
    // The kill upgrades the freeze the killing blow already asked for -
    // requestHitstop takes the max, so this never stacks into a stutter. The
    // trauma for the hit itself belongs to whoever landed it.
    ctx.requestHitstop(HITSTOP_KILL);
    ctx.spawnFx(
      'sporePuff',
      new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z),
      knockDir.clone(),
    );
    ctx.dropCoins(COIN_DROP_SPORELING, new THREE.Vector3(pos.x, pos.y, pos.z));
  }

  /** Analytic disc overlap on the ground plane - PROMPT.md section 1, no engine. */
  function strike(ctx: GameContext): void {
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive || struck.has(target)) continue;

      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > SPORELING.attackRange + target.hurtRadius) continue;

      // Marked on the attempt, not on the connect: a player who rolled into
      // the burst's first frame stays safe for the rest of the window.
      struck.add(target);
      if (distance > EPS) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));

      const hit: HitInfo = {
        damage: SPORELING.damage,
        knockback: KNOCKBACK_PLAYER,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      };
      // The victim owns its own impact response (freeze, trauma, spark) so a
      // single hit never fires two of each.
      target.takeHit(hit);
    }
  }

  /** Circle-vs-circle separation, so a pack never collapses into one body. */
  function separate(ctx: GameContext): void {
    for (const other of ctx.enemies) {
      if (other.root === root || !other.alive) continue;
      const dx = pos.x - other.position.x;
      const dz = pos.z - other.position.z;
      const gap = BODY_RADIUS + other.hurtRadius;
      const distance = Math.hypot(dx, dz);
      if (distance >= gap) continue;

      if (distance > EPS) {
        const push = (gap - distance) * SEPARATION_SHARE;
        travel.x += (dx / distance) * push;
        travel.z += (dz / distance) * push;
      } else {
        // Exactly stacked: a seeded per-spawn axis breaks the tie, because two
        // identical corrections would cancel and lock the pair together.
        travel.x += Math.sin(nudgeAngle) * gap * SEPARATION_SHARE;
        travel.z += Math.cos(nudgeAngle) * gap * SEPARATION_SHARE;
      }
    }
  }

  function think(ctx: GameContext, dt: number): void {
    travel.set(0, 0, 0);
    // Carried: the frog owns where it is, so no behaviour runs at all.
    if (held) return;
    flyOn(ctx, dt);
    const player = ctx.player;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    const sees = player.alive && distance <= SPORELING.aggroRange;

    switch (state) {
      case 'idle': {
        if (sees) enterAggro();
        break;
      }

      case 'aggro': {
        if (!sees) {
          enterIdle();
          break;
        }
        if (distance <= SPORELING.attackRange) {
          enterTelegraph(dx, dz);
          break;
        }
        if (distance > EPS) {
          turnToward(Math.atan2(dx, dz), dt);
          const step = SPORELING.moveSpeed * dt;
          travel.x += (dx / distance) * step;
          travel.z += (dz / distance) * step;
        }
        break;
      }

      case 'telegraph': {
        if (stateTime >= SPORELING.telegraph - TIME_EPS) enterAttack(ctx);
        break;
      }

      case 'attack': {
        if (stateTime >= SPORELING.active - TIME_EPS) {
          enterRecover();
          break;
        }
        strike(ctx);
        break;
      }

      case 'recover': {
        if (stateTime >= SPORELING.recovery - TIME_EPS) {
          if (sees) enterAggro();
          else enterIdle();
        }
        break;
      }

      case 'stagger': {
        if (stateTime >= ENEMY_STAGGER - TIME_EPS) {
          knockSpeed = 0;
          // Being hit is information: it comes back up already hunting.
          if (player.alive) enterAggro();
          else enterIdle();
          break;
        }
        const fade = Math.max(0, 1 - (stateTime + dt * 0.5) / ENEMY_STAGGER);
        const push = knockSpeed * fade * dt;
        travel.x += knockDir.x * push;
        travel.z += knockDir.z * push;
        break;
      }

      case 'dead': {
        break;
      }
    }

    separate(ctx);
    // One resolve per step, against the same collider and the same gravity the
    // frog obeys, so the creature stands on the terrain it is drawn over.
    controller.move(travel, dt);
  }

  /** Everything the simulation does not care about: bob, sway, squash, tell. */
  function present(dt: number): void {
    root.position.copy(pos);
    root.rotation.y = facing;

    if (state === 'telegraph') {
      // Volume-preserving crouch across the whole windup: the shape itself is
      // half the tell, so it must be legible with the glow turned off too.
      const t = Math.min(1, stateTime / SPORELING.telegraph);
      squash = 1 + (SQUASH_IMPACT - 1) * Math.pow(t, 0.6);
    } else {
      squash += (1 - squash) * (1 - Math.exp(-SQUASH_RECOVER * dt));
    }
    const counter = 1 / Math.sqrt(squash);
    model.visual.scale.set(counter, squash, counter);

    const gait = state === 'aggro' ? 1 : BOB_GAIT_IDLE;
    model.visual.position.y =
      Math.abs(Math.sin(now * bobRate + bobPhase)) * BOB_AMPLITUDE * gait;
    model.visual.rotation.z = Math.sin(now * SWAY_RATE + swayPhase) * SWAY_ANGLE;

    const shell = model.shell;
    if (hurtFlash > 0) {
      hurtFlash = Math.max(0, hurtFlash - dt);
      shell.material = hurtMaterial;
      shell.visible = true;
      shell.scale.setScalar(1 + SHELL_SWELL * (hurtFlash / HURT_FLASH_TIME));
    } else if (state === 'telegraph') {
      // Starts at full swell on frame zero of the windup, then beats. Nothing
      // fades it in, because a tell that fades in is a tell that arrives late.
      const t = stateTime / SPORELING.telegraph;
      const beat = 0.55 + 0.45 * Math.cos(TAU * t * TELL_PULSES);
      shell.visible = true;
      shell.material = tellMaterial;
      shell.scale.setScalar(1 + SHELL_SWELL * beat);
    } else if (state === 'attack') {
      shell.visible = true;
      shell.material = tellMaterial;
      shell.scale.setScalar(1 + SHELL_SWELL);
    } else if (shell.visible) {
      shell.visible = false;
    }
  }

  /**
   * Light enough to lift, so the top row of the mass rule applies: it comes to
   * the frog and ends up in its mouth.
   */
  function onTongue(_from: THREE.Vector3, _ctx: GameContext): TongueOutcome {
    if (state === 'dead' || held) return 'none';
    held = true;
    thrownSpeed = 0;
    enterStagger();
    return 'held';
  }

  function carryTo(position: THREE.Vector3): void {
    controller.teleport(position);
  }

  /** Let go. Thrown, it becomes a projectile that hurts what it lands on. */
  function release(dir: THREE.Vector3 | null, _ctx: GameContext): void {
    if (!held) return;
    held = false;
    struckByThrow.clear();
    if (dir === null) {
      enterStagger();
      return;
    }
    thrownDir.set(dir.x, 0, dir.z);
    if (thrownDir.lengthSq() < EPS) thrownDir.set(Math.sin(facing), 0, Math.cos(facing));
    thrownDir.normalize();
    thrownSpeed = TONGUE_THROW_SPEED;
    thrownLeft = TONGUE_THROW_RANGE;
    enterStagger();
  }

  /** A body in flight: it hurts what it hits, and the landing hurts it too. */
  function flyOn(ctx: GameContext, dt: number): void {
    if (thrownSpeed <= 0) return;
    const travelled = Math.min(thrownLeft, thrownSpeed * dt);
    thrownLeft -= travelled;
    travel.x += thrownDir.x * travelled;
    travel.z += thrownDir.z * travelled;

    for (const other of ctx.enemies) {
      if (other.root === root || !other.alive || struckByThrow.has(other)) continue;
      const dx = other.position.x - pos.x;
      const dz = other.position.z - pos.z;
      if (Math.hypot(dx, dz) > BODY_RADIUS + other.hurtRadius) continue;
      struckByThrow.add(other);
      hitDir.set(thrownDir.x, 0, thrownDir.z);
      other.takeHit({
        damage: TONGUE_THROW_DAMAGE,
        knockback: KNOCKBACK_SMALL_ENEMY,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'player',
      });
      ctx.requestHitstop(HITSTOP_LIGHT);
      ctx.addTrauma(TRAUMA_HIT);
      // The thrown body takes the same blow it delivers.
      thrownSpeed = 0;
      thrownLeft = 0;
      takeHit({
        damage: TONGUE_THROW_DAMAGE,
        knockback: 0,
        direction: hitDir.clone().negate(),
        hitstop: 0,
        source: 'player',
      });
      return;
    }

    if (thrownLeft <= 0) thrownSpeed = 0;
  }

  function takeHit(hit: HitInfo): boolean {
    if (state === 'dead') return false;

    if (Math.abs(hit.direction.x) + Math.abs(hit.direction.z) > EPS) {
      knockDir.set(hit.direction.x, 0, hit.direction.z).normalize();
    } else {
      knockDir.set(Math.sin(facing), 0, Math.cos(facing));
    }

    hp = Math.max(0, hp - hit.damage);
    hurtFlash = HURT_FLASH_TIME;

    if (hp <= 0) die();
    else enterStagger();
    return true;
  }

  return {
    root,
    kind: 'sporeling',
    get state(): EnemyStateName {
      return state;
    },
    get hp(): number {
      return hp;
    },
    get alive(): boolean {
      return state !== 'dead';
    },
    get position(): THREE.Vector3 {
      return pos;
    },
    get facing(): number {
      return facing;
    },
    get mass(): MassClass {
      return SPORELING.mass;
    },
    get held(): boolean {
      return held;
    },
    onTongue,
    carryTo,
    release,
    get hurtRadius(): number {
      return BODY_RADIUS;
    },
    takeHit,

    update(dt: number, ctx: GameContext): void {
      ctxRef = ctx;
      if (state === 'dead') return;

      now += dt;
      stateTime += dt;
      think(ctx, dt);
      present(dt);
    },

    dispose(): void {
      root.removeFromParent();
      // Bodies AND their outline hulls: the hulls are clones this entity was
      // handed, and every kill runs this, so a hull left to the material kit
      // would leak a geometry and its GPU buffers per death.
      for (const geometry of model.geometries) geometry.dispose();
      // Materials are shared, cached instances owned by the material kit;
      // disposing one here would tear it out from under every other entity.
    },
  };
}
