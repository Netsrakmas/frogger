/**
 * CROAK - the Bog Beetle Guard. PROMPT.md section 6: "medium, front shield -
 * tongue-yank opens it".
 *
 * The Sporeling teaches you to read a telegraph. This one teaches you that
 * where you stand is a weapon. Its shield turns anything landing inside
 * BEETLE_SHIELD_ARC of its facing, it tracks you at BEETLE_TURN_RATE - slower
 * than you can strafe at attack range - and it stops turning the moment it
 * commits to a swing. So the answer is footwork: bait the windup, roll past the
 * shoulder, hit the back. A3 adds the second answer, the tongue yank that spins
 * it round and opens the front (section 4's medium row).
 *
 * Mashing into the shield is punished rather than merely wasted: a turned blow
 * puts the guard straight into its next windup. That windup is still the full
 * BEETLE_GUARD.telegraph - nothing in this file may shorten it.
 *
 * Every stat comes from BEETLE_GUARD in core/constants. What lives here is the
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
  Rng,
} from '../core/types';
import {
  BEETLE_BLOCK_HITSTOP,
  BEETLE_BLOCK_TRAUMA,
  BEETLE_GUARD,
  BEETLE_SHIELD_ARC,
  BEETLE_TURN_RATE,
  COIN_DROP_BEETLE,
  ENEMY_STAGGER,
  HITSTOP_KILL,
  KNOCKBACK_PLAYER,
  KNOCKBACK_SMALL_ENEMY,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  TICK_DT,
} from '../core/constants';
import { makeOutline, material } from '../render/materials';
import { createController } from '../physics/controller';

// ------------------------------------------------------------- style tuning

/** Shell half-width. The widest point, so it is also the hurt disc. */
const BODY_RADIUS = 0.42;
const BODY_HEIGHT = BODY_RADIUS * 2;
const SHELL_HEIGHT = 0.34;
const SHIELD_WIDTH = 0.66;
const SHIELD_HEIGHT = 0.46;
const SHIELD_THICKNESS = 0.1;
/** The shield rides ahead of the body, which is why it reads from behind too. */
const SHIELD_FORWARD = 0.34;
const LEG_RADIUS = 0.05;
const LEG_LENGTH = 0.18;
const FX_HEIGHT = 0.4;

const PLANT_RATE = 3.1;
const PLANT_AMPLITUDE = 0.02;
const SWAY_RATE = 1.3;
const SWAY_ANGLE = 0.04;

const SHELL_OFFSET = 0.024;
const SHELL_SWELL = 0.09;
/** Slower heartbeat than the Sporeling's: a heavier thing winding up. */
const TELL_PULSES = 2;
const HURT_FLASH_TIME = 0.11;
/** The shield's own flash when it turns a blow - sparks, not damage. */
const GUARD_FLASH_TIME = 0.14;

const SEPARATION_SHARE = 0.5;

// -------------------------------------------------------------- solver slack

const TAU = Math.PI * 2;
const TIME_EPS = TICK_DT * 0.5;
const EPS = 1e-4;
const KNOCKBACK_SPEED = (2 * KNOCKBACK_SMALL_ENEMY) / ENEMY_STAGGER;

function wrapAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

// -------------------------------------------------------------------- model

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

interface BeetleModel {
  visual: THREE.Group;
  shell: THREE.Mesh;
  shield: THREE.Mesh;
  geometries: THREE.BufferGeometry[];
}

/**
 * A wide armoured wedge behind a slab. The frog is a round ball, the Sporeling
 * a thin stalk under a cap; this is low, broad and flat-fronted, so all three
 * are separable by silhouette alone at gameplay zoom (section 9 rule 11). The
 * shield is a separate mesh because the fight is about which way it points.
 */
