/**
 * CROAKIC - the frogs' writing. PROMPT.md section 7.
 *
 * An ORIGINAL hexagon-frame phonemic cipher, structurally inspired by Tunic's
 * Trunic and sharing none of its assignments. Everything a reader needs to
 * break it is in this file and nowhere else: section 7 requires the key to ship
 * as a source comment and NEVER in the UI, because the pleasure of the thing is
 * that a player can work it out with a pencil.
 *
 * ================================ THE KEY =================================
 *
 * One glyph is one SYLLABLE, drawn inside a pointy-top hexagon that sits on a
 * continuous horizontal midline running through the whole word.
 *
 *   - the SIX OUTER EDGES of the hexagon spell the VOWEL.
 *   - the FIVE INNER SPOKES (centre to a vertex, plus the two half-midlines)
 *     spell the CONSONANT.
 *   - a DOT BELOW the glyph reverses the reading: normally the consonant is
 *     read before the vowel, and with the dot the vowel comes first. That is
 *     how a syllable that ends in a consonant is written.
 *   - a gap in the midline is a word break.
 *
 * Each phoneme is a SUBSET of its strokes, written below as a bitmask.
 *
 * OUTER EDGES, numbered clockwise from the top-right edge:
 *     bit 0  upper right      bit 3  lower left
 *     bit 1  lower right      bit 4  upper left
 *     bit 2  bottom           bit 5  top
 *
 * INNER SPOKES:
 *     bit 0  up               bit 3  down-left
 *     bit 1  down-right       bit 4  the stem below the centre
 *     bit 2  the two half-midlines (left and right of centre)
 *
 * VOWELS (ARPAbet)          CONSONANTS (ARPAbet)
 *   IY  100001   as in bee    P  00001     B  00011
 *   IH  000001   bit          T  00010     D  00110
 *   EY  100011   bay          K  00100     G  01100
 *   EH  000011   bet          F  01000     V  11000
 *   AE  000010   bat          TH 10000     DH 10001
 *   AA  000110   father       S  00101     Z  01101
 *   AO  000100   bought       SH 01010     ZH 11010
 *   OW  001100   boat         CH 10100     JH 10110
 *   UH  001000   book         M  00111     N  01110
 *   UW  011000   boot         NG 11100     L  10011
 *   AH  010000   but          R  11001     W  10010
 *   ER  010001   bird         Y  01001     H  10101
 *   AY  110000   buy
 *   OY  101000   boy
 *   AW  100100   how
 *
 * ==========================================================================
 *
 * The unit of the cipher is the PHONEME, not the letter, so encode/decode round
 * trip exactly over phoneme strings - which is what `tests/croakic.mjs` asserts.
 * English spelling is not recoverable from sound (there is no way back from
 * /r et/ to "wright" rather than "right"), so `transcribe()` is documented as
 * one-way and is used only to author signage; the round-trip guarantee lives at
 * the phoneme layer where it can actually be kept.
 */

// ------------------------------------------------------------------ the key

export const VOWELS: Readonly<Record<string, number>> = {
  IY: 0b100001,
  IH: 0b000001,
  EY: 0b100011,
  EH: 0b000011,
  AE: 0b000010,
  AA: 0b000110,
  AO: 0b000100,
  OW: 0b001100,
  UH: 0b001000,
  UW: 0b011000,
  AH: 0b010000,
  ER: 0b010001,
  AY: 0b110000,
  OY: 0b101000,
  AW: 0b100100,
};

export const CONSONANTS: Readonly<Record<string, number>> = {
  P: 0b00001,
  B: 0b00011,
  T: 0b00010,
  D: 0b00110,
  K: 0b00100,
  G: 0b01100,
  F: 0b01000,
  V: 0b11000,
  TH: 0b10000,
  DH: 0b10001,
  S: 0b00101,
  Z: 0b01101,
  SH: 0b01010,
  ZH: 0b11010,
  CH: 0b10100,
  JH: 0b10110,
  M: 0b00111,
  N: 0b01110,
  NG: 0b11100,
  L: 0b10011,
  R: 0b11001,
  W: 0b10010,
  Y: 0b01001,
  H: 0b10101,
};

