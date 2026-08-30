import { iorAt, tracePrism } from "./optics";
import { entryMid } from "./layout";
import {
  collimatedLightBetween,
  type CollimatedLight,
  type DispersionPreset,
  type Triangle,
} from "./types";

/**
 * One homepage lamp, then their `tracePrism` again for every following solid.
 * The outgoing ray of prism n becomes the collimated beam into prism n + 1.
 */
export function lightsThroughPrisms(
  triangles: readonly Triangle[],
  first: CollimatedLight,
  dispersion: DispersionPreset
): CollimatedLight[] {
  const lights: CollimatedLight[] = [first];
  const ior = iorAt(550, dispersion.base, dispersion.strength);
  const width = first.beamHalfWidth * 2;
  for (let index = 0; index < triangles.length - 1; index++) {
    const current = lights[index]!;
    const triangle = triangles[index]!;
    const next = triangles[index + 1]!;
    const path = tracePrism(triangle, current.center, current.direction, ior);
    lights.push(
      collimatedLightBetween(path?.origin ?? current.center, entryMid(next), width)
    );
  }
  return lights;
}
