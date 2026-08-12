/**
 * CROAK - the frog. PROMPT.md sections 3 and 5.
 *
 * A six-state machine over a capsule controller. Every verb starts on the frame
 * its input is consumed - transitions are checked before the state body runs,
 * and nothing waits for an animation to finish (section 9 rule 8).
 *
 * The frame data, the i-frame window, the stamina economy and the knockback all
 * come from core/constants. What lives here is the wiring and the greybox body.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  Damageable,
  Enemy,
  GameContext,
  HitInfo,
  Level,
  Player,
  PlayerStateName,
  Rng,
} from '../core/types';
import type { AttackFrames, WeaponId } from '../core/constants';
import type { TongueTarget } from './tongue';
import {
  MOUTH_HEIGHT,
  advanceReach,
  createTongueView,
  pickTongueTarget,
  resolveTongue,
} from './tongue';
import {
  ACCEL_TIME,
  COMBO_WINDOW_FROM,
  DECEL_TIME,
  KNOCKBACK_PLAYER,
  BLOCK_ARC,
  BLOCK_HITSTOP,
  BLOCK_KNOCKBACK,
  BLOCK_MOVE_SCALE,
  BLOCK_STAMINA_PER_HIT,
  GUARD_BREAK_STAGGER,
  LOCKON_DROP_RANGE,
  LUNGE_SLASH,
  LOCKON_CONE,
  LOCKON_RANGE,
  MAGNETIZE_LUNGE,
  MOVE_SPEED,
  PLAYER_HITSTUN,
  PLAYER_HP_MAX,
  PLAYER_IFRAMES_AFTER_HIT,
  PLAYER_RADIUS,
  ROLL_DISTANCE,
  ROLL_DURATION,
  ROLL_IFRAME_END,
  ROLL_IFRAME_START,
  ROLL_SPEED_CURVE,
  ROLL_STAMINA,
  SQUASH_HOP,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  STAMINA_MAX,
  STAMINA_REGEN_DELAY,
  STAMINA_REGEN_DELAY_EMPTY,
  STAMINA_REGEN_RATE,
  STEP_HEIGHT,
  STARTING_WEAPON,
  WEAPONS,
  TICK_DT,
  TONGUE_PULL_SELF_SPEED,
  TRAUMA_HIT,
  TRAUMA_PLAYER_HURT,
  TURN_RATE,
  ZERO_STAMINA_DMG_MULT,
} from '../core/constants';
import { makeOutline, material } from '../render/materials';
import { createController } from '../physics/controller';

// ------------------------------------------------------------- style tuning
// Model proportions and presentation, kept beside the model they describe the
// way materials.ts keeps its look numbers. No gameplay rule reads any of them.

/** Hop-bob: a frog never quite walks. Tiny on purpose - it must not read as float. */
const BOB_RATE = 11.0; // rad/s
const BOB_AMPLITUDE = 0.035; // u
/** Visual catch-up when the controller climbs a step, so a stair is not a pop. */
const STEP_SMOOTH_RATE = 22.0;
/** Impacts spark at the frog's chest, not at its feet. */
const FX_HEIGHT = 0.45;
/** A carried body rides this far in front of the frog. */
const CARRY_FORWARD = 0.62;
/** Close enough to an anchor to call the haul finished. */
const TONGUE_ARRIVAL = 0.55;
/** Escape hatch: a pull that cannot converge must never strand the frog. */
const TONGUE_PULL_TIMEOUT = 1.6;

// -------------------------------------------------------------- solver slack

const TAU = Math.PI * 2;
/** Half a tick. Frame windows are compared on accumulated floats, not integers. */
const TIME_EPS = TICK_DT * 0.5;
/** Below this the stick is at rest; the input system has already deadzoned it. */
const STICK_EPS = 1e-3;
/** Two ground-plane points this close have no direction between them. */
const TOUCHING = 1e-4;
/**
 * ROLL_SPEED_CURVE is a shape, not a distance. Integrating it once turns
 * ROLL_DISTANCE into the distance the roll actually covers, and keeps doing so
 * if the curve is ever retuned.
 */
const ROLL_CURVE_AREA = ((): number => {
  const samples = 512;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += ROLL_SPEED_CURVE((i + 0.5) / samples);
  return sum / samples;
})();
const ROLL_PEAK_SPEED = ROLL_DISTANCE / (ROLL_DURATION * ROLL_CURVE_AREA);
/** Linear ramp-down over the stun, integrating to exactly KNOCKBACK_PLAYER. */
const KNOCKBACK_PLAYER_SPEED = (2 * KNOCKBACK_PLAYER) / PLAYER_HITSTUN;

const attackLength = (frames: AttackFrames): number =>
  frames.windup + frames.active + frames.recovery;

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

// ------------------------------------------------------------------- model

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

