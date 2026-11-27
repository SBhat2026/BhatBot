import * as THREE from 'three';

/*
 * BHATBOT PALETTE PASS.
 *
 * The office paints itself in a hundred hard-coded colors across its builders and GLB models (a red
 * jukebox, a pink rug, rainbow chairs). Rather than fork every one of them, each material in the
 * office is pulled — once — toward BhatBot's palette: its chroma is cut (quieter, more minimal) and its
 * hue drawn toward the nearest of BhatBot's anchors (burgundy, plum, indigo, teal, sage, sand), with
 * lightness kept so the room still reads. Near-greys and whites are left alone, so screens, paper and
 * glass are unchanged. People are not in office.group, so skin and clothes keep their own colors.
 */

// OKLCH hue anchors, in radians: burgundy, plum, indigo, teal-blue, sage, sand.
const ANCHORS = [12, 340, 285, 225, 150, 75].map((d) => (d * Math.PI) / 180);
const CHROMA_KEEP = 0.5;   // how much colorfulness survives
const HUE_PULL = 0.7;      // how far toward the nearest anchor

function lin(c: number) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function unlin(c: number) { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.min(1, Math.max(0, v)); }

/** sRGB (0–1, already gamma-encoded) → OKLCH. */
function toOklch(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), Math.atan2(Bb, A)];
}
function fromOklch(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
function nearestDelta(h: number): number {
  let best = Infinity;
  for (const a of ANCHORS) {
    let d = a - h;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

/** One color, in place. Greys, whites and blacks are untouched. */
export function harmonizeColor(c: THREE.Color) {
  const srgb = c.clone().convertLinearToSRGB();
  const [L, C, h] = toOklch(srgb.r, srgb.g, srgb.b);
  if (C < 0.025) return;
  const [r, g, b] = fromOklch(L, C * CHROMA_KEEP, h + nearestDelta(h) * HUE_PULL);
  c.setRGB(r, g, b, THREE.SRGBColorSpace);
}

const done = new WeakSet<THREE.Material>();

/** Every material under `root` that has not been harmonized yet. Cheap to call repeatedly. */
export function harmonize(root: THREE.Object3D) {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      if (!m || done.has(m)) continue;
      done.add(m);
      const anyM = m as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color };
      if (anyM.color) harmonizeColor(anyM.color);
      if (anyM.emissive && anyM.emissive.getHex() !== 0) harmonizeColor(anyM.emissive);
    }
  });
}

/** Keep the office harmonized as models finish loading and props are added. */
export function keepHarmonized(root: THREE.Object3D, everyMs = 2500) {
  harmonize(root);
  setInterval(() => harmonize(root), everyMs);
}
