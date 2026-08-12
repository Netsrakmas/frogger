/**
 * CROAK - the post chain. PROMPT.md sections 1 and 8.
 *
 * One merged EffectPass carrying bloom, the additive sky gradient, a vignette
 * and SMAA - not four stock jsm passes, which would be four full-screen
 * round trips for work that fits in one shader (section 1).
 *
 * BLOOM IS THRESHOLDED ON PURPOSE. Section 8: "bloom only from deliberate
 * luminescent sources - glow means meaning". At 0.85 the meadow's lit stone
 * does not glow and the belfry's growth, the gold of a shrine and the Heron's
 * eyes do. A bloom that lifts everything is the single fastest way to turn a
 * flat-colour toon game into mush, so the threshold is a design rule with a
 * number attached rather than a slider.
 *
 * The chain is REMOVABLE at runtime (`setEnabled(false)`), because A8's gate
 * asks whether the game is still readable without it. A look that only works
 * with post on is a look that breaks the moment a machine cannot afford it.
 */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  KernelSize,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import {
  BLOOM_INTENSITY,
  BLOOM_RADIUS,
  BLOOM_SMOOTHING,
  BLOOM_THRESHOLD,
  BLACK_FLOOR,
  GRADIENT_STRENGTH,
  VIGNETTE_DARKNESS,
  VIGNETTE_OFFSET,
} from '../core/constants';
import { color } from './palette';

/**
 * The fullscreen additive vertical gradient, and the floor under the darks.
 *
 * The gradient is section 8's: hazeSky at the top at ~0.12, squared falloff so
 * the bottom of the frame stays untouched. It is what puts air between the
 * camera and the diorama.
 *
 * The floor is section 2 rule 5: "no pure white, no pure black anywhere". That
 * is easy to honour while authoring materials and easy to LOSE at the end of a
 * post chain - a vignette multiplying an already-dark dungeon corner will take
 * it to zero no matter how carefully the ramp was tuned. So the last thing that
 * touches every pixel also guarantees the rule, in one place, with the
 * palette's own dungeonDark as the floor rather than a grey.
 */
/**
 * A NOTE ON THE TWO TONE CURVES, because it cost a measurement to learn.
 *
 * three's ACESFilmicToneMapping and postprocessing's ACES_FILMIC are different
 * fits, not the same curve at different exposures. three pre-multiplies by
 * `exposure / 0.6`; postprocessing uses the bare Narkowicz approximation, whose
 * toe is steeper. Matching them with a single scale factor was tried and does
 * not work: 1/0.6 lands the meadow at luma 202 against the fallback's 160 while
 * still leaving the belfry darker, because the discrepancy is in the SHAPE.
 *
 * So the chain's curve is the shipping look, the renderer's is the fallback,
 * and the fallback's job is to stay READABLE rather than identical. A8's gate
 * asserts exactly that and nothing stronger.
 */

const GRADIENT_SHADER = `
uniform vec3 tint;
uniform float strength;
uniform vec3 floorTint;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float lift = uv.y * uv.y;
  vec3 lit = inputColor.rgb + tint * strength * lift;
  outputColor = vec4(max(lit, floorTint), inputColor.a);
}
`;

class SkyGradientEffect extends Effect {
  constructor(tint: THREE.Color, strength: number, floorTint: THREE.Color) {
    super('CroakSkyGradient', GRADIENT_SHADER, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['tint', new THREE.Uniform(tint)],
        ['strength', new THREE.Uniform(strength)],
        ['floorTint', new THREE.Uniform(floorTint)],
      ]),
    });
  }
}

export interface PostKit {
  readonly enabled: boolean;
  setEnabled(value: boolean): void;
  /**
   * Bloom on its own. The gate needs to compare a frame WITH bloom against the
   * same frame without it - comparing post-on against post-off would fold the
   * vignette, the gradient and the tone curve into the answer and call the
   * total "bloom".
   */
  setBloom(value: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostKit {
  const composer = new EffectComposer(renderer, {
    // Half float keeps the bloom's bright pass from clipping before it is
    // thresholded, which is what makes a 0.85 cut behave like a cut.
    frameBufferType: THREE.HalfFloatType,
  });

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    luminanceThreshold: BLOOM_THRESHOLD,
    luminanceSmoothing: BLOOM_SMOOTHING,
    intensity: BLOOM_INTENSITY,
    radius: BLOOM_RADIUS,
    kernelSize: KernelSize.MEDIUM,
    mipmapBlur: true,
  });

  const gradient = new SkyGradientEffect(
    color('hazeSky'),
    GRADIENT_STRENGTH,
    color('dungeonDark').multiplyScalar(BLACK_FLOOR),
  );

  const vignette = new VignetteEffect({
    offset: VIGNETTE_OFFSET,
    darkness: VIGNETTE_DARKNESS,
  });

  const smaa = new SMAAEffect();

  /**
   * TONE MAPPING HAS TO MOVE INTO THE CHAIN, and this is not a preference.
   * three only applies `renderer.toneMapping` when it is drawing to the CANVAS;
   * rendering into a render target - which is the first thing a composer does -
   * silently drops it. The meadow survived that because it is bright. The
   * belfry did not: it went from rgb(91,106,110) to rgb(6,6,4), a black screen
   * with a HUD floating on it, and every check that only looked at the meadow
   * passed anyway.
   *
   * So: no tone mapping on the renderer while the chain is on, ACES inside the
   * chain instead, and the renderer's own ACES handed back the moment the chain
   * is switched off. Both paths are tone-mapped; neither is the odd one out.
   */
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

  // Order matters: bloom on the HDR image before anything compresses it, ACES
  // next, the vignette on the tone-mapped frame, then the gradient over all of
  // it so the haze reads as air in FRONT of everything, and SMAA last.
  // The gradient runs LAST of the colour work, after the vignette: it carries
  // the no-pure-black floor, and a floor applied before the thing that darkens
  // the corners is not a floor.
  const effectPass = new EffectPass(camera, bloom, toneMapping, vignette, gradient, smaa);
  composer.addPass(effectPass);

  let enabled = true;
  renderer.toneMapping = THREE.NoToneMapping;

  return {
    get enabled(): boolean {
      return enabled;
    },

    setEnabled(value: boolean): void {
      enabled = value;
      renderer.toneMapping = value ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    },

    setBloom(value: boolean): void {
      bloom.intensity = value ? BLOOM_INTENSITY : 0;
    },

    render(nextScene: THREE.Scene, nextCamera: THREE.Camera): void {
      if (!enabled) {
        renderer.render(nextScene, nextCamera);
        return;
      }
      // The camera object is stable, but the rig hands out a fresh one on a
      // resize in some paths - keeping the pass in sync is cheaper than
      // rebuilding the composer.
      if (renderPass.mainCamera !== nextCamera) renderPass.mainCamera = nextCamera;
      if (renderPass.mainScene !== nextScene) renderPass.mainScene = nextScene;
      composer.render();
    },

    setSize(width: number, height: number): void {
      composer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    },

    dispose(): void {
      composer.dispose();
    },
  };
}
