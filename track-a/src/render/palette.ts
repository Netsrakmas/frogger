/**
 * CROAK - the locked palette. PROMPT.md section 2.
 *
 * Sixteen named roles plus the outline ink. Nothing else. A color that is not
 * in this table is a spec change, not a code change (section 9 rule 2), so
 * hexes live here and only here - every other module asks for a role by name.
 */

import * as THREE from 'three';

export const PALETTE = Object.freeze({
  grassLit: '#8FBF56',
  grassShade: '#4E8A4E',
  canopy: '#2E6B45',
  waterShallow: '#5FD3C8',
  waterDeep: '#2B8FB5',
  stoneLit: '#E8D5A8',
  stoneShade: '#B08D6E',
  ruinCool: '#8E9BAF',
  gold: '#F2C14E',
  heroBody: '#6FBF4B',
  heroBelly: '#F2E8C9',
  heroTunic: '#4FA64F',
  tongue: '#F4846C',
  hazeSky: '#CDE8EA',
  dungeonDark: '#22283F',
  dungeonGlow: '#6FE3FF',
} as const);

export type PaletteRole = keyof typeof PALETTE;

/** Inverted-hull outline ink: dark warm brown, deliberately not black. */
export const OUTLINE_INK = '#3A2E28';

/**
 * The single sRGB->working-space entry point. Authored hexes are sRGB; the
 * renderer works in linear, and skipping this conversion is exactly the
 * washed-out look section 9 rule 4 forbids.
 */
const srgb = (hex: string): THREE.Color =>
  new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);

/** A fresh Color per call - callers are free to mutate what they get. */
export function color(role: PaletteRole): THREE.Color {
  return srgb(PALETTE[role]);
}

export function inkColor(): THREE.Color {
  return srgb(OUTLINE_INK);
}
