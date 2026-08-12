#!/usr/bin/env node
/**
 * CROAK - the Croakic cipher, checked without a browser. PROMPT.md section 11,
 * A7: "glyphs decode round-trip in a unit test".
 *
 * The interesting property is not that one sentence survives a round trip. It
 * is that the cipher is INJECTIVE: every phoneme has its own stroke set, no two
 * share one, and the greedy syllable packing can always be undone. So this
 * walks the whole inventory and every ordered pair in it - 39 phonemes is 1521
 * pairs, cheap enough to be exhaustive rather than representative.
 *
 * Run: node tests/croakic.mjs      (no build, no browser, ~instant)
 */

import * as C from '../src/ui/croakic.ts';

const checks = [];

function check(id, name, measured, expected, pass) {
  checks.push({ id, name, measured: String(measured), expected: String(expected), pass: !!pass });
}

const VOWELS = Object.keys(C.VOWELS);
const CONSONANTS = Object.keys(C.CONSONANTS);
const ALL = [...CONSONANTS, ...VOWELS];

// ------------------------------------------------------- 1. the key is a key

const masks = new Map();
let clash = null;
for (const [name, mask] of Object.entries(C.VOWELS)) {
  if (masks.has(`v${mask}`)) clash = `${name} shares ${mask} with ${masks.get(`v${mask}`)}`;
  masks.set(`v${mask}`, name);
}
for (const [name, mask] of Object.entries(C.CONSONANTS)) {
  if (masks.has(`c${mask}`)) clash = `${name} shares ${mask} with ${masks.get(`c${mask}`)}`;
  masks.set(`c${mask}`, name);
}
check(
  'k1',
  'every phoneme has its own stroke set - no two glyphs are the same drawing',
  clash === null ? `${VOWELS.length} vowels + ${CONSONANTS.length} consonants, all distinct` : clash,
  'all distinct',
  clash === null,
);

const outOfRange = Object.entries(C.VOWELS)
  .filter(([, m]) => m <= 0 || m > 0b111111)
  .concat(Object.entries(C.CONSONANTS).filter(([, m]) => m <= 0 || m > 0b11111));
check(
  'k2',
  'and every stroke set fits the frame it is drawn in',
  outOfRange.length === 0 ? 'vowels within 6 edges, consonants within 5 spokes' : outOfRange.join(', '),
  'in range',
  outOfRange.length === 0,
);

// -------------------------------------------------- 2. exhaustive round trip

let singleFails = [];
for (const phoneme of ALL) {
  const back = C.decode(C.encode([[phoneme]]));
  if (back.length !== 1 || back[0].length !== 1 || back[0][0] !== phoneme) {
    singleFails.push(`${phoneme} -> ${JSON.stringify(back)}`);
  }
}
check(
  'r1',
  'every phoneme on its own survives encode -> decode',
  singleFails.length === 0 ? `${ALL.length}/${ALL.length}` : singleFails.slice(0, 3).join(' | '),
  `${ALL.length}/${ALL.length}`,
  singleFails.length === 0,
);

let pairFails = [];
let pairs = 0;
for (const a of ALL) {
  for (const b of ALL) {
    pairs++;
    const back = C.decode(C.encode([[a, b]]));
    if (back.length !== 1 || back[0].join(' ') !== `${a} ${b}`) {
      pairFails.push(`${a} ${b} -> ${JSON.stringify(back[0])}`);
    }
  }
}
check(
  'r2',
  'and so does EVERY ordered pair - the syllable packing is undoable',
  pairFails.length === 0 ? `${pairs}/${pairs} pairs` : pairFails.slice(0, 3).join(' | '),
  `${pairs}/${pairs} pairs`,
  pairFails.length === 0,
);

// A deterministic pseudo-random walk over longer strings. Fixed seed, because
// a test that cannot be re-run on its own failure is not a test.
let seed = 0x1a2b3c4d;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let longFails = [];
for (let i = 0; i < 4000; i++) {
  const words = [];
  const wordCount = 1 + Math.floor(rand() * 4);
  for (let w = 0; w < wordCount; w++) {
    const length = 1 + Math.floor(rand() * 8);
    const word = [];
    for (let n = 0; n < length; n++) word.push(ALL[Math.floor(rand() * ALL.length)]);
    words.push(word);
  }
  const back = C.decode(C.encode(words));
  if (JSON.stringify(back) !== JSON.stringify(words)) {
    longFails.push(JSON.stringify(words));
  }
}
check(
  'r3',
  'and 4000 random multi-word strings, word breaks included',
  longFails.length === 0 ? '4000/4000' : longFails.slice(0, 2).join(' | '),
  '4000/4000',
  longFails.length === 0,
);

// ------------------------------------------------- 3. the reversal dot works

