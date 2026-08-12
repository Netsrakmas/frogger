/**
 * CROAK - touch controls. Phones and tablets.
 *
 * A FLOATING stick, not a fixed one: the pad appears wherever the left thumb
 * first lands and re-centres on every touch. A fixed stick makes the player
 * hunt for a spot they cannot see under their own hand, and on a game whose
 * primary verb has to respond in under 100 ms that hunt is the whole latency
 * budget spent before the input even happens.
 *
 * Everything here drives the real InputSystem through inject*, which is the
 * same path the keyboard and the gamepad take. Nothing bypasses game logic, so
 * a touch roll is buffered, consumed and i-framed exactly like a keyed one.
 *
 * The layer only mounts on a coarse pointer (or with ?touch=1, so it can be
 * driven in a test). On a desktop it never exists and never eats a click.
 */

import type { Action, InputSystem } from '../core/types';

// ------------------------------------------------------------- style tuning

/** Radius the thumb can travel before the stick reads as fully deflected. */
const STICK_RADIUS = 52; // px
/** Below this the stick reads as centred - thumbs are never perfectly still. */
const STICK_DEADZONE = 6; // px
const KNOB_RADIUS = 26; // px

interface ButtonSpec {
  action: Action;
  /** Position within the right-hand cluster, in px from its corner. */
  x: number;
  y: number;
  size: number;
  icon: string;
  label: string;
}

/**
 * Thumb reach, not a grid: attack sits under the resting thumb, tongue just
 * inboard of it (the two verbs that trade off in a fight), roll above them
 * where a panic press lands, and the two situational verbs further out.
 */
const BUTTONS: readonly ButtonSpec[] = [
  {
    action: 'attack',
    x: 24,
    y: 26,
    size: 76,
    label: 'attack',
    icon:
      '<path d="M31,14 L37,17 L21,44 L15,41 Z"/>' +
      '<path d="M13,38 L24,44 L20,51 L9,45 Z"/>',
  },
  {
    action: 'tongue',
    x: 108,
    y: 52,
    size: 68,
    label: 'tongue',
    icon:
      '<path d="M11,44 C20,44 21,26 30,26 C38,26 39,38 47,36" fill="none" stroke-width="6"/>' +
      '<circle cx="47" cy="35" r="6" stroke="none"/>',
  },
  {
    action: 'roll',
    x: 30,
    y: 108,
    size: 68,
    label: 'roll',
    icon:
      '<path d="M45,20 A16,16 0 1 0 49,34" fill="none" stroke-width="6"/>' +
      '<path d="M38,13 L47,20 L37,26 Z" stroke="none"/>',
  },
  {
    action: 'lockon',
    x: 116,
    y: 130,
    size: 56,
    label: 'lock on',
    icon:
      '<circle cx="28" cy="28" r="11" fill="none" stroke-width="5"/>' +
      '<path d="M28,6 L28,14 M28,42 L28,50 M6,28 L14,28 M42,28 L50,28" stroke-width="5"/>',
  },
  {
    action: 'block',
    x: 126,
    y: 8,
    size: 62,
    label: 'block',
    icon:
      '<path d="M28,7 44,13v13.6C44,35 37.6,42 28,45.4C18.4,42 12,35 12,26.6V13Z"' +
      ' fill="none" stroke-width="5"/>',
  },
  {
    // The book. Furthest from the fighting thumb on purpose: opening it pauses
    // the world, and a pause you can trigger by fumbling a dodge is a bug.
    action: 'manual',
    x: 132,
    y: 196,
    size: 56,
    label: 'manual',
    icon:
      '<path d="M9,14 C16,10 24,10 28,14 C32,10 40,10 47,14 L47,42' +
      ' C40,38 32,38 28,42 C24,38 16,38 9,42 Z" fill="none" stroke-width="5"/>' +
      '<path d="M28,14 L28,42" stroke-width="4"/>',
  },
  {
    action: 'interact',
    x: 40,
    y: 186,
    size: 56,
    label: 'interact',
    icon:
      '<path d="M28,10 L34,24 L48,26 L38,36 L41,50 L28,43 L15,50 L18,36 L8,26 L22,24 Z"' +
      ' fill="none" stroke-width="5"/>',
  },
];

