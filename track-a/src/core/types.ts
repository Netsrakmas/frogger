/**
 * CROAK - shared contracts.
 *
 * Every subsystem is written against these interfaces. Three.js objects are
 * VIEWS; game state is data (PROMPT.md section 1). Nothing here holds logic.
 */

import type * as THREE from 'three';
import type { WeaponId } from './constants';

// --------------------------------------------------------------------- input

export type Action =
  | 'roll'
  | 'attack'
  | 'tongue'
  | 'lockon'
  | 'interact'
  | 'block'
  /** Open and close the manual. It pauses the world while it is up. */
  | 'manual';

export interface InputSystem {
  /** Called once per rendered frame with real (unscaled) delta. */
  update(realDt: number): void;
  /** Raw stick, length clamped to 1, in screen space (x right, z down). */
  readonly moveX: number;
  readonly moveZ: number;
  /** True while held. */
  isDown(action: Action): boolean;
  /**
   * True if the action was pressed within INPUT_BUFFER of now, and consumes
   * the buffered press so it cannot fire twice.
   */
  consume(action: Action): boolean;
  /** Discard a buffered press without acting on it. */
  clear(action: Action): void;
  /** Test-only injection (gated behind the test hook). */
  injectPress(action: Action): void;
  injectRelease(action: Action): void;
  injectMove(x: number, z: number): void;
  dispose(): void;
}

// ----------------------------------------------------------------------- rng

export interface Rng {
  readonly seed: number;
  /** [0, 1) */
  next(): number;
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Independent stream, so adding a call site never shifts other streams. */
  fork(label: string): Rng;
}

// ---------------------------------------------------------------------- loop

export interface Loop {
  /** Accumulated simulation time in seconds. Frozen during hitstop. */
  readonly simTime: number;
  /** Wall-clock time since loop start. Never frozen. */
  readonly presentTime: number;
  /** Real seconds since last rendered frame. Never scaled. */
  readonly realDelta: number;
  /** Interpolation factor [0,1) between the last two simulation states. */
  readonly alpha: number;
  readonly frameCount: number;
  /** Smoothed frames per second over the last second. */
  readonly fps: number;
  readonly hitstopRemaining: number;
  requestHitstop(seconds: number): void;
  /** True while the world is stopped outright - the manual, later the menu. */
  readonly paused: boolean;
  setPaused(value: boolean): void;
  start(): void;
  stop(): void;
}

// -------------------------------------------------------------------- camera