function buildBeetle(): BeetleModel {
  const visual = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  // Shell: a six-sided dome, flattened. Faceted so the key light reads it.
  const shellGeo = place(
    new THREE.SphereGeometry(BODY_RADIUS, 6, 3, 0, TAU, 0, Math.PI * 0.5),
    0,
    LEG_LENGTH,
    0,
    1,
    SHELL_HEIGHT / BODY_RADIUS,
    0.86,
  );
  const shell = new THREE.Mesh(
    shellGeo,
    material('ruinCool', { flatShading: true }),
  );
  shell.castShadow = true;
  visual.add(shell);
  geometries.push(shellGeo);

  // Shield: the whole point of the enemy, so it is the boldest shape it has.
  const shieldGeo = place(
    new THREE.BoxGeometry(SHIELD_WIDTH, SHIELD_HEIGHT, SHIELD_THICKNESS),
    0,
    LEG_LENGTH + SHIELD_HEIGHT * 0.45,
    SHIELD_FORWARD,
  );
  const ridgeGeo = place(
    new THREE.BoxGeometry(SHIELD_WIDTH * 0.24, SHIELD_HEIGHT * 0.92, SHIELD_THICKNESS * 1.6),
    0,
    LEG_LENGTH + SHIELD_HEIGHT * 0.45,
    SHIELD_FORWARD + SHIELD_THICKNESS * 0.3,
  );
  const shield = new THREE.Mesh(
    merge([shieldGeo, ridgeGeo]),
    material('stoneShade', { flatShading: true }),
  );
  shield.castShadow = true;
  visual.add(shield);
  geometries.push(shield.geometry);

  // Legs: stubby, planted wide. They say "this thing does not dodge".
  const legParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    for (const along of [-0.2, 0.05, 0.28]) {
      legParts.push(
        place(
          new THREE.CylinderGeometry(LEG_RADIUS, LEG_RADIUS * 0.8, LEG_LENGTH, 5),
          side * BODY_RADIUS * 0.72,
          LEG_LENGTH * 0.5,
          along,
        ),
      );
    }
  }
  const legsGeo = merge(legParts);
  const legs = new THREE.Mesh(legsGeo, material('dungeonDark', { flatShading: true }));
  legs.castShadow = true;
  visual.add(legs);
  geometries.push(legsGeo);

  // Eyes peering over the rim: the only way to read its facing from the front.
  const eyeParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    eyeParts.push(
      place(
        new THREE.SphereGeometry(0.052, 6, 5),
        side * 0.14,
        LEG_LENGTH + SHELL_HEIGHT * 0.82,
        SHIELD_FORWARD - 0.16,
      ),
    );
  }
  const eyesGeo = merge(eyeParts);
  const eyes = new THREE.Mesh(eyesGeo, material('gold', { emissive: true }));
  visual.add(eyes);
  geometries.push(eyesGeo);

  const outline = makeOutline(shell);
  visual.add(outline);
  geometries.push(outline.geometry);
  const shieldOutline = makeOutline(shield);
  visual.add(shieldOutline);
  geometries.push(shieldOutline.geometry);

  return { visual, shell, shield, geometries };
}

// ------------------------------------------------------------------- entity