interface FrogModel {
  visual: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

/**
 * The greybox frog: round and squat so the silhouette fights the world's
 * angular geometry (section 2, visual grammar rule 2). Everything is primitives
 * merged down to one mesh per palette role - four draw calls plus their hulls,
 * which is what keeps a 150-call budget survivable once enemies arrive.
 */
function buildFrog(): FrogModel {
  const visual = new THREE.Group();
  visual.name = 'frogBody';

  const skin = merge([
    // torso: wider than it is tall, and it never leaves the ground
    place(new THREE.SphereGeometry(0.36, 10, 7), 0, 0.38, 0, 1.12, 0.92, 1.0),
    // head, set forward and high - the profile has to read as frog, not ball
    place(new THREE.SphereGeometry(0.27, 10, 7), 0, 0.62, 0.1, 1.0, 0.86, 1.0),
    // stubby limbs
    place(new THREE.SphereGeometry(0.11, 7, 5), 0.4, 0.36, 0.03, 1.0, 0.9, 1.3),
    place(new THREE.SphereGeometry(0.11, 7, 5), -0.4, 0.36, 0.03, 1.0, 0.9, 1.3),
    place(new THREE.SphereGeometry(0.13, 7, 5), 0.21, 0.075, 0.1, 1.15, 0.55, 1.5),
    place(new THREE.SphereGeometry(0.13, 7, 5), -0.21, 0.075, 0.1, 1.15, 0.55, 1.5),
  ]);

  const pale = merge([
    // belly patch, sitting proud of the chest above the tunic
    place(new THREE.SphereGeometry(0.26, 10, 7), 0, 0.5, 0.22, 0.8, 0.62, 0.55),
    // oversized eyes: the whole read of the character at gameplay zoom
    place(new THREE.SphereGeometry(0.135, 9, 7), 0.165, 0.78, 0.1),
    place(new THREE.SphereGeometry(0.135, 9, 7), -0.165, 0.78, 0.1),
    // tunic trim
    place(
      new THREE.TorusGeometry(0.37, 0.022, 5, 14).rotateX(-Math.PI / 2),
      0,
      0.2,
      0,
      1.05,
      1,
      1,
    ),
  ]);

  const tunic = merge([
    place(new THREE.SphereGeometry(0.42, 12, 8), 0, 0.28, 0, 1.03, 0.42, 0.98),
  ]);

  const pupils = merge([
    place(new THREE.SphereGeometry(0.075, 7, 5), 0.187, 0.797, 0.186),
    place(new THREE.SphereGeometry(0.075, 7, 5), -0.187, 0.797, 0.186),
  ]);

  const body = new THREE.Mesh(skin, material('heroBody', { flatShading: true }));
  body.name = 'frogSkin';
  const belly = new THREE.Mesh(pale, material('heroBelly', { flatShading: true }));
  belly.name = 'frogBelly';
  const coat = new THREE.Mesh(tunic, material('heroTunic', { flatShading: true }));
  coat.name = 'frogTunic';
  const eyes = new THREE.Mesh(pupils, material('dungeonDark'));
  eyes.name = 'frogPupils';

  for (const mesh of [body, belly, coat, eyes]) {
    // Grounded by the key light's own shadow, and by that ALONE - section 9
    // rule 5 asks for real OR blob, and a character wearing both reads as a
    // rendering fault. The real one wins here because a blob decal directly
    // under a wide, low body is almost entirely hidden by that body at a -40
    // degree pitch, while the offset silhouette is legible from any angle and
    // says something true about where the sun is.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    visual.add(mesh);
  }

  const geometries = [skin, pale, tunic, pupils];
  // Outline the three masses that own the silhouette; the pupils sit inside the
  // eyes and would only add a hull nobody can see. The hulls are clones, so
  // they are ours to release.
  for (const mesh of [body, belly, coat]) {
    const outline = makeOutline(mesh);
    geometries.push(outline.geometry);
    visual.add(outline);
  }

  return { visual, geometries };
}

// ------------------------------------------------------------------ player

export function createPlayer(
  scene: THREE.Scene,
  level: Level,
  rng: Rng,
): Player {
  const controller = createController(level.collider, level.playerStart);
  // Settle onto the floor before the first frame renders, so a spawn authored a
  // hair off the ground never shows the frog falling into its own level.
  controller.teleport(level.playerStart);

  const root = new THREE.Group();
  root.name = 'player';
  const model = buildFrog();
  root.add(model.visual);

  root.position.copy(controller.position);
  scene.add(root);

  // The bob starts on a per-run phase so the frog is not visibly in lockstep
  // with every other bobbing thing. One draw from its own seeded stream, so a
  // replayed seed replays identically and Math.random stays out of it.
  const bobPhase = rng.fork('player:bob').next() * TAU;

  let state: PlayerStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let facing = 0;
  let hp = PLAYER_HP_MAX;
  let stamina = STAMINA_MAX;
  let regenAt = 0;
  /**
   * Section 3: at zero stamina incoming damage is x1.5 "until the bar refills".
   * Reading `stamina <= 0` instead would lift the penalty on the first regen
   * tick, three seconds before the bar is anywhere near full - the cost of the
   * forgiveness would be a rounding error rather than a punishment window.
   */
  let zeroStaminaLatched = false;
  let invulnUntil = 0;
  let speed = 0;
  let comboIndex = 0;
  let comboQueued = false;
  let weapon = STARTING_WEAPON;
  let swings = WEAPONS[weapon].swings;
  /**
   * Hard lock. Soft lock (pickTarget) is always on and only steers a swing;
   * this one is held until dropped and changes how the frog moves - it strafes
   * instead of turning into the stick, which is what makes circling a shield
   * something you can actually aim.
   */
  let lockTarget: Damageable | null = null;

  // ---------------------------------------------------------------- tongue
  const tongueView = createTongueView(scene);
  const mouth = new THREE.Vector3();
  const tongueTip = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const throwDir = new THREE.Vector3();
  let tongueTarget: TongueTarget | null = null;
  let tongueReach = 0;
  let tongueExtending = false;
  let tongueResolved = false;
  let carrying: Enemy | null = null;
  /** Set while being hauled in: an attack now becomes the arrival slash. */
  let lungeQueued = false;
  /** A one-off frame table that outranks the equipped weapon's, for the slash. */
  let overrideSwing: AttackFrames | null = null;
  /** Guard up. Held, not toggled, and only while the Shield has been found. */
  let blocking = false;
  let lungeLeft = 0;
  let lungeSpeed = 0;
  let knockSpeed = 0;
  let squash = 1;
  /**
   * takeHit runs inside somebody else's update, so the state it enters has not
   * had a frame yet. Without this the first - and fastest - frame of hitstun
   * would be skipped, and the knockback would land short of KNOCKBACK_PLAYER.
   */
  let freshEntry = false;
  let wasGrounded = controller.grounded;
  let visualY = controller.position.y;
  let ctxRef: GameContext | null = null;

  const stick = new THREE.Vector3();
  const moveDir = new THREE.Vector3(0, 0, 1);
  const rollDir = new THREE.Vector3(0, 0, 1);
  const knockDir = new THREE.Vector3(0, 0, 1);
  const velocity = new THREE.Vector3();
  const displacement = new THREE.Vector3();
  const hitDir = new THREE.Vector3();
  const swung = new Set<Damageable>();
  const swungGates = new Set<string>();
  const pushOut = new THREE.Vector3();
  /** Push-outs are positional, not velocity - they must not be scaled by dt. */
  const dt0 = 0;

  const alive = (): boolean => state !== 'dead';

  /** Frame data for the swing in flight; the last entry is the finisher. */
  const swing = (): AttackFrames =>
    overrideSwing ?? swings[Math.min(comboIndex, swings.length - 1)];

  /** Where the tongue leaves from, and where a carried body rides. */
  function mouthAt(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      controller.position.x + Math.sin(facing) * 0.3,
      controller.position.y + MOUTH_HEIGHT,
      controller.position.z + Math.cos(facing) * 0.3,
    );
  }