export interface CameraRig {
  readonly camera: THREE.OrthographicCamera;
  /**
   * Map screen-space stick input to a world-space direction on the ground
   * plane, so "up" is always away from the viewer regardless of zone yaw.
   */
  relativeMove(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  update(dt: number, target: THREE.Vector3, lockOn: boolean): void;
  /** Trauma is added, never set. Shake is trauma^2, rotational-only. */
  addTrauma(amount: number): void;
  readonly trauma: number;
  resize(width: number, height: number): void;
  /** Per-zone camera yaw override (authored, never player-controlled). */
  setYaw(yaw: number): void;
}

// --------------------------------------------------------------------- world

export interface SpawnPoint {
  type: string;
  position: THREE.Vector3;
  yaw: number;
}

/** An authored reward spot. `occluded` ones are hidden by the camera itself. */
export interface SecretSpot {
  id: string;
  occluded: boolean;
  position: THREE.Vector3;
}

/** The demo has two: the meadow you start in and the tower under it. */
export type ZoneId = 'downs' | 'belfry' | 'arena';

export interface Level {
  readonly id: ZoneId;
  readonly root: THREE.Group;
  /** Merged, invisible collision mesh carrying a BVH. */
  readonly collider: THREE.Mesh;
  readonly spawns: SpawnPoint[];
  readonly playerStart: THREE.Vector3;
  readonly secrets: SecretSpot[];
  /** Where the frog arrives when it walks in from somewhere else. */
  readonly entries: Record<string, THREE.Vector3>;
  /** Zones with moving parts (the belfry's water) drive them here. */
  update?(dt: number, ctx: GameContext): void;
  dispose(): void;
}

export interface CharacterController {
  readonly position: THREE.Vector3;
  readonly grounded: boolean;
  readonly velocityY: number;
  /**
   * Resolve `displacement` against the level collider (capsule shapecast),
   * apply gravity/step/slope rules, and write the result into `position`.
   */
  move(displacement: THREE.Vector3, dt: number): void;
  teleport(to: THREE.Vector3): void;
}

// ------------------------------------------------------------------- combat

export interface HitInfo {
  damage: number;
  knockback: number;
  /** Unit vector from attacker toward victim, on the ground plane. */
  direction: THREE.Vector3;
  hitstop: number;
  source: 'player' | 'enemy';
}

export interface Damageable {
  readonly position: THREE.Vector3;
  readonly hurtRadius: number;
  /**
   * Vertical extent of the hurt volume, measured up from `position` (which is
   * always a FOOT position). Unset means core/constants HURT_HEIGHT; only the
   * genuinely tall (the Heron) declare their own.
   */
  readonly hurtHeight?: number;
  readonly alive: boolean;
  /** Returns true if the hit actually landed (false when i-framed or dead). */
  takeHit(hit: HitInfo): boolean;
}

// ------------------------------------------------------------------ entities

export interface Entity {
  readonly root: THREE.Object3D;
  readonly alive: boolean;
  update(dt: number, ctx: GameContext): void;
  dispose(): void;
}

export type PlayerStateName =
  | 'idle'
  | 'move'
  | 'roll'
  | 'attack'
  | 'hitstun'
  | 'dead'
  /** Tongue out: extending, latched, or reeling back in. */
  | 'tongue'
  /** Latched onto something immovable and being hauled toward it. */
  | 'tonguePull';

export interface Player extends Entity, Damageable {
  readonly state: PlayerStateName;
  /** 0..1 */
  readonly stamina: number;
  readonly hp: number;
  readonly invulnerable: boolean;
  /** True while the bar is empty: incoming damage x ZERO_STAMINA_DMG_MULT. */
  readonly zeroStaminaPenalty: boolean;
  /** Yaw in radians. */
  readonly facing: number;
  readonly controller: CharacterController;
  readonly weapon: WeaponId;
  /** The enemy a hard lock is held on, or null when free-aiming. */
  readonly lockTarget: Damageable | null;
  readonly lockedOn: boolean;
  /** The enemy currently in the frog's mouth, if any. */
  readonly carrying: Enemy | null;
  /** 0 while the tongue is stowed, else how far out it is in world units. */
  readonly tongueReach: number;
  /** Guard up. Only possible once the Shield has been found. */
  readonly blocking: boolean;
  equip(weapon: WeaponId): void;
  /** Restore to full and stand up at `at`, clearing every in-flight action. */
  respawn(at: THREE.Vector3): void;
}

export type EnemyStateName =
  | 'idle'
  | 'aggro'
  | 'telegraph'
  | 'attack'
  | 'recover'
  | 'stagger'
  | 'dead';

/** Drives the tongue's mass rule (PROMPT.md section 4). */
export type MassClass = 'light' | 'medium' | 'heavy';

/**
 * What the tongue did when it arrived:
 *   held   - lighter than the frog, so it comes to you and you carry it
 *   yanked - too heavy to lift, but it can be dragged off balance
 *   anchor - heavier than you are, so YOU go to IT
 *   none   - nothing happened (already dying, already held)
 */
export type TongueOutcome = 'held' | 'yanked' | 'anchor' | 'none';

export interface Enemy extends Entity, Damageable {
  readonly state: EnemyStateName;
  readonly hp: number;
  readonly kind: string;
  /** Yaw in radians. Which way a guard's shield points is gameplay, not decor. */
  readonly facing: number;
  readonly mass: MassClass;
  readonly held: boolean;
  /** The tongue reached it; the enemy applies its own mass rule and reports. */
  onTongue(from: THREE.Vector3, ctx: GameContext): TongueOutcome;
  /** While held, the frog owns where it is. */
  carryTo(position: THREE.Vector3): void;
  /** Let go. With a direction it is thrown, and a thrown body hurts what it hits. */
  release(dir: THREE.Vector3 | null, ctx: GameContext): void;
}

/**
 * Something in the way. Bramble yields to an edge; the belfry door yields to a
 * key. Both are locks whose key is a thing you had to go and find.
 */
export interface Gate extends Entity {
  readonly id: string;
  readonly kind: 'bramble' | 'door';
  readonly position: THREE.Vector3;
  readonly open: boolean;
  /** Collision is withdrawn the moment it opens. */
  readonly blocking: boolean;
  inRange(from: THREE.Vector3): boolean;
  /** A blow landed on it. Returns true if this one actually did something. */
  strike(damage: number, cuts: boolean, ctx: GameContext): boolean;
  /** Try to unlock with a key. */
  unlock(ctx: GameContext): boolean;
  /** Opened by a mechanism rather than by the player. No key, no edge. */
  release(ctx: GameContext): void;
  /** Ground-plane radius the frog is pushed out of while this is shut. */
  readonly blockRadius: number;
}

/**
 * A switch too far away to touch. Yanking it with the tongue is the point:
 * levers sit across water the frog cannot cross, so the verb IS the solution.
 */
export interface Lever extends Entity {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly on: boolean;
  /** Throw it. Mechanisms watch the set of levers, not the individual pull. */
  pull(ctx: GameContext): void;
}

/**
 * A fixed point the tongue can haul the frog to. Section 4: grapple posts chain
 * across water gaps, and arriving with momentum feeds an attack.
 */
export interface GrapplePost extends Entity {
  readonly id: string;
  readonly position: THREE.Vector3;
  /** Lights up while it is the tongue's current candidate. */
  setHighlighted(active: boolean): void;
}

// ------------------------------------------------------------ world objects

export type PickupKind = 'coin' | 'ghost' | 'weapon' | 'page' | 'key' | 'shield';

export interface Pickup extends Entity {
  readonly kind: PickupKind;
  readonly position: THREE.Vector3;
  /** Coins carried: 1 for a loose coin, the whole purse for a ghost. */
  readonly value: number;
  /**
   * The tongue caught it: come to the frog from wherever you are, ignoring the
   * usual magnet range. Section 4's top row - free delight, no balance cost.
   */
  lure(): void;
}

export interface Shrine extends Entity {
  readonly id: string;
  readonly position: THREE.Vector3;
  /** True once this shrine has been rested at - it is a respawn point now. */
  readonly claimed: boolean;
  inRange(from: THREE.Vector3): boolean;
  /** Light it and make it the checkpoint. Idempotent. */
  claim(): void;
  /** Drives the resting flourish; the rest itself is the game's job. */
  pulse(): void;
}

/** The run's carried state. Death moves coins out of it and into a ghost. */
export interface Progress {
  readonly coins: number;
  add(amount: number): void;
  /** Removes up to `amount` and returns what was actually taken. */
  take(amount: number): number;
  /** Manual pages found, by index. A7 turns these into the booklet. */
  readonly pages: readonly number[];
  addPage(index: number): void;
  readonly keys: number;
  addKey(): void;
  /** The belfry's Shield. Once found it is never lost. */
  readonly hasShield: boolean;
  grantShield(): void;
  /** True if a key was available and has now been spent on a door. */
  spendKey(): boolean;
}

// ------------------------------------------------------------------------ fx

export type FxKind =
  | 'rollDust'
  | 'hitSpark'
  | 'sporePuff'
  | 'footstep'
  | 'landDust'
  /** A blow turned by the Beetle Guard's shield: sparks, no blood. */
  | 'guardSpark'
  | 'coinPop'
  | 'shrineRest'
  /** The tongue latching onto something solid. */
  | 'tongueHit'
  /** Bramble giving way to an edge. */
  | 'brambleCut'
  /** Arrival slash at the end of a grapple pull - the Death's Door move. */
  | 'lungeSlash'
  /** The Heron's dive slamming into the arena floor. */
  | 'heronSlam'
  | 'featherBurst';

// ------------------------------------------------------------------------ ui

export type ToastIcon = 'coins' | 'weapon' | 'rested' | 'page' | 'key' | 'shield';

export interface Hud {
  readonly root: HTMLElement;
  setStamina(value01: number): void;
  setHp(current: number, max: number): void;
  setZeroStaminaPenalty(active: boolean): void;
  setCoins(count: number): void;
  setWeapon(weapon: WeaponId): void;
  setLockedOn(active: boolean): void;
  /** The boss bar. `max` of 0 hides it. */
  setBoss(name: string, current: number, max: number): void;
  /** The end of the demo: pages found out of the total placed. */
  showEnding(pages: number, total: number): void;
  /**
   * A drawn acknowledgement that fades: what you got, and how many. Icons and
   * numerals only - the build ships no font, and the world does the teaching.
   */
  toast(icon: ToastIcon, count?: number): void;
  /** Uses presentTime, so it keeps animating during hitstop. */
  update(dt: number): void;
  dispose(): void;
}

// ------------------------------------------------------------------- context

/**
 * The service seam. Systems never import each other directly; they reach
 * across through this.
 */
export interface GameContext {
  readonly scene: THREE.Scene;
  readonly cameraRig: CameraRig;
  readonly input: InputSystem;
  readonly rng: Rng;
  readonly loop: Loop;
  readonly level: Level;
  readonly player: Player;
  readonly enemies: Enemy[];
  /** Coins, ghosts and unclaimed weapons on the ground. A3's tongue reads it. */
  readonly pickups: Pickup[];
  readonly shrines: Shrine[];
  readonly grapplePosts: GrapplePost[];
  readonly gates: Gate[];
  readonly levers: Lever[];
  readonly hud: Hud;
  readonly progress: Progress;
  addTrauma(amount: number): void;
  requestHitstop(seconds: number): void;
  /** Tear down this zone and build the other one, arriving at `entry`. */
  changeZone(zone: ZoneId, entry: string): void;
  spawnFx(kind: FxKind, position: THREE.Vector3, dir?: THREE.Vector3): void;
  /** Scatter `amount` coins at `position` - how a dying enemy pays out. */
  dropCoins(amount: number, position: THREE.Vector3): void;
  /** Set by the boss so the HUD and the ending can read it. Null when none. */
  readonly boss: Enemy | null;
  setBoss(enemy: Enemy | null): void;
  /** The demo is over and won. */
  readonly victory: boolean;
  declareVictory(): void;
  /** Every Damageable that can receive a player hit right now. */
  damageablesFor(source: 'player' | 'enemy'): Damageable[];
}

// -------------------------------------------------------------- test harness

export interface GameSample {
  simTime: number;
  presentTime: number;
  frameCount: number;
  fps: number;
  playerState: PlayerStateName;
  stamina: number;
  hp: number;
  invulnerable: boolean;
  zeroStaminaPenalty: boolean;
  playerPos: [number, number, number];
  facing: number;
  grounded: boolean;
  enemiesAlive: number;
  weapon: WeaponId;
  lockedOn: boolean;
  tongueReach: number;
  carrying: string | null;
  coins: number;
  pickups: number;
  ghosts: number;
  shrinesClaimed: number;
  pages: number;
  /** The booklet: up or not, and which spread it is showing. */
  manualOpen: boolean;
  manualSpread: number;
  /** The opening letter: still up, or read/suppressed. */
  letterOpen: boolean;
  paused: boolean;
  /** Whether the post chain is running. A8's readability check turns it off. */
  post: boolean;
  keys: number;
  hasShield: boolean;
  blocking: boolean;
  bossHp: number;
  bossPhase: number;
  victory: boolean;
  gatesOpen: number;
  zone: ZoneId;
  trauma: number;
  hitstopRemaining: number;
  drawCalls: number;
  triangles: number;
  programs: number;
}

/**
 * Gated test API (only attached with ?test=1 or in dev). Never shipped as
 * visible UI - PROMPT.md section 9 rule 12.
 */
export interface EnemySnapshot {
  kind: string;
  state: EnemyStateName;
  hp: number;
  facing: number;
  alive: boolean;
  pos: [number, number, number];
}

export interface ShrineSnapshot {
  id: string;
  claimed: boolean;
  pos: [number, number, number];
}

export interface PickupSnapshot {
  kind: PickupKind;
  value: number;
  pos: [number, number, number];
}

export interface TestApi {
  readonly threeRevision: string;
  readonly ready: boolean;
  press(action: Action): void;
  release(action: Action): void;
  /** Tap = press + release on the next frame. */
  tap(action: Action): void;
  setMove(x: number, z: number): void;
  /** Resolves after `n` rendered frames. */
  frames(n: number): Promise<void>;
  sample(): GameSample;
  /** Per-frame trace of the last N frames, for feel-gate assertions. */
  trace(): GameSample[];
  startTrace(): void;
  stopTrace(): void;
  /** Force-damage the player from a direction, to measure i-frames. */
  /**
   * Force a blow onto the player. `fromAngle` is the world heading the blow
   * ARRIVES FROM, so a guard test can put it in front of the shield or behind
   * it; omitted, it keeps the fixed default direction.
   */
  probeHit(damage?: number, fromAngle?: number): boolean;
  teleportPlayer(x: number, y: number, z: number): void;
  enemies(): EnemySnapshot[];
  shrines(): ShrineSnapshot[];
  posts(): ShrineSnapshot[];
  gates(): { id: string; kind: string; open: boolean; pos: [number, number, number] }[];
  levers(): { id: string; on: boolean; pos: [number, number, number] }[];
  secrets(): { id: string; occluded: boolean; pos: [number, number, number] }[];
  /**
   * Is this point hidden from the fixed camera by level geometry? Cast along
   * the camera's own view axis - the only honest way to ask whether a "secret
   * behind something" really is behind something.
   */
  hiddenFromCamera(x: number, y: number, z: number): boolean;
  pickupList(): PickupSnapshot[];
  /**
   * World signage, found by walking the scene graph. `strokes` counts the
   * triangles of the carved-writing mesh ONLY (the one sign.ts names
   * `signWriting`), so a sign that says nothing reports 0 - the slab and its
   * outline never count.
   */
  signs(): { id: string; pos: [number, number, number]; strokes: number }[];
  /** Turn the whole post chain on or off, live. */
  setPost(enabled: boolean): void;
  /**
   * Take the leaf canopy away. It is never drawn, so the only way to prove the
   * dapple on the ground is its shadow is to remove it and watch the ground go
   * flat.
   */
  setCanopy(enabled: boolean): void;
  /**
   * Pin the cloud drift to a fixed moment (null resumes the clock). The drift
   * runs on present time, which a screenshot cannot schedule itself against -
   * so the gate schedules the sky against the screenshot instead, and can
   * hunt for a phase that puts a cloud over a known patch of ground.
   */
  setCanopyPhase(time: number | null): void;
  /** Bloom alone, so it can be measured without the rest of the chain moving. */
  setBloom(enabled: boolean): void;
  /**
   * Stop the simulation dead while rendering continues - the manual's pause
   * without the manual. Two screenshots taken inside a freeze differ only by
   * whatever render-side switch was flipped between them, which is the only
   * honest way to photograph an effect on a world that otherwise never stops
   * moving.
   */
  setFrozen(enabled: boolean): void;
}

declare global {
  interface Window {
    __croak?: TestApi;
  }
}
