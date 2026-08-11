/**
 * CROAK - world assembly and the service seam. PROMPT.md sections 1 and 5.
 *
 * Every subsystem is built here, wired to the others only through GameContext,
 * and torn down here. Nothing in this file has an opinion about gameplay: if a
 * number appears below it is a wiring detail, never a tunable.
 *
 * THE CLOCK SPLIT IS THE LOAD-BEARING DECISION IN THIS FILE.
 *   step()   runs on fixed sim dt and owns the world: player, enemies, culling.
 *            Hitstop simply stops calling it, which is what freezing means.
 *   render() runs once per rendered frame on loop.realDelta and owns everything
 *            that must survive a freeze: particles, HUD paper, camera follow and
 *            shake (section 5: "particles keep running"; section 9 rule 7: sim
 *            time is not wall clock). Driving those from the sim would stall the
 *            impact frame's own feedback for the length of its own hitstop.
 */

import * as THREE from 'three';
import type {
  Damageable,
  Enemy,
  FxKind,
  GameContext,
  Level,
  Loop,
  Rng,
} from './core/types';
import { DEFAULT_SEED, PLAYER_HP_MAX, RESPAWN_DELAY } from './core/constants';
import { createInput } from './core/input';
import { createLoop } from './core/loop';
import { createRng } from './core/rng';
import { createFx } from './render/fx';
import { createLighting } from './render/lighting';
import { disposeMaterials } from './render/materials';
import { createRenderer } from './render/renderer';
import { createCameraRig } from './world/camera';
import { createLevel } from './world/level';
import { createPlayer } from './entities/player';
import { createSporeling } from './entities/sporeling';
import { createHud } from './ui/hud';

export interface Game {
  readonly ctx: GameContext;
  readonly loop: Loop;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly seed: number;
  start(): void;
  stop(): void;
  /** Fires after each rendered frame. Returns its own unsubscribe. */
  onFrame(listener: () => void): () => void;
  /** Fires after each simulation step. Returns its own unsubscribe. */
  onStep(listener: () => void): () => void;
  dispose(): void;
}

type EnemyFactory = (
  scene: THREE.Scene,
  level: Level,
  position: THREE.Vector3,
  rng: Rng,
) => Enemy;

/** SpawnPoint.type is authored data, so the mapping is data too. */
const ENEMY_FACTORIES: Record<string, EnemyFactory | undefined> = {
  sporeling: createSporeling,
};

