/**
 * CROAK - the letter inside the front cover. Playtest verdict on the build
 * before this file existed: "there is no story whatsoever". This is the story,
 * delivered the only way this game delivers anything written (section 9 rule
 * 12): drawn. A sheet of the same paper the manual is printed on, covered in
 * the previous owner's hand - the same pen that scrawls the margin notes - and
 * a Croakic heading for anyone who has worked the cipher out.
 *
 * It says, in one page: whose book this was, what the Heron took, why the frog
 * is the one going after it, and what done looks like. Every margin note in
 * the manual is signed by the same hand, so the letter is not a lore dump
 * bolted on - it is the voice the player will keep meeting.
 *
 * It appears once, on boot, over the live meadow (rule 13: the first screen is
 * the game - the world is running its rain of light behind the paper, and one
 * tap puts you in it). The world holds its breath while it is up, exactly like
 * the manual, and any verb or tap dismisses it.
 */

import type { Rng } from '../core/types';
import { layout, write } from './croakic';
import { penParagraph } from './penscript';

const SHEET_W = 420;
const SHEET_H = 296;
const MARGIN = 26;
const PEN_SIZE = 11;

const n2 = (value: number): string => value.toFixed(2);

/** The heading, set in Croakic. Decodes for anyone who has earned it. */
const HEADING = 'for whoever comes after';

/** The letter itself. Lowercase: a tired hand, not a proclamation. */
const PARAGRAPHS: readonly string[] = [
  'this book belonged to the bell keeper of the sunken belfry. last night the heron came back for him, and four pages went with it, scattered where it flew.',
  'i am too old to climb after them. you are small and quick, and the bird does not know your shape yet.',
  'find the pages. read what he knew. then climb the tower and put that shadow back into the sky.',
  'the notes in the margins are mine. trust them. - m',
];

const CSS = `
.croak-letter{position:fixed;inset:0;display:flex;align-items:center;
justify-content:center;background:rgba(34,40,63,.62);opacity:0;
pointer-events:none;transition:opacity 260ms ease-out;z-index:22;}
.croak-letter.is-open{opacity:1;pointer-events:auto;}
.croak-letter__sheet{width:min(88vw,640px);max-height:90vh;
transform:rotate(-1.6deg);}
.croak-letter svg{display:block;width:100%;height:auto;overflow:visible;}
.croak-letter__shadow{fill:var(--ink,#3a2e28);opacity:.32;}
.croak-letter__paper{fill:var(--hero-belly,#f2e8c9);}
.croak-letter__edge{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.6;
stroke-linejoin:round;}
.croak-letter__glyph{fill:none;stroke:var(--ink,#3a2e28);stroke-linecap:round;
stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.croak-letter__dot{fill:var(--ink,#3a2e28);stroke:none;}
.croak-letter__rule{fill:none;stroke:var(--ink,#3a2e28);stroke-width:1.4;
stroke-linecap:round;}
.croak-letter__pen{stroke:var(--water-deep,#2b8fb5);stroke-linecap:round;
stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.croak-letter__stain{fill:var(--stone-shade,#b08d6e);opacity:.26;}
`;

let styleElement: HTMLStyleElement | null = null;
let styleUsers = 0;

function retainStyle(): void {
  styleUsers++;
  if (styleElement !== null) return;
  styleElement = document.createElement('style');
  styleElement.id = 'croak-letter-style';
  styleElement.textContent = CSS;
  document.head.appendChild(styleElement);
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0 || styleElement === null) return;
  styleElement.remove();
  styleElement = null;
}

function croakicLine(text: string, x: number, y: number, size: number): string {
  const { strokes, dots } = layout(write(text));
  let markup =
    `<g class="croak-letter__glyph" transform="translate(${n2(x)},${n2(y)}) ` +
    `scale(${n2(size)})" stroke-width="0.11">`;
  for (const s of strokes) {
    markup += `<path d="M${n2(s.x1)},${n2(s.y1)}L${n2(s.x2)},${n2(s.y2)}"/>`;
  }
  for (const d of dots) {
    markup += `<circle cx="${n2(d.x)}" cy="${n2(d.y)}" r="${n2(d.r)}" class="croak-letter__dot"/>`;
  }
  return `${markup}</g>`;
}

export interface Letter {
  readonly root: HTMLElement;
  readonly open: boolean;
  close(): void;
  dispose(): void;
}

export function createLetter(parent: HTMLElement | null, rng: Rng): Letter {
  const host = parent ?? document.getElementById('hud') ?? document.body;
  const ink = rng.fork('letter:ink');
  retainStyle();

  const root = document.createElement('div');
  root.className = 'croak-letter is-open';
  root.setAttribute('aria-hidden', 'false');

  // The body is laid out top to bottom; each paragraph reports its height.
  let body = '';
  let cursor = 64;
  for (const paragraph of PARAGRAPHS) {
    const set = penParagraph(
      paragraph,
      MARGIN,
      cursor,
      SHEET_W - MARGIN * 2,
      ink.fork(`p:${cursor}`),
      { size: PEN_SIZE, className: 'croak-letter__pen' },
    );
    body += set.markup;
    cursor += set.height + PEN_SIZE * 0.8;
  }

  const sheet = document.createElement('div');
  sheet.className = 'croak-letter__sheet';
  sheet.innerHTML = `
<svg viewBox="-8 -8 ${SHEET_W + 16} ${SHEET_H + 16}" aria-hidden="true">
  <rect class="croak-letter__shadow" x="5" y="7" width="${SHEET_W}" height="${SHEET_H}" rx="3"/>
  <rect class="croak-letter__paper" x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" rx="3"/>
  <circle class="croak-letter__stain" cx="${SHEET_W - 52}" cy="${SHEET_H - 46}" r="19"/>
  <circle class="croak-letter__paper" cx="${SHEET_W - 52}" cy="${SHEET_H - 46}" r="14"/>
  ${croakicLine(HEADING, MARGIN, 26, 10)}
  <path class="croak-letter__rule" d="M${MARGIN},40L${SHEET_W - MARGIN},40"/>
  ${body}
  <rect class="croak-letter__edge" x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" rx="3"/>
</svg>`;
  root.appendChild(sheet);
  host.appendChild(root);

  let open = true;

  function close(): void {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
  }

  // Any tap anywhere on the overlay is "yes, i have read it".
  function onTap(): void {
    close();
  }
  root.addEventListener('click', onTap);

  return {
    root,
    get open(): boolean {
      return open;
    },
    close,
    dispose(): void {
      root.removeEventListener('click', onTap);
      root.remove();
      releaseStyle();
    },
  };
}

/** What the letter decodes to, for the gate. Not shipped as UI. */
export const LETTER_TEXT = { heading: HEADING, paragraphs: PARAGRAPHS };
