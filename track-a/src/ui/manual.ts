/**
 * CROAK - the manual. PROMPT.md section 7.
 *
 * A two-page spread from a printed booklet somebody else owned first. Four
 * slots, all four visible from the moment you open it, three of them empty
 * gaps until you find the page that fills them - the collection hook is the
 * hole, not the reward.
 *
 * Everything on these pages is DRAWN (section 9 rule 12). Body text is set in
 * Croakic, which is a cipher rather than a font and decodes to real English for
 * anyone who works the key out. The margin notes are the exception the spec
 * asks for: they are in plain English because they are the player's real hints,
 * and they are drawn letter by letter in `penscript.ts` rather than typeset.
 *
 * The pages are the game's teaching channel. Nothing on them is flavour:
 *   1  the meadow, mapped, with one dotted route that ends somewhere you would
 *      not otherwise look.
 *   2  the roll, diagrammed frame by frame, and what an empty bar costs.
 *   3  the tongue's mass rule as four pictures - and the fourth one is the
 *      first time the game admits you can pull YOURSELF.
 *   4  the Heron, and the one sentence that turns its best attack into its
 *      worst moment.
 */

import type { Rng } from '../core/types';
import { PAGE_TOTAL } from '../core/constants';
import { layout, write } from './croakic';
import { penParagraph } from './penscript';

// ------------------------------------------------------------- page layout

const PAGE_W = 210;
const PAGE_H = 290;
const GUTTER = 18;
const SPREAD_W = PAGE_W * 2 + GUTTER;
const MARGIN = 16;

const n2 = (value: number): string => value.toFixed(2);

/** Croakic body text, set as one line at `size` and clipped to the column. */
function croakicLine(text: string, x: number, y: number, size: number): string {
  const { strokes, dots } = layout(write(text));
  let markup = `<g class="croak-manual__glyph" transform="translate(${n2(x)},${n2(y)}) scale(${n2(size)})" stroke-width="${n2(0.11)}">`;
  for (const s of strokes) {
    markup += `<path d="M${n2(s.x1)},${n2(s.y1)}L${n2(s.x2)},${n2(s.y2)}"/>`;
  }
  for (const d of dots) {
    markup += `<circle cx="${n2(d.x)}" cy="${n2(d.y)}" r="${n2(d.r)}" class="croak-manual__dot"/>`;
  }
  return `${markup}</g>`;
}

/** Croakic set as a block, wrapped by word count rather than by measurement. */
function croakicBlock(
  text: string,
  x: number,
  y: number,
  size: number,
  perLine: number,
): string {
  const words = text.split(/\s+/);
  let markup = '';
  let line = 0;
  for (let i = 0; i < words.length; i += perLine) {
    markup += croakicLine(words.slice(i, i + perLine).join(' '), x, y + line * size * 1.9, size);
    line++;
  }
  return markup;
}

interface PageArt {
  /** Croakic heading, decodes to this. */
  title: string;
  /** Croakic body. */
  body: string;
  /** The previous owner, in English. This is the hint. */
  note: string;
  /** Illustration, drawn in a 178 x 150 box at the page's origin. */
  draw(rng: Rng): string;
}

// ------------------------------------------------------------ illustrations

/** A dotted route: the annotation that makes a map a treasure map. */
function dottedPath(points: readonly (readonly [number, number])[]): string {
  let d = `M${n2(points[0][0])},${n2(points[0][1])}`;
  for (let i = 1; i < points.length; i++) d += `L${n2(points[i][0])},${n2(points[i][1])}`;
  return `<path class="croak-manual__route" d="${d}"/>`;
}

function blob(cx: number, cy: number, rx: number, ry: number, rng: Rng, steps = 14): string {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 1 + rng.range(-0.09, 0.09);
    const x = cx + Math.cos(a) * rx * wobble;
    const y = cy + Math.sin(a) * ry * wobble;
    d += `${i === 0 ? 'M' : 'L'}${n2(x)},${n2(y)}`;
  }
  return `${d}Z`;
}