/** Reverse lookups, built once. A mask decodes to exactly one phoneme. */
const VOWEL_BY_MASK = new Map<number, string>();
for (const [name, mask] of Object.entries(VOWELS)) VOWEL_BY_MASK.set(mask, name);
const CONSONANT_BY_MASK = new Map<number, string>();
for (const [name, mask] of Object.entries(CONSONANTS)) CONSONANT_BY_MASK.set(mask, name);

/**
 * One drawn syllable. `null` in a glyph stream is a word break - a gap in the
 * midline rather than a mark of its own.
 */
export interface Glyph {
  /** Inner-spoke mask, 0 for a bare vowel. */
  consonant: number;
  /** Outer-edge mask, 0 for a bare consonant. */
  vowel: number;
  /** The dot: read the vowel first. */
  reversed: boolean;
}

export type GlyphStream = readonly (Glyph | null)[];

export const isVowel = (phoneme: string): boolean =>
  Object.prototype.hasOwnProperty.call(VOWELS, phoneme);
export const isConsonant = (phoneme: string): boolean =>
  Object.prototype.hasOwnProperty.call(CONSONANTS, phoneme);

// ------------------------------------------------------------------ encode

/**
 * Phonemes to glyphs. `words` is a list of words, each a list of phonemes.
 *
 * Packing is greedy and deterministic, which is what makes it invertible:
 *   consonant + following vowel  -> one glyph, read forwards
 *   vowel + following consonant  -> one glyph, read backwards (the dot)
 *   anything left over           -> a glyph with one half empty
 *
 * A consonant CLUSTER is not packed into one glyph; each consonant that cannot
 * take a vowel gets its own. Frogs, apparently, do not hold their breath.
 */
export function encodeWord(phonemes: readonly string[]): Glyph[] {
  const glyphs: Glyph[] = [];
  let i = 0;
  while (i < phonemes.length) {
    const here = phonemes[i];
    const next = i + 1 < phonemes.length ? phonemes[i + 1] : null;

    if (isConsonant(here) && next !== null && isVowel(next)) {
      glyphs.push({ consonant: CONSONANTS[here], vowel: VOWELS[next], reversed: false });
      i += 2;
      continue;
    }
    if (isVowel(here) && next !== null && isConsonant(next)) {
      glyphs.push({ consonant: CONSONANTS[next], vowel: VOWELS[here], reversed: true });
      i += 2;
      continue;
    }
    if (isConsonant(here)) {
      glyphs.push({ consonant: CONSONANTS[here], vowel: 0, reversed: false });
    } else if (isVowel(here)) {
      glyphs.push({ consonant: 0, vowel: VOWELS[here], reversed: false });
    } else {
      throw new Error(`croakic: "${here}" is not a phoneme`);
    }
    i += 1;
  }
  return glyphs;
}

export function encode(words: readonly (readonly string[])[]): GlyphStream {
  const out: (Glyph | null)[] = [];
  for (let w = 0; w < words.length; w++) {
    if (w > 0) out.push(null);
    out.push(...encodeWord(words[w]));
  }
  return out;
}

// ------------------------------------------------------------------ decode

export function decodeGlyph(glyph: Glyph): string[] {
  let consonant: string | null = null;
  if (glyph.consonant !== 0) {
    const found = CONSONANT_BY_MASK.get(glyph.consonant);
    if (found === undefined) {
      throw new Error(`croakic: no consonant for mask ${glyph.consonant}`);
    }
    consonant = found;
  }
  let vowel: string | null = null;
  if (glyph.vowel !== 0) {
    const found = VOWEL_BY_MASK.get(glyph.vowel);
    if (found === undefined) {
      throw new Error(`croakic: no vowel for mask ${glyph.vowel}`);
    }
    vowel = found;
  }
  if (consonant === null && vowel === null) return [];
  if (consonant === null) return [vowel as string];
  if (vowel === null) return [consonant];
  return glyph.reversed ? [vowel, consonant] : [consonant, vowel];
}

