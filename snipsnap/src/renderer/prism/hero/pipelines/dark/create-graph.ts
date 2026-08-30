import { draw, effect } from "vgpu";

import bloomBlurPairedWgsl from "../../bloom-blur-paired.wgsl";
import bloomBlurWgsl from "../../bloom-blur.wgsl";
import bloomCompositeWgsl from "../../bloom-composite.wgsl";
import bloomExtractWgsl from "../../bloom-extract.wgsl";
import { BLOOM_BLUR_SAMPLING } from "../../bloom-pairing";
import { BLOOM_LEVELS } from "../../bloom";
import copyLinearWgsl from "../../copy-linear.wgsl";
import dustWgsl from "../../dust.wgsl";
import glassBackWgsl from "../../glass-back.wgsl";
import glassWgsl from "../../glass.wgsl";
import lightWgsl from "../../light.wgsl";
import lightWireframeWgsl from "../../light-wireframe.wgsl";
import particleLightDownsampleWgsl from "../../particle-light-downsample.wgsl";
import presentWgsl from "../../present.wgsl";
import { ensurePrismWireframeGeometry } from "../../runtime/resources";
import type { PrismRuntime } from "../../runtime/types";
import wireframeWgsl from "../../wireframe.wgsl";
import copyPresentationWgsl from "./copy-presentation.wgsl";
import type { BloomBlurEffects, DarkPipelineGraph } from "./types";

export const DUST_PARTICLE_COUNT = 2200;

export function createDarkGraph(runtime: PrismRuntime): DarkPipelineGraph {
  const { gpu, label } = runtime;
  // Keep construction order stable: renderer lifecycle tests also assert this
  // inventory, making accidental dark graph changes explicit.
  const lights = runtime.lightSlots.map((slot, index) =>
    draw(gpu, {
      shader: lightWgsl,
      geometry: slot.geometry,
      blend: "additive",
      cull: "none",
      depth: false,
      label: `${label}.light.${index}`,
    })
  );
  const light = lights[0]!;
  const copyBackground = effect(gpu, copyLinearWgsl, {
    label: `${label}.pass-b-copy-a`,
  });
  const bloomExtract = effect(gpu, bloomExtractWgsl, {
    label: `${label}.bloom-extract`,
  });
  const bloomBlur = Array.from({ length: BLOOM_LEVELS }, (_, level) => {
    const sampling = BLOOM_BLUR_SAMPLING[level]!;
    return {
      horizontal: effect(
        gpu,
        sampling.horizontal === "bilinear-pairs"
          ? bloomBlurPairedWgsl
          : bloomBlurWgsl,
        { label: `${label}.bloom-${level}-horizontal` }
      ),
      vertical: effect(
        gpu,
        sampling.vertical === "bilinear-pairs"
          ? bloomBlurPairedWgsl
          : bloomBlurWgsl,
        { label: `${label}.bloom-${level}-vertical` }
      ),
    };
  }) as unknown as BloomBlurEffects;
  const bloomComposite = effect(gpu, bloomCompositeWgsl, {
    label: `${label}.bloom-composite`,
  });
  const particleLightDownsample = effect(gpu, particleLightDownsampleWgsl, {
    label: `${label}.particle-light-downsample`,
  });
  const present = effect(gpu, presentWgsl, { label: `${label}.present` });
  const copyPresentation = effect(gpu, copyPresentationWgsl, {
    label: `${label}.copy-presentation`,
  });
  const glassBacks = runtime.solids.map((solid, index) =>
    draw(gpu, {
      shader: glassBackWgsl,
      geometry: solid,
      cull: "front",
      depth: false,
      blend: "premultiplied",
      label: `${label}.glass-back.${index}`,
    })
  );
  const glassFronts = runtime.solids.map((solid, index) =>
    draw(gpu, {
      shader: glassWgsl,
      geometry: solid,
      cull: "back",
      depth: false,
      label: `${label}.glass-front.${index}`,
    })
  );
  const glassBack = glassBacks[0]!;
  const glassFront = glassFronts[0]!;
  const dust = draw(gpu, {
    shader: dustWgsl,
    vertices: 6,
    instances: DUST_PARTICLE_COUNT,
    cull: "none",
    depth: false,
    blend: "additive",
    label: `${label}.dust`,
  });

  return {
    light,
    lights,
    copyBackground,
    bloomExtract,
    bloomBlur,
    bloomComposite,
    particleLightDownsample,
    present,
    copyPresentation,
    glassBack,
    glassFront,
    glassBacks,
    glassFronts,
    solidsVersion: runtime.solidsVersion,
    dust,
  };
}

export function rebuildSolidDraws(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime
): void {
  const { gpu, label } = runtime;
  graph.lights = runtime.lightSlots.map((slot, index) =>
    draw(gpu, {
      shader: lightWgsl,
      geometry: slot.geometry,
      blend: "additive",
      cull: "none",
      depth: false,
      label: `${label}.light.${index}`,
    })
  );
  graph.glassBacks = runtime.solids.map((solid, index) =>
    draw(gpu, {
      shader: glassBackWgsl,
      geometry: solid,
      cull: "front",
      depth: false,
      blend: "premultiplied",
      label: `${label}.glass-back.${index}`,
    })
  );
  graph.glassFronts = runtime.solids.map((solid, index) =>
    draw(gpu, {
      shader: glassWgsl,
      geometry: solid,
      cull: "back",
      depth: false,
      label: `${label}.glass-front.${index}`,
    })
  );
  graph.light = graph.lights[0]!;
  graph.glassBack = graph.glassBacks[0]!;
  graph.glassFront = graph.glassFronts[0]!;
  graph.solidsVersion = runtime.solidsVersion;
  graph.backdropBundle = undefined;
}

/** Creates debug-only draws when their controls are first enabled. */
export function ensureDarkWireframeDraws(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime
): void {
  const { gpu, label } = runtime;
  if (runtime.controls.wireframe && !graph.wireframe) {
    graph.wireframe = draw(gpu, {
      shader: wireframeWgsl,
      geometry: ensurePrismWireframeGeometry(runtime),
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.wireframe`,
    });
  }
  if (runtime.controls.lightWireframe && !graph.lightWireframe) {
    graph.lightWireframe = draw(gpu, {
      shader: lightWireframeWgsl,
      geometry: runtime.lightGeometry,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light-wireframe`,
    });
  }
}
