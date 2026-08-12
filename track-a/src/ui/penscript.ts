/**
 * CROAK - the previous owner's handwriting. PROMPT.md sections 7 and 9 rule 12.
 *
 * Section 7 asks for "hand-scrawled pen margin notes by a previous owner, in
 * plain English" - they are the player's real hints, so they have to be legible
 * English, not Croakic. Rule 12 forbids shipping a font. Both hold at once only
 * if every letter is DRAWN, so every letter is drawn: a single-weight cursive-ish
 * hand on the same 6x10 box the HUD's numerals use, wobbled per glyph from the
 * run's seeded stream so no two "e"s are the same shape.
 *
 * Lowercase only, and that is a choice rather than a shortcut: a frog scribbling
 * in the margin of a manual it is about to die holding does not capitalise.
 */

import type { Rng } from '../core/types';

/** Box metrics. Baseline 8, x-height top 4.6, ascender 2, descender 10. */
export const PEN_ADVANCE = 5.4;
export const PEN_SPACE = 2.8;
export const PEN_BOX = { width: 6, height: 10, baseline: 8 };

/**
 * One path per letter, drawn in stroke order. Quadratics where a pen would
 * curve, lines where it would not.
 */
const LETTERS: Readonly<Record<string, string>> = {
  a: 'M4.6,4.6L4.6,8M4.6,5.4Q1,4.4 1,6.3Q1,8.2 4.6,7.2',
  b: 'M1,2L1,8M1,6.3Q1,4.6 3,4.6Q5,4.6 5,6.3Q5,8 3,8Q1,8 1,6.3',
  c: 'M5,5.2Q1,3.8 1,6.3Q1,8.8 5,7.2',
  d: 'M5,2L5,8M5,6.3Q5,4.6 3,4.6Q1,4.6 1,6.3Q1,8 3,8Q5,8 5,6.3',
  e: 'M1,6.3L4.8,6.3Q4.9,4.6 3,4.6Q1,4.6 1,6.3Q1,8.2 4.7,7.2',
  f: 'M4.4,2.2Q2.4,1.7 2.4,4.2L2.4,8M1.2,4.9L4,4.9',
  g: 'M5,4.6L5,9.2Q5,10.7 2.3,10M5,6.3Q5,4.6 3,4.6Q1,4.6 1,6.3Q1,8 3,8Q5,8 5,6.3',
  h: 'M1,2L1,8M1,5.7Q1.6,4.5 3,4.6Q4.6,4.7 4.6,6.1L4.6,8',
  i: 'M3,4.6L3,8M3,2.7L3,3.3',
  j: 'M4,4.6L4,9.2Q4,10.7 1.8,10M4,2.7L4,3.3',
  k: 'M1,2L1,8M4.8,4.7L1.4,6.8M2.4,6.2L4.8,8',
  l: 'M2.6,2L2.6,7.2Q2.6,8.2 3.9,7.9',
  m: 'M1,4.6L1,8M1,5.6Q1.4,4.6 2.3,4.6Q3.1,4.6 3.1,5.9L3.1,8M3.1,5.6Q3.5,4.6 4.4,4.6Q5.2,4.6 5.2,5.9L5.2,8',
  n: 'M1,4.6L1,8M1,5.7Q1.6,4.5 3,4.6Q4.6,4.7 4.6,6.1L4.6,8',
  o: 'M3,4.6Q1,4.6 1,6.3Q1,8 3,8Q5,8 5,6.3Q5,4.6 3,4.6',
  p: 'M1,4.6L1,10M1,6.3Q1,4.6 3,4.6Q5,4.6 5,6.3Q5,8 3,8Q1,8 1,6.3',
  q: 'M5,4.6L5,10M5,6.3Q5,4.6 3,4.6Q1,4.6 1,6.3Q1,8 3,8Q5,8 5,6.3',
  r: 'M1.4,4.6L1.4,8M1.4,5.8Q2,4.5 4.4,4.8',
  s: 'M4.8,5Q1.2,3.9 1.2,5.8Q1.2,6.7 3,6.4Q4.8,6.1 4.8,7Q4.8,8.9 1.2,7.6',
  t: 'M2.6,2.6L2.6,7.2Q2.6,8.2 4.2,7.9M1.2,4.7L4.2,4.7',
  u: 'M1,4.6L1,7Q1,8.1 2.6,8Q4.4,7.9 4.4,6.6L4.4,4.6M4.4,6.6L4.4,8',
  v: 'M1,4.6L3,8L5,4.6',
  w: 'M1,4.6L2,8L3,5.6L4,8L5,4.6',
  x: 'M1,4.6L5,8M5,4.6L1,8',
  y: 'M1,4.6L3,8M5,4.6L2.2,10',
  z: 'M1,4.8L4.8,4.8L1,8L5,8',
  '0': 'M3,2Q1,2 1,5Q1,8 3,8Q5,8 5,5Q5,2 3,2',
  '1': 'M1.6,3.2L3,2L3,8',
  '2': 'M1,2.8Q1.6,2 3,2Q5,2 5,3.8Q5,5.2 1,8L5,8',
  '3': 'M1.2,2.4Q3,1.7 4.4,2.6Q5.2,3.6 3,4.9Q5.4,5.2 5,6.8Q4.4,8.6 1.2,7.6',
  '4': 'M4.1,8L4.1,2L1,6L5,6',
  '5': 'M5,2L1.4,2L1,5Q3,4.2 4.4,5.2Q5.4,6.2 4.6,7.4Q3.6,8.6 1.2,7.8',
  '6': 'M4.6,2.2Q1,2.6 1,6Q1,8 3,8Q5,8 5,6.3Q5,4.8 3,4.8Q1.2,4.8 1,6',
  '7': 'M1,2L5,2L2.5,8',
  '8': 'M3,4.9Q1.2,4.9 1.2,6.4Q1.2,8 3,8Q4.8,8 4.8,6.4Q4.8,4.9 3,4.9Q1.5,4.9 1.5,3.5Q1.5,2 3,2Q4.5,2 4.5,3.5Q4.5,4.9 3,4.9',
  '9': 'M1.4,7.8Q5,7.4 5,4Q5,2 3,2Q1,2 1,3.7Q1,5.2 3,5.2Q4.8,5.2 5,4',
  '.': 'M2.9,7.7L3.1,8',
  ',': 'M3.2,7.6Q3.3,8.7 2.4,9.2',
  "'": 'M3,2.6Q3.3,3.2 2.8,3.7',
  '!': 'M3,2.4L3,6.4M2.9,7.7L3.1,8',
  '?': 'M1.4,3.4Q1.6,2 3,2Q4.6,2 4.6,3.5Q4.6,4.7 3,5.3L3,6.4M2.9,7.7L3.1,8',
  '-': 'M1.4,6.2L4.6,6.2',
  ':': 'M2.9,4.7L3.1,5M2.9,7.7L3.1,8',
  ';': 'M2.9,4.7L3.1,5M3.2,7.6Q3.3,8.7 2.4,9.2',
  '(': 'M4,2Q2,5 4,8',
  ')': 'M2,2Q4,5 2,8',
};