  const inRollIframes = (): boolean =>
    state === 'roll' &&
    stateTime >= ROLL_IFRAME_START - TIME_EPS &&
    stateTime < ROLL_IFRAME_END - TIME_EPS;

  const isInvulnerable = (): boolean => inRollIframes() || now < invulnUntil;

  function spendStamina(cost: number): void {
    stamina = Math.max(0, stamina - cost);
    // Emptying the bar buys a longer wait: that is the whole cost of Tunic's
    // forgiveness rule, and it has to be felt before the bar comes back.
    if (stamina <= 0) zeroStaminaLatched = true;
    regenAt = now + (stamina <= 0 ? STAMINA_REGEN_DELAY_EMPTY : STAMINA_REGEN_DELAY);
  }

  function turnToward(targetYaw: number, dt: number): void {
    const delta = wrapAngle(targetYaw - facing);
    const step = TURN_RATE * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  /** Screen-space stick to a world direction on the ground plane. */
  function readStick(ctx: GameContext): number {
    const magnitude = Math.min(1, Math.hypot(ctx.input.moveX, ctx.input.moveZ));
    if (magnitude <= STICK_EPS) return 0;

    ctx.cameraRig.relativeMove(ctx.input.moveX, ctx.input.moveZ, stick);
    stick.y = 0;
    const length = stick.length();
    if (length <= STICK_EPS) return 0;
    // Normalise here rather than trusting the rig's scaling: this is the only
    // place a diagonal could outrun MOVE_SPEED, and it must not.
    stick.multiplyScalar(1 / length);
    moveDir.copy(stick);
    return magnitude;
  }

  /**
   * Nearest valid enemy. `anyDirection` is for acquiring a hard lock, where
   * demanding the frog already face the thing it wants to look at is a fight
   * with the player; a swing's soft lock keeps the cone.
   */
  function pickTarget(
    ctx: GameContext,
    anyDirection = false,
  ): Damageable | null {
    let best: Damageable | null = null;
    let bestDistance = Infinity;
    for (const target of ctx.damageablesFor('player')) {
      if (!target.alive) continue;
      const dx = target.position.x - controller.position.x;
      const dz = target.position.z - controller.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > LOCKON_RANGE || distance >= bestDistance) continue;
      if (!anyDirection && distance > TOUCHING) {
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
        if (off > LOCKON_CONE) continue;
      }
      bestDistance = distance;
      best = target;
    }
    return best;
  }

