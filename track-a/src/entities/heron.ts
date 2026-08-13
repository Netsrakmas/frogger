/**
 * CROAK - The Heron of the Sunken Belfry. PROMPT.md section 6, the boss.
 *
 * A frog's natural nightmare: tall, still, patient, and the only HEAVY thing in
 * the game. That last word is the whole fight. Every other enemy answers the
 * tongue by coming to you; this one does not move at all, so the frog travels
 * instead - and a tongue thrown at a Heron is a commitment to arrive inside its
 * reach with a slash already spent.
 *
 * Three phases, and each one asks a different question:
 *
 *   1  ON THE DECK. Spear-beak stabs and wing gusts, both telegraphed at 40 f.
 *      This is the phase that teaches the two tells apart: the neck rears back
 *      for a stab, the wings open for a gust. Ordinary swordfighting works.
 *
 *   2  IN THE MIDDLE. It takes the centre of the arena and turns the air
 *      outward, hardest at the middle (HERON_WIND_CENTRE), so the last few
 *      metres cannot be walked at MOVE_SPEED. The four posts sit exactly on the
 *      ring where the wind starts winning, which makes the way in
 *      post -> haul -> anchor on the Heron -> arrival slash. The grapple loop
 *      IS the damage in this phase.
 *
 *   3  DESPERATION. Back on the deck, faster between blows - but never below
 *      HERON_TELEGRAPH_FLOOR inside one, because "harder" must never mean "less
 *      readable" (section 5). Feather volleys cover the ground the stabs do
 *      not, and once a cycle it goes up for a 90 f dive. Dodge the dive and it
 *      buries its beak in the deck and is yours for three full seconds; that
 *      window is where a first-time player actually wins.
 *
 * It never gets a move whose wind-up the player has not been shown at least
 * once already, and every wind-up in every phase is asserted >= 36 f by the A6
 * gate rather than merely intended to be.
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
  ARENA_RADIUS,
  COIN_DROP_HERON,
  ENEMY_STAGGER,
  FEATHER_DAMAGE,
  FEATHER_RADIUS,
  FEATHER_RANGE,
  FEATHER_SPEED,
  FEATHER_SPREAD,
  HERON,
  HERON_DIVE_COMMIT,
  HERON_DIVE_DAMAGE,
  HERON_DIVE_RADIUS,
  HERON_DIVE_STUN,
  HERON_DIVE_TELEGRAPH,
  HERON_FEATHERS,
  HERON_GUST_DAMAGE,
  HERON_GUST_KNOCKBACK,
  HERON_GUST_RANGE,
  HERON_HASTE,
  HERON_HOVER,
  HERON_PHASE_2,
  HERON_PHASE_3,
  HERON_TELEGRAPH_FLOOR,
  HERON_WIND_CENTRE,
  HERON_WIND_PUSH,
  HITSTOP_HEAVY,
  HITSTOP_KILL,
  HITSTOP_LIGHT,
  KNOCKBACK_PLAYER,
  SQUASH_IMPACT,
  SQUASH_RECOVER,
  TICK_DT,
  TRAUMA_BOSS_SLAM,
  TRAUMA_HIT,
} from '../core/constants';
import { inStrikeHeight } from '../core/hits';
import { makeOutline, material } from '../render/materials';

const TAU = Math.PI * 2;
const TIME_EPS = TICK_DT * 0.5;
const EPS = 1e-4;

/** Body radius for hits and separation. It is the biggest target in the game. */
const BODY_RADIUS = 0.95;
const LEG_HEIGHT = 1.5;
const BODY_Y = LEG_HEIGHT + 0.5;
const NECK_Y = BODY_Y + 0.42;
const NECK_LENGTH = 1.15;
const BEAK_LENGTH = 1.1;
const WING_SPAN = 2.6;

