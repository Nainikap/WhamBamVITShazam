import {
  BLOOM_LEVEL_FACTORS,
  PARTICLE_LIGHT_FIRST_LEVEL,
  bloomSpread,
} from "../../bloom";
import {
  glassUniforms,
  runtimeWallExtent,
  sceneUniforms,
} from "../../runtime/uniforms";
import type { PrismRuntime } from "../../runtime/types";
import {
  PRISM_FRONT_Z,
  PRISM_LIGHT_PLANE_Z,
  PRISM_POSTPROCESS_RANGES,
  PRISM_TRIANGLE,
} from "../../types";
import { presentationRevealUniforms } from "../presentation";
import { ensureDarkWireframeDraws } from "./create-graph";
import type { DarkPipelineGraph } from "./types";
import { bloomBlurUniforms } from "./bloom-uniforms";

export function bindDarkGraph(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  time: number,
  updateScene = true,
  revealProgress = 1,
  beamWidthReveal = 1,
  revealChanged = true
): void {
  const backgroundTarget = graph.backgroundTarget;
  const sceneTarget = graph.sceneTarget;
  const bloomTargets = graph.bloomTargets;
  const presentationTarget = graph.presentationTarget;
  const studioEnvironment = runtime.studioEnvironment;
  if (
    !backgroundTarget ||
    !sceneTarget ||
    !bloomTargets ||
    !presentationTarget
  ) {
    throw new Error(
      "prepare() must create dark pipeline targets before bind()."
    );
  }
  if (!studioEnvironment) {
    throw new Error("prepare() must create prism environments before bind().");
  }
  // Bindings are statically required even when the debug environment is not.
  // Reusing the studio view keeps the production path allocation-free.
  const debugEnvironment = runtime.debugEnvironment ?? studioEnvironment;
  ensureDarkWireframeDraws(graph, runtime);
  const reveal = presentationRevealUniforms("dark", revealProgress);

  if (!updateScene) {
    if (revealChanged) graph.copyPresentation.set({ params: reveal });
    graph.dust.set({
      params: revealChanged
        ? { time, revealProgress: reveal.revealProgress }
        : { time },
    });
    return;
  }

  const scene = sceneUniforms(runtime, beamWidthReveal);
  for (const light of graph.lights) light.set({ scene });
  graph.lightWireframe?.set({ scene });
  graph.copyBackground.set({ sceneTexture: backgroundTarget });
  runtime.triangles.forEach((triangle, index) => {
    const params = glassUniforms(runtime, "dark", triangle);
    graph.glassBacks[index]?.set({
      params,
      studioEnvironment: studioEnvironment.texture,
      debugEnvironment: debugEnvironment.texture,
      environmentSampler: runtime.environmentSampler,
    });
    graph.glassFronts[index]?.set({
      params,
      sceneTexture: backgroundTarget,
      sceneSampler: runtime.sceneSampler,
      studioEnvironment: studioEnvironment.texture,
      debugEnvironment: debugEnvironment.texture,
      environmentSampler: runtime.environmentSampler,
    });
  });
  graph.wireframe?.set({
    params: { viewProjection: runtime.view.viewProjection },
  });
  graph.bloomExtract.set({
    sourceTexture: sceneTarget,
    sourceSampler: runtime.sceneSampler,
    params: { threshold: runtime.controls.postprocess.bloomThreshold },
  });

  const particleTarget = bloomTargets[PARTICLE_LIGHT_FIRST_LEVEL];
  graph.particleLightDownsample.set({
    sourceTexture: sceneTarget,
    sourceSampler: runtime.sceneSampler,
    params: {
      sourceTexelSize: [1 / sceneTarget.size[0], 1 / sceneTarget.size[1]],
      sourceToTargetScale: [
        sceneTarget.size[0] / particleTarget.vertical.size[0],
        sceneTarget.size[1] / particleTarget.vertical.size[1],
      ],
    },
  });
  graph.bloomBlur.forEach((bloom, level) => {
    const targets = bloomTargets[level]!;
    const horizontalSource =
      level === 0 || level === PARTICLE_LIGHT_FIRST_LEVEL
        ? targets.vertical
        : bloomTargets[level - 1]!.vertical;
    bloom.horizontal.set({
      sourceTexture: horizontalSource,
      sourceSampler: runtime.sceneSampler,
      params: bloomBlurUniforms(level, "horizontal", targets.horizontal.size),
    });
    bloom.vertical.set({
      sourceTexture: targets.horizontal,
      sourceSampler: runtime.sceneSampler,
      params: bloomBlurUniforms(level, "vertical", targets.vertical.size),
    });
  });
  graph.bloomComposite.set({
    level0Texture: bloomTargets[0].vertical,
    level1Texture: bloomTargets[1].vertical,
    level2Texture: bloomTargets[2].vertical,
    levelSampler: runtime.sceneSampler,
    params: {
      radius: bloomSpread(
        runtime.controls.postprocess.bloomRadius,
        PRISM_POSTPROCESS_RANGES.bloomRadius.min,
        PRISM_POSTPROCESS_RANGES.bloomRadius.max
      ),
      factors: [...BLOOM_LEVEL_FACTORS, 0],
    },
  });
  graph.present.set({
    sceneTexture: sceneTarget,
    bloomTexture: bloomTargets[0].horizontal,
    bloomSampler: runtime.sceneSampler,
    params: {
      bloomStrength:
        runtime.controls.view === "glass"
          ? runtime.controls.postprocess.bloomStrength
          : 0,
    },
  });
  graph.copyPresentation.set({
    sourceTexture: presentationTarget,
    params: reveal,
  });
  graph.dust.set({
    params: dustUniforms(runtime, time, reveal.revealProgress),
    colorTexture: bloomTargets[1].vertical,
    lightTexture: particleTarget.vertical,
    lightSampler: runtime.sceneSampler,
  });
}

function dustUniforms(
  runtime: PrismRuntime,
  time: number,
  revealProgress: number
): Record<string, unknown> {
  return {
    viewProjection: runtime.view.viewProjection,
    fieldHalfExtent: runtimeWallExtent(runtime),
    outputSize: runtime.outputSize,
    time,
    cameraDistance: runtime.cameraDistance,
    lightPlaneZ: PRISM_LIGHT_PLANE_Z,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    prismFrontZ: PRISM_FRONT_Z,
    revealProgress,
  };
}
