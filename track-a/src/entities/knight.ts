/**
 * CROAK - the Drowned Knight. PROMPT.md section 6: "dungeon, sword patterns,
 * teaches shield".
 *
 * A frog knight that never got out of the belfry. It is the only enemy that
 * attacks TWICE: a telegraphed overhead, then a second blow KNIGHT_FOLLOWUP_GAP
 * later. One roll clears the first; the second lands while that roll is still
 * recovering. So the pair is not unfair, it is a question, and the Shield in the
 * vault is the answer - which is exactly why it is the enemy standing between
 * you and it.
 *
 * It tracks slowly and stops tracking once committed, like the Beetle Guard, so
 * everything the player learned upstairs still applies. What is new is only the
 * rhythm.
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
  COIN_DROP_KNIGHT,
  DROWNED_KNIGHT,
  ENEMY_STAGGER,
  HITSTOP_KILL,
  HITSTOP_LIGHT,
  KNIGHT_FOLLOWUP_GAP,
  KNIGHT_TURN_RATE,
  KNOCKBACK_PLAYER,
  KNOCKBACK_SMALL_ENEMY,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  TICK_DT,
  TONGUE_YANK_DISTANCE,
  TONGUE_YANK_STAGGER,
} from '../core/constants';
import { inStrikeHeight } from '../core/hits';
import { makeOutline, material } from '../render/materials';
import { createController } from '../physics/controller';

const TAU = Math.PI * 2;
const TIME_EPS = TICK_DT * 0.5;
const EPS = 1e-4;
const BODY_RADIUS = 0.38;
const BODY_HEIGHT = BODY_RADIUS * 2;
const TORSO_HEIGHT = 0.62;
const BLADE_LENGTH = 1.05;
const HURT_FLASH_TIME = 0.11;
const SHELL_SWELL = 0.08;
const TELL_PULSES = 2;
const FX_HEIGHT = 0.5;
const KNOCKBACK_SPEED = (2 * KNOCKBACK_SMALL_ENEMY) / ENEMY_STAGGER;
const SEPARATION_SHARE = 0.5;
/** Sword arc, matching the reach it advertises. */
const SWING_ARC = Math.PI * 0.55;

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

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