const PAGES: readonly PageArt[] = [
  {
    title: 'lilypond downs',
    body: 'the pond hides more than it shows follow the dotted way past the fallen stone',
    note: 'the hollow west of the ruin. i went past it four times.',
    draw(rng: Rng): string {
      // The meadow from above: pond, plateau, ruin, and one dotted route that
      // leaves the walked path and ends at the hollow the note names.
      let art = `<path class="croak-manual__ink-fill" d="${blob(88, 82, 52, 34, rng, 18)}"/>`;
      art += `<path class="croak-manual__hatch-fill" d="${blob(88, 82, 40, 25, rng, 16)}"/>`;
      art += `<path class="croak-manual__ink-line" d="${blob(30, 34, 20, 14, rng)}"/>`;
      art += `<path class="croak-manual__ink-line" d="${blob(148, 40, 17, 13, rng)}"/>`;
      // The ruin: three broken uprights, drawn as a plan.
      for (let i = 0; i < 3; i++) {
        art += `<rect class="croak-manual__ink-line" x="${18 + i * 11}" y="118" width="7" height="7"/>`;
      }
      art += dottedPath([
        [96, 140],
        [72, 128],
        [50, 130],
        [36, 122],
        [26, 112],
      ]);
      art += `<circle class="croak-manual__mark" cx="26" cy="112" r="5"/>`;
      art += `<path class="croak-manual__mark" d="M22,108L30,116M30,108L22,116"/>`;
      return art;
    },
  },
  {
    title: 'the roll',
    body: 'the first half of a roll cannot be hit the second half can this is the whole of it',
    note: 'count it. fourteen frames safe, twelve frames not. i learned that too late.',
    draw(rng: Rng): string {
      // A frame strip: 26 cells, the first 14 filled. The diagram IS the rule.
      let art = '';
      const cell = 6.2;
      for (let i = 0; i < 26; i++) {
        const x = 8 + i * cell;
        const safe = i < 14;
        art +=
          `<rect class="${safe ? 'croak-manual__cell-safe' : 'croak-manual__cell'}" ` +
          `x="${n2(x)}" y="30" width="${n2(cell - 1.1)}" height="22"/>`;
      }
      art += `<path class="croak-manual__ink-line" d="M8,58L${n2(8 + 14 * cell - 1.1)},58"/>`;
      // The frog, mid-roll, as three stamps of the same ball.
      for (let i = 0; i < 3; i++) {
        art += `<path class="croak-manual__ink-line" d="${blob(34 + i * 52, 96, 15, 15, rng, 12)}"/>`;
        art += `<path class="croak-manual__hatch-fill" d="${blob(34 + i * 52, 108, 17, 4, rng, 12)}"/>`;
      }
      // The stamina bar, running out.
      art += `<rect class="croak-manual__ink-line" x="8" y="128" width="160" height="12"/>`;
      art += `<rect class="croak-manual__cell-safe" x="10" y="130" width="44" height="8"/>`;
      art += `<path class="croak-manual__mark" d="M60,126L168,142M168,126L60,142"/>`;
      return art;
    },
  },
  {
    title: 'the tongue',
    body: 'small things come to you large things do not and what will not come is what you go to',
    note: 'the posts across the water are not scenery. chain them.',
    draw(rng: Rng): string {
      // Four rows, four masses. The last one draws the arrow the other way.
      let art = '';
      const rows = [12, 48, 84, 120];
      const sizes = [5, 9, 14, 18];
      for (let i = 0; i < rows.length; i++) {
        const y = rows[i];
        art += `<path class="croak-manual__ink-line" d="${blob(24, y + 14, 11, 11, rng, 12)}"/>`;
        const target = 140;
        art += `<path class="croak-manual__ink-line" d="${blob(target, y + 14, sizes[i], sizes[i], rng, 12)}"/>`;
        // Rows 1-3: the thing travels. Row 4: the frog does.
        const forward = i < 3;
        const from = forward ? target - sizes[i] - 4 : 24 + 13;
        const to = forward ? 24 + 13 : target - sizes[i] - 4;
        art += `<path class="croak-manual__route" d="M${n2(from)},${n2(y + 14)}L${n2(to)},${n2(y + 14)}"/>`;
        const head = to + (forward ? 7 : -7);
        art +=
          `<path class="croak-manual__mark" d="M${n2(to)},${n2(y + 14)}` +
          `L${n2(head)},${n2(y + 9)}M${n2(to)},${n2(y + 14)}L${n2(head)},${n2(y + 19)}"/>`;
      }
      return art;
    },
  },
  {
    title: 'the heron',
    body: 'it comes down once and if it misses it cannot lift its head for three whole breaths',
    note: 'behind the roof, past the broken arch. something is on the ledge.',
    draw(rng: Rng): string {
      // An anatomy sketch: legs, body, that neck, and the beak with a measure
      // line under it. The dive arc is annotated with its own tell.
      let art = '';
      art += `<path class="croak-manual__ink-line" d="M56,140L58,96M74,140L70,96"/>`;
      art += `<path class="croak-manual__ink-fill" d="${blob(66, 84, 22, 17, rng, 14)}"/>`;
      art += `<path class="croak-manual__ink-line" d="M70,70Q86,40 104,34"/>`;
      art += `<path class="croak-manual__ink-line" d="M104,34L146,26"/>`;
      art += `<circle class="croak-manual__mark" cx="103" cy="33" r="3"/>`;
      // Measure line under the beak.
      art += `<path class="croak-manual__route" d="M104,44L146,36"/>`;
      // The dive: a long arc that ends in a burst.
      art += `<path class="croak-manual__route" d="M30,26Q20,96 44,132"/>`;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        art +=
          `<path class="croak-manual__mark" d="M44,132L${n2(44 + Math.cos(a) * 13)},` +
          `${n2(132 + Math.sin(a) * 9)}"/>`;
      }
      return art;
    },
  },
];

