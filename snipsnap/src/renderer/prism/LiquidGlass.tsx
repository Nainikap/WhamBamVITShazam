/**
 * Liquid glass after kube.io/blog/liquid-glass-css-svg:
 * convex-squircle bezel, SVG displacement map, specular rim, backdrop-filter.
 * Electron is Chromium, so `backdrop-filter: url()` is available.
 */

const MAP = 128;
const BEZEL = 0.22;

function squircle(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return (1 - (1 - t) ** 4) ** 0.25;
}

function roundedRectSdf(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x - width * 0.5) - (width * 0.5 - radius);
  const qy = Math.abs(y - height * 0.5) - (height * 0.5 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function buildDisplacementMap(): string {
  const canvas = document.createElement('canvas');
  canvas.width = MAP;
  canvas.height = MAP;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(MAP, MAP);
  const radius = MAP * 0.22;
  const bezelPx = MAP * BEZEL;
  for (let y = 0; y < MAP; y += 1) {
    for (let x = 0; x < MAP; x += 1) {
      const sdf = -roundedRectSdf(x + 0.5, y + 0.5, MAP, MAP, radius);
      const fromEdge = Math.min(1, Math.max(0, sdf / bezelPx));
      const height = squircle(fromEdge);
      const cx = x + 0.5 - MAP * 0.5;
      const cy = y + 0.5 - MAP * 0.5;
      const length = Math.hypot(cx, cy) || 1;
      const magnitude = (1 - height) * 0.92;
      const dx = (cx / length) * magnitude;
      const dy = (cy / length) * magnitude;
      const index = (y * MAP + x) * 4;
      image.data[index] = Math.round(128 + dx * 127);
      image.data[index + 1] = Math.round(128 + dy * 127);
      image.data[index + 2] = 128;
      image.data[index + 3] = sdf > 0 ? 255 : 0;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function buildSpecularMap(): string {
  const canvas = document.createElement('canvas');
  canvas.width = MAP;
  canvas.height = MAP;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(MAP, MAP);
  const radius = MAP * 0.22;
  const light = { x: -0.55, y: -0.75 };
  for (let y = 0; y < MAP; y += 1) {
    for (let x = 0; x < MAP; x += 1) {
      const sdf = -roundedRectSdf(x + 0.5, y + 0.5, MAP, MAP, radius);
      const band = Math.max(0, 1 - Math.abs(sdf - MAP * 0.06) / (MAP * 0.08));
      const nx = (x + 0.5 - MAP * 0.5) / (MAP * 0.5);
      const ny = (y + 0.5 - MAP * 0.5) / (MAP * 0.5);
      const shine = Math.max(0, -(nx * light.x + ny * light.y));
      const tone = Math.round(255 * band * shine ** 1.4);
      const index = (y * MAP + x) * 4;
      image.data[index] = tone;
      image.data[index + 1] = tone;
      image.data[index + 2] = tone;
      image.data[index + 3] = Math.round(band * 220);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

const displacementMap = typeof document === 'undefined' ? '' : buildDisplacementMap();
const specularMap = typeof document === 'undefined' ? '' : buildSpecularMap();

/** Filter definitions shared by every glass surface. Render once, near the root. */
export function GlassFilters() {
  return <svg aria-hidden="true" className="vg-glass-defs" focusable="false">
    <defs>
      <filter id="vg-liquid" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
        <feImage href={displacementMap} x="0" y="0" width="100%" height="100%" result="displace" preserveAspectRatio="none" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="displace"
          scale="28"
          xChannelSelector="R"
          yChannelSelector="G"
          result="refract"
        />
        <feGaussianBlur in="refract" stdDeviation="0.45" result="soft" />
        <feImage href={specularMap} x="0" y="0" width="100%" height="100%" result="spec" preserveAspectRatio="none" />
        <feBlend in="soft" in2="spec" mode="screen" />
      </filter>
    </defs>
  </svg>;
}

/** The decorative layers of one pane. Drop inside anything with `position: relative`. */
export function GlassSurface() {
  return <>
    <span aria-hidden="true" className="vg-glass-blur" />
    <span aria-hidden="true" className="vg-glass-warp" />
    <span aria-hidden="true" className="vg-glass-edge" />
    <span aria-hidden="true" className="vg-glass-sheen" />
  </>;
}
