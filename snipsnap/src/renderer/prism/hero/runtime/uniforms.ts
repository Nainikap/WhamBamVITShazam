import { rotationMatrix } from "../camera";
import {
  ENVIRONMENT_SIZE,
  ENVIRONMENT_TEXEL_ANGLE,
} from "../environment-texture";
import {
  LIGHT_INTERNAL_QUADS,
  LIGHT_INTERNAL_SEGMENTS,
  LIGHT_WHITE_QUADS,
} from "../light-mesh";
import { prismPlanes } from "../prism-mesh";
import {
  PRISM_BACK_Z,
  PRISM_BEAM_SLICES,
  PRISM_FRONT_Z,
  PRISM_GLASS,
  PRISM_LIGHT_PLANE_Z,
  PRISM_TRIANGLE,
  type PrismTheme,
} from "../types";
import { lampAt, wallExtent } from "./state";
import type { PrismRuntime } from "./types";

const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);
const PRISM_PLANES = prismPlanes();

/** Schlick's normal-incidence reflectance, rounded like the shader's f32 math. */
export function schlickFresnelF0(ior: number): number {
  const shaderIor = Math.fround(ior);
  const ratio = Math.fround(
    Math.fround(shaderIor - 1) / Math.fround(shaderIor + 1)
  );
  return Math.fround(ratio * ratio);
}

/** Shared block used by wall and light draws in either theme. */
export function sceneUniforms(
  runtime: PrismRuntime,
  beamWidthReveal = 1
): Record<string, unknown> {
  const light = lampAt(
    runtime.lampArc,
    runtime.controls.beamWidth,
    runtime.lampTarget,
    runtime.controls.beamMouseY
  );
  const wallColor = runtime.controls.wallColor.match(
    /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
  );
  return {
    viewProjection: runtime.view.viewProjection,
    wallHalfExtent: runtimeWallExtent(runtime),
    inputBeamDirection: light.direction,
    wallColor: wallColor
      ? wallColor.slice(1).map((channel) => Number.parseInt(channel, 16) / 255)
      : [0, 0, 0],
    causticOnly: runtime.controls.view === "caustic" ? 1 : 0,
    lightPlaneZ: PRISM_LIGHT_PLANE_Z,
    lightWhiteQuads: LIGHT_WHITE_QUADS,
    lightBeamSlices: PRISM_BEAM_SLICES,
    lightInternalQuads: LIGHT_INTERNAL_QUADS,
    lightInternalSegments: LIGHT_INTERNAL_SEGMENTS,
    lightOpacity: runtime.controls.lightFade.beamOpacity,
    lightEdgeFalloff: runtime.controls.lightFade.edgeFalloff,
    rainbowFalloffRate: runtime.controls.lightFade.rainbowFalloffRate,
    rainbowFalloffPower: runtime.controls.lightFade.rainbowFalloffPower,
    beamWidthReveal: Math.min(1, Math.max(0, beamWidthReveal)),
  };
}

export function glassUniforms(
  runtime: PrismRuntime,
  mode: PrismTheme,
  triangle = runtime.triangles[0] ?? PRISM_TRIANGLE
): Record<string, unknown> {
  const glass = runtime.controls.glass;
  const transmission = glass.transmission[mode];
  const reflection = glass.reflection[mode];
  return {
    viewProjection: runtime.view.viewProjection,
    environmentRotation: ENVIRONMENT_ROTATION,
    cameraPosition: runtime.view.position,
    absorption: transmission.absorption,
    prismA: triangle.a,
    prismB: triangle.b,
    prismC: triangle.c,
    environmentSize: ENVIRONMENT_SIZE,
    frontZ: PRISM_FRONT_Z,
    backZ: PRISM_BACK_Z,
    ior: transmission.ior,
    reflectionStrength: reflection.reflectionStrength,
    environmentExposure: reflection.environmentExposure,
    environmentDebug:
      runtime.debugEnvironmentEnabled && runtime.controls.environmentDebug
        ? 1
        : 0,
    environmentTexelAngle: ENVIRONMENT_TEXEL_ANGLE,
    fresnelF0: schlickFresnelF0(transmission.ior),
    prismPlanes: prismPlanes(triangle),
  };
}

export function runtimeWallExtent(
  runtime: PrismRuntime
): readonly [number, number] {
  return wallExtent(
    runtime.aspect,
    runtime.cameraDistance,
    runtime.controls.cameraFov,
    runtime.framing
  );
}