export function decode(stream: GlyphStream): string[][] {
  const words: string[][] = [];
  let current: string[] = [];
  for (const glyph of stream) {
    if (glyph === null) {
      words.push(current);
      current = [];
      continue;
    }
    current.push(...decodeGlyph(glyph));
  }
  words.push(current);
  return words;
}

// -------------------------------------------------------------- transcribe

/**
 * English spelling to phonemes. ONE WAY, and deliberately so - see the header.
 * It is a small deterministic rule set, not a dictionary: enough to set the
 * signage and the manual's body text in a way that decodes back to something a
 * player can read aloud and recognise. Longer digraphs are matched first.
 */
const SPELLING: readonly (readonly [string, readonly string[]])[] = [
  // Vowel teams and r-coloured vowels before anything shorter can steal them.
  ['ough', ['AO']],
  ['augh', ['AO']],
  ['tion', ['SH', 'AH', 'N']],
  ['ing', ['IH', 'NG']],
  ['ight', ['AY', 'T']],
  ['air', ['EH', 'R']],
  ['ear', ['IH', 'R']],
  ['eer', ['IY', 'R']],
  ['oor', ['UH', 'R']],
  ['our', ['AW', 'R']],
  ['ar', ['AA', 'R']],
  ['or', ['AO', 'R']],
  ['er', ['ER']],
  ['ir', ['ER']],
  ['ur', ['ER']],
  ['ee', ['IY']],
  ['ea', ['IY']],
  ['ie', ['AY']],
  ['ai', ['EY']],
  ['ay', ['EY']],
  ['oa', ['OW']],
  ['oe', ['OW']],
  ['oo', ['UW']],
  ['ou', ['AW']],
  ['ow', ['AW']],
  ['oi', ['OY']],
  ['oy', ['OY']],
  ['au', ['AO']],
  ['aw', ['AO']],
  // Consonant digraphs.
  ['tch', ['CH']],
  ['dge', ['JH']],
  ['sh', ['SH']],
  ['ch', ['CH']],
  ['th', ['TH']],
  ['ph', ['F']],
  ['wh', ['W']],
  ['ck', ['K']],
  ['ng', ['NG']],
  ['qu', ['K', 'W']],
  // Singles.
  ['a', ['AE']],
  ['b', ['B']],
  ['c', ['K']],
  ['d', ['D']],
  ['e', ['EH']],
  ['f', ['F']],
  ['g', ['G']],
  ['h', ['H']],
  ['i', ['IH']],
  ['j', ['JH']],
  ['k', ['K']],
  ['l', ['L']],
  ['m', ['M']],
  ['n', ['N']],
  ['o', ['AA']],
  ['p', ['P']],
  ['r', ['R']],
  ['s', ['S']],
  ['t', ['T']],
  ['u', ['AH']],
  ['v', ['V']],
  ['w', ['W']],
  ['x', ['K', 'S']],
  ['y', ['Y']],
  ['z', ['Z']],
];

export function transcribeWord(word: string): string[] {
  const lower = word.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < lower.length) {
    let matched = false;
    for (const [spelling, phonemes] of SPELLING) {
      if (!lower.startsWith(spelling, i)) continue;
      out.push(...phonemes);
      i += spelling.length;
      matched = true;
      break;
    }
    // Anything the table does not know (punctuation, digits) is simply not
    // sound, so it is not written.
    if (!matched) i += 1;
  }
  return out;
}

export function transcribe(text: string): string[][] {
  return text
    .split(/\s+/)
    .map((word) => transcribeWord(word))
    .filter((phonemes) => phonemes.length > 0);
}

/** The whole pipeline, for signage: English in, glyphs out. */
export function write(text: string): GlyphStream {
  return encode(transcribe(text));
}

