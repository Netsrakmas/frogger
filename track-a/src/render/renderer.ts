/**
 * CROAK - the WebGL renderer. PROMPT.md section 1.
 *
 * Colour management is not optional here: sRGB output plus ACES tone mapping
 * is the difference between the locked palette landing on screen and a washed
 * flat mess (section 9 rule 4).
 */

import * as THREE from 'three';
import { DPR_CAP } from '../core/constants';

/** Reported by the test API, and checked at boot against the pinned version. */
export const THREE_REVISION = THREE.REVISION;

/** Must match the `three` pin in package.json. */
const EXPECTED_REVISION = '185';

export interface RendererKit {
  readonly renderer: THREE.WebGLRenderer;
  resize(width: number, height: number): void;
  dispose(): void;
}

function targetPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, DPR_CAP);
}

export function createRenderer(canvasParent: HTMLElement): RendererKit {
  // A silent revision drift would change shader chunks under the material kit
  // and colour management under the palette, so fail loudly instead.
  if (THREE.REVISION !== EXPECTED_REVISION) {
    throw new Error(
      `CROAK: three is pinned to r${EXPECTED_REVISION}, found r${THREE.REVISION}.`,
    );
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // r185 deprecated PCFSoftShadowMap: it warns on construction and then falls
  // back to exactly this. Asking for the fallback directly keeps a clean run
  // silent (section 10's zero-console gate) with identical output.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // The post chain issues several renders per frame, and three resets its
  // counters on EVERY one of them - so with post on, `info.render.calls` would
  // report the final effect pass's single fullscreen triangle and the 150-call
  // budget would pass by measuring nothing. Manual reset once per frame instead
  // (game.ts render()), so the number covers the whole frame.
  renderer.info.autoReset = false;

  const canvas = renderer.domElement;
  // Layout size is CSS-driven; setSize below only ever touches the backing
  // store, so a DPR change never fights the page for the element's box.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvasParent.appendChild(canvas);

  const kit: RendererKit = {
    renderer,

    resize(width: number, height: number): void {
      const dpr = targetPixelRatio();
      // setPixelRatio re-runs setSize internally; skipping the no-op call
      // keeps a plain window resize down to a single buffer reallocation.
      if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
      renderer.setSize(
        Math.max(1, Math.floor(width)),
        Math.max(1, Math.floor(height)),
        false,
      );
    },

    dispose(): void {
      renderer.dispose();
      // Browsers cap live GL contexts; a remount that only drops the canvas
      // leaks one every time until the tab starts losing the oldest.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };

  kit.resize(canvasParent.clientWidth, canvasParent.clientHeight);
  return kit;
}
