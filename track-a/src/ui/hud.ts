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

import type { Hud, Rng, ToastIcon } from '../core/types';
import type { WeaponId } from '../core/constants';
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

/** The boss bar's own user-space box. Wider and shallower than the stamina bar. */
const BOSS_W = 420;
const BOSS_H = 34;
/** Left inset of the well, leaving room for the sigil that names the fight. */
const BOSS_WELL_X = 40;

/** The ending card: the demo's tally, drawn rather than written. */
const END_W = 220;
const END_H = 76;
const END_SLOT_W = 26;

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

/** How long a pickup acknowledgement stays up before it fades. */
const TOAST_HOLD = 1.6; // s
/** Digits per second the purse counts at when it is catching up. */
const COIN_ROLL = 14;

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
.croak-hud__purse{width:76%;margin-top:2px;}
.croak-hud__coin{fill:var(--gold,#f2c14e);}
.croak-hud__num{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.5;
stroke-linejoin:round;stroke-linecap:round;}
.croak-hud__blade{fill:var(--hero-belly,#f2e8c9);stroke:var(--ink,#3a2e28);
stroke-width:1.4;stroke-linejoin:round;}
.croak-hud__haft{fill:var(--stone-shade,#b08d6e);stroke:var(--ink,#3a2e28);
stroke-width:1.4;stroke-linejoin:round;}
/* Z-targeting's oldest tell: the frame narrows when you are locked on. */
.croak-lock{position:fixed;left:0;right:0;height:5.2vh;background:var(--ink,#3a2e28);
opacity:0;transition:opacity 140ms ease-out,transform 180ms ease-out;
pointer-events:none;}
.croak-lock--top{top:0;transform:translateY(-100%);}
.croak-lock--bottom{bottom:0;transform:translateY(100%);}
.croak-lock.is-on{opacity:.82;transform:translateY(0);}
.croak-toast{position:fixed;left:50%;bottom:11vh;transform:translate(-50%,10px);
width:min(30vw,190px);opacity:0;pointer-events:none;
transition:opacity 200ms ease-out,transform 200ms ease-out;}
.croak-toast.is-on{opacity:1;transform:translate(-50%,0);}
.croak-toast svg{display:block;width:100%;height:auto;overflow:visible;}
/* The boss bar. Same paper, but across the top and twice the width: the one
   thing on screen that is about something other than the frog. */
.croak-boss{position:fixed;left:50%;top:calc(3.4vh + env(safe-area-inset-top,0px));
width:min(54vw,540px);opacity:0;transform:translate(-50%,-10px);pointer-events:none;
transition:opacity 260ms ease-out,transform 260ms ease-out;}
.croak-boss.is-on{opacity:1;transform:translate(-50%,0);}
.croak-boss svg{display:block;width:100%;height:auto;overflow:visible;}
.croak-boss__fill{fill:var(--tongue,#f4846c);}
.croak-boss__sigil{fill:var(--ink,#3a2e28);}
/* The ending card. It does NOT cover the game: the last page is still out
   there behind the arena, and a player who wants it must be able to go. */
.croak-ending{position:fixed;left:50%;bottom:6vh;width:min(46vw,420px);
opacity:0;transform:translate(-50%,24px);pointer-events:none;
transition:opacity 700ms ease-out,transform 700ms ease-out;}
.croak-ending.is-on{opacity:1;transform:translate(-50%,0);}
.croak-ending svg{display:block;width:100%;height:auto;overflow:visible;}
.croak-ending__slot{fill:var(--stone-shade,#b08d6e);opacity:.35;}
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

/**
 * A stroked numeral set on a 6x10 box. The build ships no font and rule 12
 * rules out falling back on the browser's, so every digit the player ever sees
 * is drawn - angular, to sit with the world's geometry rather than against it.
 */
const DIGITS: readonly string[] = [
  'M1,2L5,2L5,8L1,8Z',
  'M1.6,3.2L3,2L3,8',
  'M1,2.6L1.5,2L4.5,2L5,2.6L5,4.3L1,6.2L1,8L5,8',
  'M1,2L5,2L5,4.9L2.2,4.9L5,4.9L5,8L1,8',
  'M4.1,8L4.1,2L1,6L5,6',
  'M5,2L1,2L1,4.9L4.4,4.9L5,5.5L5,7.4L4.4,8L1,8',
  'M5,2L2,2L1,3.1L1,8L5,8L5,5L1,5',
  'M1,2L5,2L2.5,8',
  'M1,2L5,2L5,8L1,8ZM1,5L5,5',
  'M5,5L1,5L1,2L5,2L5,8L1,8',
];

const DIGIT_W = 6;

/** Renders `value` as drawn glyphs, left-aligned from `x`. */
function numerals(value: number, x: number, y: number, scale = 1): string {
  const text = String(Math.max(0, Math.round(value)));
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const glyph = DIGITS[text.charCodeAt(i) - 48];
    if (glyph === undefined) continue;
    out += `<path class="croak-hud__num" transform="translate(${n2(
      x + i * DIGIT_W * scale,
    )},${n2(y)}) scale(${n2(scale)})" d="${glyph}"/>`;
  }
  return out;
}

/** Weapon chips. A stick is a stick; a sword has an edge and a guard. */
const WEAPON_ICON: Record<string, string> = {
  stick:
    '<path class="croak-hud__haft" d="M2,13.5L10.5,2.5L12.5,3.6L4.4,14.6Z"/>' +
    '<path class="croak-hud__haft" d="M9.2,4.6L12,6.2"/>',
  sword:
    '<path class="croak-hud__blade" d="M11.6,1.6L13.4,2.6L6.2,13.2L4.4,12.2Z"/>' +
    '<path class="croak-hud__haft" d="M3.2,10.6L7,12.8L5.6,15L1.8,12.8Z"/>',
};

const TOAST_ICON: Record<string, string> = {
  shield:
    '<path class="croak-hud__blade" d="M9,1.4 15.6,4v5.2C15.6,12.6 12.6,15.4 9,16.6' +
    'C5.4,15.4 2.4,12.6 2.4,9.2V4Z"/>' +
    '<circle class="croak-hud__haft" cx="9" cy="8.4" r="2.2"/>',
  page:
    '<path class="croak-hud__blade" d="M3.4,1.6h8.2l3,3v11.8H3.4Z"/>' +
    '<path class="croak-hud__num" d="M5.6,6.2h6.4M5.6,9h6.4M5.6,11.8h4"/>',
  key:
    '<circle class="croak-hud__coin" cx="6" cy="6" r="3.4"/>' +
    '<circle class="croak-hud__num" cx="6" cy="6" r="3.4"/>' +
    '<path class="croak-hud__num" d="M8.2,8.2L14,14M11.6,11.6l1.8-1.8M14,14l1.6-1.6"/>',
  coins: '<circle class="croak-hud__coin" cx="9" cy="9" r="6.4"/>' +
    '<circle class="croak-hud__num" cx="9" cy="9" r="6.4"/>',
  weapon: WEAPON_ICON.sword,
  rested:
    '<path class="croak-hud__coin" d="M9,1.6C12,5 13.4,7 13.4,9.4' +
    'C13.4,12.2 11.4,14.4 9,14.4C6.6,14.4 4.6,12.2 4.6,9.4C4.6,7 6,5 9,1.6Z"/>',
};

/**
 * Who the bar belongs to, drawn as a mark rather than named in letters (rule
 * 12). The Heron's is its own silhouette: the long neck and the spear beak,
 * which is exactly the shape the player has just spent the fight reading.
 */
const BOSS_SIGIL: Record<string, string> = {
  heron:
    '<path class="croak-boss__sigil" d="M3,19C3,12 6.6,7 11.4,5.4' +
    'C10.6,3 11.8,1 13.8,1C15.6,1 16.8,2.4 16.6,4.2L25,7.2L16.4,7.8' +
    'C16,11 13.6,13.2 10.6,13.6C9.4,15.6 9,17.4 9,19Z"/>',
};

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

  // --------------------------------------------------------------- purse
  // Coins and the weapon in hand, drawn on the same scrap as the bar.
  const purse = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  purse.setAttribute('class', 'croak-hud__purse');
  purse.setAttribute('viewBox', '0 0 100 18');
  root.appendChild(purse);

  /**
   * The lock letterbox and the toast are screen furniture, not corner
   * furniture, so they mount beside the panel rather than inside it. dispose()
   * owns all three.
   */
  const lockTop = document.createElement('div');
  lockTop.className = 'croak-lock croak-lock--top';
  const lockBottom = document.createElement('div');
  lockBottom.className = 'croak-lock croak-lock--bottom';
  const toastEl = document.createElement('div');
  toastEl.className = 'croak-toast';
  const toastSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  toastSvg.setAttribute('viewBox', '0 0 100 18');
  toastEl.appendChild(toastSvg);

  // ------------------------------------------------------------- boss bar
  // Drawn once at build time with the same pen as the stamina frame, so the
  // two read as the same hand rather than as two different UI kits.
  const bossFrame = smoothClosed(
    jitter(ink, roundedRect(2, 2, BOSS_W - 4, BOSS_H - 4, 9), WOBBLE_FRAME),
  );
  const bossWell = smoothClosed(
    jitter(
      ink,
      roundedRect(BOSS_WELL_X, 6, BOSS_W - BOSS_WELL_X - 7, BOSS_H - 12, 6),
      WOBBLE_FRAME * 0.5,
    ),
  );
  const bossEl = document.createElement('div');
  bossEl.className = 'croak-boss';
  bossEl.innerHTML = `
<svg viewBox="0 0 ${BOSS_W} ${BOSS_H}" aria-hidden="true">
  <defs><clipPath id="${uid}-boss"><path d="${bossWell}"/></clipPath></defs>
  <path class="croak-hud__print" transform="translate(1.8,2.8)" d="${bossFrame}"/>
  <path class="croak-hud__paper" d="${bossFrame}"/>
  <path class="croak-hud__grain" d="${bossFrame}" fill="url(#${uid}-dots)"/>
  <path class="croak-hud__well" d="${bossWell}"/>
  <g clip-path="url(#${uid}-boss)">
    <rect class="croak-boss__fill" x="0" y="0" width="0" height="${BOSS_H}"/>
  </g>
  <path class="croak-hud__ink" d="${bossFrame}"/>
  <g class="croak-boss__sigil-slot" transform="translate(10,7)"></g>
</svg>`;

  const endFrame = smoothClosed(
    jitter(ink, roundedRect(2, 2, END_W - 4, END_H - 4, 8), WOBBLE_FRAME),
  );
  const endingEl = document.createElement('div');
  endingEl.className = 'croak-ending';
  const endingSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  endingSvg.setAttribute('viewBox', `0 0 ${END_W} ${END_H}`);
  endingEl.appendChild(endingSvg);

  host.append(lockTop, lockBottom, toastEl, bossEl, endingEl);

  const bossFill = q<SVGRectElement>(bossEl, '.croak-boss__fill');
  const bossSigil = q<SVGGElement>(bossEl, '.croak-boss__sigil-slot');
  const bossWellX = BOSS_WELL_X;
  const bossWellW = BOSS_W - BOSS_WELL_X - 7;

  let bossName = '';
  let bossShown = -1;
  let endingShown = '';

  let coins = 0;
  let shownCoins = 0;
  let weapon: WeaponId = 'stick';
  let purseDirty = true;
  let toastLeft = 0;

  function writePurse(): void {
    if (!purseDirty) return;
    purseDirty = false;
    purse.innerHTML =
      '<circle class="croak-hud__coin" cx="7" cy="9" r="5.4"/>' +
      '<circle class="croak-hud__num" cx="7" cy="9" r="5.4"/>' +
      numerals(shownCoins, 16, 4, 1.05) +
      `<g transform="translate(78,1)">${WEAPON_ICON[weapon] ?? ''}</g>`;
  }

  writePurse();
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

    setCoins(count: number): void {
      const next = Math.max(0, Math.round(count));
      if (next === coins) return;
      coins = next;
    },

    setWeapon(next: WeaponId): void {
      if (next === weapon) return;
      weapon = next;
      purseDirty = true;
    },

    setLockedOn(active: boolean): void {
      lockTop.classList.toggle('is-on', active);
      lockBottom.classList.toggle('is-on', active);
    },

    /**
     * The boss bar. `max` of 0 is how a fight ends as well as how it has not
     * started: the bar leaves the moment there is nothing left to measure.
     */
    setBoss(name: string, current: number, max: number): void {
      if (max <= 0) {
        bossEl.classList.remove('is-on');
        bossShown = -1;
        return;
      }
      if (name !== bossName) {
        bossName = name;
        bossSigil.innerHTML = BOSS_SIGIL[name] ?? '';
      }
      bossEl.classList.add('is-on');
      const fraction = Math.max(0, Math.min(1, current / max));
      const width = bossWellX + fraction * bossWellW;
      if (Math.abs(width - bossShown) <= WRITE_EPS) return;
      bossShown = width;
      bossFill.setAttribute('width', n2(width));
    },

    /**
     * The end of the demo: the Heron struck through, and one slot per manual
     * page with the ones you actually found coloured in. It sits at the bottom
     * of the screen and takes no input, because the fourth page is still out
     * there behind the arena and a card that stole the frame would be a card
     * that told the player the game was over when it was not.
     */
    showEnding(found: number, total: number): void {
      const slots = Math.max(1, Math.round(total));
      const key = `${Math.max(0, Math.round(found))}/${slots}`;
      if (key === endingShown) return;
      endingShown = key;

      const row = END_W - 24;
      const step = Math.min(END_SLOT_W + 8, row / slots);
      const left = (END_W - step * slots) * 0.5;
      let markup =
        `<path class="croak-hud__print" transform="translate(2,3)" d="${endFrame}"/>` +
        `<path class="croak-hud__paper" d="${endFrame}"/>` +
        `<path class="croak-hud__grain" d="${endFrame}" fill="url(#${uid}-dots)"/>` +
        `<path class="croak-hud__ink" d="${endFrame}"/>` +
        // The mark of the thing that is no longer standing.
        `<g transform="translate(${n2(END_W * 0.5 - 14)},9) scale(1)">` +
        `${BOSS_SIGIL.heron}</g>` +
        `<path class="croak-hud__warn" opacity="1" ` +
        `d="M${n2(END_W * 0.5 - 18)},30L${n2(END_W * 0.5 + 22)},6"/>`;
      for (let i = 0; i < slots; i++) {
        const x = left + step * i + (step - 18) * 0.5;
        markup +=
          `<g transform="translate(${n2(x)},44)">` +
          (i < found
            ? TOAST_ICON.page
            : `<path class="croak-ending__slot" d="M3.4,1.6h8.2l3,3v11.8H3.4Z"/>`) +
          `</g>`;
      }
      endingSvg.innerHTML = markup;
      endingEl.classList.add('is-on');
    },

    toast(icon: ToastIcon, count?: number): void {
      toastSvg.innerHTML =
        `<g transform="translate(${count === undefined ? 41 : 24},0)">` +
        `${TOAST_ICON[icon] ?? ''}</g>` +
        (count === undefined ? '' : numerals(count, 46, 3, 1.25));
      toastEl.classList.add('is-on');
      toastLeft = TOAST_HOLD;
    },

    setZeroStaminaPenalty(active: boolean): void {
      penalty = active;
    },

    update(dt: number): void {
      if (dt > 0) {
        clock += dt;

        // Coins count up rather than snap: a kill's four coins arrive as four
        // separate events, and the purse should read as filling.
        if (shownCoins !== coins) {
          const step = Math.max(1, Math.ceil(Math.abs(coins - shownCoins) * COIN_ROLL * dt));
          shownCoins += Math.sign(coins - shownCoins) * Math.min(step, Math.abs(coins - shownCoins));
          purseDirty = true;
        }
        if (toastLeft > 0) {
          toastLeft = Math.max(0, toastLeft - dt);
          if (toastLeft === 0) toastEl.classList.remove('is-on');
        }
        writePurse();
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
      lockTop.remove();
      lockBottom.remove();
      toastEl.remove();
      bossEl.remove();
      endingEl.remove();
      releaseStyle();
    },
  };
}
