/**
 * CROAK - the HUD. PROMPT.md section 2 visual-grammar rule 6.
 *
 * The 2D layer is the analog one: the digital diorama annotated by a paper
 * artifact. So this is ink on paper - wobbled pen outlines, a halftone stipple,
 * and a mis-registered print shadow under every shape - drawn as SVG in the DOM
 * overlay rather than on the canvas, and coloured only from the locked palette
 * (the same custom properties index.html declares, each with its hex restated
 * as the fallback).
 *
 * Nothing here is a progress bar with a gradient in it, nothing here is text,
 * and nothing here reports a number to the player (section 9 rules 3 and 12).
 * `update` runs on PRESENT time, so the paper keeps breathing while hitstop has
 * the world frozen.
 */

import type { Hud, Rng } from '../core/types';
import { DEFAULT_SEED, PLAYER_HP_MAX } from '../core/constants';
import { createRng } from '../core/rng';

// ------------------------------------------------------------- style tuning
// Presentation numbers for the paper layer, kept beside the shapes they
// describe. No gameplay rule reads any of them.

const TAU = Math.PI * 2;

/** Stamina bar user-space box. Width is fixed; CSS scales the whole SVG. */
const BAR_W = 240;
const BAR_H = 30;
const BAR_CORNER = 12;
/** The inner well the fill lives in, inset from the frame. */
const WELL_X = 7;
const WELL_Y = 6.5;
const WELL_W = 226;
const WELL_H = 17;
const WELL_CORNER = 8;

const PIP_ROW_W = 240;
const PIP_ROW_H = 40;
const PIP_ROW_PAD = 6;
const PIP_CY = 20;
/** Pip diameter as a fraction of its slot, so a longer bar just packs tighter. */
const PIP_FILL_RATIO = 0.86;
/** The coloured heart is drawn a touch small: coloured in, not printed. */
const PIP_INNER = 0.84;

/** Pen wobble, in user units. Enough to read as a hand, not as a mistake. */
const WOBBLE_FRAME = 0.95;
const WOBBLE_PIP = 0.7;
const EDGE_STEPS = 5;
const CORNER_STEPS = 4;
const HEART_STEPS = 26;

/** Bar catch-up rate, per second. Fast enough to feel instant, slow enough to read. */
const BAR_LERP = 14;
/** The spent-stamina ghost holds this long before it drains after the fill. */
const GHOST_HOLD = 0.22;
const GHOST_DRAIN = 0.85;

const PIP_FLASH_TIME = 0.3;
const PIP_POP = 0.24;

/** Zero-stamina hazard: marching stripes, because a drain has to look alive. */
const HATCH_STEP = 16;
const HATCH_SLANT = 12;
const HATCH_SCROLL = 26;
const HATCH_COUNT = 22;
const PENALTY_RATE = 7.0;

/** Below this, a rewrite of the attribute is not worth the repaint. */
const WRITE_EPS = 0.0015;

// ------------------------------------------------------------- path drawing

const n2 = (value: number): string => value.toFixed(2);

type Point = [number, number];

function jitter(rng: Rng, points: Point[], amount: number): Point[] {
  for (const p of points) {
    p[0] += rng.range(-amount, amount);
    p[1] += rng.range(-amount, amount);
  }
  return points;
}

/**
 * Quadratic smoothing through the sample points: the curve passes the
 * midpoints and uses each sample as its control handle, which turns a jittered
 * polygon into a line that looks drawn rather than plotted.
 */
function smoothClosed(points: Point[]): string {
  const n = points.length;
  const mid = (a: Point, b: Point): Point => [
    (a[0] + b[0]) * 0.5,
    (a[1] + b[1]) * 0.5,
  ];
  const start = mid(points[n - 1], points[0]);
  let d = `M${n2(start[0])},${n2(start[1])}`;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const next = mid(p, points[(i + 1) % n]);
    d += `Q${n2(p[0])},${n2(p[1])} ${n2(next[0])},${n2(next[1])}`;
  }
  return `${d}Z`;
}

