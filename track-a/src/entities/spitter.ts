/**
 * CROAK - the Spitter Fly. PROMPT.md section 6: "ranged, hovers over water,
 * tongue-pullable out of the air".
 *
 * The third enemy is the one that answers "why would I ever use the tongue in a
 * fight?". It never closes: it holds SPITTER_STANDOFF away, usually over water
 * the frog cannot follow it onto, and lobs globs. A sword is useless against it.
 * A tongue drags it out of the sky and into your mouth, where it is just another
 * thing to throw.
 *
 * So its mass is light, exactly like a Sporeling's - the lesson is not a new
 * rule, it is the same rule finally being necessary.
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
  COIN_DROP_SPITTER,
  ENEMY_STAGGER,
  GLOB_RADIUS,
  GLOB_RANGE,
  GLOB_SPEED,
  HITSTOP_KILL,
  HITSTOP_LIGHT,
  KNOCKBACK_PLAYER,
  KNOCKBACK_SMALL_ENEMY,
  SPITTER_FLY,
  SPITTER_HOVER,
  SPITTER_STANDOFF,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  TICK_DT,
  TONGUE_THROW_DAMAGE,
  TONGUE_THROW_RANGE,
  TONGUE_THROW_SPEED,
  TRAUMA_HIT,
  TURN_RATE,
} from '../core/constants';
import { inStrikeHeight } from '../core/hits';
import { makeOutline, material } from '../render/materials';

const TAU = Math.PI * 2;
const TIME_EPS = TICK_DT * 0.5;
const EPS = 1e-4;
const BODY_RADIUS = 0.26;
const WING_SPAN = 0.5;
const HOVER_RATE = 7.5;
const HOVER_AMPLITUDE = 0.07;
const WING_RATE = 34.0;
const HURT_FLASH_TIME = 0.11;
const SHELL_SWELL = 0.13;
const TELL_PULSES = 3;
const KNOCKBACK_SPEED = (2 * KNOCKBACK_SMALL_ENEMY) / ENEMY_STAGGER;
/** Drift toward its standoff ring, so a pack does not stack into one body. */
const DRIFT_RATE = 2.6;

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

interface SpitterModel {
  visual: THREE.Group;
  body: THREE.Mesh;
  wings: THREE.Mesh;
  geometries: THREE.BufferGeometry[];
}

/**
 * A fat winged seed pod. The frog is round and grounded, the Sporeling is a
 * stalk, the Guard is a wedge - this one is the only silhouette in the game
 * with its mass ABOVE the ground and nothing underneath it, which is the read
 * that matters: you cannot reach it.
 */
function buildSpitter(): SpitterModel {
  const visual = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  const bodyGeo = mergeGeometries([
    place(new THREE.SphereGeometry(BODY_RADIUS, 8, 6), 0, 0, 0, 1, 0.86, 1.25),
    // A blunt snout: the end the globs come out of, pointed at you.
    place(new THREE.ConeGeometry(BODY_RADIUS * 0.5, 0.24, 6), 0, 0, BODY_RADIUS * 1.1, 1, 1, 1),
  ]);
  const body = new THREE.Mesh(bodyGeo, material('canopy', { flatShading: true }));
  body.castShadow = true;
  visual.add(body);
  geometries.push(bodyGeo);

  const wingGeo = mergeGeometries([
    place(new THREE.SphereGeometry(0.19, 6, 4), WING_SPAN * 0.5, 0.1, -0.05, 1.5, 0.16, 0.9),
    place(new THREE.SphereGeometry(0.19, 6, 4), -WING_SPAN * 0.5, 0.1, -0.05, 1.5, 0.16, 0.9),
  ]);
  const wings = new THREE.Mesh(
    wingGeo,
    material('hazeSky', { transparent: true, opacity: 0.72 }),
  );
  visual.add(wings);
  geometries.push(wingGeo);

  const eyeGeo = mergeGeometries([
    place(new THREE.SphereGeometry(0.06, 6, 5), 0.1, 0.08, 0.18),
    place(new THREE.SphereGeometry(0.06, 6, 5), -0.1, 0.08, 0.18),
  ]);
  const eyes = new THREE.Mesh(eyeGeo, material('gold', { emissive: true }));
  visual.add(eyes);
  geometries.push(eyeGeo);

  const outline = makeOutline(body);
  visual.add(outline);
  geometries.push(outline.geometry);

  return { visual, body, wings, geometries };
}

