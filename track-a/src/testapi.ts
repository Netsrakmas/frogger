/**
 * CROAK - the gated test harness hook. PROMPT.md section 10.
 *
 * The feel gate measures frame windows ("i-frames span roll frames 1..14",
 * "a press 140 ms early still fires"), so every verb here drives the REAL
 * input system through its injection path and every measurement is taken from
 * the live objects. There is no shortcut into the state machines: a harness
 * that bypasses game logic can only ever prove things about itself.
 *
 * Attached only in dev or with ?test=1, and never rendered - section 9 rule 12.
 */

import * as THREE from 'three';
import type { Action, GameSample, HitInfo, TestApi } from './core/types';
import {
  HERON,
  HERON_PHASE_2,
  HERON_PHASE_3,
  HITSTOP_LIGHT,
  KNOCKBACK_PLAYER,
  LIGHT_ATK,
} from './core/constants';
import { THREE_REVISION } from './render/renderer';
import type { Game } from './game';

/** 20 s of simulation at 60 Hz - longer than any single feel-gate window. */
/** Far enough back along the view axis to start outside any level geometry. */
const CAMERA_PROBE_BACKOFF = 60;
const TRACE_CAP = 1200;

/**
 * Probe hits always arrive from the same direction, so a measured i-frame
 * window is a property of the roll and not of where the prober stood.
 */
const PROBE_DIRECTION = new THREE.Vector3(1, 0, 0);

