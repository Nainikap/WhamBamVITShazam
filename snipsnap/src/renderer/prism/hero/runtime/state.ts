import { cameraView, wallHalfHeight, type CameraView } from "../camera";
import {
  applyProjectionFraming,
  fitProjectionDistance,
  framingCoverage,
  IDENTITY_PROJECTION_FRAMING,
  projectedBounds,
  type NormalizedViewport,
  type ProjectionFraming,
} from "../framing";
import { lightsThroughPrisms } from "../chain";
import { buildLightMesh } from "../light-mesh";
import type { PrismLayoutKind } from "../layout";
import { prismMeshData } from "../prism-mesh";
import { prismGeometry } from "../prism-mesh";
import { layoutCameraDistance, prismLayout } from "../layout";
import { LIGHT_VERTEX_STRIDE, lightVertexCount } from "../light-mesh";
import type { PrismLightSlot } from "./types";
import {
  CAMERA_DISTANCE,
  DEFAULT_PRISM_CONTROLS,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_FRONT_Z,
  PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES,
  lampForIncidence,
  type BeamMouseYControls,
  type CollimatedLight,
  type PrismControls,
} from "../types";
import { normalizeControls } from "./normalize-controls";
import type { PrismRuntime } from "./types";

const CAMERA_FIT_MIN_DISTANCE = PRISM_FRONT_Z + 0.1;
const CAMERA_FIT_MAX_DISTANCE = 32;
const PRISM_FRAME_POINTS = (() => {
  const vertices = prismMeshData().vertices;
  const points: [number, number, number][] = [];
  for (let index = 0; index < vertices.length; index += 6) {
    points.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return points;
})();

function refreshRuntime(runtime: PrismRuntime): void {
  refreshFraming(runtime);
  refreshCamera(runtime);
  refreshLightMesh(runtime);
}

export function setRuntimeControls(
  runtime: PrismRuntime,
  controls: PrismControls
): void {
  const next = normalizeControls(controls);
  const opticsChanged =
    next.dispersion !== runtime.controls.dispersion ||
    next.spectralDispersion?.base !==
      runtime.controls.spectralDispersion?.base ||
    next.spectralDispersion?.strength !==
      runtime.controls.spectralDispersion?.strength ||
    next.beamWidth !== runtime.controls.beamWidth ||
    next.beamMouseY.top !== runtime.controls.beamMouseY.top ||
    next.beamMouseY.bottom !== runtime.controls.beamMouseY.bottom ||
    next.lightFade.edgeFalloff !== runtime.controls.lightFade.edgeFalloff;
  const cameraChanged = next.cameraFov !== runtime.controls.cameraFov;
  runtime.controls = next;
  if (cameraChanged) {
    refreshFraming(runtime);
    refreshCamera(runtime);
  }
  if (opticsChanged || cameraChanged) refreshLightMesh(runtime);
}

export function setRuntimeLampArc(
  runtime: PrismRuntime,
  position: number
): void {
  setRuntimeLampAim(runtime, position, runtime.lampTarget);
}

export function setRuntimeLampAim(
  runtime: PrismRuntime,
  arcPosition: number,
  targetPosition: number
): void {
  const nextArc = Math.min(1, Math.max(0, arcPosition));
  const nextTarget = Math.min(1, Math.max(0, targetPosition));
  if (nextArc === runtime.lampArc && nextTarget === runtime.lampTarget) return;
  runtime.lampArc = nextArc;
  runtime.lampTarget = nextTarget;
  refreshLightMesh(runtime);
}

export function setRuntimeOrbit(
  runtime: PrismRuntime,
  x: number,
  y: number
): void {
  runtime.orbit = [Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y))];
  refreshCamera(runtime);
}

export function setRuntimeLayout(
  runtime: PrismRuntime,
  kind: PrismLayoutKind
): void {
  if (runtime.layout === kind) return;
  const triangles = prismLayout(kind);
  for (const solid of runtime.solids) solid.destroy();
  runtime.triangles = triangles;
  runtime.layout = kind;
  runtime.solids = triangles.map((triangle, index) =>
    prismGeometry(runtime.gpu, `${runtime.label}.prism.${index}`, triangle)
  );
  runtime.prism = runtime.solids[0]!;
  runtime.cameraDistance = layoutCameraDistance(kind);
  runtime.solidsVersion += 1;
  while (runtime.lightSlots.length < triangles.length) {
    const empty = new Float32Array(lightVertexCount() * 3);
    const buffer = runtime.gpu.device.createBuffer({
      size: empty.byteLength,
      usage: ["vertex", "copy_dst"],
      label: `${runtime.label}.light-vertices.${runtime.lightSlots.length}`,
    });
    buffer.write(empty);
    const slot: PrismLightSlot = {
      buffer,
      vertices: empty,
      geometry: {
        vertexBuffers: [buffer.gpu],
        vertexBufferLayouts: [
          {
            arrayStride: LIGHT_VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32" },
            ],
          },
        ],
        vertexCount: lightVertexCount(),
      },
    };
    runtime.lightSlots.push(slot);
  }
  refreshCamera(runtime);
  refreshLightMesh(runtime);
}

export function setRuntimeFramingViewport(
  runtime: PrismRuntime,
  viewport: NormalizedViewport | undefined
): void {
  if (sameViewport(runtime.framingViewport, viewport)) return;
  runtime.framingViewport = viewport;
  refreshRuntime(runtime);
}

export function resizeRuntime(
  runtime: PrismRuntime,
  output: readonly [number, number]
): void {
  if (
    runtime.outputSize[0] === output[0] &&
    runtime.outputSize[1] === output[1]
  )
    return;
  runtime.outputSize = output;
  runtime.aspect = output[0] / Math.max(1, output[1]);
  refreshRuntime(runtime);
}