function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): Point[] {
  const points: Point[] = [];
  const edge = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): void => {
    for (let i = 0; i < EDGE_STEPS; i++) {
      const t = i / EDGE_STEPS;
      points.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  };
  const arc = (cx: number, cy: number, a0: number, a1: number): void => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const a = a0 + (a1 - a0) * (i / CORNER_STEPS);
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  const right = x + w;
  const bottom = y + h;
  const half = Math.PI / 2;

  edge(x + r, y, right - r, y);
  arc(right - r, y + r, -half, 0);
  edge(right, y + r, right, bottom - r);
  arc(right - r, bottom - r, 0, half);
  edge(right - r, bottom, x + r, bottom);
  arc(x + r, bottom - r, half, Math.PI);
  edge(x, bottom - r, x, y + r);
  arc(x + r, y + r, Math.PI, Math.PI * 1.5);

  return points;
}

/** The curve's own width, which `size` maps onto, and its vertical centre. */
const HEART_SPAN = 32;
const HEART_CENTRE = -2.54;

/**
 * The classic parametric heart, sampled and re-centred so `size` is its width
 * and its natural proportions survive. A pip has to read as life at a glance;
 * anything more abstract needs a legend, and a legend is text (rule 16).
 */
function heart(size: number): Point[] {
  const points: Point[] = [];
  const scale = size / HEART_SPAN;
  for (let i = 0; i < HEART_STEPS; i++) {
    const t = (i / HEART_STEPS) * TAU;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    // SVG y grows downward, so the curve is flipped as well as re-centred.
    points.push([x * scale, (HEART_CENTRE - y) * scale]);
  }
  return points;
}

// --------------------------------------------------------------- stylesheet

const CSS = `
.croak-hud{position:absolute;top:calc(18px + env(safe-area-inset-top,0px));
left:calc(20px + env(safe-area-inset-left,0px));width:min(34vw,264px);
min-width:172px;pointer-events:none;user-select:none;}
.croak-hud svg{display:block;width:100%;height:auto;overflow:visible;}
.croak-hud__bar{width:90%;margin-top:-1px;}
.croak-hud__print{fill:var(--ink,#3a2e28);opacity:.26;}
.croak-hud__paper{fill:var(--hero-belly,#f2e8c9);}
.croak-hud__grain{opacity:.42;}
.croak-hud__well{fill:var(--stone-shade,#b08d6e);opacity:.28;}
.croak-hud__ink{fill:none;stroke:var(--ink,#3a2e28);stroke-width:2.6;
stroke-linejoin:round;stroke-linecap:round;}
.croak-hud__warn{fill:none;stroke:var(--tongue,#f4846c);stroke-width:3.6;
stroke-linejoin:round;stroke-linecap:round;}
.croak-hud__ghost{fill:var(--stone-shade,#b08d6e);opacity:.75;}
.croak-hud__fill{fill:var(--hero-body,#6fbf4b);}
.croak-hud__hatch{fill:none;stroke:var(--tongue,#f4846c);stroke-width:3.2;
stroke-linecap:round;}
.croak-hud__pip-print{fill:var(--ink,#3a2e28);opacity:.24;}
.croak-hud__pip-paper{fill:var(--hero-belly,#f2e8c9);}
.croak-hud__pip-fill{fill:var(--tongue,#f4846c);}
.croak-hud__pip-ink{fill:none;stroke:var(--ink,#3a2e28);stroke-width:2.4;
stroke-linejoin:round;stroke-linecap:round;}
`;

let styleElement: HTMLStyleElement | null = null;
let styleUsers = 0;
let instanceCount = 0;

/** Refcounted: a hot-reload can briefly hold two HUDs, and the first one to go
 * must not take the survivor's stylesheet with it. */
function retainStyle(): void {
  styleUsers++;
  if (styleElement !== null) return;
  styleElement = document.createElement('style');
  styleElement.id = 'croak-hud-style';
  styleElement.textContent = CSS;
  document.head.appendChild(styleElement);
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0 || styleElement === null) return;
  styleElement.remove();
  styleElement = null;
}