const CSS = `
.croak-touch{position:fixed;inset:0;pointer-events:none;user-select:none;
-webkit-user-select:none;touch-action:none;z-index:5;}
.croak-touch__zone{position:absolute;top:0;bottom:0;pointer-events:auto;
touch-action:none;}
.croak-touch__zone--move{left:0;width:46%;}
.croak-touch__stick{position:absolute;width:${STICK_RADIUS * 2}px;
height:${STICK_RADIUS * 2}px;margin:-${STICK_RADIUS}px 0 0 -${STICK_RADIUS}px;
opacity:0;transition:opacity 120ms ease-out;pointer-events:none;}
.croak-touch__stick.is-on{opacity:1;}
.croak-touch__ring{fill:var(--hero-belly,#f2e8c9);fill-opacity:.16;
stroke:var(--hero-belly,#f2e8c9);stroke-opacity:.5;stroke-width:3;}
.croak-touch__knob{fill:var(--hero-belly,#f2e8c9);fill-opacity:.6;
stroke:var(--ink,#3a2e28);stroke-opacity:.45;stroke-width:2.5;}
.croak-touch__pad{position:absolute;right:0;bottom:0;pointer-events:none;}
.croak-touch__btn{position:absolute;pointer-events:auto;touch-action:none;
border:0;padding:0;background:none;-webkit-tap-highlight-color:transparent;}
.croak-touch__btn svg{display:block;width:100%;height:100%;overflow:visible;}
.croak-touch__disc{fill:var(--hero-belly,#f2e8c9);fill-opacity:.2;
stroke:var(--hero-belly,#f2e8c9);stroke-opacity:.55;stroke-width:3;}
.croak-touch__glyph{fill:var(--hero-belly,#f2e8c9);fill-opacity:.9;
stroke:var(--hero-belly,#f2e8c9);stroke-opacity:.9;stroke-linecap:round;
stroke-linejoin:round;}
.croak-touch__btn.is-down .croak-touch__disc{fill-opacity:.5;
stroke:var(--gold,#f2c14e);stroke-opacity:1;}
.croak-touch__btn.is-down .croak-touch__glyph{fill:var(--gold,#f2c14e);
stroke:var(--gold,#f2c14e);}
`;

export interface TouchControls {
  readonly root: HTMLElement;
  /** False on a desktop, where nothing was mounted at all. */
  readonly active: boolean;
  dispose(): void;
}

/** Coarse pointer, or an explicit ?touch=1 so this can be driven in a test. */
function wantsTouch(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('touch') === '1') return true;
  if (params.get('touch') === '0') return false;
  const coarse =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  return coarse || navigator.maxTouchPoints > 0;
}

let styleElement: HTMLStyleElement | null = null;
let styleUsers = 0;

function retainStyle(): void {
  styleUsers++;
  if (styleElement !== null) return;
  styleElement = document.createElement('style');
  styleElement.id = 'croak-touch-style';
  styleElement.textContent = CSS;
  document.head.appendChild(styleElement);
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0 || styleElement === null) return;
  styleElement.remove();
  styleElement = null;
}

