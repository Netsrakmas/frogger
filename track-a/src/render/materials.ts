/**
 * CROAK - the material kit. PROMPT.md sections 2 and 8.
 *
 * Nothing in the game constructs a material directly. Every surface asks for a
 * palette role here and gets back a SHARED instance, because the draw-call
 * budget is 150 and each distinct material is a state change.
 *
 * The look is "lighting does all the texturing": one flat role colour, a
 * 3-band toon ramp, warm light against a cool blue-violet shadow. No maps, no
 * per-surface detail noise.
 */

import * as THREE from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';
import type { PaletteRole } from './palette';
import { color, inkColor } from './palette';
import { EMISSIVE_INTENSITY } from '../core/constants';

// ------------------------------------------------------------- style tuning
// Render-look numbers, not gameplay tunables, so they live with the kit that
// owns the look rather than in core/constants.ts.

const DEFAULT_BANDS = 3;
/**
 * Darkest band as a fraction of full key light, in LINEAR space. Never zero:
 * section 2 forbids pure black as hard as it forbids pure white.
 */
const RAMP_FLOOR = 0.11;
/** Band spacing. Tuned so the mid band lands halfway up perceptually, not linearly. */
const RAMP_CURVE = 1.5;
/** How far the shadow band leans into the palette's cool dark. */
const SHADOW_TINT = 0.62;
/** Tint fades out as the band brightens - only shadows go cool. */
const TINT_FALLOFF = 1.4;

const OUTLINE_THICKNESS = 0.03;
/** Vertices within 1e-4 u count as the same corner when welding outline normals. */
const WELD_PRECISION = 1e4;

/**
 * r185's MeshToonMaterial no longer declares `flatShading`, but the program
 * builder still reads it off any material and FLAT_SHADED is what gives
 * low-poly facets their hard edges. Set it through a narrow view rather than
 * losing the faceting or reaching for a second material class.
 */
interface FlatShadable {
  flatShading: boolean;
}

export interface MaterialOpts {
  emissive?: boolean;
  flatShading?: boolean;
  transparent?: boolean;
  opacity?: number;
}

const cache = new Map<string, THREE.MeshToonMaterial>();
const ramps = new Set<THREE.DataTexture>();
let sharedRamp: THREE.DataTexture | null = null;
let sharedOutlineMaterial: THREE.MeshBasicMaterial | null = null;

// -------------------------------------------------------------------- ramp

/**
 * A 1D toon ramp: `bands` hard steps from cool shadow to full light.
 *
 * The dark band carries chroma pulled from dungeonDark, the palette's own
 * blue-violet. Grading the shadow here rather than on the material colour is
 * what keeps a lit surface reading as its true role colour while its shadow
 * side goes rich and cool - the core Tunic chord.
 */
export function makeToonRamp(bands = DEFAULT_BANDS): THREE.DataTexture {
  const n = Math.max(2, Math.floor(bands));
  const data = new Uint8Array(n * 4);

  // Pure chroma direction: normalise brightness out so SHADOW_TINT controls
  // hue lean and the level curve alone controls how dark the band sits.
  const cool = color('dungeonDark');
  const peak = Math.max(cool.r, cool.g, cool.b) || 1;
  cool.multiplyScalar(1 / peak);

  const swatch = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const level = RAMP_FLOOR + (1 - RAMP_FLOOR) * Math.pow(t, RAMP_CURVE);
    const tint = SHADOW_TINT * Math.pow(1 - t, TINT_FALLOFF);
    swatch.setRGB(
      level * (1 - tint + tint * cool.r),
      level * (1 - tint + tint * cool.g),
      level * (1 - tint + tint * cool.b),
      THREE.LinearSRGBColorSpace,
    );

    // Store sRGB-encoded: the shadow band lives in the darks, where 8-bit
    // linear would band visibly and sRGB has precision to spare.
    const hex = swatch.getHex(THREE.SRGBColorSpace);
    const o = i * 4;
    data[o] = (hex >> 16) & 0xff;
    data[o + 1] = (hex >> 8) & 0xff;
    data[o + 2] = hex & 0xff;
    data[o + 3] = 0xff;
  }

  const tex = new THREE.DataTexture(
    data,
    n,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // NearestFilter on BOTH is what makes the bands hard instead of a gradient.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = `croakToonRamp${n}`;
  tex.needsUpdate = true;

  ramps.add(tex);
  return tex;
}

function defaultRamp(): THREE.DataTexture {
  if (sharedRamp === null) sharedRamp = makeToonRamp();
  return sharedRamp;
}

// ---------------------------------------------------------------- materials

const GRADIENT_GREY = 'vec3( texture2D( gradientMap, coord ).r )';
const GRADIENT_CHROMA = 'texture2D( gradientMap, coord ).rgb';
const TOON_CACHE_KEY = 'croak-toon-chroma-ramp';

/**
 * Stock MeshToonMaterial broadcasts the ramp's RED channel to all three
 * channels, which flattens any chroma in the ramp back to neutral grey - the
 * exact grey-black shadow section 2 rules out. Reading the ramp's full rgb is
 * the smallest change that lets the graded shadow band survive to the screen.
 */
function gradeShadowChroma(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    GRADIENT_GREY,
    GRADIENT_CHROMA,
  );
}

/** Keeps the patched toon program from colliding with an unpatched one. */
const toonCacheKey = (): string => TOON_CACHE_KEY;

