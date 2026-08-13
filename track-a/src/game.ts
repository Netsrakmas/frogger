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
  Entity,
  FxKind,
  GameContext,
  Level,
  Loop,
  Pickup,
  Progress,
  Gate,
  GrapplePost,
  Rng,
  Lever,
  Shrine,
  ZoneId,
} from './core/types';
import {
  DEATH_COIN_DROP,
  HERON,
  PAGE_TOTAL,
  SECRET_COINS,
  DEFAULT_SEED,
  PLAYER_HP_MAX,
  RESPAWN_DELAY,
} from './core/constants';
import { createInput } from './core/input';
import { createLoop } from './core/loop';
import { createRng } from './core/rng';
import { createFx } from './render/fx';
import { createLighting } from './render/lighting';
import { disposeMaterials } from './render/materials';
import { createRenderer } from './render/renderer';
import type { PostKit } from './render/post';
import { createPost } from './render/post';
import type { Canopy } from './render/canopy';
import { createCanopy } from './render/canopy';
import { createCameraRig } from './world/camera';
import { createZone } from './world/zones';
import { createLever } from './world/lever';
import { createPlayer } from './entities/player';
import { createSporeling } from './entities/sporeling';
import { createBeetleGuard } from './entities/beetle';
import { createSpitterFly } from './entities/spitter';
import { createDrownedKnight } from './entities/knight';
import { createHeron } from './entities/heron';
import { createToken } from './entities/pickup';
import { createGate } from './world/gate';
import { createCoin, createGhost, createWeaponPickup } from './entities/pickup';
import { createShrine } from './world/shrine';
import { createGrapplePost } from './world/grapple';
import { createSign } from './world/sign';
import { createHud } from './ui/hud';
import type { Manual } from './ui/manual';
import { createManual } from './ui/manual';
import { createTouchControls } from './ui/touch';

export interface Game {
  readonly ctx: GameContext;
  /** The booklet, exposed so the test hook can read it without a DOM query. */
  readonly manual: Manual;
  /** The post chain, exposed so the gate can turn it off and look again. */
  readonly post: PostKit;
  /** The leaf canopy, exposed for the same reason. */
  readonly canopy: Canopy;
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
  beetleGuard: createBeetleGuard,
  spitterFly: createSpitterFly,
  drownedKnight: createDrownedKnight,
  heron: createHeron,
};

/**
 * Which door leads where. A transition is authored data, not a special case
 * buried in the tick: a door is a way through only if this table says so, and
 * both zones name the arrival point the other one uses.
 */
interface Doorway {
  gate: string;
  to: ZoneId;
  entry: string;
}

