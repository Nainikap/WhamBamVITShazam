import type { Frame, TimerSpan } from "vgpu";

import { BLOOM_VISIBLE_LEVELS, PARTICLE_LIGHT_FIRST_LEVEL } from "../../bloom";
import {
  LIGHT_INTERNAL_FIRST_VERTEX,
  LIGHT_INTERNAL_VERTICES,
  LIGHT_OUTGOING_FIRST_VERTEX,
  LIGHT_OUTGOING_VERTICES,
  LIGHT_WHITE_VERTICES,
} from "../../light-mesh";
import type { PrismRuntime } from "../../runtime/types";
import type {
  PrismOutput,
  PrismPassProfile,
  PrismPipelineRenderOptions,
} from "../types";
import { DUST_PARTICLE_COUNT } from "./create-graph";
import type { DarkPipelineGraph } from "./types";
import { darkWallClear } from "./wall-clear";

export function renderDarkGraph(
  current: Frame,
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  output: PrismOutput,
  options: PrismPipelineRenderOptions = {}
): void {
  const background = graph.backgroundTarget;
  const scene = graph.sceneTarget;
  const bloom = graph.bloomTargets;
  const presentation = graph.presentationTarget;
  if (!background || !scene || !bloom || !presentation) {
    throw new Error("prepare() must run before rendering the dark pipeline.");
  }

  if (options.updateScene ?? true) {
    renderBackdrop(current, graph, runtime, options.profile);
    current.pass(
      profilePass(
        { target: scene, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.scene"
      ),
      (pass) => {
        pass.draw(graph.copyBackground);
        if (runtime.controls.view === "glass") {
          for (const glass of graph.glassFronts) pass.draw(glass);
          if (runtime.controls.wireframe && graph.wireframe)
            pass.draw(graph.wireframe);
        }
      }
    );
    current.pass(
      profilePass(
        { target: bloom[0].vertical, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.bloom.extract"
      ),
      (pass) => pass.draw(graph.bloomExtract)
    );
    bloom.slice(0, BLOOM_VISIBLE_LEVELS).forEach((level, index) => {
      current.pass(
        profilePass(
          { target: level.horizontal, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.bloom.${index}.horizontal`
        ),
        (pass) => {
          pass.draw(graph.bloomBlur[index]!.horizontal);
        }
      );
      current.pass(
        profilePass(
          { target: level.vertical, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.bloom.${index}.vertical`
        ),
        (pass) => pass.draw(graph.bloomBlur[index]!.vertical)
      );
    });
    current.pass(
      profilePass(
        {
          target: bloom[PARTICLE_LIGHT_FIRST_LEVEL].vertical,
          clear: [0, 0, 0, 1],
        },
        options.profile,
        "dark.particle-light.downsample"
      ),
      (pass) => pass.draw(graph.particleLightDownsample)
    );
    bloom.slice(PARTICLE_LIGHT_FIRST_LEVEL).forEach((level, offset) => {
      const index = PARTICLE_LIGHT_FIRST_LEVEL + offset;
      current.pass(
        profilePass(
          { target: level.horizontal, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.particle-light.${index}.horizontal`
        ),
        (pass) => {
          pass.draw(graph.bloomBlur[index]!.horizontal);
        }
      );
      current.pass(
        profilePass(
          { target: level.vertical, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.particle-light.${index}.vertical`
        ),
        (pass) => pass.draw(graph.bloomBlur[index]!.vertical)
      );
    });
    current.pass(
      profilePass(
        { target: bloom[0].horizontal, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.bloom.composite"
      ),
      (pass) => {
        pass.draw(graph.bloomComposite);
      }
    );
    current.pass(
      profilePass(
        { target: presentation, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.present-cache"
      ),
      (pass) => pass.draw(graph.present)
    );
  }

  current.pass(
    profilePass({ target: output }, options.profile, "dark.output"),
    (pass) => {
      pass.draw(graph.copyPresentation);
      if (runtime.controls.view === "glass") {
        pass.draw(graph.dust, { instances: DUST_PARTICLE_COUNT });
      }
    }
  );
}

function renderBackdrop(
  current: Frame,
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  profile?: PrismPassProfile
): void {
  const target = graph.backgroundTarget!;
  const showBack =
    runtime.controls.view === "glass" || runtime.controls.view === "back";
  const showLight = runtime.controls.view !== "wall";
  current.pass(
    profilePass(
      {
        target,
        clear: darkWallClear(
          runtime.controls.wallColor,
          runtime.controls.view
        ),
      },
      profile,
      "dark.backdrop"
    ),
    (pass) => {
      if (
        runtime.controls.view === "glass" &&
        !runtime.controls.lightWireframe &&
        graph.backdropBundle &&
        runtime.solids.length === 1
      ) {
        pass.bundles(graph.backdropBundle);
        return;
      }
      if (showLight) {
        for (const light of graph.lights) {
          pass.draw(light, {
            firstVertex: 0,
            vertices: LIGHT_WHITE_VERTICES,
          });
          pass.draw(light, {
            firstVertex: LIGHT_OUTGOING_FIRST_VERTEX,
            vertices: LIGHT_OUTGOING_VERTICES,
          });
        }
        if (runtime.controls.lightWireframe && graph.lightWireframe) {
          pass.draw(graph.lightWireframe, {
            firstVertex: 0,
            vertices: LIGHT_WHITE_VERTICES,
          });
          pass.draw(graph.lightWireframe, {
            firstVertex: LIGHT_OUTGOING_FIRST_VERTEX,
            vertices: LIGHT_OUTGOING_VERTICES,
          });
        }
      }
      if (showBack) {
        for (const glass of graph.glassBacks) pass.draw(glass);
      }
      if (showLight) {
        for (const light of graph.lights) {
          pass.draw(light, {
            firstVertex: LIGHT_INTERNAL_FIRST_VERTEX,
            vertices: LIGHT_INTERNAL_VERTICES,
          });
        }
        if (runtime.controls.lightWireframe && graph.lightWireframe) {
          pass.draw(graph.lightWireframe, {
            firstVertex: LIGHT_INTERNAL_FIRST_VERTEX,
            vertices: LIGHT_INTERNAL_VERTICES,
          });
        }
      }
    }
  );
}

function profilePass<T extends { readonly target: PrismOutput }>(
  options: T,
  profile: PrismPassProfile | undefined,
  name: string
): T | (T & { readonly timer: TimerSpan }) {
  const timer = profile?.pass(name);
  return timer ? { ...options, timer } : options;
}