// --------------------------------------------------------------- stylesheet

const CSS = `
.croak-manual{position:fixed;inset:0;display:flex;align-items:center;
justify-content:center;background:rgba(34,40,63,.72);opacity:0;
pointer-events:none;transition:opacity 220ms ease-out;z-index:20;}
.croak-manual.is-open{opacity:1;pointer-events:auto;}
.croak-manual__spread{width:min(94vw,980px);max-height:92vh;}
.croak-manual svg{display:block;width:100%;height:auto;overflow:visible;}
.croak-manual__paper{fill:var(--hero-belly,#f2e8c9);}
.croak-manual__shadow{fill:var(--ink,#3a2e28);opacity:.3;}
.croak-manual__grain{opacity:.5;}
.croak-manual__edge{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.6;
stroke-linejoin:round;}
.croak-manual__glyph{fill:none;stroke:var(--ink,#3a2e28);stroke-linecap:round;
stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.croak-manual__dot{fill:var(--ink,#3a2e28);stroke:none;}
.croak-manual__ink-line{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.7;
stroke-linejoin:round;stroke-linecap:round;}
.croak-manual__ink-fill{fill:var(--stone-shade,#b08d6e);stroke:var(--ink,#3a2e28);
stroke-width:1.7;stroke-linejoin:round;}
.croak-manual__hatch-fill{fill:var(--water-deep,#2b8fb5);opacity:.5;stroke:none;}
.croak-manual__cell{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.2;}
.croak-manual__cell-safe{fill:var(--hero-body,#6fbf4b);stroke:var(--ink,#3a2e28);
stroke-width:1.2;}
.croak-manual__route{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.8;
stroke-dasharray:3 4.5;stroke-linecap:round;}
.croak-manual__mark{fill:none;stroke:var(--tongue,#f4846c);stroke-width:2;
stroke-linecap:round;}
.croak-pen{stroke:var(--water-deep,#2b8fb5);stroke-linecap:round;
stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.croak-manual__slot{fill:var(--stone-shade,#b08d6e);opacity:.22;}
.croak-manual__stain{fill:var(--stone-shade,#b08d6e);opacity:.28;}
.croak-manual__tape{fill:var(--haze-sky,#cde8ea);opacity:.55;
stroke:var(--ink,#3a2e28);stroke-width:.7;}
.croak-manual__tab{fill:var(--gold,#f2c14e);stroke:var(--ink,#3a2e28);
stroke-width:1.4;}
.croak-manual__tab--empty{fill:none;}
.croak-manual__turn{transition:transform 260ms ease-in-out;transform-origin:50% 50%;}
.croak-manual.is-turning .croak-manual__turn{transform:scaleX(.04);}
`;

let styleElement: HTMLStyleElement | null = null;
let styleUsers = 0;