const q = <T extends Element>(scope: ParentNode, selector: string): T =>
  scope.querySelector<T>(selector)!;

// --------------------------------------------------------------------- hud

/**
 * @param parent where the overlay mounts. Defaults to `#hud`, the layer
 *   index.html already reserves above the canvas.
 * @param rng optional: pass the run's generator and the pen wobble inherits the
 *   recorded seed. Without one the HUD still never touches `Math.random`.
 */
export function createHud(parent?: HTMLElement | null, rng?: Rng): Hud {
  const host =
    parent ?? document.getElementById('hud') ?? document.body;
  const ink = (rng ?? createRng(DEFAULT_SEED)).fork('hud:ink');
  const uid = `croak-hud-${++instanceCount}`;

  retainStyle();

  const root = document.createElement('div');
  root.className = 'croak-hud';

  const dots = `<pattern id="${uid}-dots" width="5" height="5"
      patternUnits="userSpaceOnUse">
      <circle cx="1.2" cy="1.2" r=".75" fill="var(--stone-shade,#b08d6e)"/>
      <circle cx="3.7" cy="3.7" r=".55" fill="var(--stone-shade,#b08d6e)"/>
    </pattern>`;

  const frame = smoothClosed(
    jitter(ink, roundedRect(2, 2, BAR_W - 4, BAR_H - 4, BAR_CORNER), WOBBLE_FRAME),
  );
  const well = smoothClosed(
    jitter(ink, roundedRect(WELL_X, WELL_Y, WELL_W, WELL_H, WELL_CORNER), WOBBLE_FRAME * 0.5),
  );

  let hatch = '';
  for (let i = 0; i < HATCH_COUNT; i++) {
    const x = -HATCH_STEP * 3 + i * HATCH_STEP;
    hatch += `M${n2(x)},-2L${n2(x - HATCH_SLANT)},${BAR_H + 2}`;
  }

  const pipCenter = (index: number, count: number): number =>
    PIP_ROW_PAD + ((PIP_ROW_W - PIP_ROW_PAD * 2) / count) * (index + 0.5);

  /** Width of one pip's heart, which the partial-fill clip is measured in. */
  const pipSize = (count: number): number =>
    ((PIP_ROW_W - PIP_ROW_PAD * 2) / count) * PIP_FILL_RATIO;

  function pipMarkup(count: number): string {
    const size = pipSize(count);
    // One shared clip, because only ever one pip is part-filled: the pips all
    // live in identically-translated groups, so a single userSpaceOnUse rect
    // means the same thing inside each of them.
    let markup =
      `<defs><clipPath id="${uid}-part" clipPathUnits="userSpaceOnUse">` +
      `<rect class="croak-hud__part" x="${n2(-size)}" y="${n2(-size)}" ` +
      `width="0" height="${n2(size * 2)}"/></clipPath></defs>`;
    for (let i = 0; i < count; i++) {
      // Each pip gets its own wobble: identical hearts would read as a stamp,
      // and the paper layer is meant to look drawn one at a time.
      const outline = smoothClosed(jitter(ink, heart(size), WOBBLE_PIP));
      const inner = smoothClosed(
        jitter(ink, heart(size * PIP_INNER), WOBBLE_PIP),
      );
      markup +=
        `<g class="croak-hud__pip" transform="translate(${n2(
          pipCenter(i, count),
        )},${PIP_CY})">` +
        `<path class="croak-hud__pip-print" transform="translate(1.3,2)" d="${outline}"/>` +
        `<path class="croak-hud__pip-paper" d="${outline}"/>` +
        `<path class="croak-hud__pip-fill" d="${inner}"/>` +
        `<path class="croak-hud__pip-ink" d="${outline}"/>` +
        `</g>`;
    }
    return markup;
  }

  root.innerHTML = `
<svg class="croak-hud__pips" viewBox="0 0 ${PIP_ROW_W} ${PIP_ROW_H}"
     aria-hidden="true">${pipMarkup(PLAYER_HP_MAX)}</svg>
<svg class="croak-hud__bar" viewBox="0 0 ${BAR_W} ${BAR_H}" aria-hidden="true">
  <defs>
    ${dots}
    <clipPath id="${uid}-well"><path d="${well}"/></clipPath>
  </defs>
  <path class="croak-hud__print" transform="translate(1.6,2.6)" d="${frame}"/>
  <path class="croak-hud__paper" d="${frame}"/>
  <path class="croak-hud__grain" d="${frame}" fill="url(#${uid}-dots)"/>
  <path class="croak-hud__well" d="${well}"/>
  <g clip-path="url(#${uid}-well)">
    <rect class="croak-hud__ghost" x="0" y="0" width="0" height="${BAR_H}"/>
    <rect class="croak-hud__fill" x="0" y="0" width="0" height="${BAR_H}"/>
    <g class="croak-hud__hatch" opacity="0"><path d="${hatch}"/></g>
  </g>
  <path class="croak-hud__ink" d="${frame}"/>
  <path class="croak-hud__warn" d="${frame}" opacity="0"/>
</svg>`;

  host.appendChild(root);

  const pipsSvg = q<SVGSVGElement>(root, '.croak-hud__pips');
  let partRect = q<SVGRectElement>(root, '.croak-hud__part');
  const fillRect = q<SVGRectElement>(root, '.croak-hud__fill');
  const ghostRect = q<SVGRectElement>(root, '.croak-hud__ghost');
  const hatchGroup = q<SVGGElement>(root, '.croak-hud__hatch');
  const warnPath = q<SVGPathElement>(root, '.croak-hud__warn');

  let pipGroups: SVGGElement[] = [];
  let pipFills: SVGPathElement[] = [];
  let pipX: number[] = [];
  let pipFlash: number[] = [];
  let pipCount = 0;

  let target = 1;
  let display = 1;
  let ghost = 1;
  let ghostHold = 0;
  let penalty = false;
  /**
   * The real, possibly fractional hp. Rounding it to whole pips here is what
   * made an identical 1-damage hit cost one pip or two depending on where the
   * x1.5 penalty had left the total; a part-filled heart is the honest reading
   * and is exactly what the penalty is trying to teach.
   */
  let hpValue = PLAYER_HP_MAX;
  let clock = 0;
  let pipsDirty = true;

  let lastFill = -1;
  let lastGhost = -1;
  let lastHatch = -1;
  let lastWarn = -1;

  function wirePips(count: number): void {
    pipGroups = Array.from(
      pipsSvg.querySelectorAll<SVGGElement>('.croak-hud__pip'),
    );
    pipFills = Array.from(
      pipsSvg.querySelectorAll<SVGPathElement>('.croak-hud__pip-fill'),
    );
    pipX = pipGroups.map((_, i) => pipCenter(i, count));
    pipFlash = new Array(count).fill(0);
    pipCount = count;
    pipsDirty = true;
  }

  /** Only ever reached if a run raises PLAYER_HP_MAX mid-session. */
  function rebuildPips(count: number): void {
    pipsSvg.innerHTML = pipMarkup(count);
    partRect = q<SVGRectElement>(root, '.croak-hud__part');
    wirePips(count);
  }

  wirePips(PLAYER_HP_MAX);

  function write(): void {
    const fill = WELL_X + display * WELL_W;
    if (Math.abs(fill - lastFill) > WRITE_EPS) {
      fillRect.setAttribute('width', n2(fill));
      lastFill = fill;
    }
    const trail = WELL_X + ghost * WELL_W;
    if (Math.abs(trail - lastGhost) > WRITE_EPS) {
      ghostRect.setAttribute('width', n2(trail));
      lastGhost = trail;
    }

    // The penalty has to be legible without a number on screen: the empty well
    // fills with hazard stripes that march, and the pen frame doubles in the
    // HP colour - the bar says "this is costing you health" in the same red the
    // pips are drawn in.
    const beat = 0.5 + 0.5 * Math.sin(clock * PENALTY_RATE);
    const hatchAlpha = penalty ? 0.55 + 0.45 * beat : 0;
    if (Math.abs(hatchAlpha - lastHatch) > WRITE_EPS) {
      hatchGroup.setAttribute('opacity', n2(hatchAlpha));
      lastHatch = hatchAlpha;
    }
    if (penalty) {
      const scroll = (clock * HATCH_SCROLL) % HATCH_STEP;
      hatchGroup.setAttribute('transform', `translate(${n2(scroll)},0)`);
    }
    const warnAlpha = penalty ? 0.35 + 0.65 * beat : 0;
    if (Math.abs(warnAlpha - lastWarn) > WRITE_EPS) {
      warnPath.setAttribute('opacity', n2(warnAlpha));
      lastWarn = warnAlpha;
    }

    if (!pipsDirty) return;
    const whole = Math.floor(hpValue + WRITE_EPS);
    const part = hpValue - whole;
    if (part > WRITE_EPS) {
      const size = pipSize(pipCount);
      // The clip starts well left of the heart and stops `part` of the way
      // across it, so a half-heart is a half-heart and not a scaled one.
      partRect.setAttribute('width', n2(size * 0.5 + size * part));
    }

    let animating = false;
    for (let i = 0; i < pipCount; i++) {
      const flash = pipFlash[i];
      if (flash > 0) animating = true;
      const scale = 1 + PIP_POP * flash;
      pipGroups[i].setAttribute(
        'transform',
        `translate(${n2(pipX[i])},${PIP_CY}) scale(${n2(scale)})`,
      );
      const partial = i === whole && part > WRITE_EPS;
      // A lost pip fades its colour out through the flash and leaves the paper
      // and the pen line behind: clearly empty, still clearly a slot.
      pipFills[i].setAttribute('opacity', n2(i < whole || partial ? 1 : flash));
      if (partial) pipFills[i].setAttribute('clip-path', `url(#${uid}-part)`);
      else pipFills[i].removeAttribute('clip-path');
    }
    pipsDirty = animating;
  }

  write();

  return {
    root,

    setStamina(value01: number): void {
      const next = Math.max(0, Math.min(1, value01));
      if (next < target) ghostHold = GHOST_HOLD;
      target = next;
    },

    setHp(current: number, max: number): void {
      const cap = Math.max(1, Math.round(max));
      if (cap !== pipCount) rebuildPips(cap);
      const next = Math.max(0, Math.min(cap, current));
      if (Math.abs(next - hpValue) < WRITE_EPS) return;
      // A pip flashes when it stops carrying any colour at all, which is the
      // moment the player actually loses a slot.
      const before = Math.ceil(hpValue - WRITE_EPS);
      const after = Math.ceil(next - WRITE_EPS);
      for (let i = Math.min(after, before); i < Math.max(after, before); i++) {
        pipFlash[i] = 1;
      }
      hpValue = next;
      pipsDirty = true;
    },

    setZeroStaminaPenalty(active: boolean): void {
      penalty = active;
    },

    update(dt: number): void {
      if (dt > 0) {
        clock += dt;
        display += (target - display) * (1 - Math.exp(-BAR_LERP * dt));

        if (display >= ghost) {
          ghost = display;
        } else {
          ghostHold = Math.max(0, ghostHold - dt);
          if (ghostHold <= 0) {
            ghost = Math.max(display, ghost - GHOST_DRAIN * dt);
          }
        }

        if (pipsDirty) {
          for (let i = 0; i < pipCount; i++) {
            if (pipFlash[i] > 0) {
              pipFlash[i] = Math.max(0, pipFlash[i] - dt / PIP_FLASH_TIME);
            }
          }
        }
      }
      write();
    },

    dispose(): void {
      root.remove();
      releaseStyle();
    },
  };
}