const HURT_FLASH_TIME = 0.12;
const SWELL = 0.06;
const TELL_PULSES = 2;
const TURN_RATE = 1.9; // rad/s - slow, so a flank is always available
/** How far in from the parapet it will walk. It is too big to hug the wall. */
const ROAM_LIMIT = ARENA_RADIUS - 2.6;
/** Stab arc, matching the reach a beak that long advertises. */
const STAB_ARC = Math.PI * 0.3;
const FX_HEIGHT = 1.2;
/** Vertical travel rate between deck and hover, u/s. */
const RISE_RATE = 3.2;
/** Peak of the dive arc above the deck. */
const DIVE_APEX = 6.0;
/** A dive that cannot reach its mark still lands. Guard, not gameplay. */
const DIVE_TIMEOUT = 2.5; // s
/** How far in from the parapet the gust fades out completely. */
const WIND_FADE = 2.5; // u

/** What it is doing. The FSM state says *when*; this says *which*. */
type Move = 'stab' | 'gust' | 'feathers' | 'dive';

/**
 * One cycle per phase, walked in order. A fixed loop rather than a random pick:
 * a boss you can learn is a boss you can beat, and section 5 asks for patterns
 * that reward reading rather than reflexes.
 */
const PATTERN: Record<number, readonly Move[]> = {
  1: ['stab', 'stab', 'gust'],
  2: ['gust'],
  3: ['stab', 'feathers', 'stab', 'dive'],
};

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

interface HeronModel {
  visual: THREE.Group;
  body: THREE.Mesh;
  /** Rotates and extends: the stab is the neck, not the legs. */
  neck: THREE.Group;
  wings: THREE.Group;
  legs: THREE.Group;
  geometries: THREE.BufferGeometry[];
}

/**
 * The silhouette: two hair-thin legs, a small high body, and a neck longer than
 * either. Nothing else in the game is tall and empty in the middle - the frog is
 * a ball, the Knight a column, the Fly a pod - so a Heron is legible at gameplay
 * zoom from its negative space alone.
 */
function buildHeron(): HeronModel {
  const visual = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];

  const legs = new THREE.Group();
  const legGeo = mergeGeometries([
    place(new THREE.CylinderGeometry(0.075, 0.055, LEG_HEIGHT, 5), 0.3, LEG_HEIGHT * 0.5, 0),
    place(new THREE.CylinderGeometry(0.075, 0.055, LEG_HEIGHT, 5), -0.3, LEG_HEIGHT * 0.5, 0),
    // Splayed feet, half-sunk in the flood.
    place(new THREE.BoxGeometry(0.34, 0.07, 0.5), 0.3, 0.04, 0.1),
    place(new THREE.BoxGeometry(0.34, 0.07, 0.5), -0.3, 0.04, 0.1),
  ]);
  const legMesh = new THREE.Mesh(legGeo, material('stoneShade', { flatShading: true }));
  legMesh.castShadow = true;
  legs.add(legMesh);
  visual.add(legs);
  geometries.push(legGeo);

  const bodyGeo = place(
    new THREE.SphereGeometry(0.72, 10, 8),
    0,
    BODY_Y,
    -0.1,
    0.86,
    0.82,
    1.25,
  );
  const body = new THREE.Mesh(bodyGeo, material('hazeSky', { flatShading: true }));
  body.castShadow = true;
  visual.add(body);
  geometries.push(bodyGeo);

  // Tail: the counterweight that stops the neck reading as a mistake.
  const tailGeo = new THREE.ConeGeometry(0.34, 1.1, 6);
  tailGeo.rotateX(-Math.PI * 0.5);
  tailGeo.translate(0, BODY_Y - 0.05, -1.0);
  const tail = new THREE.Mesh(tailGeo, material('ruinCool', { flatShading: true }));
  tail.castShadow = true;
  visual.add(tail);
  geometries.push(tailGeo);

  // The neck pivots at the shoulder and is modelled along +Z, so one rotation
  // takes it from reared-back to fully extended down the frog's throat line.
  const neck = new THREE.Group();
  neck.position.set(0, NECK_Y, 0.1);
  // Cylinders and cones are built along +Y, so each one is laid down onto +Z
  // FIRST and translated afterwards - rotating a piece that has already been
  // moved swings its offset round with it.
  const neckShaft = new THREE.CylinderGeometry(0.14, 0.19, NECK_LENGTH, 6);
  neckShaft.rotateX(Math.PI * 0.5);
  neckShaft.translate(0, 0, NECK_LENGTH * 0.5);
  const neckGeo = mergeGeometries([
    neckShaft,
    // head
    place(new THREE.SphereGeometry(0.2, 8, 6), 0, 0, NECK_LENGTH + 0.08, 1, 1, 1.2),
  ]);
  const neckMesh = new THREE.Mesh(neckGeo, material('hazeSky', { flatShading: true }));
  neckMesh.castShadow = true;
  neck.add(neckMesh);
  geometries.push(neckGeo);

  // The beak is a spear. It is the single most important shape in the fight.
  const beakGeo = new THREE.ConeGeometry(0.12, BEAK_LENGTH, 5);
  beakGeo.rotateX(Math.PI * 0.5);
  beakGeo.translate(0, 0, NECK_LENGTH + 0.2 + BEAK_LENGTH * 0.5);
  const beak = new THREE.Mesh(beakGeo, material('gold', { flatShading: true }));
  beak.castShadow = true;
  neck.add(beak);
  geometries.push(beakGeo);

  const eyeGeo = mergeGeometries([
    place(new THREE.SphereGeometry(0.075, 6, 5), 0.13, 0.08, NECK_LENGTH + 0.1),
    place(new THREE.SphereGeometry(0.075, 6, 5), -0.13, 0.08, NECK_LENGTH + 0.1),
  ]);
  const eyes = new THREE.Mesh(eyeGeo, material('dungeonGlow', { emissive: true }));
  neck.add(eyes);
  geometries.push(eyeGeo);
  visual.add(neck);

  // Wings open for the gust and beat for the hover: one group, two readings.
  const wings = new THREE.Group();
  wings.position.set(0, BODY_Y + 0.12, -0.1);
  const wingGeo = mergeGeometries([
    place(new THREE.SphereGeometry(0.55, 7, 5), WING_SPAN * 0.32, 0, -0.15, 1.9, 0.16, 1.15),
    place(new THREE.SphereGeometry(0.55, 7, 5), -WING_SPAN * 0.32, 0, -0.15, 1.9, 0.16, 1.15),
  ]);
  const wingMesh = new THREE.Mesh(wingGeo, material('ruinCool', { flatShading: true }));
  wingMesh.castShadow = true;
  wings.add(wingMesh);
  visual.add(wings);
  geometries.push(wingGeo);

  const outline = makeOutline(body);
  visual.add(outline);
  geometries.push(outline.geometry);

  return { visual, body, neck, wings, legs, geometries };
}