export function createGame(
  canvasParent: HTMLElement,
  hudParent: HTMLElement | null,
  seed: number = DEFAULT_SEED,
): Game {
  // One recorded seed, forked per subsystem. Forks hash against the root seed
  // rather than its draw count, so adding a system here never reshuffles the
  // spawns of the ones already wired (section 10's determinism gate).
  const rng = createRng(seed);

  const rendererKit = createRenderer(canvasParent);
  const renderer = rendererKit.renderer;
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  scene.name = 'croak';

  // lighting owns scene.fog and scene.background; nothing else may assign them.
  const lighting = createLighting(scene);

  const level = createLevel(rng);
  scene.add(level.root);

  const cameraRig = createCameraRig(viewportWidth(), viewportHeight());
  // Pointer buttons belong to the canvas; keys, blur and pad stay on window.
  const input = createInput(canvas);
  const hud = createHud(hudParent, rng);
  const fx = createFx(scene, rng);
  const player = createPlayer(scene, level, rng);

  const enemies: Enemy[] = [];

  /**
   * Forks are keyed on the spawn's identity, not on a draw count, so refilling
   * the meadow after a death replays exactly the same enemies (section 10's
   * determinism gate) instead of walking the root stream forward.
   */
  function spawnEnemies(): void {
    for (let i = 0; i < level.spawns.length; i++) {
      const spawn = level.spawns[i];
      const make = ENEMY_FACTORIES[spawn.type];
      if (make === undefined) continue;
      enemies.push(
        make(scene, level, spawn.position, rng.fork(`spawn:${spawn.type}:${i}`)),
      );
    }
  }

  spawnEnemies();

  const loop = createLoop({ step, render });

  /** The player is the only thing an enemy can hit, and it never changes. */
  const enemyTargets: Damageable[] = [player];

  const ctx: GameContext = {
    scene,
    cameraRig,
    input,
    rng,
    loop,
    level,
    player,
    enemies,
    hud,

    addTrauma(amount: number): void {
      cameraRig.addTrauma(amount);
    },

    /** One hitstop channel for the whole game; the loop takes the max. */
    requestHitstop(seconds: number): void {
      loop.requestHitstop(seconds);
    },

    spawnFx(kind: FxKind, position: THREE.Vector3, dir?: THREE.Vector3): void {
      fx.spawn(kind, position, dir);
    },

    damageablesFor(source: 'player' | 'enemy'): Damageable[] {
      if (source === 'enemy') return enemyTargets;
      // A fresh list, not a shared scratch one: a swing that kills its target
      // mutates `enemies` while the attacker is still walking this array.
      const targets: Damageable[] = [];
      for (const enemy of enemies) {
        if (enemy.alive) targets.push(enemy);
      }
      return targets;
    },
  };

  // ------------------------------------------------------------- frame hooks

  const frameListeners = new Set<() => void>();
  const stepListeners = new Set<() => void>();

  /** Snapshotted: a one-shot listener unsubscribing itself is the normal case. */
  function emit(listeners: Set<() => void>): void {
    if (listeners.size === 0) return;
    for (const listener of Array.from(listeners)) listener();
  }

  // -------------------------------------------------------------------- tick

  let pumpedFrame = -1;
  /** Seconds the frog has been down, driving the A1 respawn. */
  let deadFor = 0;

  /**
   * The input buffer ages on wall time and must be pumped exactly once per
   * rendered frame, before the first step of that frame. The loop hands us two
   * callbacks and no frame hook, so whichever of them runs first in a given
   * frame does the pumping - and on a frame with zero steps (hitstop, or a
   * display faster than 60 Hz) render() still ages the buffer on schedule.
   *
   * The buffer's clock stops for the length of a freeze. It measures the
   * player's reaction time, and during hitstop the player is looking at a
   * frozen frame while claimVerbs() is not running: ageing it there would let a
   * kill freeze (117 ms of a 150 ms buffer) silently eat a press that was made
   * before the impact - pressed roll, saw the freeze, got nothing (rule 8).
   */
  function pumpInput(): void {
    if (loop.frameCount === pumpedFrame) return;
    pumpedFrame = loop.frameCount;
    input.update(loop.hitstopRemaining > 0 ? 0 : loop.realDelta);
  }

  function cullDead(): void {
    for (let i = enemies.length - 1; i >= 0; i--) {
      const enemy = enemies[i];
      if (enemy.alive) continue;
      enemy.dispose();
      enemies.splice(i, 1);
    }
  }

  /**
   * Death is a pause, not an ending. A1 stands the frog back up where it
   * started and refills the meadow; A2 swaps this for shrines and the coin
   * ghost. Without it an unattended slice ends face-down and stays there.
   */
  function tickRespawn(dt: number): void {
    if (player.alive) {
      deadFor = 0;
      return;
    }
    deadFor += dt;
    if (deadFor < RESPAWN_DELAY) return;
    deadFor = 0;
    player.respawn(level.playerStart);
    for (const enemy of enemies) enemy.dispose();
    enemies.length = 0;
    spawnEnemies();
  }

  function step(dt: number): void {
    pumpInput();

    player.update(dt, ctx);
    for (const enemy of enemies) enemy.update(dt, ctx);
    cullDead();
    tickRespawn(dt);

    // The HUD is told the truth every step and animates toward it on its own
    // clock, so a hit that lands during a freeze is already on the paper when
    // the freeze ends.
    hud.setStamina(player.stamina);
    hud.setHp(player.hp, PLAYER_HP_MAX);
    hud.setZeroStaminaPenalty(player.zeroStaminaPenalty);

    emit(stepListeners);
  }

  /**
   * `alpha` is unused on purpose: entities write their own transforms inside
   * update(), so there is no pair of simulation states to blend between. The
   * smoothing the player actually sees is the rig's damped follow, which runs
   * here on real time and is therefore already frame-rate independent.
   */
  function render(_alpha: number): void {
    pumpInput();
    const dt = loop.realDelta;

    fx.update(dt);
    hud.update(dt);
    cameraRig.update(dt, player.position, input.isDown('lockon'));
    // The shadow frustum has to be current for the frame being drawn, not the
    // one before it, or the fitted 30x30 box lags the frog by a frame.
    lighting.update(player.position);

    renderer.render(scene, cameraRig.camera);
    emit(frameListeners);
  }

  // ------------------------------------------------------------------ layout

  function viewportWidth(): number {
    return Math.max(1, canvasParent.clientWidth);
  }

  function viewportHeight(): number {
    return Math.max(1, canvasParent.clientHeight);
  }

  function applyViewport(): void {
    const width = viewportWidth();
    const height = viewportHeight();
    rendererKit.resize(width, height);
    cameraRig.resize(width, height);
  }

  // One observer, not a window listener plus a DPR watcher: the canvas parent
  // is the only box that matters, and remounting must not leave a second one.
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(applyViewport);
  if (observer === null) window.addEventListener('resize', applyViewport);
  else observer.observe(canvasParent);

  applyViewport();

  return {
    ctx,
    loop,
    renderer,
    canvas,
    seed,

    start(): void {
      loop.start();
    },

    stop(): void {
      loop.stop();
    },

    onFrame(listener: () => void): () => void {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },

    onStep(listener: () => void): () => void {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },

    /**
     * Teardown order is the build order reversed: entities release their
     * geometry, then the kit releases the shared materials and ramps they were
     * pointing at, then the renderer drops the context. Doing the middle step
     * first would strip materials out from under meshes that still exist.
     */
    dispose(): void {
      loop.stop();

      if (observer === null) window.removeEventListener('resize', applyViewport);
      else observer.disconnect();

      frameListeners.clear();
      stepListeners.clear();

      input.dispose();
      hud.dispose();
      fx.dispose();

      for (const enemy of enemies) enemy.dispose();
      enemies.length = 0;
      player.dispose();

      level.dispose();
      level.root.removeFromParent();
      lighting.dispose();

      disposeMaterials();
      scene.clear();
      rendererKit.dispose();
    },
  };
}
