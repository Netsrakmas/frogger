/**
 * CROAK - shared contracts.
 *
 * Every subsystem is written against these interfaces. Three.js objects are
 * VIEWS; game state is data (PROMPT.md section 1). Nothing here holds logic.
 */

import type * as THREE from 'three';
import type { WeaponId } from './constants';

// --------------------------------------------------------------------- input

export type Action = 'roll' | 'attack' | 'tongue' | 'lockon' | 'interact';

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

export interface Level {
  readonly root: THREE.Group;
  /** Merged, invisible collision mesh carrying a BVH. */
  readonly collider: THREE.Mesh;
  readonly spawns: SpawnPoint[];
  readonly playerStart: THREE.Vector3;
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
  | 'dead';

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

export interface Enemy extends Entity, Damageable {
  readonly state: EnemyStateName;
  readonly hp: number;
  readonly kind: string;
  /** Yaw in radians. Which way a guard's shield points is gameplay, not decor. */
  readonly facing: number;
}

// ------------------------------------------------------------ world objects

export type PickupKind = 'coin' | 'ghost' | 'weapon';

export interface Pickup extends Entity {
  readonly kind: PickupKind;
  readonly position: THREE.Vector3;
  /** Coins carried: 1 for a loose coin, the whole purse for a ghost. */
  readonly value: number;
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
  | 'shrineRest';

// ------------------------------------------------------------------------ ui

export type ToastIcon = 'coins' | 'weapon' | 'rested';

export interface Hud {
  readonly root: HTMLElement;
  setStamina(value01: number): void;
  setHp(current: number, max: number): void;
  setZeroStaminaPenalty(active: boolean): void;
  setCoins(count: number): void;
  setWeapon(weapon: WeaponId): void;
  setLockedOn(active: boolean): void;
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
  readonly hud: Hud;
  readonly progress: Progress;
  addTrauma(amount: number): void;
  requestHitstop(seconds: number): void;
  spawnFx(kind: FxKind, position: THREE.Vector3, dir?: THREE.Vector3): void;
  /** Scatter `amount` coins at `position` - how a dying enemy pays out. */
  dropCoins(amount: number, position: THREE.Vector3): void;
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
  coins: number;
  pickups: number;
  ghosts: number;
  shrinesClaimed: number;
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
  probeHit(damage?: number): boolean;
  teleportPlayer(x: number, y: number, z: number): void;
  enemies(): EnemySnapshot[];
  shrines(): ShrineSnapshot[];
  pickupList(): PickupSnapshot[];
}

declare global {
  interface Window {
    __croak?: TestApi;
  }
}
