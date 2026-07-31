/**
 * Q16.16 deterministic fixed-point math — a bit-exact port of the helpers
 * found in the quip.gg client bundle (`index-*.js`).
 *
 * Original minified names are noted so the port can be re-verified against a
 * future bundle:
 *   ONE   -> xe      (1 << 16)
 *   fx    -> Z       (float  -> fixed, rounded)
 *   fxInt -> as      (int    -> fixed)
 *   toF   -> Se      (fixed  -> float)
 *   fmul  -> pe      (fixed multiply, floor)
 *   fdiv  -> Vn      (fixed divide, floor)
 *   isqrt -> ai      (integer sqrt with correction loops)
 *   norm  -> H3      (normalise a fixed vector)
 *   fmin  -> z3
 */

export const FRAC_BITS = 16;
export const ONE = 1 << FRAC_BITS; // 65536

/** float -> fixed (Z) */
export const fx = (t) => Math.round(t * ONE);
/** integer -> fixed (as) */
export const fxInt = (t) => (t | 0) * ONE;
/** fixed -> float (Se) */
export const toF = (t) => t / ONE;

/** fixed multiply (pe). Uses Math.floor exactly like the bundle. */
export function fmul(a, b) {
  return Math.floor((a * b) / ONE);
}

/** fixed divide (Vn). Division by zero yields 0, matching the bundle. */
export function fdiv(a, b) {
  return b === 0 ? 0 : Math.floor((a * ONE) / b);
}

/** clamp (Qf) */
export function clampI(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const iabs = (t) => (t < 0 ? -t : t);
export const fmin = (a, b) => (a < b ? a : b);
export const fmax = (a, b) => (a > b ? a : b);

/**
 * Integer square root (ai). The bundle seeds with Math.sqrt then corrects in
 * both directions, which makes it exact for all inputs representable as
 * doubles. Reproduced verbatim so results match bit-for-bit.
 */
export function isqrt(t) {
  if (t <= 0) return 0;
  let e = Math.floor(Math.sqrt(t));
  while (e > 0 && e * e > t) e--;
  while ((e + 1) * (e + 1) <= t) e++;
  return e;
}

/** length of a fixed vector (iRe) */
export const flen = (x, z) => isqrt(x * x + z * z);

/** normalise a fixed vector (H3); zero-vector maps to (1, 0) */
export function fnorm(x, z) {
  const l = flen(x, z);
  if (l === 0) return { x: ONE, z: 0 };
  return { x: fdiv(x, l), z: fdiv(z, l) };
}

/* ------------------------------------------------------------------ *
 * FNV-1a-style checksum over a state array (ja / N0e / TL).
 * Used to prove the port is bit-identical to the in-page simulation.
 * ------------------------------------------------------------------ */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function mixByte(h, b) {
  h ^= b & 255;
  h = Math.imul(h, FNV_PRIME);
  return h >>> 0;
}

function mixU32(h, v) {
  h = mixByte(h, v);
  h = mixByte(h, v >>> 8);
  h = mixByte(h, v >>> 16);
  h = mixByte(h, v >>> 24);
  return h;
}

export function checksumArray(arr) {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    const lo = s >>> 0;
    const hi = Math.floor(s / 4294967296) >>> 0;
    h = mixU32(h, lo);
    h = mixU32(h, hi);
  }
  return h >>> 0;
}
