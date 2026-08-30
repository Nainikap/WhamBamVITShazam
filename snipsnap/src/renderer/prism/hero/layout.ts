import {
  PRISM_SIDE,
  PRISM_TRIANGLE,
  type Triangle,
  type Vec2,
} from "./types";

export type PrismLayoutKind = "hero" | "strip" | "corners";

const translate = (triangle: Triangle, offset: Vec2, scale = 1): Triangle => {
  const move = (point: Vec2): Vec2 => [
    point[0] * scale + offset[0],
    point[1] * scale + offset[1],
  ];
  return { a: move(triangle.a), b: move(triangle.b), c: move(triangle.c) };
};

/** Entry midpoint of the right-hand face, matching the homepage lamp aim. */
export function entryMid(triangle: Triangle): Vec2 {
  return [
    (triangle.a[0] + triangle.c[0]) * 0.5,
    (triangle.a[1] + triangle.c[1]) * 0.5,
  ];
}

/**
 * Stage layouts for the same optical solid the homepage hero traces.
 *
 * `hero` is their single prism. `strip` is the library zigzag — first and last
 * sit past the frame. `corners` is the project zoom, one solid at each corner
 * so a click that travels here still sees glass and the connecting beam.
 */
export function prismLayout(kind: PrismLayoutKind): Triangle[] {
  if (kind === "hero") return [PRISM_TRIANGLE];

  const small = PRISM_TRIANGLE;

  if (kind === "strip") {
    return [
      translate(small, [0.96, -0.16], 0.78),
      translate(small, [0.32, 0.28], 0.78),
      translate(small, [-0.32, -0.2], 0.78),
      translate(small, [-0.96, 0.24], 0.78),
    ];
  }

  const corner = PRISM_SIDE * 0.58;
  return [
    translate(small, [0.86, -0.46], corner / PRISM_SIDE),
    translate(small, [0.86, 0.46], corner / PRISM_SIDE),
    translate(small, [-0.86, 0.46], corner / PRISM_SIDE),
    translate(small, [-0.86, -0.46], corner / PRISM_SIDE),
  ];
}

export function layoutCameraDistance(kind: PrismLayoutKind): number {
  if (kind === "hero") return 1.25;
  if (kind === "strip") return 2.05;
  return 1.92;
}
