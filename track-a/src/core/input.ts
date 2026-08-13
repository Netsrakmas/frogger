/**
 * CROAK - input. PROMPT.md section 9 rule 8: no floaty controls. Every verb is
 * buffered for INPUT_BUFFER, so a press that lands early still fires when the
 * game is ready for it, and nothing is gated behind an animation finishing.
 *
 * Injection drives the exact same state as keyboard/mouse/pad - the test
 * harness must exercise the real path, never a bypass.
 */

import type { Action, InputSystem } from './types';
import { INPUT_BUFFER } from './constants';

const ACTION_LIST: readonly Action[] = [
  'roll',
  'attack',
  'tongue',
  'lockon',
  'interact',
  'block',
  'manual',
];

/** Keyed by `event.code` (physical key), so AZERTY/Dvorak players get WASD too. */
const KEY_ACTIONS: Record<string, Action | undefined> = {
  Space: 'roll',
  ShiftLeft: 'roll',
  ShiftRight: 'roll',
  KeyJ: 'attack',
  KeyZ: 'attack',
  KeyK: 'tongue',
  KeyX: 'tongue',
  KeyL: 'lockon',
  KeyC: 'lockon',
  KeyE: 'interact',
  KeyF: 'block',
  KeyQ: 'block',
  Enter: 'interact',
  NumpadEnter: 'interact',
  Tab: 'manual',
  KeyM: 'manual',
};

/** Screen-space stick contribution per movement key (x right, z down). */
const MOVE_KEYS: Record<string, readonly [number, number] | undefined> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const MOUSE_ACTIONS: Record<number, Action | undefined> = {
  0: 'attack',
  2: 'lockon',
};

/** Standard-mapping face/shoulder buttons. */
const PAD_ACTIONS: Record<number, Action | undefined> = {
  0: 'interact',
  1: 'roll',
  2: 'attack',
  3: 'tongue',
  6: 'lockon',
  11: 'lockon',
  4: 'block',
  9: 'manual',
};

/** Standard-mapping d-pad, treated as digital movement. */
const PAD_DPAD: Record<number, readonly [number, number] | undefined> = {
  12: [0, -1],
  13: [0, 1],
  14: [-1, 0],
  15: [1, 0],
};

/**
 * Hardware calibration, not a feel tunable: sticks rest off-centre and analog
 * triggers report a partial value long before the player means it.
 */
const PAD_DEADZONE = 0.22;
const PAD_TRIGGER_THRESHOLD = 0.5;

interface ActionState {
  /** Every source currently holding the action; held while any of them is down. */
  held: Set<string>;
  pressAt: number;
  buffered: boolean;
}

const newState = (): ActionState => ({ held: new Set(), pressAt: 0, buffered: false });