const DOORWAYS: Record<ZoneId, readonly Doorway[]> = {
  downs: [{ gate: 'belfry', to: 'belfry', entry: 'downs' }],
  // The vault door the sluice puzzle opens is the way up onto the roof.
  belfry: [{ gate: 'vault', to: 'arena', entry: 'belfry' }],
  // The arena is the end of the demo. There is nowhere else to be.
  arena: [],
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

  let level = createZone(rng, 'downs');
  scene.add(level.root);

  const cameraRig = createCameraRig(viewportWidth(), viewportHeight());
  const post = createPost(renderer, scene, cameraRig.camera);
  // Pointer buttons belong to the canvas; keys, blur and pad stay on window.
  const input = createInput(canvas);
  const hud = createHud(hudParent, rng);
  // The booklet. It is its own overlay above the HUD and it pauses the world.
  const manual = createManual(hudParent, rng);
  // Mounts only on a coarse pointer; on a desktop this is inert and invisible.
  const touch = createTouchControls(hudParent, input);
  const fx = createFx(scene, rng);
  // Never drawn, always casting: the dapple on the ground is a real shadow.
  const canopy = createCanopy(scene, rng);
  const player = createPlayer(scene, level, rng);

  const enemies: Enemy[] = [];
  const pickups: Pickup[] = [];
  const shrines: Shrine[] = [];
  const grapplePosts: GrapplePost[] = [];
  const gates: Gate[] = [];
  const levers: Lever[] = [];
  /** Signage. It has no behaviour, but it still has to be torn down. */
  const signs: Entity[] = [];

  /**
   * Forks are keyed on the spawn's identity, not on a draw count, so refilling
   * a zone after a death replays exactly the same enemies (section 10's
   * determinism gate) instead of walking the root stream forward.
   */
  function spawnEnemies(): void {
    for (let i = 0; i < level.spawns.length; i++) {
      const spawn = level.spawns[i];
      const make = ENEMY_FACTORIES[spawn.type];
      if (make === undefined) continue;
      // A shrine refills a zone, and after the win that must not put the Heron
      // back on its feet - resting in a cleared arena is a rest, not a rematch.
      if (spawn.type === 'heron' && victory) continue;
      const enemy = make(
        scene,
        level,
        spawn.position,
        rng.fork(`spawn:${level.id}:${spawn.type}:${i}`),
      );
      enemies.push(enemy);
      if (spawn.type === 'heron') boss = enemy;
    }
  }
  /** The ghost currently owed to the player. Dying again abandons it for good. */
  let ghost: Pickup | null = null;
  let coins = 0;
  const pages: number[] = [];
  let keys = 0;
  let hasShield = false;
  /** The Heron, while it is standing. The HUD and the ending both read it. */
  let boss: Enemy | null = null;
  let victory = false;

  /** Everything in a zone that is not an enemy. Torn down by teardownWorld. */
  function spawnProps(): void {
  for (const spawn of level.spawns) {
    if (spawn.type.startsWith('shrine:')) {
      shrines.push(
        createShrine(scene, spawn.type.slice('shrine:'.length), spawn.position),
      );
    } else if (spawn.type.startsWith('grapple:')) {
      grapplePosts.push(
        createGrapplePost(scene, spawn.type.slice('grapple:'.length), spawn.position),
      );
    } else if (spawn.type.startsWith('bramble:')) {
      gates.push(
        createGate(scene, spawn.type.slice('bramble:'.length), 'bramble', spawn.position, spawn.yaw),
      );
    } else if (spawn.type.startsWith('door:')) {
      gates.push(
        createGate(scene, spawn.type.slice('door:'.length), 'door', spawn.position, spawn.yaw),
      );
    } else if (spawn.type.startsWith('page:')) {
      pickups.push(
        createToken(scene, spawn.position, 'page', Number(spawn.type.slice('page:'.length))),
      );
    } else if (spawn.type === 'secretCoins') {
      // A secret's payout is real coins on the ground, so finding one reads
      // exactly like winning a fight rather than like a menu event.
      for (let n = 0; n < SECRET_COINS; n++) {
        pickups.push(createCoin(scene, spawn.position, rng.fork(`secret:${spawn.type}:${n}`)));
      }
    } else if (spawn.type === 'key') {
      pickups.push(createToken(scene, spawn.position, 'key'));
    } else if (spawn.type === 'sword') {
      pickups.push(createWeaponPickup(scene, spawn.position, 'sword'));
    } else if (spawn.type === 'shield') {
      pickups.push(createToken(scene, spawn.position, 'shield'));
    } else if (spawn.type.startsWith('sign:')) {
      signs.push(
        createSign(scene, spawn.type.slice('sign:'.length), spawn.position, spawn.yaw),
      );
    } else if (spawn.type.startsWith('lever:')) {
      levers.push(createLever(scene, spawn.type.slice('lever:'.length), spawn.position));
    } else if (spawn.type.startsWith('sluice:')) {
      gates.push(
        createGate(scene, spawn.type.slice('sluice:'.length), 'door', spawn.position, spawn.yaw),
      );
    }
  }
  }

  spawnEnemies();
  spawnProps();

  /** Queued so a zone never changes underneath a loop that is still walking it. */
  let pendingZone: { zone: ZoneId; entry: string } | null = null;
  /**
   * Doorways the frog has walked clear of since they opened. Without this you
   * arrive on top of the trigger you just used and bounce straight back
   * through it.
   */
  const armedDoorways = new Set<string>();

  const progress: Progress = {
    get coins(): number {
      return coins;
    },
    add(amount: number): void {
      coins = Math.max(0, coins + Math.max(0, Math.round(amount)));
    },
    take(amount: number): number {
      const taken = Math.min(coins, Math.max(0, Math.round(amount)));
      coins -= taken;
      return taken;
    },
    get pages(): readonly number[] {
      return pages;
    },
    addPage(index: number): void {
      if (!pages.includes(index)) pages.push(index);
    },
    get keys(): number {
      return keys;
    },
    addKey(): void {
      keys++;
    },
    get hasShield(): boolean {
      return hasShield;
    },
    grantShield(): void {
      hasShield = true;
    },
    spendKey(): boolean {
      if (keys <= 0) return false;
      keys--;
      return true;
    },
  };

  /** Where the frog wakes up. Moves to whichever shrine was last rested at. */
  let checkpoint = level.playerStart.clone();

  const loop = createLoop({ step, render, whilePaused });

  /** The player is the only thing an enemy can hit, and it never changes. */
  const enemyTargets: Damageable[] = [player];

  const ctx: GameContext = {
    scene,
    cameraRig,
    input,
    rng,
    loop,
    get level(): Level {
      return level;
    },
    player,
    enemies,
    pickups,
    shrines,
    grapplePosts,
    gates,
    levers,
    hud,
    progress,

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

    changeZone(zone: ZoneId, entry: string): void {
      if (level.id === zone) return;
      pendingZone = { zone, entry };
    },

    get boss(): Enemy | null {
      return boss;
    },

    setBoss(enemy: Enemy | null): void {
      boss = enemy;
    },

    get victory(): boolean {
      return victory;
    },

    /**
     * The Heron is down. The reward is not a menu: the last manual page appears
     * on the ledge behind the arena - somewhere the player has been able to
     * walk the whole time and has had no reason to - and the tally card comes
     * up without taking the frame, so going and getting it is still playable.
     */
    declareVictory(): void {
      if (victory) return;
      victory = true;
      const spot = level.entries.victoryPage;
      if (spot !== undefined) {
        pickups.push(createToken(scene, spot.clone(), 'page', PAGE_TOTAL - 1));
      }
    },

    dropCoins(amount: number, position: THREE.Vector3): void {
      for (let i = 0; i < amount; i++) {
        pickups.push(createCoin(scene, position, rng.fork(`coin:${coinSerial++}`)));
      }
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
  /** Seconds the frog has been down, before the last shrine takes it back. */
  let deadFor = 0;
  /** Distinct rng streams per coin, so a payout is deterministic per kill. */
  let coinSerial = 0;
  /** Pages the booklet has been told about, so a new one triggers the reveal. */
  let shownPages = 0;
  /** Whether the CURRENT pause is the manual's, so it only clears its own. */
  let manualOwnsPause = false;

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

  function teardownWorld(): void {
    for (const enemy of enemies) enemy.dispose();
    enemies.length = 0;
    for (const pickup of pickups) pickup.dispose();
    pickups.length = 0;
    ghost = null;
    for (const shrine of shrines) shrine.dispose();
    shrines.length = 0;
    for (const post of grapplePosts) post.dispose();
    grapplePosts.length = 0;
    for (const gate of gates) gate.dispose();
    gates.length = 0;
    for (const lever of levers) lever.dispose();
    levers.length = 0;
    for (const sign of signs) sign.dispose();
    signs.length = 0;
  }

  /**
   * The zone swap. Everything the old zone owned goes, the new one is built,
   * and the frog is stood at the named entry - which is always somewhere it can
   * see where it came from, so a transition never disorients.
   */
  function applyZoneChange(zone: ZoneId, entry: string): void {
    teardownWorld();
    boss = null;
    level.dispose();

    level = createZone(rng, zone);
    scene.add(level.root);
    spawnEnemies();
    spawnProps();

    const arrival = level.entries[entry] ?? level.playerStart;
    checkpoint = arrival.clone();
    player.respawn(arrival);
    armedDoorways.clear();
  }

  /**
   * Doors are two-way once open. Standing in one sends you through; you have to
   * step off it before it will take you again.
   *
   * ARMING IS PER DOOR, AND A SHUT DOOR NEVER ARMS. Both halves matter. A
   * single shared flag armed by "no open door in reach" means the frame a key
   * turns is the frame you are thrown through the door you were standing at to
   * unlock it: you never see it open, and a scripted walkthrough reads it as
   * still locked because it is already in the next zone asking the wrong world.
   * Keying the flag on the door itself also stops one open door across the map
   * from arming a different one under the frog's feet.
   */
  function tickTransitions(): void {
    if (!player.alive) return;
    for (const doorway of DOORWAYS[level.id]) {
      const door = gates.find((gate) => gate.id === doorway.gate);
      if (door === undefined) continue;
      if (!door.open) {
        armedDoorways.delete(doorway.gate);
        continue;
      }
      if (!door.inRange(player.position)) {
        armedDoorways.add(doorway.gate);
        continue;
      }
      if (!armedDoorways.has(doorway.gate)) continue;
      armedDoorways.delete(doorway.gate);
      ctx.changeZone(doorway.to, doorway.entry);
      return;
    }
  }

  function refillEnemies(): void {
    for (const enemy of enemies) enemy.dispose();
    enemies.length = 0;
    spawnEnemies();
  }

  /**
   * Resting: full heal, and the regular enemies come back with you. Claiming
   * the shrine moves the checkpoint, so where you last sat down is where death
   * returns you to.
   */
  function rest(shrine: Shrine): void {
    shrine.claim();
    shrine.pulse();
    checkpoint = shrine.position.clone();
    player.respawn(checkpoint);
    refillEnemies();
    hud.toast('rested');
    fx.spawn('shrineRest', shrine.position.clone());
  }

  function tickShrines(dt: number): void {
    for (const shrine of shrines) shrine.update(dt, ctx);
    for (const post of grapplePosts) post.update(dt, ctx);
    for (const gate of gates) gate.update(dt, ctx);
    if (!player.alive || !input.consume('interact')) return;
    // One interact button, resolved by what is nearest to hand.
    for (const shrine of shrines) {
      if (!shrine.inRange(player.position)) continue;
      rest(shrine);
      return;
    }
    for (const gate of gates) {
      if (!gate.blocking || !gate.inRange(player.position)) continue;
      if (gate.unlock(ctx)) return;
    }
  }

  /**
   * Death costs the purse. What you were carrying is left standing where you
   * fell and you get exactly one walk back to it - dying again while a ghost is
   * still out there is what loses those coins for good (section 5, DEATH).
   */
  function die(): void {
    const lost = progress.take(DEATH_COIN_DROP);
    if (ghost !== null) {
      ghost.dispose();
      const index = pickups.indexOf(ghost);
      if (index >= 0) pickups.splice(index, 1);
      ghost = null;
    }
    if (lost > 0) {
      ghost = createGhost(scene, player.position.clone(), lost);
      pickups.push(ghost);
    }
  }

  function tickRespawn(dt: number): void {
    if (player.alive) {
      deadFor = 0;
      return;
    }
    // The drop happens once, on the frame the frog goes down.
    if (deadFor === 0) die();
    deadFor += dt;
    if (deadFor < RESPAWN_DELAY) return;
    deadFor = 0;
    player.respawn(checkpoint);
    refillEnemies();
  }

  function tickPickups(dt: number): void {
    for (let i = pickups.length - 1; i >= 0; i--) {
      const pickup = pickups[i];
      pickup.update(dt, ctx);
      if (pickup.alive) continue;
      if (pickup === ghost) ghost = null;
      pickup.dispose();
      pickups.splice(i, 1);
    }
  }

  /** Presses queued while reaching for (or reading) the book are not swings. */
  function clearVerbBuffers(): void {
    input.clear('attack');
    input.clear('tongue');
    input.clear('roll');
    input.clear('interact');
  }

  /**
   * The booklet's own input, read on BOTH clocks: from inside a step while the
   * game is running, and from the loop's paused callback while it is not. The
   * pause switches the simulation off, so the one verb that can undo it cannot
   * live in the simulation.
   *
   * THE PAUSE FOLLOWS THE BOOK'S TRANSITIONS, not only the toggle press. The
   * book has two other ways to change state - the page-pickup reveal opens it,
   * and a tap on the overlay closes it - and a pause that only tracked the
   * keyboard toggle left both of those drifting: the reveal froze the world
   * while simTime kept counting, and a tap-close left the loop paused with the
   * book gone. The sync is EDGE-triggered rather than written every frame, so
   * a pause the manual does not own (the test hook's freeze) is left alone.
   */
  function tickManual(): boolean {
    if (input.consume('manual')) {
      manual.toggle();
      clearVerbBuffers();
    }
    if (manual.open !== manualOwnsPause) {
      manualOwnsPause = manual.open;
      loop.setPaused(manual.open);
    }
    if (!manual.open) return false;
    // Section 7's spread is a thing you READ, and a boss that kept swinging
    // while you did would make reading it a punishment.
    if (input.consume('attack')) manual.turn(1);
    if (input.consume('tongue')) manual.turn(-1);
    return true;
  }

  function whilePaused(_realDt: number): void {
    pumpInput();
    tickManual();
    // Deliberately no stepListeners: a paused frame is not a simulation step,
    // and a feel trace that recorded them would be measuring the reader.
  }

  function step(dt: number): void {
    pumpInput();
    if (tickManual()) return;

    player.update(dt, ctx);
    for (const enemy of enemies) enemy.update(dt, ctx);
    cullDead();
    tickPickups(dt);
    tickShrines(dt);
    for (const lever of levers) lever.update(dt, ctx);
    level.update?.(dt, ctx);
    tickTransitions();
    tickRespawn(dt);

    // Deferred to the end of the step: nothing above is still holding a
    // reference into the arrays a swap is about to empty.
    if (pendingZone !== null) {
      const { zone, entry } = pendingZone;
      pendingZone = null;
      applyZoneChange(zone, entry);
    }

    // The HUD is told the truth every step and animates toward it on its own
    // clock, so a hit that lands during a freeze is already on the paper when
    // the freeze ends.
    hud.setStamina(player.stamina);
    hud.setHp(player.hp, PLAYER_HP_MAX);
    hud.setZeroStaminaPenalty(player.zeroStaminaPenalty);
    hud.setCoins(progress.coins);
    hud.setWeapon(player.weapon);
    hud.setLockedOn(player.lockedOn);

    // A page arriving opens the booklet on the spread it belongs to - the
    // full-screen reveal section 7 asks for, and the moment the player sees
    // how many gaps are left.
    if (progress.pages.length !== shownPages) {
      shownPages = progress.pages.length;
      manual.setFound(progress.pages);
      manual.reveal(progress.pages[progress.pages.length - 1]);
      // The reveal is an OPEN, and an open pauses - same contract as the
      // toggle. Setting it here rather than waiting for the next tickManual
      // means not a single extra sim step leaks past the reveal frame.
      manualOwnsPause = true;
      loop.setPaused(true);
      clearVerbBuffers();
    }

    // Told every step rather than on a change: the bar has to survive a zone
    // swap, a death and a rest without anyone remembering to put it back.
    if (boss !== null && boss.alive) hud.setBoss(boss.kind, boss.hp, HERON.hp);
    else hud.setBoss('', 0, 0);
    if (victory) hud.showEnding(progress.pages.length, PAGE_TOTAL);

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
    // Counters are reset here rather than by three, once per FRAME, so a
    // measurement taken between frames covers the shadow pass, the scene and
    // every post pass together. See renderer.ts.
    renderer.info.reset();
    const dt = loop.realDelta;

    fx.update(dt);
    hud.update(dt);
    cameraRig.update(dt, player.position, player.lockedOn);
    // The shadow frustum has to be current for the frame being drawn, not the
    // one before it, or the fitted 30x30 box lags the frog by a frame.
    lighting.update(player.position);
    // Present time, not sim: the wind does not stop for a hitstop.
    canopy.update(loop.presentTime, player.position);

    post.render(scene, cameraRig.camera);
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
    post.setSize(width, height);
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
    manual,
    post,
    canopy,
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
      touch.dispose();
      manual.dispose();
      hud.dispose();
      fx.dispose();

      teardownWorld();
      player.dispose();
      canopy.dispose();
      post.dispose();

      level.dispose();
      level.root.removeFromParent();
      lighting.dispose();

      disposeMaterials();
      scene.clear();
      rendererKit.dispose();
    },
  };
}