export function createTestApi(game: Game): TestApi {
  const ctx = game.ctx;
  const scratch = new THREE.Vector3();

  const ring: GameSample[] = new Array<GameSample>(TRACE_CAP);
  let filled = 0;
  let head = 0;
  let recording = false;

  function enemies() {
    return ctx.enemies.map((enemy) => ({
      kind: enemy.kind,
      state: enemy.state,
      hp: enemy.hp,
      facing: enemy.facing,
      alive: enemy.alive,
      pos: [enemy.position.x, enemy.position.y, enemy.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function shrines() {
    return ctx.shrines.map((shrine) => ({
      id: shrine.id,
      claimed: shrine.claimed,
      pos: [shrine.position.x, shrine.position.y, shrine.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function posts() {
    return ctx.grapplePosts.map((post) => ({
      id: post.id,
      claimed: false,
      pos: [post.position.x, post.position.y, post.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function gates() {
    return ctx.gates.map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      open: gate.open,
      pos: [gate.position.x, gate.position.y, gate.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function secrets() {
    return ctx.level.secrets.map((secret) => ({
      id: secret.id,
      occluded: secret.occluded,
      pos: [secret.position.x, secret.position.y, secret.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  const camDir = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();

  function hiddenFromCamera(x: number, y: number, z: number): boolean {
    const camera = ctx.cameraRig.camera;
    camera.getWorldDirection(camDir);
    // Orthographic: every eye ray is parallel to the view axis, so back off
    // along it far enough to start outside the world and look inward.
    rayOrigin.set(x, y, z).addScaledVector(camDir, -CAMERA_PROBE_BACKOFF);
    raycaster.set(rayOrigin, camDir);
    raycaster.far = CAMERA_PROBE_BACKOFF - 0.25;
    const hits = raycaster.intersectObject(ctx.level.collider, false);
    return hits.length > 0;
  }

  function levers() {
    return ctx.levers.map((lever) => ({
      id: lever.id,
      on: lever.on,
      pos: [lever.position.x, lever.position.y, lever.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function pickupList() {
    return ctx.pickups.map((pickup) => ({
      kind: pickup.kind,
      value: pickup.value,
      pos: [pickup.position.x, pickup.position.y, pickup.position.z] as [
        number,
        number,
        number,
      ],
    }));
  }

  function bossPhase(): number {
    const boss = ctx.boss;
    if (boss === null || !boss.alive) return 0;
    const fraction = boss.hp / HERON.hp;
    if (fraction > HERON_PHASE_2) return 1;
    if (fraction > HERON_PHASE_3) return 2;
    return 3;
  }

  /**
   * Signage, read off the scene graph rather than from a registry: a sign the
   * player can walk up to is an object in the world, and that is the thing
   * worth asserting exists.
   */
  function signs() {
    const out: { id: string; pos: [number, number, number]; strokes: number }[] = [];
    ctx.scene.traverse((object) => {
      if (!object.name.startsWith('sign:')) return;
      // Only the mesh sign.ts names as the carving counts. An earlier version
      // excluded children[0] and counted the rest, which swept the outline
      // hull in - so a sign with EMPTY text still reported strokes, and the
      // one property this probe exists for was never actually measured.
      let strokes = 0;
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh !== true || child.name !== 'signWriting') return;
        const position = mesh.geometry.getAttribute('position');
        // Non-indexed box soup: three vertices per triangle.
        if (position !== undefined) strokes += position.count / 3;
      });
      const world = object.getWorldPosition(new THREE.Vector3());
      out.push({
        id: object.name.slice('sign:'.length),
        pos: [world.x, world.y, world.z],
        strokes,
      });
    });
    return out;
  }

  function sample(): GameSample {
    const player = ctx.player;
    const boss = ctx.boss;
    const position = player.position;
    const info = game.renderer.info;

    let enemiesAlive = 0;
    for (const enemy of ctx.enemies) {
      if (enemy.alive) enemiesAlive++;
    }

    return {
      simTime: ctx.loop.simTime,
      presentTime: ctx.loop.presentTime,
      frameCount: ctx.loop.frameCount,
      fps: ctx.loop.fps,
      playerState: player.state,
      stamina: player.stamina,
      hp: player.hp,
      invulnerable: player.invulnerable,
      zeroStaminaPenalty: player.zeroStaminaPenalty,
      playerPos: [position.x, position.y, position.z],
      facing: player.facing,
      grounded: player.controller.grounded,
      enemiesAlive,
      weapon: player.weapon,
      lockedOn: player.lockedOn,
      tongueReach: player.tongueReach,
      carrying: player.carrying === null ? null : player.carrying.kind,
      coins: ctx.progress.coins,
      pickups: ctx.pickups.length,
      ghosts: ctx.pickups.filter((pickup) => pickup.kind === 'ghost').length,
      shrinesClaimed: ctx.shrines.filter((shrine) => shrine.claimed).length,
      pages: ctx.progress.pages.length,
      manualOpen: game.manual.open,
      manualSpread: game.manual.spread,
      paused: ctx.loop.paused,
      post: game.post.enabled,
      keys: ctx.progress.keys,
      gatesOpen: ctx.gates.filter((gate) => gate.open).length,
      zone: ctx.level.id,
      hasShield: ctx.progress.hasShield,
      blocking: ctx.player.blocking,
      // The bar's own numbers. `bossPhase` is DERIVED from health here rather
      // than read off the boss, so the A6 gate never proves a phase by asking
      // the boss which phase it thinks it is in - it proves phases by watching
      // what the fight actually does (where it stands, whether it dives).
      bossHp: boss === null || !boss.alive ? 0 : boss.hp,
      bossPhase: bossPhase(),
      victory: ctx.victory,
      trauma: ctx.cameraRig.trauma,
      hitstopRemaining: ctx.loop.hitstopRemaining,
      // Counted for the frame just rendered: three resets these per render(),
      // and the harness always reads them between frames.
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs === null ? 0 : info.programs.length,
    };
  }

  // One sample per SIMULATION step, not per frame: the gate counts frames of
  // roll, and a display running at 144 Hz would otherwise smear 14 sim frames
  // across 34 samples.
  game.onStep(() => {
    if (!recording) return;
    ring[head] = sample();
    head = (head + 1) % TRACE_CAP;
    if (filled < TRACE_CAP) filled++;
  });

  return {
    threeRevision: THREE_REVISION,

    /** True once the game has actually put a frame on screen. */
    get ready(): boolean {
      return ctx.loop.frameCount > 0;
    },

    press(action: Action): void {
      ctx.input.injectPress(action);
    },

    release(action: Action): void {
      ctx.input.injectRelease(action);
    },

    tap(action: Action): void {
      ctx.input.injectPress(action);
      const off = game.onFrame(() => {
        off();
        ctx.input.injectRelease(action);
      });
    },

    setMove(x: number, z: number): void {
      ctx.input.injectMove(x, z);
    },

    frames(n: number): Promise<void> {
      const wanted = Math.max(1, Math.floor(n));
      return new Promise<void>((resolve) => {
        let seen = 0;
        const off = game.onFrame(() => {
          seen++;
          if (seen < wanted) return;
          off();
          resolve();
        });
      });
    },

    sample,

    trace(): GameSample[] {
      const out: GameSample[] = [];
      const start = filled < TRACE_CAP ? 0 : head;
      for (let i = 0; i < filled; i++) out.push(ring[(start + i) % TRACE_CAP]);
      return out;
    },

    /** Always starts a fresh window, so two measurements never bleed together. */
    startTrace(): void {
      filled = 0;
      head = 0;
      recording = true;
    },

    stopTrace(): void {
      recording = false;
    },

    probeHit(damage: number = LIGHT_ATK.damage, fromAngle?: number): boolean {
      // HitInfo.direction points attacker -> victim, so a blow arriving FROM
      // `fromAngle` travels the opposite way.
      const direction =
        fromAngle === undefined
          ? PROBE_DIRECTION.clone()
          : new THREE.Vector3(-Math.sin(fromAngle), 0, -Math.cos(fromAngle));
      const hit: HitInfo = {
        damage,
        knockback: KNOCKBACK_PLAYER,
        direction,
        hitstop: HITSTOP_LIGHT,
        source: 'enemy',
      };
      // Straight at the player's own takeHit: i-frames, the zero-stamina
      // multiplier and the hitstun entry are all the real ones.
      return ctx.player.takeHit(hit);
    },

    teleportPlayer(x: number, y: number, z: number): void {
      ctx.player.controller.teleport(scratch.set(x, y, z));
    },

    enemies,
    shrines,
    posts,
    gates,
    levers,
    secrets,
    hiddenFromCamera,
    pickupList,
    signs,

    setPost(enabled: boolean): void {
      game.post.setEnabled(enabled);
    },

    setCanopy(enabled: boolean): void {
      game.canopy.mesh.visible = enabled;
    },

    setBloom(enabled: boolean): void {
      game.post.setBloom(enabled);
    },

    setFrozen(enabled: boolean): void {
      ctx.loop.setPaused(enabled);
    },
  };
}