export function incidenceAt(
  position: number,
  beamMouseY: BeamMouseYControls = DEFAULT_PRISM_CONTROLS.beamMouseY
): number {
  const clamped = Math.min(1, Math.max(0, position));
  if (clamped <= 0.5) {
    return (
      beamMouseY.top +
      (PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES - beamMouseY.top) * clamped * 2
    );
  }
  return (
    PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES +
    (beamMouseY.bottom - PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES) *
      (clamped - 0.5) *
      2
  );
}

export function lampAt(
  position: number = PRISM_DEFAULT_ARC,
  beamWidth = DEFAULT_PRISM_CONTROLS.beamWidth,
  targetPosition = 0.5,
  beamMouseY: BeamMouseYControls = DEFAULT_PRISM_CONTROLS.beamMouseY
): CollimatedLight {
  return lampForIncidence(
    incidenceAt(position, beamMouseY),
    beamWidth,
    targetPosition
  );
}

export function wallExtent(
  aspect: number,
  cameraDistance = CAMERA_DISTANCE,
  cameraFov = DEFAULT_PRISM_CONTROLS.cameraFov,
  framing: ProjectionFraming = IDENTITY_PROJECTION_FRAMING
): readonly [number, number] {
  const halfHeight = wallHalfHeight(aspect, cameraDistance, cameraFov);
  const coverage = framingCoverage(framing);
  return [halfHeight * aspect * coverage[0], halfHeight * coverage[1]];
}

/**
 * Keeps the rainbow's dark tail outside narrow portrait canvases. The light
 * mesh is clipped by the real render target, so overscanning its wall boundary
 * changes only where normalized outgoing travel reaches one.
 */
export function lightWallExtent(
  aspect: number,
  cameraDistance = CAMERA_DISTANCE,
  cameraFov = DEFAULT_PRISM_CONTROLS.cameraFov,
  framing: ProjectionFraming = IDENTITY_PROJECTION_FRAMING
): readonly [number, number] {
  const extent = wallExtent(aspect, cameraDistance, cameraFov, framing);
  const overscan = Math.min(2.5, Math.max(1, 1 / Math.max(aspect, 1e-3)));
  return [extent[0] * overscan, extent[1] * overscan];
}

function refreshCamera(runtime: PrismRuntime): void {
  const view = cameraView(
    runtime.aspect,
    runtime.orbit[0],
    runtime.orbit[1],
    runtime.cameraDistance,
    runtime.controls.cameraFov
  );
  runtime.view = {
    ...view,
    viewProjection: applyProjectionFraming(
      view.viewProjection,
      runtime.framing
    ),
  };
}

function refreshFraming(runtime: PrismRuntime): void {
  const viewport = runtime.framingViewport;
  if (!viewport) {
    runtime.cameraDistance = CAMERA_DISTANCE;
    runtime.framing = IDENTITY_PROJECTION_FRAMING;
    return;
  }
  const fit = fitProjectionDistance(
    viewport,
    (distance) =>
      projectedBounds(
        framingMatrices(runtime.aspect, distance, runtime.controls.cameraFov),
        PRISM_FRAME_POINTS
      ),
    CAMERA_FIT_MIN_DISTANCE,
    CAMERA_FIT_MAX_DISTANCE
  );
  runtime.cameraDistance = fit.distance;
  runtime.framing = fit.framing;
}

function refreshLightMesh(runtime: PrismRuntime): void {
  const measurement = runtime.measurementSink;
  const startedAt = measurement?.now();
  const dispersion =
    runtime.controls.spectralDispersion ??
    PRISM_DISPERSION_PRESETS[runtime.controls.dispersion];
  const first = lampAt(
    runtime.lampArc,
    runtime.controls.beamWidth,
    runtime.lampTarget,
    runtime.controls.beamMouseY
  );
  const lights = lightsThroughPrisms(runtime.triangles, first, dispersion);
  const wallHalfExtent = lightWallExtent(
    runtime.aspect,
    runtime.cameraDistance,
    runtime.controls.cameraFov,
    runtime.framing
  );
  let bytes = 0;
  runtime.triangles.forEach((triangle, index) => {
    const slot = runtime.lightSlots[index];
    const light = lights[index];
    if (!slot || !light) return;
    const mesh = buildLightMesh(
      {
        light,
        triangle,
        dispersion,
        edgeFalloff: runtime.controls.lightFade.edgeFalloff,
        wallHalfExtent,
      },
      slot.vertices,
      runtime.lightVertexScratch
    );
    slot.buffer.write(slot.vertices);
    bytes += mesh.vertices.byteLength;
    if (index === 0) runtime.lightStats = mesh.stats;
  });
  const builtAt = measurement?.now();
  if (measurement && startedAt !== undefined && builtAt !== undefined) {
    measurement.recordLightMesh({
      buildMs: builtAt - startedAt,
      uploadMs: measurement.now() - builtAt,
      bytes,
    });
  }
}

function framingMatrices(
  aspect: number,
  distance: number,
  fov: number
): CameraView["viewProjection"][] {
  const matrices: CameraView["viewProjection"][] = [];
  for (const orbitX of [-1, 0, 1]) {
    for (const orbitY of [-1, 0, 1]) {
      matrices.push(
        cameraView(aspect, orbitX, orbitY, distance, fov).viewProjection
      );
    }
  }
  return matrices;
}

function sameViewport(
  a: NormalizedViewport | undefined,
  b: NormalizedViewport | undefined
): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.left - b.left) < 1e-5 &&
    Math.abs(a.top - b.top) < 1e-5 &&
    Math.abs(a.right - b.right) < 1e-5 &&
    Math.abs(a.bottom - b.bottom) < 1e-5
  );
}