function retainStyle(): void {
  styleUsers++;
  if (styleElement !== null) return;
  styleElement = document.createElement('style');
  styleElement.id = 'croak-manual-style';
  styleElement.textContent = CSS;
  document.head.appendChild(styleElement);
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0 || styleElement === null) return;
  styleElement.remove();
  styleElement = null;
}

// -------------------------------------------------------------------- api

export interface Manual {
  readonly root: HTMLElement;
  readonly open: boolean;
  /** Which spread is showing: 0 for pages 1-2, 1 for pages 3-4. */
  readonly spread: number;
  toggle(): void;
  close(): void;
  /** Step to the next spread, with the turn. */
  turn(direction: number): void;
  /** Which pages the player has. Re-renders if it changed. */
  setFound(pages: readonly number[]): void;
  /** A page just came in: open on it and hold. Section 7's full-screen reveal. */
  reveal(index: number): void;
  dispose(): void;
}

export function createManual(parent: HTMLElement | null, rng: Rng): Manual {
  const host = parent ?? document.getElementById('hud') ?? document.body;
  const ink = rng.fork('manual:ink');
  retainStyle();

  const root = document.createElement('div');
  root.className = 'croak-manual';
  root.setAttribute('aria-hidden', 'true');

  const spreadEl = document.createElement('div');
  spreadEl.className = 'croak-manual__spread';
  root.appendChild(spreadEl);
  host.appendChild(root);

  let open = false;
  let spread = 0;
  let found: number[] = [];
  let turning = false;
  let turnTimer = 0;

  /**
   * The overlay handles its own taps, and it HAS to: it sits above the touch
   * controls (z 20 over z 5) with pointer-events on while open, so on a phone
   * it swallows every tap - including the taps on the buttons that would close
   * it. Without this handler, a touch-only player who picked up their first
   * page was permanently stuck on the booklet screen.
   *
   * The zones are the obvious ones: the outer third of the spread turns the
   * page toward that side, anywhere else - the middle of the spread or the
   * backdrop around it - closes the book. Click events fire for taps too, so
   * one listener covers mouse and touch alike.
   */
  function onTap(event: MouseEvent): void {
    if (!open) return;
    const rect = spreadEl.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (inside) {
      const across = (event.clientX - rect.left) / Math.max(1, rect.width);
      if (across < 1 / 3) {
        turn(-1);
        return;
      }
      if (across > 2 / 3) {
        turn(1);
        return;
      }
    }
    setOpen(false);
  }
  root.addEventListener('click', onTap);

  /** One leaf, either the page or the gap where it will go. */
  function leaf(index: number, x: number): string {
    const have = found.includes(index);
    const art = PAGES[index];
    let markup =
      `<g transform="translate(${n2(x)},0)">` +
      `<rect class="croak-manual__shadow" x="3" y="4" width="${PAGE_W}" height="${PAGE_H}" rx="3"/>` +
      `<rect class="croak-manual__paper" x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" rx="3"/>` +
      `<rect class="croak-manual__grain" x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" ` +
      `rx="3" fill="url(#croak-manual-dots)"/>`;

    // Coffee ring and a strip of tape: the booklet has had a life.
    markup +=
      `<circle class="croak-manual__stain" cx="${n2(PAGE_W - 34)}" cy="${n2(PAGE_H - 40)}" r="21"/>` +
      `<circle class="croak-manual__paper" cx="${n2(PAGE_W - 34)}" cy="${n2(PAGE_H - 40)}" r="16"/>`;
    if (index % 2 === 1) {
      markup += `<rect class="croak-manual__tape" x="-8" y="46" width="26" height="13" transform="rotate(-8 5 52)"/>`;
    }

    if (!have) {
      // The gap. A torn rectangle and a drawn question mark - the shape of the
      // thing you have not got yet, which is the whole collection hook.
      markup +=
        `<rect class="croak-manual__slot" x="${MARGIN}" y="${MARGIN}" ` +
        `width="${PAGE_W - MARGIN * 2}" height="${PAGE_H - MARGIN * 2}"/>`;
      const cx = PAGE_W / 2;
      const cy = PAGE_H / 2;
      markup +=
        `<path class="croak-manual__edge" stroke-width="5" fill="none" ` +
        `d="M${n2(cx - 22)},${n2(cy - 24)}Q${n2(cx - 22)},${n2(cy - 54)} ${n2(cx)},${n2(cy - 54)}` +
        `Q${n2(cx + 26)},${n2(cy - 54)} ${n2(cx + 26)},${n2(cy - 26)}` +
        `Q${n2(cx + 26)},${n2(cy - 2)} ${n2(cx)},${n2(cy + 8)}L${n2(cx)},${n2(cy + 24)}"/>` +
        `<circle class="croak-manual__edge" cx="${n2(cx)}" cy="${n2(cy + 42)}" r="4"/>`;
      return `${markup}</g>`;
    }

    markup += croakicLine(art.title, MARGIN, MARGIN + 12, 13);
    markup += `<path class="croak-manual__ink-line" d="M${MARGIN},${MARGIN + 24}L${PAGE_W - MARGIN},${MARGIN + 24}"/>`;
    markup += `<g transform="translate(${MARGIN + 4},${MARGIN + 36})">${art.draw(ink.fork(`page:${index}`))}</g>`;
    markup += croakicBlock(art.body, MARGIN, MARGIN + 208, 8.5, 5);
    markup += penParagraph(
      art.note,
      MARGIN + 4,
      PAGE_H - 34,
      PAGE_W - MARGIN * 2 - 8,
      ink.fork(`note:${index}`),
      { size: 11 },
    ).markup;
    markup += `<rect class="croak-manual__edge" x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" rx="3"/>`;
    return `${markup}</g>`;
  }

  function render(): void {
    const left = spread * 2;
    const right = left + 1;
    // Index tabs down the right edge: one per page, filled once found. The
    // player can see how many are left without a number anywhere.
    let tabs = '';
    for (let i = 0; i < PAGE_TOTAL; i++) {
      tabs +=
        `<rect class="croak-manual__tab${found.includes(i) ? '' : ' croak-manual__tab--empty'}" ` +
        `x="${SPREAD_W + 4}" y="${n2(30 + i * 26)}" width="14" height="18" rx="3"/>`;
    }
    spreadEl.innerHTML = `
<svg viewBox="-6 -6 ${SPREAD_W + 34} ${PAGE_H + 12}" aria-hidden="true">
  <defs>
    <pattern id="croak-manual-dots" width="6" height="6" patternUnits="userSpaceOnUse">
      <circle cx="1.4" cy="1.4" r=".9" fill="var(--stone-shade,#b08d6e)"/>
      <circle cx="4.4" cy="4.4" r=".65" fill="var(--stone-shade,#b08d6e)"/>
    </pattern>
  </defs>
  <g class="croak-manual__turn">
    ${leaf(left, 0)}
    ${leaf(right, PAGE_W + GUTTER)}
  </g>
  ${tabs}
</svg>`;
  }

  render();

  function setOpen(next: boolean): void {
    open = next;
    root.classList.toggle('is-open', open);
    root.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function turn(direction: number): void {
    const spreads = Math.ceil(PAGE_TOTAL / 2);
    const next = Math.max(0, Math.min(spreads - 1, spread + Math.sign(direction)));
    if (next === spread || turning) return;
    spread = next;
    turning = true;
    root.classList.add('is-turning');
    // The leaf collapses, the content swaps behind it, and it opens again.
    // Doing the swap on a timer rather than a transitionend keeps it honest
    // if the page is not composited (a headless run still turns the page).
    turnTimer = window.setTimeout(() => {
      render();
      root.classList.remove('is-turning');
      turning = false;
    }, 260);
  }

  return {
    root,
    get open(): boolean {
      return open;
    },
    get spread(): number {
      return spread;
    },

    toggle(): void {
      setOpen(!open);
    },

    close(): void {
      setOpen(false);
    },

    turn,

    setFound(pages: readonly number[]): void {
      const next = [...pages].sort((a, b) => a - b);
      if (next.join(',') === found.join(',')) return;
      found = next;
      render();
    },

    reveal(index: number): void {
      spread = Math.floor(index / 2);
      render();
      setOpen(true);
    },

    dispose(): void {
      window.clearTimeout(turnTimer);
      root.removeEventListener('click', onTap);
      root.remove();
      releaseStyle();
    },
  };
}

/** What each page decodes to, for the gate to check against. Not shipped as UI. */
export const PAGE_TEXT: readonly { title: string; body: string; note: string }[] = PAGES.map(
  (page) => ({ title: page.title, body: page.body, note: page.note }),
);