export function createInput(target: EventTarget = window): InputSystem {
  const state: Record<Action, ActionState> = {
    roll: newState(),
    attack: newState(),
    tongue: newState(),
    lockon: newState(),
    interact: newState(),
    block: newState(),
    manual: newState(),
  };

  /** Real-time clock; the buffer ages on wall time, never on sim time. */
  let time = 0;
  let moveX = 0;
  let moveZ = 0;

  const heldMoveKeys = new Set<string>();
  const padHeld = new Set<number>();
  let padPresent = false;
  let padStickX = 0;
  let padStickZ = 0;
  let padDigitalX = 0;
  let padDigitalZ = 0;
  let injectX = 0;
  let injectZ = 0;

  const press = (action: Action, source: string): void => {
    const s = state[action];
    s.held.add(source);
    s.pressAt = time;
    s.buffered = true;
  };

  const release = (action: Action, source: string): void => {
    state[action].held.delete(source);
  };

  const resolveMove = (): void => {
    let x = 0;
    let z = 0;
    for (const code of heldMoveKeys) {
      const v = MOVE_KEYS[code];
      if (v) {
        x += v[0];
        z += v[1];
      }
    }
    x += padDigitalX;
    z += padDigitalZ;

    // Digital wins while it is held; otherwise fall through to the analog
    // sources (pad stick, then injected stick).
    if (x === 0 && z === 0) {
      if (padStickX !== 0 || padStickZ !== 0) {
        x = padStickX;
        z = padStickZ;
      } else {
        x = injectX;
        z = injectZ;
      }
    }

    // Clamp to the unit circle: a diagonal must never outrun a cardinal.
    const mag = Math.hypot(x, z);
    if (mag > 1) {
      x /= mag;
      z /= mag;
    }
    moveX = x;
    moveZ = z;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const action = KEY_ACTIONS[e.code];
    const move = MOVE_KEYS[e.code];
    if (!action && !move) return;
    e.preventDefault(); // game keys never scroll the page
    if (e.repeat) return;
    if (move) {
      heldMoveKeys.add(e.code);
      resolveMove();
    }
    if (action) press(action, `key:${e.code}`);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const action = KEY_ACTIONS[e.code];
    const move = MOVE_KEYS[e.code];
    if (!action && !move) return;
    e.preventDefault();
    if (move) {
      heldMoveKeys.delete(e.code);
      resolveMove();
    }
    if (action) release(action, `key:${e.code}`);
  };

  const onMouseDown = (e: Event): void => {
    const action = MOUSE_ACTIONS[(e as MouseEvent).button];
    if (!action) return;
    e.preventDefault();
    press(action, `mouse:${(e as MouseEvent).button}`);
  };

  const onMouseUp = (e: Event): void => {
    const action = MOUSE_ACTIONS[(e as MouseEvent).button];
    if (!action) return;
    e.preventDefault();
    release(action, `mouse:${(e as MouseEvent).button}`);
  };

  /** Right mouse is lock-on; the browser menu would eat the release event. */
  const onContextMenu = (e: Event): void => e.preventDefault();

  const releaseAll = (): void => {
    for (const action of ACTION_LIST) {
      const s = state[action];
      s.held.clear();
      // Frames stop while unfocused, so a surviving buffer would never age out
      // and would fire the moment the player came back.
      s.buffered = false;
    }
    heldMoveKeys.clear();
    padHeld.clear();
    padStickX = 0;
    padStickZ = 0;
    padDigitalX = 0;
    padDigitalZ = 0;
    injectX = 0;
    injectZ = 0;
    resolveMove();
  };

  const firstPad = (): Gamepad | null => {
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return pad;
    }
    return null;
  };

  const onPadConnected = (): void => {
    padPresent = true;
  };

  const onPadDisconnected = (): void => {
    padPresent = firstPad() !== null;
    for (const index of padHeld) {
      const action = PAD_ACTIONS[index];
      if (action) release(action, `pad:${index}`);
    }
    padHeld.clear();
    padStickX = 0;
    padStickZ = 0;
    padDigitalX = 0;
    padDigitalZ = 0;
  };

  const pollPad = (): void => {
    const pad = firstPad();
    if (!pad) {
      onPadDisconnected();
      return;
    }

    let dx = 0;
    let dz = 0;
    for (let i = 0; i < pad.buttons.length; i++) {
      const button = pad.buttons[i];
      const down = button.pressed || button.value > PAD_TRIGGER_THRESHOLD;
      const dpad = PAD_DPAD[i];
      if (down && dpad) {
        dx += dpad[0];
        dz += dpad[1];
      }
      const action = PAD_ACTIONS[i];
      if (!action) continue;
      const was = padHeld.has(i);
      if (down && !was) {
        padHeld.add(i);
        press(action, `pad:${i}`);
      } else if (!down && was) {
        padHeld.delete(i);
        release(action, `pad:${i}`);
      }
    }
    padDigitalX = dx;
    padDigitalZ = dz;

    const ax = pad.axes.length > 0 ? pad.axes[0] : 0;
    const az = pad.axes.length > 1 ? pad.axes[1] : 0;
    const mag = Math.hypot(ax, az);
    if (mag > PAD_DEADZONE) {
      // Radial rescale so the stick still reaches a clean zero at the edge of
      // the deadzone instead of snapping to a fifth of full speed.
      const scaled = Math.min(1, (mag - PAD_DEADZONE) / (1 - PAD_DEADZONE));
      padStickX = (ax / mag) * scaled;
      padStickZ = (az / mag) * scaled;
    } else {
      padStickX = 0;
      padStickZ = 0;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  window.addEventListener('gamepadconnected', onPadConnected);
  window.addEventListener('gamepaddisconnected', onPadDisconnected);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('contextmenu', onContextMenu);

  return {
    update(realDt: number): void {
      time += Math.max(0, realDt);
      if (padPresent) pollPad();
      for (const action of ACTION_LIST) {
        const s = state[action];
        if (s.buffered && time - s.pressAt > INPUT_BUFFER) s.buffered = false;
      }
      resolveMove();
    },
    get moveX(): number {
      return moveX;
    },
    get moveZ(): number {
      return moveZ;
    },
    isDown(action: Action): boolean {
      return state[action].held.size > 0;
    },
    consume(action: Action): boolean {
      const s = state[action];
      if (!s.buffered) return false;
      s.buffered = false;
      // Checked here as well as in update(), so a consume() that runs before
      // this frame's ageing cannot honour a stale press.
      return time - s.pressAt <= INPUT_BUFFER;
    },
    clear(action: Action): void {
      state[action].buffered = false;
    },
    injectPress(action: Action): void {
      press(action, 'inject');
    },
    injectRelease(action: Action): void {
      release(action, 'inject');
    },
    injectMove(x: number, z: number): void {
      const mag = Math.hypot(x, z);
      const scale = mag > 1 ? 1 / mag : 1;
      injectX = x * scale;
      injectZ = z * scale;
      resolveMove();
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('gamepadconnected', onPadConnected);
      window.removeEventListener('gamepaddisconnected', onPadDisconnected);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('contextmenu', onContextMenu);
      releaseAll();
    },
  };
}

/** Alias for call sites that spell the system out in full. */
export const createInputSystem = createInput;
