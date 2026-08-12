/**
 * CROAK - what the world's signs say. PROMPT.md section 7.
 *
 * Its own module, with no imports at all, for one reason: `tests/a7.mjs` reads
 * this table directly under Node's ESM loader, which cannot follow the
 * extensionless relative imports the browser build uses. A gate that had to
 * keep its own copy of the authored text would be asserting against itself.
 */

/** Everything the world can say, keyed by the id a spawn point names. */
export const SIGN_TEXT: Readonly<Record<string, string>> = {
  belfry: 'the bell is under the water',
  bramble: 'only an edge opens this way',
  sluice: 'four gates hold the flood',
  arena: 'it waits above the bell',
  pond: 'the posts are a path',
};
