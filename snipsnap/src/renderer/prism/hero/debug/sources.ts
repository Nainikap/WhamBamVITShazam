import type { PrismDebugSource, PrismPipelineMode } from "../pipelines/types";

export const PRISM_DEBUG_SOURCE_IDS = [
  "wall-material",
  "wall-normal",
  "wall-roughness",
  "global-shadow",
  "prism-shadow",
  "prism-ao",
  "raw-caustic",
  "projected-caustic",
  "composed-wall",
  "backdrop-hdr",
  "front-glass",
  "scene-hdr",
  "final-output",
] as const;

export const PRISM_DARK_DEBUG_SOURCE_IDS = [
  "dark-wall",
  "dark-backdrop-hdr",
  "dark-front-glass",
  "dark-scene-hdr",
  "dark-bloom-0",
  "dark-bloom-1",
  "dark-bloom-2",
  "dark-bloom-composite",
  "dark-particle-light",
] as const;

export type PrismDebugSourceId =
  | (typeof PRISM_DEBUG_SOURCE_IDS)[number]
  | (typeof PRISM_DARK_DEBUG_SOURCE_IDS)[number];

export const PRISM_DEBUG_SOURCES = [
  source("wall-material", "Wall material / albedo", "asset", "srgb"),
  source("wall-normal", "Wall normal", "view", "normal", [
    input("wall-material", "unpack GB"),
  ]),
  source("wall-roughness", "Wall roughness", "view", "scalar", [
    input("wall-material", "unpack A"),
  ]),
  source("global-shadow", "Ambient light blobs", "asset", "scalar"),
  source("prism-shadow", "Prism cast shadow (analytic)", "view", "scalar"),
  source("prism-ao", "Prism contact AO", "asset", "scalar"),
  source("raw-caustic", "Raw spectral caustic", "asset", "hdr"),
  source("projected-caustic", "Projected caustic", "view", "hdr", [
    input("raw-caustic", "project onto wall"),
  ]),
  source("composed-wall", "Composed wall", "pass", "hdr", [
    input("wall-material", "base color"),
    input("wall-normal", "shade normal"),
    input("wall-roughness", "rough response"),
    input("global-shadow", "multiply"),
    input("prism-shadow", "draw core + penumbra"),
    input("prism-ao", "multiply diffuse"),
    input("projected-caustic", "add after AO"),
  ]),
  source("backdrop-hdr", "Backdrop HDR", "target", "hdr", [
    input("composed-wall", "Pass L0"),
  ]),
  source("front-glass", "Front glass", "pass", "hdr", [
    input("backdrop-hdr", "transmit / reflect"),
  ]),
  source("scene-hdr", "Scene HDR", "target", "hdr", [
    input("backdrop-hdr", "copy background"),
    input("front-glass", "composite"),
  ]),
  source("final-output", "Final output", "target", "srgb", [
    input("scene-hdr", "tone map + sRGB"),
  ]),
] as const satisfies readonly PrismDebugSource[];

export const PRISM_DARK_DEBUG_SOURCES = [
  source("dark-wall", "Dark wall", "pass", "none"),
  source("dark-backdrop-hdr", "Backdrop HDR", "target", "hdr", [
    input("dark-wall", "base wall"),
  ]),
  source("dark-front-glass", "Front glass", "pass", "hdr", [
    input("dark-backdrop-hdr", "transmit / reflect"),
  ]),
  source("dark-scene-hdr", "Scene HDR", "target", "hdr", [
    input("dark-backdrop-hdr", "copy background"),
    input("dark-front-glass", "composite"),
  ]),
  source("dark-bloom-0", "Bloom 1/2", "target", "hdr", [
    input("dark-scene-hdr", "threshold + blur"),
  ]),
  source("dark-bloom-1", "Bloom 1/4", "target", "hdr", [
    input("dark-bloom-0", "downsample + blur"),
  ]),
  source("dark-bloom-2", "Bloom 1/8", "target", "hdr", [
    input("dark-bloom-1", "downsample + blur"),
  ]),
  source("dark-bloom-composite", "Bloom composite", "target", "hdr", [
    input("dark-bloom-0", "near halo"),
    input("dark-bloom-1", "medium halo"),
    input("dark-bloom-2", "far halo"),
  ]),
  source("dark-particle-light", "Particle light 1/16", "target", "hdr", [
    input("dark-scene-hdr", "particle illumination"),
  ]),
] as const satisfies readonly PrismDebugSource[];

export function debugSourcesForMode(
  mode: PrismPipelineMode
): readonly PrismDebugSource[] {
  return mode === "light" ? PRISM_DEBUG_SOURCES : PRISM_DARK_DEBUG_SOURCES;
}

function input(
  sourceId: PrismDebugSourceId,
  operation: string
): { readonly source: PrismDebugSourceId; readonly operation: string } {
  return { source: sourceId, operation };
}

function source(
  id: PrismDebugSourceId,
  label: string,
  kind: PrismDebugSource["kind"],
  visualization: PrismDebugSource["visualization"],
  inputs: readonly ReturnType<typeof input>[] = []
): PrismDebugSource {
  return { id, label, kind, inputs, visualization };
}
