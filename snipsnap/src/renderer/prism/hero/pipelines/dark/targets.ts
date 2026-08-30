import type { Target } from "vgpu";
import { target } from "vgpu";

import { BLOOM_LEVEL_DIVISORS, BLOOM_LEVELS } from "../../bloom";
import { bloomFormatForLevel } from "../../capabilities";
import type { PrismRuntime } from "../../runtime/types";
import type { BloomTargets, DarkPipelineGraph } from "./types";

export function ensureDarkTargets(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  size: readonly [number, number],
  outputFormat: GPUTextureFormat
): void {
  const hdrMsaa = runtime.gpu.device.isCompatibilityMode
    ? {}
    : { msaa: true as const };
  graph.backgroundTarget ??= target(runtime.gpu, {
    size,
    format: "rgba16float",
    ...hdrMsaa,
    label: `${runtime.label}.pass-a-back-and-light`,
  });
  graph.sceneTarget ??= target(runtime.gpu, {
    size,
    format: "rgba16float",
    ...hdrMsaa,
    label: `${runtime.label}.pass-b-front-glass`,
  });
  graph.bloomTargets ??= Array.from({ length: BLOOM_LEVELS }, (_, level) =>
    bloomLevelTargets(runtime, size, level)
  ) as unknown as BloomTargets;
  graph.presentationTarget ??= target(runtime.gpu, {
    size,
    format: outputFormat,
    label: `${runtime.label}.retained-dark-presentation`,
  });
  resizeDarkTargets(graph, size);
}

function bloomLevelTargets(
  runtime: PrismRuntime,
  size: readonly [number, number],
  level: number
): BloomTargets[number] {
  const format = bloomFormatForLevel(runtime.gpu.device.features, level);
  return Object.freeze({
    horizontal: target(runtime.gpu, {
      size: bloomLevelSize(size, level),
      format,
      label: `${runtime.label}.bloom-${level}-horizontal`,
    }),
    vertical: target(runtime.gpu, {
      size: bloomLevelSize(size, level),
      format,
      label: `${runtime.label}.bloom-${level}-vertical`,
    }),
  });
}

export function resizeDarkTargets(
  graph: DarkPipelineGraph,
  size: readonly [number, number]
): void {
  resizeTarget(graph.backgroundTarget, size);
  resizeTarget(graph.sceneTarget, size);
  resizeTarget(graph.presentationTarget, size);
  graph.bloomTargets?.forEach((bloomLevel, level) => {
    const next = bloomLevelSize(size, level);
    resizeTarget(bloomLevel.horizontal, next);
    resizeTarget(bloomLevel.vertical, next);
  });
}

export function destroyDarkTargets(graph: DarkPipelineGraph): void {
  destroyTarget(graph.backgroundTarget);
  graph.backgroundTarget = undefined;
  destroyTarget(graph.sceneTarget);
  graph.sceneTarget = undefined;
  graph.bloomTargets?.forEach((bloomLevel) => {
    destroyTarget(bloomLevel.horizontal);
    destroyTarget(bloomLevel.vertical);
  });
  graph.bloomTargets = undefined;
  destroyTarget(graph.presentationTarget);
  graph.presentationTarget = undefined;
}

export function bloomLevelSize(
  size: readonly [number, number],
  level: number
): readonly [number, number] {
  const divisor = BLOOM_LEVEL_DIVISORS[level] ?? BLOOM_LEVEL_DIVISORS.at(-1)!;
  return [
    Math.max(1, Math.ceil(size[0] / divisor)),
    Math.max(1, Math.ceil(size[1] / divisor)),
  ];
}

function resizeTarget(
  value: Target | undefined,
  size: readonly [number, number]
): void {
  if (!value || (value.size[0] === size[0] && value.size[1] === size[1]))
    return;
  value.resize(size);
}

function destroyTarget(value: Target | undefined): void {
  (value as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
}