  /**
   * Bramble is not a Damageable - it has no health the player can read and no
   * hit reaction - so it is swept separately, with the weapon's own claim about
   * having an edge. A Stick reports false and the thicket merely shudders.
   */
  function strikeGates(ctx: GameContext, frames: AttackFrames): void {
    for (const gate of ctx.gates) {
      if (!gate.blocking || swungGates.has(gate.id)) continue;
      const dx = gate.position.x - controller.position.x;
      const dz = gate.position.z - controller.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > frames.reach + 1.0) continue;
      if (distance > TOUCHING) {
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
        if (off > frames.arc) continue;
      }
      swungGates.add(gate.id);
      gate.strike(frames.damage, WEAPONS[weapon].cutsBramble, ctx);
    }
  }

  /** Analytic arc overlap on the ground plane - PROMPT.md section 1, no engine. */
  function strike(ctx: GameContext, frames: AttackFrames): void {
    strikeGates(ctx, frames);
    for (const target of ctx.damageablesFor('player')) {
      if (!target.alive || swung.has(target)) continue;

      const dx = target.position.x - controller.position.x;
      const dz = target.position.z - controller.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > frames.reach + target.hurtRadius) continue;
      if (distance > TOUCHING) {
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
        // A fat target covers more of the arc than its centre point suggests.
        const widen = Math.asin(
          Math.min(1, target.hurtRadius / Math.max(distance, target.hurtRadius)),
        );
        if (off > frames.arc + widen) continue;
      }

      swung.add(target);
      if (distance > TOUCHING) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));

      const hit: HitInfo = {
        damage: frames.damage,
        knockback: frames.knockback,
        direction: hitDir.clone(),
        hitstop: frames.hitstop,
        source: 'player',
      };
      if (!target.takeHit(hit)) continue;

      // Visual, camera and freeze on the same frame as the damage - section 9
      // rule 9. The audio hook lands here too once A9 brings it.
      ctx.requestHitstop(frames.hitstop);
      ctx.addTrauma(TRAUMA_HIT);
      ctx.spawnFx(
        'hitSpark',
        new THREE.Vector3(
          controller.position.x + dx * 0.5,
          controller.position.y + FX_HEIGHT,
          controller.position.z + dz * 0.5,
        ),
        hitDir.clone(),
      );
      lungeLeft = 0; // a connect stops the lunge dead, so hits read as impacts
    }
  }

  /**
   * Gates are drawn objects, not level geometry - the BVH is baked once and a
   * thicket that opens mid-run cannot be cut out of it. So a shut gate is
   * enforced here instead: an analytic push-out of its ground-plane disc, the
   * same shape the level's own props would have had. Without this a bramble is
   * scenery you can stroll through, and the lock it represents is a lie.
   */
  function resolveGates(ctx: GameContext): void {
    for (const gate of ctx.gates) {
      if (!gate.blocking) continue;
      const dx = controller.position.x - gate.position.x;
      const dz = controller.position.z - gate.position.z;
      const reach = gate.blockRadius + PLAYER_RADIUS;
      const distance = Math.hypot(dx, dz);
      if (distance >= reach) continue;
      if (distance <= TOUCHING) {
        // Dead centre: shove along the frog's own facing rather than dividing
        // by zero and teleporting it somewhere arbitrary.
        pushOut.set(Math.sin(facing), 0, Math.cos(facing)).multiplyScalar(reach);
      } else {
        pushOut.set((dx / distance) * (reach - distance), 0, (dz / distance) * (reach - distance));
      }
      controller.move(pushOut, dt0);
    }
  }

  /** A lock survives only while its target is alive, present and in reach. */
  function updateLock(): void {
    if (lockTarget === null) return;
    if (!lockTarget.alive) {
      lockTarget = null;
      return;
    }
    const dx = lockTarget.position.x - controller.position.x;
    const dz = lockTarget.position.z - controller.position.z;
    if (Math.hypot(dx, dz) > LOCKON_DROP_RANGE) lockTarget = null;
  }

  function enterIdle(): void {
    state = 'idle';
    stateTime = 0;
    freshEntry = true;
  }

  function enterMove(): void {
    state = 'move';
    stateTime = 0;
    freshEntry = true;
  }

  function enterRoll(ctx: GameContext, magnitude: number): void {
    // The stick wins over the facing: a roll is an escape, and it has to go
    // where the player is pointing on the frame they asked for it.
    if (magnitude > 0) rollDir.copy(moveDir);
    else rollDir.set(Math.sin(facing), 0, Math.cos(facing));
    facing = Math.atan2(rollDir.x, rollDir.z);

    // Tunic's forgiveness: the roll happens whether or not it can be paid for.
    spendStamina(ROLL_STAMINA);

    state = 'roll';
    stateTime = 0;
    freshEntry = true;
    speed = 0;
    comboQueued = false;
    lungeLeft = 0;
    squash = SQUASH_HOP;
    // The dust cloud is the i-frame tell, so it is spawned with the state, not
    // with the first frame of invulnerability.
    ctx.spawnFx('rollDust', controller.position.clone(), rollDir.clone());
  }

  function enterAttack(ctx: GameContext, index: number, magnitude: number): void {
    state = 'attack';
    stateTime = 0;
    freshEntry = true;
    comboIndex = index;
    comboQueued = false;
    const frames = swings[Math.min(index, swings.length - 1)];
    speed = 0;
    swung.clear();
    // Gates get the same once-per-swing rule as bodies, and the same reset -
    // without this the first blow marks the thicket and every later one skips it.
    swungGates.clear();

    const target =
      lockTarget !== null && lockTarget.alive ? lockTarget : pickTarget(ctx);
    if (target !== null) {
      const dx = target.position.x - controller.position.x;
      const dz = target.position.z - controller.position.z;
      facing = Math.atan2(dx, dz);
      const gap = Math.hypot(dx, dz) - frames.reach;
      lungeLeft = Math.max(0, Math.min(gap, MAGNETIZE_LUNGE));
    } else {
      if (magnitude > 0) facing = Math.atan2(moveDir.x, moveDir.z);
      lungeLeft = 0;
    }
    // The lunge is spent by the time the swing lands, never during recovery.
    lungeSpeed = lungeLeft / (frames.windup + frames.active);
  }

  function enterTongue(ctx: GameContext): void {
    state = 'tongue';
    stateTime = 0;
    freshEntry = true;
    speed = 0;
    tongueReach = 0;
    tongueExtending = true;
    tongueResolved = false;
    lungeQueued = false;
    mouthAt(mouth);
    tongueTarget = pickTongueTarget(ctx, mouth, facing, ctx.input.isDown('tongue'));
    // Commit to the direction on the frame it is thrown, so the rope never
    // bends round behind the frog while it is out.
    const dx = tongueTarget.position.x - controller.position.x;
    const dz = tongueTarget.position.z - controller.position.z;
    if (Math.abs(dx) + Math.abs(dz) > TOUCHING) facing = Math.atan2(dx, dz);
  }

  function enterTonguePull(): void {
    state = 'tonguePull';
    stateTime = 0;
    freshEntry = true;
    speed = 0;
    lungeQueued = false;
  }

  /** Spit or hurl whatever is in the frog's mouth. */
  function releaseCarried(ctx: GameContext, thrown: boolean): void {
    const held = carrying;
    if (held === null) return;
    carrying = null;
    if (!thrown) {
      held.release(null, ctx);
      return;
    }
    throwDir.set(Math.sin(facing), 0, Math.cos(facing));
    held.release(throwDir, ctx);
    ctx.addTrauma(TRAUMA_HIT * 0.5);
  }

  function enterHitstun(): void {
    state = 'hitstun';
    stateTime = 0;
    freshEntry = true;
    speed = 0;
    comboQueued = false;
    lungeLeft = 0;
    knockSpeed = KNOCKBACK_PLAYER_SPEED;
    squash = SQUASH_IMPACT;
  }

  function enterDead(): void {
    state = 'dead';
    stateTime = 0;
    freshEntry = true;
    speed = 0;
    knockSpeed = 0;
    lungeLeft = 0;
    velocity.set(0, 0, 0);
    squash = SQUASH_IMPACT;
  }

  /**
   * Verbs are claimed before any state body runs, so the frame that consumes
   * the press is the frame the verb starts on. Presses are only consumed when
   * they can be honoured - otherwise they stay buffered and fire the moment the
   * frog is free.
   */
  function claimVerbs(ctx: GameContext, magnitude: number): void {
    if (state === 'dead') {
      blocking = false;
      return;
    }

    // The guard is a held state, not a verb with frames: it is up whenever the
    // button is down, the Shield has been found, and the frog is on its feet.
    blocking =
      ctx.progress.hasShield &&
      ctx.input.isDown('block') &&
      (state === 'idle' || state === 'move');

    // Toggle, not hold: a lock you have to keep a finger on competes with every
    // other verb on the hand.
    if (ctx.input.consume('lockon')) {
      lockTarget = lockTarget === null ? pickTarget(ctx, true) : null;
    }

    const active = swing();
    const recoveryAt = active.windup + active.active;
    const canRollFromAttack =
      state === 'attack' &&
      stateTime >= recoveryAt + active.rollCancelFrom - TIME_EPS;

    if (state === 'idle' || state === 'move' || canRollFromAttack) {
      if (ctx.input.consume('roll')) {
        enterRoll(ctx, magnitude);
        return;
      }
    }

    if (state === 'idle' || state === 'move') {
      // With something in your mouth the verbs change meaning: attack hurls it,
      // the tongue button just spits it out.
      if (carrying !== null) {
        if (ctx.input.consume('attack')) {
          releaseCarried(ctx, true);
          return;
        }
        if (ctx.input.consume('tongue')) {
          releaseCarried(ctx, false);
          return;
        }
      } else if (ctx.input.consume('tongue')) {
        enterTongue(ctx);
        return;
      }
      if (ctx.input.consume('attack')) enterAttack(ctx, 0, magnitude);
      return;
    }

    // Hauling in: an attack now is the arrival slash, claimed early and spent
    // on landing so the input is never eaten by the flight.
    if (state === 'tonguePull' && ctx.input.consume('attack')) lungeQueued = true;

    if (
      state === 'attack' &&
      !comboQueued &&
      comboIndex + 1 < swings.length &&
      stateTime >= COMBO_WINDOW_FROM - TIME_EPS
    ) {
      if (ctx.input.consume('attack')) comboQueued = true;
    }
  }

  /** Shared by idle and move: accelerate, decelerate, and turn into the stick. */
  function groundMovement(dt: number, magnitude: number): void {
    const target = MOVE_SPEED * magnitude * (blocking ? BLOCK_MOVE_SCALE : 1);
    if (target > speed) {
      speed = Math.min(target, speed + (MOVE_SPEED / ACCEL_TIME) * dt);
    } else {
      speed = Math.max(target, speed - (MOVE_SPEED / DECEL_TIME) * dt);
    }
    // Locked on, the frog keeps its eyes on the target and side-steps; free,
    // it turns into whichever way the stick is pointing.
    if (lockTarget !== null) {
      const dx = lockTarget.position.x - controller.position.x;
      const dz = lockTarget.position.z - controller.position.z;
      if (Math.abs(dx) + Math.abs(dz) > TOUCHING) {
        turnToward(Math.atan2(dx, dz), dt);
      }
    } else if (magnitude > 0) {
      turnToward(Math.atan2(moveDir.x, moveDir.z), dt);
    }
    velocity.set(moveDir.x * speed, 0, moveDir.z * speed);
  }

  function step(ctx: GameContext, dt: number, magnitude: number): void {
    velocity.set(0, 0, 0);

    switch (state) {
      case 'idle': {
        if (magnitude > 0) enterMove();
        groundMovement(dt, magnitude);
        break;
      }

      case 'move': {
        if (magnitude <= 0 && speed <= 0) enterIdle();
        groundMovement(dt, magnitude);
        break;
      }

      case 'roll': {
        if (stateTime >= ROLL_DURATION - TIME_EPS) {
          // The successor takes the rest of the frame: a roll flows straight
          // back into a run, with no dead frame in between.
          if (magnitude > 0) enterMove();
          else enterIdle();
          groundMovement(dt, magnitude);
          break;
        }
        // Sampled at the frame midpoint so the discrete sum of 26 frames lands
        // on ROLL_DISTANCE instead of overshooting it.
        const t = Math.min(1, (stateTime + dt * 0.5) / ROLL_DURATION);
        const rollSpeed = ROLL_PEAK_SPEED * ROLL_SPEED_CURVE(t);
        velocity.set(rollDir.x * rollSpeed, 0, rollDir.z * rollSpeed);
        break;
      }

      case 'tongue': {
        mouthAt(mouth);
        const target = tongueTarget;
        const aim = target === null ? mouth : target.position;
        const span = Math.hypot(aim.x - mouth.x, aim.z - mouth.z);

        tongueReach = advanceReach(tongueReach, span, tongueExtending, dt);

        if (tongueExtending && !tongueResolved && tongueReach >= span - TOUCHING) {
          tongueResolved = true;
          tongueExtending = false;
          if (target !== null) {
            const resolution = resolveTongue(target, mouth, ctx);
            if (resolution.outcome !== 'none') {
              ctx.spawnFx('tongueHit', aim.clone());
            }
            if (resolution.outcome === 'held') {
              carrying = resolution.held;
            } else if (resolution.outcome === 'anchor' && resolution.anchor !== null) {
              anchor.copy(resolution.anchor);
              enterTonguePull();
              break;
            }
          }
        }

        // Nothing was caught and the tongue is all the way out: the whiff has
        // to be seen, so the recovery is served on the way back in.
        if (!tongueExtending && tongueReach <= TOUCHING) {
          if (magnitude > 0) enterMove();
          else enterIdle();
        }
        break;
      }

      case 'tonguePull': {
        const dx = anchor.x - controller.position.x;
        const dz = anchor.z - controller.position.z;
        const gap = Math.hypot(dx, dz);
        // Arrive when the frog is as close as its own body allows.
        if (gap <= PLAYER_RADIUS + TONGUE_ARRIVAL || stateTime > TONGUE_PULL_TIMEOUT) {
          tongueReach = 0;
          if (lungeQueued) {
            // The flight WAS the windup. Spend it as a real swing so the blow
            // goes through exactly the same strike path as any other.
            overrideSwing = LUNGE_SLASH;
            ctx.spawnFx('lungeSlash', controller.position.clone());
            ctx.addTrauma(TRAUMA_HIT);
            enterAttack(ctx, 0, magnitude);
          } else if (magnitude > 0) enterMove();
          else enterIdle();
          break;
        }
        const travel = Math.min(gap, TONGUE_PULL_SELF_SPEED * dt);
        velocity.set((dx / gap) * (travel / dt), 0, (dz / gap) * (travel / dt));
        facing = Math.atan2(dx, dz);
        mouthAt(mouth);
        tongueReach = gap;
        break;
      }

      case 'attack': {
        if (stateTime >= attackLength(swing()) - TIME_EPS) {
          if (overrideSwing !== null) {
            // The arrival slash is a single blow; it never chains.
            overrideSwing = null;
            if (magnitude > 0) enterMove();
            else enterIdle();
            groundMovement(dt, magnitude);
          } else if (comboQueued && comboIndex + 1 < swings.length) {
            enterAttack(ctx, comboIndex + 1, magnitude);
          } else {
            if (magnitude > 0) enterMove();
            else enterIdle();
            groundMovement(dt, magnitude);
          }
          break;
        }

        if (lungeLeft > 0) {
          const travel = Math.min(lungeLeft, lungeSpeed * dt);
          lungeLeft -= travel;
          const lunge = travel / dt;
          velocity.set(Math.sin(facing) * lunge, 0, Math.cos(facing) * lunge);
        }

        const frames = swing();
        const activeFrom = frames.windup;
        const activeTo = frames.windup + frames.active;
        if (stateTime >= activeFrom - TIME_EPS && stateTime < activeTo - TIME_EPS) {
          strike(ctx, frames);
        }
        break;
      }

      case 'hitstun': {
        if (stateTime >= PLAYER_HITSTUN - TIME_EPS) {
          knockSpeed = 0;
          if (magnitude > 0) enterMove();
          else enterIdle();
          groundMovement(dt, magnitude);
          break;
        }
        const fade = Math.max(
          0,
          1 - (stateTime + dt * 0.5) / PLAYER_HITSTUN,
        );
        const push = knockSpeed * fade;
        velocity.set(knockDir.x * push, 0, knockDir.z * push);
        break;
      }

      case 'dead': {
        break;
      }
    }
  }

  /** Draw the rope, and carry whatever is in the frog's mouth along with it. */
  function presentTongue(): void {
    const out = state === 'tongue' || state === 'tonguePull';
    mouthAt(mouth);

    if (carrying !== null) {
      // A held body rides just past the mouth, so the frog visibly has it.
      tongueTip.set(
        controller.position.x + Math.sin(facing) * CARRY_FORWARD,
        controller.position.y,
        controller.position.z + Math.cos(facing) * CARRY_FORWARD,
      );
      carrying.carryTo(tongueTip);
      tongueView.aim(mouth, tongueTip.clone().setY(mouth.y));
      tongueView.setVisible(true);
      return;
    }

    if (!out || tongueReach <= TOUCHING) {
      tongueView.setVisible(false);
      return;
    }

    tongueTip.set(
      mouth.x + Math.sin(facing) * tongueReach,
      mouth.y,
      mouth.z + Math.cos(facing) * tongueReach,
    );
    tongueView.aim(mouth, tongueTip);
    tongueView.setVisible(true);
  }

  /** Everything the simulation does not care about: bob, squash, step smoothing. */
  function present(ctx: GameContext, dt: number): void {
    const position = controller.position;

    if (controller.grounded) {
      if (!wasGrounded) {
        // Volume-preserving impact: the counter-axis comes back out of squash
        // in the scale below, so the frog spreads exactly as much as it flattens.
        squash = SQUASH_IMPACT;
        ctx.spawnFx('landDust', position.clone());
      }
    }
    wasGrounded = controller.grounded;

    // Climbing a step moves the capsule up to STEP_HEIGHT in one frame; the
    // body catches up over a few frames so a stair reads as a hop, not a jump
    // cut. Anything bigger than a step is a real fall and is followed exactly.
    if (Math.abs(position.y - visualY) > STEP_HEIGHT) visualY = position.y;
    else visualY += (position.y - visualY) * (1 - Math.exp(-STEP_SMOOTH_RATE * dt));

    root.position.set(position.x, visualY, position.z);
    root.rotation.y = facing;

    squash += (1 - squash) * (1 - Math.exp(-SQUASH_RECOVER * dt));
    const counter = 1 / Math.sqrt(squash);
    model.visual.scale.set(counter, squash, counter);

    // presentTime, not simTime: the frog keeps breathing through hitstop.
    const gait = Math.min(1, speed / MOVE_SPEED);
    const bob = Math.sin(ctx.loop.presentTime * BOB_RATE + bobPhase);
    model.visual.position.y = Math.abs(bob) * BOB_AMPLITUDE * gait;
  }

  /**
   * True if the guard is up AND the blow is coming at the front of it. A shield
   * that covered the back would make positioning meaningless, which is the one
   * thing this whole game is about.
   */
  function guardCovers(hit: HitInfo): boolean {
    if (!blocking) return false;
    const toAttacker = Math.atan2(-hit.direction.x, -hit.direction.z);
    return Math.abs(wrapAngle(toAttacker - facing)) <= BLOCK_ARC;
  }

  function takeHit(hit: HitInfo): boolean {
    if (!alive() || isInvulnerable()) return false;

    if (Math.abs(hit.direction.x) + Math.abs(hit.direction.z) > TOUCHING) {
      knockDir.set(hit.direction.x, 0, hit.direction.z).normalize();
    } else {
      knockDir.set(-Math.sin(facing), 0, -Math.cos(facing));
    }

    // Guard first. With stamina to spend the blow is turned; with an empty bar
    // it breaks through, and breaking through costs MORE than never guarding -
    // that is what stops the shield being a button you simply hold forever.
    if (guardCovers(hit)) {
      const ctxGuard = ctxRef;
      if (stamina >= BLOCK_STAMINA_PER_HIT) {
        spendStamina(BLOCK_STAMINA_PER_HIT);
        knockSpeed = (2 * BLOCK_KNOCKBACK) / PLAYER_HITSTUN;
        squash = SQUASH_IMPACT;
        if (ctxGuard !== null) {
          ctxGuard.requestHitstop(BLOCK_HITSTOP);
          ctxGuard.addTrauma(TRAUMA_HIT);
          ctxGuard.spawnFx(
            'guardSpark',
            new THREE.Vector3(
              controller.position.x + Math.sin(facing) * 0.5,
              controller.position.y + FX_HEIGHT,
              controller.position.z + Math.cos(facing) * 0.5,
            ),
            hit.direction.clone().negate(),
          );
        }
        return false;
      }
      // Guard break: the hit lands, and the stun is longer than a clean one.
      blocking = false;
      invulnUntil = now + PLAYER_IFRAMES_AFTER_HIT;
      hp = Math.max(0, hp - hit.damage);
      if (hp <= 0) enterDead();
      else {
        enterHitstun();
        stateTime = -GUARD_BREAK_STAGGER + PLAYER_HITSTUN;
      }
      if (ctxGuard !== null) {
        ctxGuard.addTrauma(TRAUMA_PLAYER_HURT);
        ctxGuard.requestHitstop(hit.hitstop);
      }
      return true;
    }

    const multiplier = zeroStaminaLatched ? ZERO_STAMINA_DMG_MULT : 1;
    hp = Math.max(0, hp - hit.damage * multiplier);
    invulnUntil = now + PLAYER_IFRAMES_AFTER_HIT;

    if (hp <= 0) enterDead();
    else enterHitstun();

    const ctx = ctxRef;
    if (ctx !== null) {
      ctx.addTrauma(TRAUMA_PLAYER_HURT);
      ctx.requestHitstop(hit.hitstop);
      ctx.spawnFx(
        'hitSpark',
        new THREE.Vector3(
          controller.position.x,
          controller.position.y + FX_HEIGHT,
          controller.position.z,
        ),
        knockDir.clone(),
      );
    }
    return true;
  }

  return {
    root,
    controller,
    get alive(): boolean {
      return alive();
    },
    get state(): PlayerStateName {
      return state;
    },
    get stamina(): number {
      return stamina;
    },
    get hp(): number {
      return hp;
    },
    get invulnerable(): boolean {
      return isInvulnerable();
    },
    get zeroStaminaPenalty(): boolean {
      return zeroStaminaLatched;
    },
    get facing(): number {
      return facing;
    },
    get position(): THREE.Vector3 {
      return controller.position;
    },
    get hurtRadius(): number {
      return PLAYER_RADIUS;
    },
    takeHit,

    get weapon(): WeaponId {
      return weapon;
    },
    get lockTarget(): Damageable | null {
      return lockTarget;
    },
    get lockedOn(): boolean {
      return lockTarget !== null;
    },
    get carrying(): Enemy | null {
      return carrying;
    },
    get tongueReach(): number {
      return tongueReach;
    },
    get blocking(): boolean {
      return blocking;
    },

    equip(next: WeaponId): void {
      weapon = next;
      swings = WEAPONS[next].swings;
      // A weapon that arrives mid-combo must not inherit the old one's index.
      comboIndex = 0;
      comboQueued = false;
    },

    respawn(at: THREE.Vector3): void {
      controller.teleport(at);
      hp = PLAYER_HP_MAX;
      stamina = STAMINA_MAX;
      zeroStaminaLatched = false;
      regenAt = 0;
      speed = 0;
      knockSpeed = 0;
      lungeLeft = 0;
      squash = 1;
      velocity.set(0, 0, 0);
      swung.clear();
      lockTarget = null;
      carrying = null;
      tongueReach = 0;
      tongueTarget = null;
      overrideSwing = null;
      tongueView.setVisible(false);
      // A beat of grace, so a respawn cannot hand the frog straight back into
      // a blow it never had the frames to read.
      invulnUntil = now + PLAYER_IFRAMES_AFTER_HIT;
      enterIdle();
    },

    update(dt: number, ctx: GameContext): void {
      ctxRef = ctx;
      now += dt;
      updateLock();
      if (freshEntry) freshEntry = false;
      else stateTime += dt;

      if (now >= regenAt && stamina < STAMINA_MAX) {
        stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN_RATE * dt);
        if (stamina >= STAMINA_MAX) zeroStaminaLatched = false;
      }

      const magnitude = state === 'dead' ? 0 : readStick(ctx);
      claimVerbs(ctx, magnitude);
      step(ctx, dt, magnitude);

      displacement.set(velocity.x * dt, 0, velocity.z * dt);
      controller.move(displacement, dt);
      resolveGates(ctx);

      present(ctx, dt);
      presentTongue();
      // Anything entered during this frame has now run a frame of its own.
      freshEntry = false;
    },

    dispose(): void {
      root.removeFromParent();
      // Bodies AND their outline hulls: the hulls are clones this entity was
      // handed, so nothing else can free them.
      for (const geometry of model.geometries) geometry.dispose();
      // Materials are shared, cached instances owned by the material kit;
      // disposing one here would tear it out from under every other entity.
    },
  };
}