interface KnightModel {
  visual: THREE.Group;
  body: THREE.Mesh;
  arm: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

/**
 * Tall and narrow, and the only humanoid silhouette in the game: the frog is a
 * ball, the Sporeling a stalk, the Guard a wedge, the Fly a hovering pod. This
 * one stands upright and carries a blade above its head when it winds up, which
 * is the read the whole fight depends on.
 */
function buildKnight(): KnightModel {
  const visual = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  const bodyGeo = mergeGeometries([
    // torso: a drowned frog gone gaunt
    place(new THREE.SphereGeometry(BODY_RADIUS, 8, 6), 0, TORSO_HEIGHT, 0, 0.9, 1.15, 0.8),
    // head, sunken forward
    place(new THREE.SphereGeometry(0.24, 8, 6), 0, TORSO_HEIGHT + 0.5, 0.06, 1, 0.95, 1),
    // legs
    place(new THREE.CylinderGeometry(0.09, 0.07, 0.5, 5), 0.16, 0.25, 0),
    place(new THREE.CylinderGeometry(0.09, 0.07, 0.5, 5), -0.16, 0.25, 0),
  ]);
  const body = new THREE.Mesh(bodyGeo, material('ruinCool', { flatShading: true }));
  body.castShadow = true;
  visual.add(body);
  geometries.push(bodyGeo);

  // Rotted tunic, so it reads as the same order of knight the frog belongs to.
  const tunicGeo = place(
    new THREE.SphereGeometry(0.42, 8, 6),
    0,
    TORSO_HEIGHT - 0.12,
    0,
    0.92,
    0.6,
    0.82,
  );
  const tunic = new THREE.Mesh(tunicGeo, material('heroTunic', { flatShading: true }));
  tunic.castShadow = true;
  visual.add(tunic);
  geometries.push(tunicGeo);

  const eyeGeo = mergeGeometries([
    place(new THREE.SphereGeometry(0.055, 6, 5), 0.1, TORSO_HEIGHT + 0.54, 0.2),
    place(new THREE.SphereGeometry(0.055, 6, 5), -0.1, TORSO_HEIGHT + 0.54, 0.2),
  ]);
  const eyes = new THREE.Mesh(eyeGeo, material('dungeonGlow', { emissive: true }));
  visual.add(eyes);
  geometries.push(eyeGeo);

  // The arm is its own group so the blade can be raised: a telegraph you can
  // read from the silhouette alone, not just from a colour flash.
  const arm = new THREE.Group();
  arm.position.set(0.34, TORSO_HEIGHT + 0.18, 0);
  const bladeGeo = mergeGeometries([
    place(new THREE.BoxGeometry(0.09, BLADE_LENGTH, 0.04), 0, BLADE_LENGTH * 0.5, 0),
    place(new THREE.BoxGeometry(0.3, 0.07, 0.09), 0, 0.03, 0),
  ]);
  const blade = new THREE.Mesh(bladeGeo, material('stoneShade', { flatShading: true }));
  blade.castShadow = true;
  arm.add(blade);
  visual.add(arm);
  geometries.push(bladeGeo);

  const outline = makeOutline(body);
  visual.add(outline);
  geometries.push(outline.geometry);

  return { visual, body, arm, geometries };
}

export function createDrownedKnight(
  scene: THREE.Scene,
  level: Level,
  position: THREE.Vector3,
  rng: Rng,
): Enemy {
  const controller = createController(level.collider, position, {
    radius: BODY_RADIUS,
    height: BODY_HEIGHT,
  });
  controller.teleport(position);

  const root = new THREE.Group();
  root.name = 'drownedKnight';
  const model = buildKnight();
  root.add(model.visual);
  scene.add(root);

  const swayPhase = rng.next() * TAU;

  const tellMaterial = material('dungeonGlow', { emissive: true, flatShading: true });
  const hurtMaterial = material('heroBelly', { emissive: true, flatShading: true });
  const bodyMaterial = model.body.material as THREE.Material;

  const pos = controller.position;
  const travel = new THREE.Vector3();
  const knockDir = new THREE.Vector3(0, 0, 1);
  const hitDir = new THREE.Vector3();
  const struck = new Set<Damageable>();

  let state: EnemyStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let hp = DROWNED_KNIGHT.hp;
  let facing = 0;
  let squash = 1;
  let knockSpeed = 0;
  let hurtFlash = 0;
  let staggerFor = ENEMY_STAGGER;
  let yankLeft = 0;
  /** 0 = the overhead, 1 = the follow-up. The pair is the whole lesson. */
  let swingIndex = 0;
  let ctxRef: GameContext | null = null;

  root.position.copy(pos);

  function turnToward(target: number, dt: number): void {
    const delta = wrapAngle(target - facing);
    const step = KNIGHT_TURN_RATE * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  function enter(next: EnemyStateName, duration = ENEMY_STAGGER): void {
    state = next;
    stateTime = 0;
    if (next === 'stagger') {
      staggerFor = duration;
      squash = SQUASH_IMPACT;
      knockSpeed = KNOCKBACK_SPEED;
      swingIndex = 0;
    }
    if (next === 'attack') struck.clear();
  }

  function die(): void {
    state = 'dead';
    stateTime = 0;
    knockSpeed = 0;
    root.visible = false;
    const ctx = ctxRef;
    if (ctx === null) return;
    ctx.requestHitstop(HITSTOP_KILL);
    ctx.spawnFx('sporePuff', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z), knockDir.clone());
    ctx.dropCoins(COIN_DROP_KNIGHT, new THREE.Vector3(pos.x, pos.y, pos.z));
  }

  function strike(ctx: GameContext): void {
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive || struck.has(target)) continue;
      // The sword swings at its own height: a frog up a ramp is out of it.
      if (!inStrikeHeight(pos.y, target)) continue;
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > DROWNED_KNIGHT.attackRange + target.hurtRadius) continue;
      if (distance > EPS) {
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
        if (off > SWING_ARC) continue;
      }
      struck.add(target);
      if (distance > EPS) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));
      target.takeHit({
        damage: DROWNED_KNIGHT.damage,
        knockback: KNOCKBACK_PLAYER,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      });
    }
  }

  function separate(ctx: GameContext): void {
    for (const other of ctx.enemies) {
      if (other.root === root || !other.alive) continue;
      const dx = pos.x - other.position.x;
      const dz = pos.z - other.position.z;
      const distance = Math.hypot(dx, dz);
      const minimum = BODY_RADIUS + other.hurtRadius;
      if (distance >= minimum || distance <= EPS) continue;
      const push = (minimum - distance) * SEPARATION_SHARE;
      travel.x += (dx / distance) * push;
      travel.z += (dz / distance) * push;
    }
  }

  function onTongue(from: THREE.Vector3, ctx: GameContext): TongueOutcome {
    if (state === 'dead') return 'none';
    const dx = from.x - pos.x;
    const dz = from.z - pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance > EPS) {
      knockDir.set(dx / distance, 0, dz / distance);
      facing = Math.atan2(-dx, -dz);
    }
    yankLeft = TONGUE_YANK_DISTANCE;
    enter('stagger', TONGUE_YANK_STAGGER);
    ctx.spawnFx('tongueHit', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z), knockDir.clone());
    return 'yanked';
  }

  function carryTo(_position: THREE.Vector3): void {
    /* medium mass is never held */
  }

  function release(_dir: THREE.Vector3 | null, _ctx: GameContext): void {
    /* medium mass is never held */
  }

  function think(ctx: GameContext, dt: number): void {
    const player = ctx.player;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    const toPlayer = Math.atan2(dx, dz);

    travel.set(0, 0, 0);

    switch (state) {
      case 'idle': {
        if (player.alive && distance <= DROWNED_KNIGHT.aggroRange) enter('aggro');
        break;
      }
      case 'aggro': {
        if (!player.alive || distance > DROWNED_KNIGHT.aggroRange * 1.3) {
          enter('idle');
          break;
        }
        turnToward(toPlayer, dt);
        if (distance > DROWNED_KNIGHT.attackRange * 0.85) {
          const speed = DROWNED_KNIGHT.moveSpeed * dt;
          travel.x += (dx / Math.max(distance, EPS)) * speed;
          travel.z += (dz / Math.max(distance, EPS)) * speed;
        } else if (Math.abs(wrapAngle(toPlayer - facing)) < SWING_ARC) {
          swingIndex = 0;
          enter('telegraph');
        }
        break;
      }
      case 'telegraph': {
        // Committed: no tracking, so a roll past the shoulder still works.
        // The follow-up gets a SHORTER wind-up but is never silent - the blade
        // still rises, which is the only promise this enemy has to keep.
        const window = swingIndex === 0 ? DROWNED_KNIGHT.telegraph : KNIGHT_FOLLOWUP_GAP;
        if (stateTime >= window - TIME_EPS) enter('attack');
        break;
      }
      case 'attack': {
        strike(ctx);
        if (stateTime >= DROWNED_KNIGHT.active - TIME_EPS) {
          if (swingIndex === 0) {
            swingIndex = 1;
            enter('telegraph');
          } else {
            enter('recover');
          }
        }
        break;
      }
      case 'recover': {
        if (stateTime >= DROWNED_KNIGHT.recovery - TIME_EPS) {
          swingIndex = 0;
          enter('aggro');
        }
        break;
      }
      case 'stagger': {
        if (knockSpeed > 0) {
          const push = knockSpeed * dt;
          travel.x += knockDir.x * push;
          travel.z += knockDir.z * push;
          knockSpeed = Math.max(0, knockSpeed - KNOCKBACK_SPEED * (dt / ENEMY_STAGGER));
        }
        if (yankLeft > 0) {
          const drag = Math.min(yankLeft, (TONGUE_YANK_DISTANCE / TONGUE_YANK_STAGGER) * dt * 2);
          yankLeft -= drag;
          travel.x += knockDir.x * drag;
          travel.z += knockDir.z * drag;
        }
        if (stateTime >= staggerFor - TIME_EPS) enter('aggro');
        break;
      }
      case 'dead':
        break;
    }

    separate(ctx);
    controller.move(travel, dt);
  }

  function present(dt: number): void {
    hurtFlash = Math.max(0, hurtFlash - dt);
    squash += (1 - squash) * Math.min(1, SQUASH_RECOVER * dt);
    const stretch = 1 / Math.sqrt(Math.max(squash, EPS));

    root.position.copy(pos);
    root.rotation.set(0, facing, Math.sin(now * 1.1 + swayPhase) * 0.03);
    model.visual.scale.set(stretch, squash, stretch);

    // The blade: raised through the wind-up, dropped through the active frames.
    let armAngle = -0.25;
    if (state === 'telegraph') {
      const window = swingIndex === 0 ? DROWNED_KNIGHT.telegraph : KNIGHT_FOLLOWUP_GAP;
      armAngle = -0.25 - Math.min(1, stateTime / window) * 2.3;
    } else if (state === 'attack') {
      armAngle = -2.55 + Math.min(1, stateTime / DROWNED_KNIGHT.active) * 3.1;
    }
    model.arm.rotation.x = armAngle;

    let swell = 0;
    if (state === 'telegraph') {
      const window = swingIndex === 0 ? DROWNED_KNIGHT.telegraph : KNIGHT_FOLLOWUP_GAP;
      const t = Math.min(1, stateTime / window);
      swell = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * TELL_PULSES));
      model.body.material = tellMaterial;
    } else if (hurtFlash > 0) {
      model.body.material = hurtMaterial;
      swell = hurtFlash / HURT_FLASH_TIME;
    } else {
      model.body.material = bodyMaterial;
    }
    model.body.scale.setScalar(1 + swell * SHELL_SWELL);
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
    else enter('stagger');
    return true;
  }

  return {
    root,
    kind: 'drownedKnight',
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
      return DROWNED_KNIGHT.mass;
    },
    get held(): boolean {
      return false;
    },
    get hurtRadius(): number {
      return BODY_RADIUS;
    },
    takeHit,
    onTongue,
    carryTo,
    release,

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
      for (const geometry of model.geometries) geometry.dispose();
    },
  };
}