const n2 = (value: number): string => value.toFixed(2);

export interface PenOptions {
  /** Height of one line, in the caller's user units. Width follows from it. */
  size?: number;
  /** Stroke width, as a fraction of `size`. */
  weight?: number;
  /** Extra slant, radians. A pen held at an angle is what makes it a hand. */
  slant?: number;
  className?: string;
}

/**
 * Set `text` as one line of handwriting starting at (x, y), where y is the
 * BASELINE. Returns SVG markup plus the width consumed, so a caller can wrap.
 */
export function penLine(
  text: string,
  x: number,
  y: number,
  rng: Rng,
  options: PenOptions = {},
): { markup: string; width: number } {
  const size = options.size ?? 10;
  const scale = size / PEN_BOX.height;
  const weight = (options.weight ?? 0.11) * size;
  const slant = options.slant ?? 0.12;
  const className = options.className ?? 'croak-pen';

  let cursor = 0;
  let markup = '';
  for (const raw of text.toLowerCase()) {
    if (raw === ' ') {
      cursor += PEN_SPACE * scale;
      continue;
    }
    const glyph = LETTERS[raw];
    if (glyph === undefined) {
      cursor += PEN_SPACE * scale;
      continue;
    }
    // Every letter gets its own tiny baseline hop, tilt and scale. Identical
    // letters are the single clearest tell that something was typeset rather
    // than written, and this page is meant to look written.
    const hop = rng.range(-0.055, 0.055) * size;
    const tilt = slant + rng.range(-0.045, 0.045);
    const squeeze = 1 + rng.range(-0.04, 0.04);
    markup +=
      `<path class="${className}" fill="none" stroke-width="${n2(weight)}" ` +
      `transform="translate(${n2(x + cursor)},${n2(y + hop)}) ` +
      `scale(${n2(scale * squeeze)},${n2(scale)}) ` +
      `skewX(${n2((-tilt * 180) / Math.PI)}) translate(0,${-PEN_BOX.baseline})" ` +
      `d="${glyph}"/>`;
    cursor += PEN_ADVANCE * scale * squeeze;
  }
  return { markup, width: cursor };
}

/**
 * Wrap `text` to `maxWidth` and set it as several lines. Breaks on spaces only,
 * because a pen note that hyphenates is a pen note nobody wrote.
 */
export function penParagraph(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  rng: Rng,
  options: PenOptions = {},
): { markup: string; height: number } {
  const size = options.size ?? 10;
  const lineHeight = size * 1.35;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const scale = size / PEN_BOX.height;

  const widthOf = (word: string): number => {
    let width = 0;
    for (const letter of word.toLowerCase()) {
      width += letter === ' ' || LETTERS[letter] === undefined ? PEN_SPACE * scale : PEN_ADVANCE * scale;
    }
    return width;
  };

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (widthOf(candidate) > maxWidth && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(line);

  let markup = '';
  for (let i = 0; i < lines.length; i++) {
    markup += penLine(lines[i], x, y + i * lineHeight, rng, options).markup;
  }
  return { markup, height: lines.length * lineHeight };
}