export function createBeetleGuard(
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
  root.name = 'beetleGuard';
  const model = buildBeetle();
  root.add(model.visual);
  scene.add(root);

  const plantPhase = rng.next() * TAU;
  const swayPhase = rng.next() * TAU;

  const tellMaterial = material('dungeonGlow', {
    emissive: true,
    flatShading: true,
  });
  const hurtMaterial = material('heroBelly', {
    emissive: true,
    flatShading: true,
  });
  const shellMaterial = model.shell.material as THREE.Material;
  const guardMaterial = material('gold', { emissive: true, flatShading: true });
  const shieldMaterial = model.shield.material as THREE.Material;

  const pos = controller.position;
  const travel = new THREE.Vector3();
  const knockDir = new THREE.Vector3(0, 0, 1);
  const hitDir = new THREE.Vector3();
  const struck = new Set<Damageable>();

  let state: EnemyStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let hp = BEETLE_GUARD.hp;
  let facing = 0;
  let squash = 1;
  let knockSpeed = 0;
  let hurtFlash = 0;
  let guardFlash = 0;
  let ctxRef: GameContext | null = null;

  root.position.copy(pos);

  function turnToward(target: number, dt: number): void {
    const delta = wrapAngle(target - facing);
    const step = BEETLE_TURN_RATE * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  /**
   * True when a blow arriving along `direction` (attacker -> guard) lands on
   * the shield. The guard's own facing is the only thing that decides it, so
   * the player controls the outcome entirely by where they stand.
   */
  function isGuarded(direction: THREE.Vector3): boolean {
    const toAttacker = Math.atan2(-direction.x, -direction.z);
    return Math.abs(wrapAngle(toAttacker - facing)) <= BEETLE_SHIELD_ARC;
  }

  function enterIdle(): void {
    state = 'idle';
    stateTime = 0;
  }

  function enterAggro(): void {
    state = 'aggro';
    stateTime = 0;
  }

  function enterTelegraph(): void {
    state = 'telegraph';
    stateTime = 0;
  }

  function enterAttack(): void {
    state = 'attack';
    stateTime = 0;
    struck.clear();
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
    root.visible = false;

    const ctx = ctxRef;
    if (ctx === null) return;
    ctx.requestHitstop(HITSTOP_KILL);
    ctx.spawnFx(
      'sporePuff',
      new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z),
      knockDir.clone(),
    );
    ctx.dropCoins(COIN_DROP_BEETLE, new THREE.Vector3(pos.x, pos.y, pos.z));
  }

  function strike(ctx: GameContext): void {
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive || struck.has(target)) continue;

      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > BEETLE_GUARD.attackRange + target.hurtRadius) continue;
      // It shoves with the shield, so the blow only exists in front of it.
      if (distance > EPS) {
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - facing));
        if (off > BEETLE_SHIELD_ARC) continue;
      }

      struck.add(target);
      if (distance > EPS) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));

      const hit: HitInfo = {
        damage: BEETLE_GUARD.damage,
        knockback: KNOCKBACK_PLAYER,
        direction: hitDir.clone(),
        hitstop: BEETLE_BLOCK_HITSTOP,
        source: 'enemy',
      };
      target.takeHit(hit);
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

  function think(ctx: GameContext, dt: number): void {
    const player = ctx.player;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    const toPlayer = Math.atan2(dx, dz);

    travel.set(0, 0, 0);

    switch (state) {
      case 'idle': {
        if (player.alive && distance <= BEETLE_GUARD.aggroRange) enterAggro();
        break;
      }

      case 'aggro': {
        if (!player.alive || distance > BEETLE_GUARD.aggroRange * 1.25) {
          enterIdle();
          break;
        }
        // Keeping the shield pointed at the player is the whole behaviour.
        turnToward(toPlayer, dt);
        if (distance > BEETLE_GUARD.attackRange) {
          const speed = BEETLE_GUARD.moveSpeed * dt;
          travel.x += (dx / Math.max(distance, EPS)) * speed;
          travel.z += (dz / Math.max(distance, EPS)) * speed;
        } else if (Math.abs(wrapAngle(toPlayer - facing)) < BEETLE_SHIELD_ARC) {
          enterTelegraph();
        }
        break;
      }

      case 'telegraph': {
        // Committed: it does NOT track here, which is what makes rolling past
        // the shoulder work. Nothing may cut this window short.
        if (stateTime >= BEETLE_GUARD.telegraph - TIME_EPS) enterAttack();
        break;
      }

      case 'attack': {
        strike(ctx);
        if (stateTime >= BEETLE_GUARD.active - TIME_EPS) enterRecover();
        break;
      }

      case 'recover': {
        if (stateTime >= BEETLE_GUARD.recovery - TIME_EPS) enterAggro();
        break;
      }

      case 'stagger': {
        if (knockSpeed > 0) {
          const push = knockSpeed * dt;
          travel.x += knockDir.x * push;
          travel.z += knockDir.z * push;
          knockSpeed = Math.max(0, knockSpeed - KNOCKBACK_SPEED * (dt / ENEMY_STAGGER));
        }
        if (stateTime >= ENEMY_STAGGER - TIME_EPS) enterAggro();
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
    guardFlash = Math.max(0, guardFlash - dt);

    const plant = Math.sin(now * PLANT_RATE + plantPhase) * PLANT_AMPLITUDE;
    const sway = Math.sin(now * SWAY_RATE + swayPhase) * SWAY_ANGLE;

    squash += (1 - squash) * Math.min(1, SQUASH_RECOVER * dt);
    const stretch = 1 / Math.sqrt(Math.max(squash, EPS));

    root.position.set(pos.x, pos.y + plant, pos.z);
    root.rotation.set(0, facing, sway);
    model.visual.scale.set(stretch, squash, stretch);

    // The windup floods the shell with light on its FIRST frame and holds; the
    // shield answers separately when it turns a blow, so the two reads never
    // get confused with one another.
    let swell = 0;
    if (state === 'telegraph') {
      const t = Math.min(1, stateTime / BEETLE_GUARD.telegraph);
      swell = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * TELL_PULSES));
      model.shell.material = tellMaterial;
    } else if (hurtFlash > 0) {
      model.shell.material = hurtMaterial;
      swell = hurtFlash / HURT_FLASH_TIME;
    } else {
      model.shell.material = shellMaterial;
    }
    const scale = 1 + swell * SHELL_SWELL + (swell > 0 ? SHELL_OFFSET : 0);
    model.shell.scale.setScalar(scale);

    model.shield.material = guardFlash > 0 ? guardMaterial : shieldMaterial;
  }

  function takeHit(hit: HitInfo): boolean {
    if (state === 'dead') return false;

    const ctx = ctxRef;

    if (hit.source === 'player' && isGuarded(hit.direction)) {
      guardFlash = GUARD_FLASH_TIME;
      if (ctx !== null) {
        ctx.requestHitstop(BEETLE_BLOCK_HITSTOP);
        ctx.addTrauma(BEETLE_BLOCK_TRAUMA);
        ctx.spawnFx(
          'guardSpark',
          new THREE.Vector3(
            pos.x + Math.sin(facing) * SHIELD_FORWARD,
            pos.y + FX_HEIGHT,
            pos.z + Math.cos(facing) * SHIELD_FORWARD,
          ),
          hit.direction.clone().negate(),
        );
      }
      // Mashing the shield is answered, not merely absorbed - but the answer
      // still telegraphs in full.
      if (state === 'idle' || state === 'aggro') enterTelegraph();
      return false;
    }

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
    kind: 'beetleGuard',
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
      for (const geometry of model.geometries) geometry.dispose();
    },
  };
}