export function createSpitterFly(
  scene: THREE.Scene,
  _level: Level,
  position: THREE.Vector3,
  rng: Rng,
): Enemy {
  const root = new THREE.Group();
  root.name = 'spitterFly';
  const model = buildSpitter();
  root.add(model.visual);
  scene.add(root);

  // It flies, so it does not use the capsule solver at all - it is the one
  // body in the game that is allowed to ignore the ground.
  const pos = position.clone();
  const home = position.clone();
  const groundY = position.y;

  const globGeo = new THREE.SphereGeometry(GLOB_RADIUS, 6, 5);
  const glob = new THREE.Mesh(globGeo, material('canopy', { emissive: true }));
  glob.visible = false;
  scene.add(glob);

  const tellMaterial = material('dungeonGlow', { emissive: true, flatShading: true });
  const hurtMaterial = material('heroBelly', { emissive: true, flatShading: true });
  const bodyMaterial = model.body.material as THREE.Material;

  const globPos = new THREE.Vector3();
  const globDir = new THREE.Vector3();
  const knockDir = new THREE.Vector3(0, 0, 1);
  const hitDir = new THREE.Vector3();
  const thrownDir = new THREE.Vector3();
  const struckByThrow = new Set<Damageable>();

  const bobPhase = rng.next() * TAU;
  const orbitPhase = rng.next() * TAU;

  let state: EnemyStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let hp = SPITTER_FLY.hp;
  let facing = 0;
  let squash = 1;
  let knockSpeed = 0;
  let hurtFlash = 0;
  let globLeft = 0;
  let held = false;
  let thrownSpeed = 0;
  let thrownLeft = 0;
  let ctxRef: GameContext | null = null;

  root.position.copy(pos);

  function turnToward(target: number, dt: number): void {
    const delta = wrapAngle(target - facing);
    const step = TURN_RATE * 0.4 * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  function enterState(next: EnemyStateName): void {
    state = next;
    stateTime = 0;
  }

  function die(): void {
    state = 'dead';
    stateTime = 0;
    root.visible = false;
    glob.visible = false;
    globLeft = 0;
    const ctx = ctxRef;
    if (ctx === null) return;
    ctx.requestHitstop(HITSTOP_KILL);
    ctx.spawnFx('sporePuff', new THREE.Vector3(pos.x, pos.y, pos.z), knockDir.clone());
    ctx.dropCoins(COIN_DROP_SPITTER, new THREE.Vector3(pos.x, groundY, pos.z));
  }

  /** Lob a glob at where the frog is standing right now. */
  function spit(ctx: GameContext): void {
    globPos.set(pos.x, pos.y, pos.z);
    const dx = ctx.player.position.x - pos.x;
    const dz = ctx.player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= EPS) return;
    globDir.set(dx / distance, 0, dz / distance);
    globLeft = GLOB_RANGE;
    glob.visible = true;
  }

  function advanceGlob(ctx: GameContext, dt: number): void {
    if (globLeft <= 0) return;
    const travel = Math.min(globLeft, GLOB_SPEED * dt);
    globLeft -= travel;
    globPos.x += globDir.x * travel;
    globPos.z += globDir.z * travel;
    glob.position.copy(globPos);

    const target = ctx.player;
    const dx = target.position.x - globPos.x;
    const dz = target.position.z - globPos.z;
    // The glob flies at spit height; a frog above or below that line is safe.
    if (
      inStrikeHeight(globPos.y, target) &&
      Math.hypot(dx, dz) <= GLOB_RADIUS + target.hurtRadius
    ) {
      hitDir.set(globDir.x, 0, globDir.z);
      target.takeHit({
        damage: SPITTER_FLY.damage,
        knockback: KNOCKBACK_PLAYER * 0.6,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      });
      globLeft = 0;
    }
    if (globLeft <= 0) glob.visible = false;
  }

  function onTongue(_from: THREE.Vector3, _ctx: GameContext): TongueOutcome {
    if (state === 'dead' || held) return 'none';
    // Dragged out of the sky. From here it is just a thing to throw.
    held = true;
    thrownSpeed = 0;
    enterState('stagger');
    return 'held';
  }

  function carryTo(position2: THREE.Vector3): void {
    pos.copy(position2);
  }

  function release(dir: THREE.Vector3 | null, _ctx: GameContext): void {
    if (!held) return;
    held = false;
    struckByThrow.clear();
    if (dir === null) {
      enterState('stagger');
      return;
    }
    thrownDir.set(dir.x, 0, dir.z);
    if (thrownDir.lengthSq() < EPS) thrownDir.set(Math.sin(facing), 0, Math.cos(facing));
    thrownDir.normalize();
    thrownSpeed = TONGUE_THROW_SPEED;
    thrownLeft = TONGUE_THROW_RANGE;
    enterState('stagger');
  }

  function flyOn(ctx: GameContext, dt: number): void {
    if (thrownSpeed <= 0) return;
    const travelled = Math.min(thrownLeft, thrownSpeed * dt);
    thrownLeft -= travelled;
    pos.x += thrownDir.x * travelled;
    pos.z += thrownDir.z * travelled;

    for (const other of ctx.enemies) {
      if (other.root === root || !other.alive || struckByThrow.has(other)) continue;
      if (!inStrikeHeight(pos.y, other)) continue;
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

  function think(ctx: GameContext, dt: number): void {
    if (held) return;
    advanceGlob(ctx, dt);
    flyOn(ctx, dt);

    const player = ctx.player;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    const sees = player.alive && distance <= SPITTER_FLY.aggroRange;

    switch (state) {
      case 'idle': {
        // Drifts around its perch until it notices you.
        const drift = Math.sin(now * 0.6 + orbitPhase) * 0.6;
        pos.x += (home.x + drift - pos.x) * Math.min(1, dt);
        pos.z += (home.z - pos.z) * Math.min(1, dt);
        if (sees) enterState('aggro');
        break;
      }

      case 'aggro': {
        if (!sees) {
          enterState('idle');
          break;
        }
        turnToward(Math.atan2(dx, dz), dt);
        // Holds its standoff: closer and it backs off, further and it edges in.
        const want = distance - SPITTER_STANDOFF;
        if (Math.abs(want) > 0.3 && distance > EPS) {
          const move = Math.sign(want) * Math.min(Math.abs(want), DRIFT_RATE * dt);
          pos.x += (dx / distance) * move;
          pos.z += (dz / distance) * move;
        }
        if (distance <= SPITTER_FLY.attackRange && globLeft <= 0) enterState('telegraph');
        break;
      }

      case 'telegraph': {
        turnToward(Math.atan2(dx, dz), dt);
        if (stateTime >= SPITTER_FLY.telegraph - TIME_EPS) {
          spit(ctx);
          enterState('attack');
        }
        break;
      }

      case 'attack': {
        if (stateTime >= SPITTER_FLY.active - TIME_EPS) enterState('recover');
        break;
      }

      case 'recover': {
        if (stateTime >= SPITTER_FLY.recovery - TIME_EPS) enterState('aggro');
        break;
      }

      case 'stagger': {
        if (knockSpeed > 0) {
          const push = knockSpeed * dt;
          pos.x += knockDir.x * push;
          pos.z += knockDir.z * push;
          knockSpeed = Math.max(0, knockSpeed - KNOCKBACK_SPEED * (dt / ENEMY_STAGGER));
        }
        if (stateTime >= ENEMY_STAGGER - TIME_EPS) enterState('aggro');
        break;
      }

      case 'dead':
        break;
    }
  }

  function present(dt: number): void {
    hurtFlash = Math.max(0, hurtFlash - dt);
    squash += (1 - squash) * Math.min(1, SQUASH_RECOVER * dt);

    const hover = held ? 0 : Math.sin(now * HOVER_RATE + bobPhase) * HOVER_AMPLITUDE;
    root.position.set(pos.x, pos.y + hover, pos.z);
    root.rotation.set(0, facing, 0);
    // Wings beat far too fast to read individually, which is the point.
    model.wings.scale.set(1, 1, 0.4 + 0.6 * Math.abs(Math.sin(now * WING_RATE)));

    let swell = 0;
    if (state === 'telegraph') {
      const t = Math.min(1, stateTime / SPITTER_FLY.telegraph);
      swell = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * TELL_PULSES));
      model.body.material = tellMaterial;
    } else if (hurtFlash > 0) {
      model.body.material = hurtMaterial;
      swell = hurtFlash / HURT_FLASH_TIME;
    } else {
      model.body.material = bodyMaterial;
    }
    model.body.scale.setScalar((1 + swell * SHELL_SWELL) * squash);
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
    squash = SQUASH_IMPACT;
    if (hp <= 0) die();
    else {
      knockSpeed = KNOCKBACK_SPEED;
      enterState('stagger');
    }
    return true;
  }

  return {
    root,
    kind: 'spitterFly',
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
      return SPITTER_FLY.mass;
    },
    get held(): boolean {
      return held;
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
      // Held or free, it always rides at hover height: a fly that sinks to the
      // grass when grabbed reads as a bug rather than a catch.
      pos.y = groundY + SPITTER_HOVER;
      think(ctx, dt);
      present(dt);
    },

    dispose(): void {
      root.removeFromParent();
      glob.removeFromParent();
      globGeo.dispose();
      for (const geometry of model.geometries) geometry.dispose();
    },
  };
}