export function createTouchControls(
  parent: HTMLElement | null,
  input: InputSystem,
): TouchControls {
  const root = document.createElement('div');
  root.className = 'croak-touch';

  if (!wantsTouch()) {
    return {
      root,
      active: false,
      dispose(): void {
        /* never mounted */
      },
    };
  }

  const host = parent ?? document.getElementById('hud') ?? document.body;
  retainStyle();

  // ------------------------------------------------------------- the stick
  const zone = document.createElement('div');
  zone.className = 'croak-touch__zone croak-touch__zone--move';

  const stick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  stick.setAttribute('class', 'croak-touch__stick');
  stick.setAttribute('viewBox', `0 0 ${STICK_RADIUS * 2} ${STICK_RADIUS * 2}`);
  stick.innerHTML =
    `<circle class="croak-touch__ring" cx="${STICK_RADIUS}" cy="${STICK_RADIUS}" r="${STICK_RADIUS - 3}"/>` +
    `<circle class="croak-touch__knob" cx="${STICK_RADIUS}" cy="${STICK_RADIUS}" r="${KNOB_RADIUS}"/>`;
  const knob = stick.querySelector('.croak-touch__knob') as SVGCircleElement;

  root.append(zone, stick);

  // ------------------------------------------------------------ the buttons
  const pad = document.createElement('div');
  pad.className = 'croak-touch__pad';
  const buttonEls: HTMLButtonElement[] = [];

  for (const spec of BUTTONS) {
    const button = document.createElement('button');
    button.className = 'croak-touch__btn';
    button.type = 'button';
    // Labelled for assistive tech only - nothing here is ever drawn as text.
    button.setAttribute('aria-label', spec.label);
    button.style.width = `${spec.size}px`;
    button.style.height = `${spec.size}px`;
    button.style.right = `${spec.x}px`;
    button.style.bottom = `${spec.y}px`;
    button.innerHTML =
      `<svg viewBox="0 0 56 56" aria-hidden="true">` +
      `<circle class="croak-touch__disc" cx="28" cy="28" r="25"/>` +
      `<g class="croak-touch__glyph">${spec.icon}</g></svg>`;
    pad.appendChild(button);
    buttonEls.push(button);
  }
  root.appendChild(pad);
  host.appendChild(root);

  // ------------------------------------------------------------- behaviour

  /** Which pointer owns the stick. Buttons keep their own, so both work at once. */
  let stickPointer: number | null = null;
  let originX = 0;
  let originY = 0;

  function showStick(x: number, y: number): void {
    stick.style.left = `${x}px`;
    stick.style.top = `${y}px`;
    stick.classList.add('is-on');
  }

  function moveKnob(dx: number, dy: number): void {
    knob.setAttribute('cx', String(STICK_RADIUS + dx));
    knob.setAttribute('cy', String(STICK_RADIUS + dy));
  }

  function onZoneDown(event: PointerEvent): void {
    if (stickPointer !== null) return;
    stickPointer = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    zone.setPointerCapture(event.pointerId);
    showStick(originX, originY);
    moveKnob(0, 0);
    input.injectMove(0, 0);
    event.preventDefault();
  }

  function onZoneMove(event: PointerEvent): void {
    if (event.pointerId !== stickPointer) return;
    let dx = event.clientX - originX;
    let dy = event.clientY - originY;
    const distance = Math.hypot(dx, dy);

    if (distance > STICK_RADIUS) {
      // Past the ring the stick re-centres under the thumb rather than
      // clamping: a thumb that has drifted keeps full control instead of
      // grinding against an invisible edge.
      const excess = distance - STICK_RADIUS;
      originX += (dx / distance) * excess;
      originY += (dy / distance) * excess;
      showStick(originX, originY);
      dx = (dx / distance) * STICK_RADIUS;
      dy = (dy / distance) * STICK_RADIUS;
    }

    moveKnob(dx, dy);

    const magnitude = Math.hypot(dx, dy);
    if (magnitude <= STICK_DEADZONE) {
      input.injectMove(0, 0);
      return;
    }
    // Screen space, x right and z down - exactly what the rig expects, so the
    // camera's yaw is applied in one place for every input source.
    const scaled = Math.min(1, (magnitude - STICK_DEADZONE) / (STICK_RADIUS - STICK_DEADZONE));
    input.injectMove((dx / magnitude) * scaled, (dy / magnitude) * scaled);
    event.preventDefault();
  }

  function onZoneUp(event: PointerEvent): void {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    stick.classList.remove('is-on');
    moveKnob(0, 0);
    input.injectMove(0, 0);
    if (zone.hasPointerCapture(event.pointerId)) zone.releasePointerCapture(event.pointerId);
  }

  zone.addEventListener('pointerdown', onZoneDown);
  zone.addEventListener('pointermove', onZoneMove);
  zone.addEventListener('pointerup', onZoneUp);
  zone.addEventListener('pointercancel', onZoneUp);

  const buttonCleanups: (() => void)[] = [];

  buttonEls.forEach((button, index) => {
    const spec = BUTTONS[index];
    let owner: number | null = null;

    const down = (event: PointerEvent): void => {
      if (owner !== null) return;
      owner = event.pointerId;
      button.setPointerCapture(event.pointerId);
      button.classList.add('is-down');
      input.injectPress(spec.action);
      event.preventDefault();
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== owner) return;
      owner = null;
      button.classList.remove('is-down');
      input.injectRelease(spec.action);
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    };
    // A context menu on long-press would cancel the hold mid-fight.
    const menu = (event: Event): void => event.preventDefault();

    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('contextmenu', menu);
    buttonCleanups.push(() => {
      button.removeEventListener('pointerdown', down);
      button.removeEventListener('pointerup', up);
      button.removeEventListener('pointercancel', up);
      button.removeEventListener('contextmenu', menu);
      // Never leave an action stuck down because the layer was torn down
      // while a thumb was still on it.
      if (owner !== null) input.injectRelease(spec.action);
    });
  });

  return {
    root,
    active: true,
    dispose(): void {
      zone.removeEventListener('pointerdown', onZoneDown);
      zone.removeEventListener('pointermove', onZoneMove);
      zone.removeEventListener('pointerup', onZoneUp);
      zone.removeEventListener('pointercancel', onZoneUp);
      for (const cleanup of buttonCleanups) cleanup();
      if (stickPointer !== null) input.injectMove(0, 0);
      root.remove();
      releaseStyle();
    },
  };
}