function keyFor(role: PaletteRole, opts: MaterialOpts): string {
  return [
    role,
    opts.emissive ? 'e' : '-',
    opts.flatShading ? 'f' : '-',
    opts.transparent ? 't' : '-',
    (opts.opacity ?? 1).toFixed(3),
  ].join('|');
}

export function material(
  role: PaletteRole,
  opts: MaterialOpts = {},
): THREE.MeshToonMaterial {
  const key = keyFor(role, opts);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const base = color(role);
  const mat = new THREE.MeshToonMaterial({
    color: base,
    gradientMap: defaultRamp(),
    transparent: opts.transparent === true,
    opacity: opts.opacity ?? 1,
  });
  (mat as THREE.MeshToonMaterial & FlatShadable).flatShading =
    opts.flatShading === true;

  // Glow means meaning (section 8): only deliberate luminescent roles emit,
  // and they emit their own colour so bloom never invents a new one.
  if (opts.emissive === true) {
    mat.emissive.copy(base);
    mat.emissiveIntensity = EMISSIVE_INTENSITY;
  }

  mat.onBeforeCompile = gradeShadowChroma;
  mat.customProgramCacheKey = toonCacheKey;
  mat.name = key;

  cache.set(key, mat);
  return mat;
}

export function outlineMaterial(): THREE.MeshBasicMaterial {
  if (sharedOutlineMaterial === null) {
    sharedOutlineMaterial = new THREE.MeshBasicMaterial({
      color: inkColor(),
      side: THREE.BackSide,
    });
    sharedOutlineMaterial.name = 'croakOutline';
  }
  return sharedOutlineMaterial;
}

// ----------------------------------------------------------------- outlines

/**
 * Averages normals across coincident vertices. A hard-edged mesh stores one
 * normal per face, so pushing raw normals outward tears the hull into
 * detached faces at every corner - the welded normal keeps it a closed shell.
 */
function weldedNormals(geo: THREE.BufferGeometry): Float32Array {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const out = new Float32Array(pos.count * 3);

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * WELD_PRECISION)},${Math.round(
      pos.getY(i) * WELD_PRECISION,
    )},${Math.round(pos.getZ(i) * WELD_PRECISION)}`;
    const bucket = buckets.get(k);
    if (bucket === undefined) buckets.set(k, [i]);
    else bucket.push(i);
  }

  const sum = new THREE.Vector3();
  for (const bucket of buckets.values()) {
    sum.set(0, 0, 0);
    for (const i of bucket) {
      sum.x += nrm.getX(i);
      sum.y += nrm.getY(i);
      sum.z += nrm.getZ(i);
    }
    // Opposing normals can cancel to nothing; fall back to the raw normal.
    if (sum.lengthSq() < 1e-8) {
      for (const i of bucket) {
        out[i * 3] = nrm.getX(i);
        out[i * 3 + 1] = nrm.getY(i);
        out[i * 3 + 2] = nrm.getZ(i);
      }
      continue;
    }
    sum.normalize();
    for (const i of bucket) {
      out[i * 3] = sum.x;
      out[i * 3 + 1] = sum.y;
      out[i * 3 + 2] = sum.z;
    }
  }
  return out;
}

/**
 * Inverted-hull outline. CHARACTERS ONLY - the world never gets one
 * (section 2: one outline treatment everywhere, and it means "on characters").
 *
 * The hull is a real geometry offset along welded normals, not an object
 * scale, so a squashed or stretched mesh keeps a uniform-width line instead of
 * a fat side and a thin one.
 *
 * The clone belongs to the CALLER, not to the kit: entities are created and
 * destroyed constantly (every kill, every shrine respawn) while the kit is
 * released once at teardown, so a hull tracked here would leak a geometry and
 * its GPU buffers per death. Push `outline.geometry` into whatever the owner
 * disposes.
 */
export function makeOutline(
  mesh: THREE.Mesh,
  thickness = OUTLINE_THICKNESS,
): THREE.Mesh {
  const geo = mesh.geometry.clone();
  if (!geo.hasAttribute('normal')) geo.computeVertexNormals();

  const pos = geo.getAttribute('position');
  const normals = weldedNormals(geo);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + normals[i * 3] * thickness,
      pos.getY(i) + normals[i * 3 + 1] * thickness,
      pos.getZ(i) + normals[i * 3 + 2] * thickness,
    );
  }
  pos.needsUpdate = true;

  // The hull is drawn with a flat basic material; normals and uvs would only
  // cost upload bandwidth and a vertex attribute slot.
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo.computeBoundingSphere();

  const outline = new THREE.Mesh(geo, outlineMaterial());
  outline.name = `${mesh.name || 'mesh'}_outline`;
  outline.castShadow = false;
  outline.receiveShadow = false;
  // Hulls draw first, as one contiguous batch: they all share the ink
  // material, and their solid owners then win the depth test on top.
  outline.renderOrder = mesh.renderOrder - 1;

  return outline;
}

// ------------------------------------------------------------------ teardown

export function disposeMaterials(): void {
  for (const mat of cache.values()) mat.dispose();
  cache.clear();

  for (const tex of ramps) tex.dispose();
  ramps.clear();
  sharedRamp = null;

  if (sharedOutlineMaterial !== null) {
    sharedOutlineMaterial.dispose();
    sharedOutlineMaterial = null;
  }
}