const cv = C.encodeWord(['B', 'AE']);
const vc = C.encodeWord(['AE', 'B']);
check(
  'd1',
  'a consonant-then-vowel syllable is ONE glyph with no dot',
  `${cv.length} glyph(s), reversed = ${cv[0] && cv[0].reversed}`,
  '1 glyph, no dot',
  cv.length === 1 && cv[0].reversed === false,
);
check(
  'd2',
  'the same two sounds the other way round are one glyph WITH the dot',
  `${vc.length} glyph(s), reversed = ${vc[0] && vc[0].reversed}`,
  '1 glyph, dotted',
  vc.length === 1 && vc[0].reversed === true,
);
check(
  'd3',
  'and the dot is the ONLY difference between them',
  `same strokes: ${cv[0].consonant === vc[0].consonant && cv[0].vowel === vc[0].vowel}`,
  'identical strokes',
  cv[0].consonant === vc[0].consonant && cv[0].vowel === vc[0].vowel,
);

// ------------------------------------------------------- 4. English signage

const sign = 'the bell is under the water';
const spoken = C.transcribe(sign);
const written = C.write(sign);
const readBack = C.decode(written);
check(
  't1',
  'authored English can be set in Croakic',
  `"${sign}" -> ${written.filter((g) => g !== null).length} glyphs`,
  'glyphs',
  written.filter((g) => g !== null).length > 0,
);
check(
  't2',
  'and reading the signage back gives the sounds it was set from',
  JSON.stringify(readBack) === JSON.stringify(spoken)
    ? `${spoken.length} words, ${spoken.flat().length} phonemes recovered`
    : 'mismatch',
  'exact',
  JSON.stringify(readBack) === JSON.stringify(spoken),
);
check(
  't3',
  'a reader who knows the key gets something they can say out loud',
  spoken.map((w) => w.join('')).join(' ').slice(0, 46),
  'phonemes, not letters',
  spoken.length === 6 && spoken[0].join(' ') === 'TH EH',
);

// --------------------------------------------------------- 5. it can be drawn

const drawn = C.layout(C.write('croak'));
// "under" opens on a vowel, so its first syllable is written backwards.
const dotted = C.layout(C.write('under'));
const undotted = C.layout(C.write('bat'));
check(
  'g1',
  'every glyph produces strokes, and the word rides one continuous midline',
  `${drawn.strokes.length} strokes across ${drawn.width.toFixed(2)} units`,
  'strokes, positive width',
  drawn.strokes.length > 4 && drawn.width > 0,
);
const midlines = drawn.strokes.filter((s) => s.y1 === 0 && s.y2 === 0 && s.x2 - s.x1 > 0.9);
check(
  'g2',
  'and that midline is ONE run for a word, not one stub per glyph',
  `${midlines.length} long midline run(s)`,
  '1',
  midlines.length === 1,
);
check(
  'g3',
  'a reversed syllable puts a dot under the glyph that carries it',
  `"under" ${dotted.dots.length} dot(s), "bat" ${undotted.dots.length}`,
  '>= 1 and 0',
  dotted.dots.length >= 1 && undotted.dots.length === 0,
);

const twoWords = C.layout(C.write('sunken belfry'));
const runs = twoWords.strokes.filter((s) => s.y1 === 0 && s.y2 === 0 && s.x2 - s.x1 > 0.9);
check(
  'g4',
  'two words are two runs - the break in the line IS the space',
  `${runs.length} run(s)`,
  '2',
  runs.length === 2,
);

// ----------------------------------------------------------------- 6. hygiene

let threw = false;
try {
  C.encodeWord(['QQ']);
} catch {
  threw = true;
}
check(
  'h1',
  'a non-phoneme is refused rather than silently written as nothing',
  threw ? 'throws' : 'accepted silently',
  'throws',
  threw,
);

// The key must live in the source and never reach the player. Asserted by
// reading this module's own text: rule 12 has no exception for cleverness.
const source = await (await import('node:fs/promises')).readFile(
  new URL('../src/ui/croakic.ts', import.meta.url),
  'utf8',
);
check(
  'h2',
  'the cipher key ships as a source comment (section 7)',
  /THE KEY/.test(source) && /IY\s+100001/.test(source) ? 'present in croakic.ts' : 'missing',
  'present',
  /THE KEY/.test(source) && /IY\s+100001/.test(source),
);

// ------------------------------------------------------------------- report

console.log('\nCROAK - Croakic cipher unit test\n');
console.log('id'.padEnd(5) + 'check'.padEnd(66) + 'measured'.padEnd(46) + 'expected'.padEnd(26) + 'result');
console.log('-'.repeat(150));
for (const c of checks) {
  console.log(
    c.id.padEnd(5) +
      c.name.slice(0, 65).padEnd(66) +
      c.measured.slice(0, 45).padEnd(46) +
      c.expected.slice(0, 25).padEnd(26) +
      (c.pass ? 'PASS' : 'FAIL'),
  );
}
const passed = checks.filter((c) => c.pass).length;
console.log('-'.repeat(150));
console.log(`${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
