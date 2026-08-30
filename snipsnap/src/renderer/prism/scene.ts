import type { Gpu, Surface } from 'vgpu';
import { heroRevealProgress } from './hero/pipelines/presentation';
import { createPrismInteraction } from './hero/runtime/interaction';
import type { PrismLayoutKind } from './hero/layout';
import {
  createScene,
  destroyScene,
  prepareScene,
  resizeScene,
  setControls,
  setLampAim,
  setLayout,
  setOrbit,
  type PrismScene as HeroScene,
} from './hero/scene';
import { DEFAULT_POSTPROCESS_CONTROLS, DEFAULT_PRISM_CONTROLS, PRISM_DEFAULT_BEAM_WIDTH } from './hero/types';

/** Where the camera is along the beam, and how much of the scene should show through. */
export interface PrismState {
  /** 0 keeps the hero prism in frame, 1 arrives at the library rest pose. */
  travel: number;
  /** 1 pushes in on the glass while a project fills the window. */
  zoom: number;
  /** Dims the beam so foreground glass stays readable. */
  fade: number;
}

export interface PrismScene {
  dispose(): void;
}

const BLACK: readonly [number, number, number, number] = [0, 0, 0, 1];

/**
 * The vgpu.sh homepage hero, driven by VideoGit's stage pose instead of their
 * Next.js renderer. Optics, glass, spectral mesh, and the dark pipeline stay
 * theirs; this file only creates a surface and maps travel / zoom / fade onto
 * lamp aim, orbit, and beam opacity.
 */
export async function createPrismScene(
  canvas: HTMLCanvasElement,
  read: () => PrismState,
): Promise<PrismScene | null> {
  if (!('gpu' in navigator) || !navigator.gpu) return null;

  const { clock, frameLoop, init, surface } = await import('vgpu');

  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let hero: HeroScene | undefined;
  let loop: { stop(): void } | undefined;
  let lastFade = -1;
  let syncingLayout = false;
  const interaction = createPrismInteraction(canvas, () => undefined);

  const onPointerMove = (event: PointerEvent) => {
    if (read().travel > 0.02) return;
    interaction.onPointerMove(event);
  };

  const teardown = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', interaction.onPointerLeave);
    loop?.stop();
    if (hero) destroyScene(hero);
    output?.dispose();
    gpu?.dispose();
    hero = undefined;
    output = undefined;
    gpu = undefined;
  };

  try {
    gpu = await init();
    output = surface(gpu, canvas, { dpr: [1, 2], clearColor: BLACK });
    hero = createScene(gpu, output.size, 'videogit-hero');
    setControls(hero, { ...DEFAULT_PRISM_CONTROLS, wallColor: '#000000' });
    await prepareScene(hero, output);

    const time = clock(gpu);
    const revealOrigin = time.time;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('blur', interaction.onPointerLeave);

    loop = frameLoop(gpu, (currentFrame) => {
      const canvasTarget = output;
      const scene = hero;
      if (!canvasTarget || !scene) return;
      const [width, height] = canvasTarget.size;
      if (scene.runtime.outputSize[0] !== width || scene.runtime.outputSize[1] !== height) {
        resizeScene(scene, [width, height]);
      }

      const state = read();
      applyFade(scene, state.fade, lastFade);
      lastFade = state.fade;
      applyPose(scene, state, interaction);
      applyLayout(scene, state, () => {
        if (syncingLayout) return;
        syncingLayout = true;
        void scene.pipeline.syncSolids?.().finally(() => {
          syncingLayout = false;
        });
      });

      const reveal = heroRevealProgress(Math.max(0, time.time - revealOrigin));
      scene.pipeline.bind(time.time, {
        revealProgress: reveal.opacity,
        beamWidthReveal: reveal.beamWidth,
      });
      scene.pipeline.render(currentFrame, canvasTarget);
    });
  } catch (error) {
    teardown();
    throw error;
  }

  return { dispose: teardown };
}

function applyFade(scene: HeroScene, fade: number, previous: number): void {
  if (fade === previous) return;
  const controls = scene.runtime.controls;
  setControls(scene, {
    ...controls,
    lightFade: { ...controls.lightFade, beamOpacity: fade },
    postprocess: {
      ...controls.postprocess,
      bloomStrength: DEFAULT_POSTPROCESS_CONTROLS.bloomStrength * fade,
    },
  });
}

function applyPose(
  scene: HeroScene,
  state: PrismState,
  interaction: ReturnType<typeof createPrismInteraction>,
): void {
  if (state.travel <= 0.02) {
    const aim = interaction.stepAim();
    if (aim) setLampAim(scene, aim[0], aim[1]);
    const orbit = interaction.stepOrbit();
    if (orbit) setOrbit(scene, orbit[0], orbit[1]);
    return;
  }

  setLampAim(scene, 0.5 + state.travel * 0.16, 0.48);
  setOrbit(scene, state.travel * 0.28 + state.zoom * 0.22, state.zoom * -0.12);
}

function layoutFor(state: PrismState): PrismLayoutKind {
  if (state.travel > 0.45) return 'strip';
  return 'hero';
}

function applyLayout(scene: HeroScene, state: PrismState, sync: () => void): void {
  const kind = layoutFor(state);
  if (scene.runtime.layout === kind) return;
  setLayout(scene, kind);
  const beamWidth = kind === 'hero' ? PRISM_DEFAULT_BEAM_WIDTH : 0.048;
  setControls(scene, { ...scene.runtime.controls, beamWidth });
  sync();
}
