import { bundle } from "vgpu";

import {
  LIGHT_INTERNAL_FIRST_VERTEX,
  LIGHT_INTERNAL_VERTICES,
  LIGHT_OUTGOING_FIRST_VERTEX,
  LIGHT_OUTGOING_VERTICES,
  LIGHT_WHITE_VERTICES,
} from "../../light-mesh";
import type { PrismRuntime } from "../../runtime/types";
import type { DarkPipelineGraph } from "./types";

/** Records the stable production backdrop. Debug variants remain direct. */
export function recordDarkBackdropBundle(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime
): void {
  if (graph.backdropBundle || !graph.backgroundTarget) return;
  graph.backdropBundle = bundle(
    runtime.gpu,
    {
      target: graph.backgroundTarget,
      label: `${runtime.label}.dark-backdrop`,
    },
    (recorded) => {
      for (const light of graph.lights) {
        recorded.draw(light, {
          firstVertex: 0,
          vertices: LIGHT_WHITE_VERTICES,
        });
        recorded.draw(light, {
          firstVertex: LIGHT_OUTGOING_FIRST_VERTEX,
          vertices: LIGHT_OUTGOING_VERTICES,
        });
      }
      for (const glass of graph.glassBacks) recorded.draw(glass);
      for (const light of graph.lights) {
        recorded.draw(light, {
          firstVertex: LIGHT_INTERNAL_FIRST_VERTEX,
          vertices: LIGHT_INTERNAL_VERTICES,
        });
      }
    }
  );
}