interface Feather {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  dx: number;
  dz: number;
  left: number;
}

export function createHeron(
  scene: THREE.Scene,
  _level: Level,
  position: THREE.Vector3,
  rng: Rng,
): Enemy {
  const root = new THREE.Group();
  root.name = 'heron';
  const model = buildHeron();
  root.add(model.visual);
  scene.add(root);

  // It walks a flat deck and flies over it, so it owns its own position rather
  // than borrowing the capsule solver. The one containment rule it needs -
  // "stay inside the parapet" - is a clamp, not a collision.
  const deckY = position.y;
  const pos = position.clone();

  const tellMaterial = material('dungeonGlow', { emissive: true, flatShading: true });
  const hurtMaterial = material('heroBelly', { emissive: true, flatShading: true });
  const bodyMaterial = model.body.material as THREE.Material;

  // Feathers are pre-allocated: a volley in the middle of a fight must not
  // allocate, and five meshes is cheaper than an instanced batch this small.
  const featherGeo = new THREE.OctahedronGeometry(FEATHER_RADIUS, 0);
  featherGeo.scale(0.5, 0.5, 2.4);
  const feathers: Feather[] = [];
  for (let i = 0; i < HERON_FEATHERS; i++) {
    const mesh = new THREE.Mesh(featherGeo, material('hazeSky', { emissive: true }));
    mesh.visible = false;
    scene.add(mesh);
    feathers.push({ mesh, x: 0, z: 0, dx: 0, dz: 1, left: 0 });
  }

  const hitDir = new THREE.Vector3();
  const knockDir = new THREE.Vector3(0, 0, 1);
  const wind = new THREE.Vector3();
  const struck = new Set<Damageable>();
  const diveAt = new THREE.Vector3();

  const swayPhase = rng.next() * TAU;

  let state: EnemyStateName = 'idle';
  let stateTime = 0;
  let now = 0;
  let hp = HERON.hp;
  let facing = 0;
  let squash = 1;
  let hurtFlash = 0;
  let staggerFor = ENEMY_STAGGER;
  let phase = 1;
  let move: Move = 'stab';
  let moveIndex = 0;
  /** Height above the deck. Phase 2 and the dive are the only things that fly. */
  let lift = 0;
  let diveLift = 0;
  let ctxRef: GameContext | null = null;

  root.position.copy(pos);

  // ------------------------------------------------------------------ timing

  /**
   * Every wind-up in the fight, run through the one floor that guarantees it is
   * still readable. Phase 3's haste would put a stab at 28.8 f on its own.
   */
  function telegraphFor(which: Move): number {
    if (which === 'dive') return HERON_DIVE_TELEGRAPH;
    const base = HERON.telegraph;
    return phase === 3 ? Math.max(HERON_TELEGRAPH_FLOOR, base * HERON_HASTE) : base;
  }

  function recoveryFor(which: Move): number {
    const base = which === 'dive' ? HERON.recovery * 1.4 : HERON.recovery;
    return phase === 3 ? base * HERON_HASTE : base;
  }

  function phaseFor(fraction: number): number {
    if (fraction > HERON_PHASE_2) return 1;
    if (fraction > HERON_PHASE_3) return 2;
    return 3;
  }

  // ------------------------------------------------------------------- state

  function enter(next: EnemyStateName, duration = ENEMY_STAGGER): void {
    state = next;
    stateTime = 0;
    if (next === 'stagger') staggerFor = duration;
    if (next === 'attack') struck.clear();
  }

  function nextMove(): void {
    const pattern = PATTERN[phase];
    moveIndex = (moveIndex + 1) % pattern.length;
    move = pattern[moveIndex];
  }

  /** A phase change re-reads the pattern from its start and resets the flight. */
  function setPhase(next: number): void {
    if (next === phase) return;
    phase = next;
    moveIndex = 0;
    diveLift = 0;
    move = PATTERN[phase][0];
    // Whatever it was in the middle of, the transition interrupts: a boss that
    // finishes a wind-up you have already answered is a boss that cheats.
    enter('aggro');
    const ctx = ctxRef;
    if (ctx !== null) {
      ctx.addTrauma(TRAUMA_HIT);
      ctx.spawnFx('featherBurst', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z));
    }
  }

  function die(): void {
    state = 'dead';
    stateTime = 0;
    root.visible = false;
    for (const feather of feathers) {
      feather.left = 0;
      feather.mesh.visible = false;
    }
    const ctx = ctxRef;
    if (ctx === null) return;
    ctx.requestHitstop(HITSTOP_KILL * 2);
    ctx.addTrauma(TRAUMA_BOSS_SLAM);
    ctx.spawnFx('featherBurst', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z));
    ctx.spawnFx('heronSlam', new THREE.Vector3(pos.x, deckY, pos.z));
    ctx.dropCoins(COIN_DROP_HERON, new THREE.Vector3(pos.x, deckY, pos.z));
    ctx.setBoss(null);
    ctx.declareVictory();
  }

  // ------------------------------------------------------------------ moves

  function turnToward(target: number, dt: number): void {
    const delta = wrapAngle(target - facing);
    const step = TURN_RATE * dt;
    facing = wrapAngle(facing + Math.max(-step, Math.min(step, delta)));
  }

  /** The beak. A narrow cone straight down the facing, and it reaches. */
  function stab(ctx: GameContext): void {
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive || struck.has(target)) continue;
      // The beak stabs at its own footing. It only ever stabs from the deck,
      // so this is symmetry with the player's own height rule, not a nerf.
      if (!inStrikeHeight(pos.y, target)) continue;
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > HERON.attackRange + target.hurtRadius) continue;
      if (distance > EPS) {
        if (Math.abs(wrapAngle(Math.atan2(dx, dz) - facing)) > STAB_ARC) continue;
        hitDir.set(dx / distance, 0, dz / distance);
      } else {
        hitDir.set(Math.sin(facing), 0, Math.cos(facing));
      }
      struck.add(target);
      target.takeHit({
        damage: HERON.damage,
        knockback: KNOCKBACK_PLAYER,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      });
    }
  }

  /**
   * The wings. A ring, not a cone: it hits everywhere and hurts barely.
   * DELIBERATELY not height-gated: phase 2 gusts from the hover, and the gust
   * is the downdraft reaching the deck - air, not a blade.
   */
  function gust(ctx: GameContext): void {
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive || struck.has(target)) continue;
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > HERON_GUST_RANGE + target.hurtRadius) continue;
      struck.add(target);
      if (distance > EPS) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));
      target.takeHit({
        damage: HERON_GUST_DAMAGE,
        knockback: HERON_GUST_KNOCKBACK,
        direction: hitDir.clone(),
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      });
    }
    ctx.spawnFx('featherBurst', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z));
    ctx.addTrauma(TRAUMA_HIT);
  }

  /** A fan of five, aimed where the frog is standing on the release frame. */
  function volley(ctx: GameContext): void {
    const dx = ctx.player.position.x - pos.x;
    const dz = ctx.player.position.z - pos.z;
    const base = Math.hypot(dx, dz) > EPS ? Math.atan2(dx, dz) : facing;
    for (let i = 0; i < feathers.length; i++) {
      const offset = (i - (feathers.length - 1) * 0.5) * FEATHER_SPREAD;
      const angle = base + offset;
      const feather = feathers[i];
      feather.x = pos.x;
      feather.z = pos.z;
      feather.dx = Math.sin(angle);
      feather.dz = Math.cos(angle);
      feather.left = FEATHER_RANGE;
      feather.mesh.position.set(pos.x, pos.y + FX_HEIGHT, pos.z);
      feather.mesh.rotation.set(0, angle, 0);
      feather.mesh.visible = true;
    }
    ctx.spawnFx('featherBurst', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z));
  }

  function advanceFeathers(ctx: GameContext, dt: number): void {
    const target = ctx.player;
    for (const feather of feathers) {
      if (feather.left <= 0) continue;
      const travel = Math.min(feather.left, FEATHER_SPEED * dt);
      feather.left -= travel;
      feather.x += feather.dx * travel;
      feather.z += feather.dz * travel;
      feather.mesh.position.set(feather.x, pos.y + FX_HEIGHT, feather.z);

      if (target.alive) {
        const dx = target.position.x - feather.x;
        const dz = target.position.z - feather.z;
        // Feathers fly a flat line at the deck the volley left from.
        if (
          inStrikeHeight(deckY, target) &&
          Math.hypot(dx, dz) <= FEATHER_RADIUS + target.hurtRadius
        ) {
          hitDir.set(feather.dx, 0, feather.dz);
          target.takeHit({
            damage: FEATHER_DAMAGE,
            knockback: KNOCKBACK_PLAYER * 0.5,
            direction: hitDir.clone(),
            hitstop: HITSTOP_LIGHT,
            source: 'enemy',
          });
          feather.left = 0;
        }
      }
      // Nothing leaves the arena: a feather that outlives the deck is litter.
      if (Math.hypot(feather.x, feather.z) > ARENA_RADIUS + 1) feather.left = 0;
      if (feather.left <= 0) feather.mesh.visible = false;
    }
  }

  /**
   * The dive lands. Whether anything was under it decides the next three
   * seconds: a hit and it recovers normally, a miss and its beak is in the deck.
   */
  function slam(ctx: GameContext): void {
    let landed = false;
    for (const target of ctx.damageablesFor('enemy')) {
      if (!target.alive) continue;
      // The dive lands ON the deck; a frog standing above the blast is clear.
      if (!inStrikeHeight(diveAt.y, target)) continue;
      const dx = target.position.x - diveAt.x;
      const dz = target.position.z - diveAt.z;
      const distance = Math.hypot(dx, dz);
      if (distance > HERON_DIVE_RADIUS + target.hurtRadius) continue;
      if (distance > EPS) hitDir.set(dx / distance, 0, dz / distance);
      else hitDir.set(Math.sin(facing), 0, Math.cos(facing));
      if (
        target.takeHit({
          damage: HERON_DIVE_DAMAGE,
          knockback: KNOCKBACK_PLAYER * 1.6,
          direction: hitDir.clone(),
          hitstop: HITSTOP_HEAVY,
          source: 'enemy',
        })
      ) {
        landed = true;
      }
    }
    ctx.spawnFx('heronSlam', new THREE.Vector3(diveAt.x, deckY, diveAt.z));
    ctx.addTrauma(TRAUMA_BOSS_SLAM);
    ctx.requestHitstop(HITSTOP_HEAVY);
    if (landed) enter('recover');
    // Dodged: the beak is stuck, and the punish window is the longest in the
    // game by a factor of ten. This is the fight's answer to itself.
    else enter('stagger', HERON_DIVE_STUN);
  }

  /**
   * Phase 2's air. Outward from wherever the Heron is standing, hardest at the
   * middle. It is applied to the player's own controller so the wall, the
   * parapet and the ledge all still stop it - a shove that could push the frog
   * through geometry would be a shove that broke the room.
   */
  function blow(ctx: GameContext, dt: number): void {
    const player = ctx.player;
    if (!player.alive) return;
    // A haul and a roll are both commitments the player has already paid for.
    if (player.state === 'tonguePull' || player.state === 'roll') return;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= EPS) return;
    const t = Math.min(1, distance / ARENA_RADIUS);
    // Dies away at the parapet. Without the taper the gale keeps pushing after
    // the frog has run out of arena, and it walks the frog straight out through
    // the doorway in the far wall and onto the ledge behind - out of the fight
    // entirely, with the Heron standing in an empty room. The rim is where you
    // get your breath back; it is not a place the wind can reach you.
    const edge = Math.max(0, Math.min(1, (ARENA_RADIUS - distance) / WIND_FADE));
    const speed = HERON_WIND_PUSH * (1 + (HERON_WIND_CENTRE - 1) * (1 - t)) * edge;
    if (speed <= EPS) return;
    wind.set((dx / distance) * speed * dt, 0, (dz / distance) * speed * dt);
    player.controller.move(wind, dt);
  }

  // ------------------------------------------------------------------ think

  function walkToward(x: number, z: number, speed: number, dt: number): void {
    const dx = x - pos.x;
    const dz = z - pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= EPS) return;
    const step = Math.min(distance, speed * dt);
    pos.x += (dx / distance) * step;
    pos.z += (dz / distance) * step;
    const radius = Math.hypot(pos.x, pos.z);
    if (radius > ROAM_LIMIT) {
      pos.x *= ROAM_LIMIT / radius;
      pos.z *= ROAM_LIMIT / radius;
    }
  }

  /** True once the current move has something to swing at. */
  function ready(distance: number): boolean {
    switch (move) {
      case 'stab':
        return distance <= HERON.attackRange;
      case 'gust':
        return distance <= HERON_GUST_RANGE;
      case 'feathers':
        // A zoning move. Fired into someone's face it is a shotgun, and five
        // feathers at point-blank is most of the frog's health for a wind-up
        // it shares with everything else - so up close it simply is not the
        // move, and the Heron reaches for the beak instead.
        return distance > HERON.attackRange && distance <= FEATHER_RANGE;
      case 'dive':
        return true;
    }
  }

  function think(ctx: GameContext, dt: number): void {
    const player = ctx.player;
    const dx = player.position.x - pos.x;
    const dz = player.position.z - pos.z;
    const distance = Math.hypot(dx, dz);
    const toPlayer = distance > EPS ? Math.atan2(dx, dz) : facing;

    advanceFeathers(ctx, dt);
    if (phase === 2 && state !== 'dead') blow(ctx, dt);

    // Phase 2 holds the middle; the others come to you. A dive owns its own
    // height outright rather than easing toward one, so the arc it draws in the
    // air is the arc the 90 f tell promised.
    if (move === 'dive' && (state === 'telegraph' || state === 'attack')) {
      lift = diveLift;
    } else {
      const wantLift = phase === 2 ? HERON_HOVER : 0;
      const gap = wantLift - lift;
      lift += Math.max(-RISE_RATE * dt, Math.min(RISE_RATE * dt, gap));
    }

    switch (state) {
      case 'idle': {
        if (player.alive && distance <= HERON.aggroRange) enter('aggro');
        break;
      }

      case 'aggro': {
        if (!player.alive) {
          enter('idle');
          break;
        }
        turnToward(toPlayer, dt);
        if (phase === 2) {
          // It does not chase in phase 2. It stands in the middle and waits for
          // the wind to do the work.
          walkToward(0, 0, HERON.moveSpeed, dt);
          if (Math.hypot(pos.x, pos.z) < 0.6 && ready(distance)) enter('telegraph');
          break;
        }
        if (!ready(distance)) {
          // Too close for the move it had queued: take the next one rather
          // than backing off to make room for a bad idea.
          if (move === 'feathers' && distance <= HERON.attackRange) {
            nextMove();
            break;
          }
          walkToward(player.position.x, player.position.z, HERON.moveSpeed, dt);
          break;
        }
        // A stab from behind its own shoulder would be unreadable, so it only
        // commits once it is actually looking at you.
        if (move !== 'stab' || Math.abs(wrapAngle(toPlayer - facing)) < STAB_ARC) {
          enter('telegraph');
        }
        break;
      }

      case 'telegraph': {
        const window = telegraphFor(move);
        // The dive tracks for HERON_DIVE_COMMIT of its tell and then locks, so
        // the dodge is a real decision made against a real, fixed target.
        if (move === 'dive') {
          if (stateTime < window * HERON_DIVE_COMMIT) {
            turnToward(toPlayer, dt);
            diveAt.set(player.position.x, deckY, player.position.z);
          }
          diveLift = DIVE_APEX * Math.min(1, stateTime / (window * HERON_DIVE_COMMIT));
        } else if (move !== 'stab') {
          // Everything but the stab keeps tracking: those are area moves and
          // pretending otherwise would only make them look broken.
          turnToward(toPlayer, dt);
        }
        if (stateTime >= window - TIME_EPS) {
          enter('attack');
          if (move === 'feathers') volley(ctx);
          if (move === 'gust') gust(ctx);
        }
        break;
      }

      case 'attack': {
        if (move === 'stab') stab(ctx);
        if (move === 'dive') {
          // Down the arc it committed to, fast, and it lands where it aimed.
          const gap = Math.hypot(diveAt.x - pos.x, diveAt.z - pos.z);
          const speed = HERON.moveSpeed * 4.0;
          if (gap > EPS) {
            const step = Math.min(gap, speed * dt);
            pos.x += ((diveAt.x - pos.x) / gap) * step;
            pos.z += ((diveAt.z - pos.z) / gap) * step;
          }
          diveLift = Math.max(0, diveLift - DIVE_APEX * dt * 3.4);
          // The timeout is a guard, not a rule: a dive that somehow cannot
          // reach its mark still has to land, or the fight stops.
          if ((diveLift <= EPS && gap <= 0.35) || stateTime > DIVE_TIMEOUT) {
            diveLift = 0;
            slam(ctx);
          }
          break;
        }
        if (stateTime >= HERON.active - TIME_EPS) enter('recover');
        break;
      }

      case 'recover': {
        if (stateTime >= recoveryFor(move) - TIME_EPS) {
          nextMove();
          enter('aggro');
        }
        break;
      }

      case 'stagger': {
        // Nothing pushes a Heron. It is too heavy to move and that is the point
        // of it - a stagger is time, not distance.
        if (stateTime >= staggerFor - TIME_EPS) {
          nextMove();
          enter('aggro');
        }
        break;
      }

      case 'dead':
        break;
    }
  }

  // ---------------------------------------------------------------- present

  function present(dt: number): void {
    hurtFlash = Math.max(0, hurtFlash - dt);
    squash += (1 - squash) * Math.min(1, SQUASH_RECOVER * dt);

    root.position.set(pos.x, deckY + lift, pos.z);
    root.rotation.set(0, facing, Math.sin(now * 0.9 + swayPhase) * 0.02);
    model.visual.scale.set(1, squash, 1);
    // Legs fold up the moment it leaves the deck: a wading bird in the air is a
    // different silhouette entirely, and phase 2 has to read at a glance.
    model.legs.scale.setScalar(lift > 0.2 ? 0.35 : 1);

    // The neck: reared right back through a stab's wind-up, whipped through the
    // active frames. Same frame data as the hitbox, so the tell cannot drift.
    let neckAngle = -0.35;
    let wingOpen = 0.1;
    if (state === 'telegraph') {
      const t = Math.min(1, stateTime / telegraphFor(move));
      if (move === 'stab') neckAngle = -0.35 - t * 1.15;
      if (move === 'gust' || move === 'feathers') wingOpen = 0.1 + t * 1.25;
      if (move === 'dive') {
        neckAngle = -0.35 - t * 0.6;
        wingOpen = 0.1 + t * 1.5;
      }
    } else if (state === 'attack') {
      if (move === 'stab') {
        neckAngle = -1.5 + Math.min(1, stateTime / HERON.active) * 2.2;
      } else if (move === 'dive') {
        neckAngle = 1.1;
        wingOpen = 1.4;
      } else {
        wingOpen = 1.35 - Math.min(1, stateTime / HERON.active) * 1.25;
      }
    } else if (state === 'stagger') {
      // Beak in the deck. The stun has to be as obvious as the dive was.
      neckAngle = 1.25;
      wingOpen = -0.2;
    }
    model.neck.rotation.x = neckAngle;
    model.wings.rotation.z = 0;
    model.wings.rotation.x = wingOpen * 0.15;
    const beat = lift > 0.2 ? Math.sin(now * 9.0) * 0.35 : 0;
    model.wings.scale.set(1, 1, 1);
    model.wings.rotation.z = beat;
    model.wings.children[0].scale.set(1 + wingOpen * 0.35, 1, 1);

    let swell = 0;
    if (state === 'telegraph') {
      const t = Math.min(1, stateTime / telegraphFor(move));
      swell = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * TELL_PULSES));
      model.body.material = tellMaterial;
    } else if (hurtFlash > 0) {
      model.body.material = hurtMaterial;
      swell = hurtFlash / HURT_FLASH_TIME;
    } else {
      model.body.material = bodyMaterial;
    }
    model.body.scale.setScalar(1 + swell * SWELL);
  }

  // ------------------------------------------------------------------ hooks

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
    const ctx = ctxRef;
    if (ctx !== null) {
      ctx.spawnFx('hitSpark', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT, pos.z), knockDir.clone());
    }
    if (hp <= 0) {
      die();
      return true;
    }
    // It does not flinch. A boss that staggers on every blow has no phases,
    // only interruptions - so damage changes the PHASE and nothing else.
    setPhase(phaseFor(hp / HERON.hp));
    return true;
  }

  /**
   * Heavy: the frog is the one that travels. This is the row of section 4's
   * table that has had no user until now, and the whole reason phase 2 works.
   */
  function onTongue(_from: THREE.Vector3, ctx: GameContext): TongueOutcome {
    if (state === 'dead') return 'none';
    ctx.spawnFx('tongueHit', new THREE.Vector3(pos.x, pos.y + FX_HEIGHT * 0.7, pos.z));
    return 'anchor';
  }

  function carryTo(_position: THREE.Vector3): void {
    /* nothing carries a Heron */
  }

  function release(_dir: THREE.Vector3 | null, _ctx: GameContext): void {
    /* nothing carries a Heron */
  }

  const self: Enemy = {
    root,
    kind: 'heron',
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
      return HERON.mass;
    },
    get held(): boolean {
      return false;
    },
    get hurtRadius(): number {
      return BODY_RADIUS;
    },
    // Feet to the crown of the standing neck. On the deck the whole column is
    // inside a sword's window; hovering lifts the feet past STRIKE_REACH_UP
    // and only the arrival slash's tall window can follow it up.
    get hurtHeight(): number {
      return NECK_Y + 0.6;
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
      // The body rides at deck + lift; feathers and FX read pos.y, so keep it
      // honest rather than tracking two heights.
      pos.y = deckY + lift;
      think(ctx, dt);
      present(dt);
    },

    dispose(): void {
      root.removeFromParent();
      for (const feather of feathers) feather.mesh.removeFromParent();
      featherGeo.dispose();
      for (const geometry of model.geometries) geometry.dispose();
    },
  };

  return self;
}