// ------------------------------------------------------------------ drawing
// Pure geometry, in a 1-unit-tall glyph box centred on (0, 0). Callers scale.

/** Hexagon half-width and half-height, pointy-top, midline through the waist. */
const HX = 0.42;
const HY = 0.5;

/** Vertices, clockwise from the top point. */
const V: readonly (readonly [number, number])[] = [
  [0, -HY],
  [HX, -HY * 0.5],
  [HX, HY * 0.5],
  [0, HY],
  [-HX, HY * 0.5],
  [-HX, -HY * 0.5],
];

/** Outer edge n runs from vertex n to vertex n+1, matching the key's numbering. */
const EDGE_ORDER: readonly number[] = [0, 1, 2, 3, 4, 5];

export interface Stroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Every stroke a glyph draws, including its frame and the midline stub. */
export function glyphStrokes(glyph: Glyph): Stroke[] {
  const strokes: Stroke[] = [];

  for (const bit of EDGE_ORDER) {
    if ((glyph.vowel & (1 << bit)) === 0) continue;
    // The key numbers edges clockwise from the UPPER RIGHT, which is the edge
    // between vertex 0 (top) and vertex 1.
    const a = V[bit];
    const b = V[(bit + 1) % 6];
    strokes.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }

  const spoke = glyph.consonant;
  if ((spoke & 0b00001) !== 0) strokes.push({ x1: 0, y1: 0, x2: V[0][0], y2: V[0][1] });
  if ((spoke & 0b00010) !== 0) strokes.push({ x1: 0, y1: 0, x2: V[2][0], y2: V[2][1] });
  if ((spoke & 0b00100) !== 0) {
    strokes.push({ x1: -HX, y1: 0, x2: 0, y2: 0 });
    strokes.push({ x1: 0, y1: 0, x2: HX, y2: 0 });
  }
  if ((spoke & 0b01000) !== 0) strokes.push({ x1: 0, y1: 0, x2: V[4][0], y2: V[4][1] });
  if ((spoke & 0b10000) !== 0) strokes.push({ x1: 0, y1: 0, x2: V[3][0], y2: V[3][1] });

  return strokes;
}

/** Where the reversal dot sits, in the same glyph box. */
export const DOT = { x: 0, y: HY + 0.16, r: 0.07 };
/** Advance between glyph centres, and how far the midline runs past a word. */
export const ADVANCE = HX * 2 + 0.1;
export const WORD_GAP = ADVANCE * 0.8;

/**
 * Lay a stream out along a midline running left to right from the origin, and
 * return every stroke in one flat list plus the total width. The midline is
 * continuous through a word and breaks between words - that continuity is the
 * script's most recognisable feature and it is not decoration: it is what tells
 * a reader where one word ends.
 */
export interface Dot {
  x: number;
  y: number;
  r: number;
}

export function layout(stream: GlyphStream): { strokes: Stroke[]; dots: Dot[]; width: number } {
  const strokes: Stroke[] = [];
  const dots: Dot[] = [];
  let x = 0;
  let runStart = 0;
  let runEnd = 0;
  let inRun = false;

  const closeRun = (): void => {
    if (!inRun) return;
    strokes.push({ x1: runStart, y1: 0, x2: runEnd, y2: 0 });
    inRun = false;
  };

  for (const glyph of stream) {
    if (glyph === null) {
      closeRun();
      x += WORD_GAP;
      continue;
    }
    if (!inRun) {
      inRun = true;
      runStart = x - HX;
    }
    for (const stroke of glyphStrokes(glyph)) {
      strokes.push({
        x1: stroke.x1 + x,
        y1: stroke.y1,
        x2: stroke.x2 + x,
        y2: stroke.y2,
      });
    }
    if (glyph.reversed) dots.push({ x: DOT.x + x, y: DOT.y, r: DOT.r });
    runEnd = x + HX;
    x += ADVANCE;
  }
  closeRun();

  return { strokes, dots, width: Math.max(0, x - (ADVANCE - HX * 2)) };
}
