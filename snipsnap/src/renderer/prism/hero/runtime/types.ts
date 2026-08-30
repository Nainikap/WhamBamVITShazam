import type { Buffer, Geometry, GeometryLike, Gpu } from "vgpu";

import type { CameraView } from "../camera";
import type { EnvironmentTexture } from "../environment-texture";
import type { NormalizedViewport, ProjectionFraming } from "../framing";
import type { PrismLayoutKind } from "../layout";
import type { LightMeshStats } from "../light-mesh";
import type { PrismControls, Triangle } from "../types";

export interface PrismLightSlot {
  readonly buffer: Buffer;
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly geometry: GeometryLike;
}

export interface PrismLightMeshMeasurement {
  readonly buildMs: number;
  readonly uploadMs: number;
  readonly bytes: number;
}

/** Installed only while the opt-in performance sampler owns the frame loop. */
export interface PrismRuntimeMeasurementSink {
  now(): number;
  recordLightMesh(sample: PrismLightMeshMeasurement): void;
}

/** Retained identities and mutable optical/camera state shared by both modes. */
export interface PrismRuntime {
  readonly gpu: Gpu;
  readonly label: string;
  readonly lightBuffer: Buffer;
  readonly lightVertexScratch: number[];
  readonly lightVertices: Float32Array<ArrayBuffer>;
  readonly lightGeometry: GeometryLike;
  prism: Geometry;
  solids: Geometry[];
  lightSlots: PrismLightSlot[];
  layout: PrismLayoutKind;
  triangles: Triangle[];
  solidsVersion: number;
  /** Allocated only when a debug wireframe is first requested. */
  prismWireframe?: Geometry | undefined;
  readonly sceneSampler: GPUSampler;
  readonly environmentSampler: GPUSampler;
  /** Allocates the authored orientation map only for the opt-in debug UI. */
  readonly debugEnvironmentEnabled: boolean;
  studioEnvironment?: EnvironmentTexture | undefined;
  debugEnvironment?: EnvironmentTexture | undefined;
  environmentReady?: Promise<void> | undefined;
  outputSize: readonly [number, number];
  lightStats: LightMeshStats;
  controls: PrismControls;
  lampArc: number;
  lampTarget: number;
  orbit: readonly [number, number];
  aspect: number;
  cameraDistance: number;
  framingViewport?: NormalizedViewport | undefined;
  framing: ProjectionFraming;
  view: CameraView;
  measurementSink?: PrismRuntimeMeasurementSink;
}
