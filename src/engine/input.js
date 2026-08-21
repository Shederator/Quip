/**
 * Input bit encoding — bit-exact port of the quip.gg protocol helpers.
 *
 *   BTN   -> ae         button bit flags
 *   NONE  -> Fo         (0)
 *   BTN_MASK -> Q4      (63)  low 6 bits = buttons
 *   AIM_BITS -> X$      (6)   bits per signed aim component
 *   AIM_MASK -> J$      (63)
 *   AIM_MAX  -> Pl      (31)
 *   AIM_X_SHIFT -> zoe  (6)
 *   AIM_Z_SHIFT -> Hoe  (12)
 *   FULL_MASK -> kd
 *
 * Slingshot Sumo only consumes the 6 button bits (via `dirOf`), but the aim
 * payload is still part of the wire format so we reproduce it faithfully.
 */

export const BTN = {
  Up: 1,
  Down: 2,
  Left: 4,
  Right: 8,
  Dash: 16,
  Brace: 32,
};

export const NONE = 0;
export const BTN_MASK = 63;
const AIM_BITS = 6;
const AIM_MASK = (1 << AIM_BITS) - 1;
export const AIM_MAX = (1 << (AIM_BITS - 1)) - 1; // 31
const AIM_X_SHIFT = 6;
const AIM_Z_SHIFT = 12;
export const FULL_MASK = BTN_MASK | (AIM_MASK << AIM_X_SHIFT) | (AIM_MASK << AIM_Z_SHIFT);

/** has(bits, flag) -> nn */
export function has(bits, flag) {
  return (bits & flag) !== 0;
}

/** sanitise a full input word -> ET */
export function sanitize(t) {
  return (t | 0) & FULL_MASK;
}

/** buttons only -> aE */
export function buttonsOf(t) {
  return t & BTN_MASK;
}

function clampAim(v) {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v);
  return r < -AIM_MAX ? -AIM_MAX : r > AIM_MAX ? AIM_MAX : r;
}

function packAim(v) {
  return clampAim(v) & AIM_MASK;
}

function unpackAim(word, shift) {
  const n = (word >> shift) & AIM_MASK;
  return n & (1 << (AIM_BITS - 1)) ? n - (1 << AIM_BITS) : n;
}

/** encode(buttons, aimX, aimZ) -> F3 */
export function encode(buttons, aimX = 0, aimZ = 0) {
  return sanitize((buttons & BTN_MASK) | (packAim(aimX) << AIM_X_SHIFT) | (packAim(aimZ) << AIM_Z_SHIFT));
}

/** decodeAim -> RU */
export function decodeAim(word) {
  return { x: unpackAim(word, AIM_X_SHIFT), z: unpackAim(word, AIM_Z_SHIFT) };
}

/**
 * Direction from button bits -> Yp.
 * NOTE the screen-space convention: Up decreases z.
 */
export function dirOf(bits) {
  let x = 0;
  let z = 0;
  if (has(bits, BTN.Left)) x -= 1;
  if (has(bits, BTN.Right)) x += 1;
  if (has(bits, BTN.Up)) z -= 1;
  if (has(bits, BTN.Down)) z += 1;
  return { x, z };
}

/**
 * Inverse of dirOf with a dead-zone — the same helper the built-in bots use
 * to turn a desired vector into button bits (`Lv`).
 */
export function bitsForVector(x, z, deadzone) {
  let s = 0;
  if (x > deadzone) s |= BTN.Right;
  else if (x < -deadzone) s |= BTN.Left;
  if (z > deadzone) s |= BTN.Down;
  else if (z < -deadzone) s |= BTN.Up;
  return s;
}

/** The 8 cardinal/diagonal button combos plus "no movement". */
export const DIR_BITS = [
  0,
  BTN.Up,
  BTN.Up | BTN.Right,
  BTN.Right,
  BTN.Down | BTN.Right,
  BTN.Down,
  BTN.Down | BTN.Left,
  BTN.Left,
  BTN.Up | BTN.Left,
];

/** Human-readable rendering, handy for logs and the dashboard. */
export function describe(bits) {
  const parts = [];
  if (has(bits, BTN.Up)) parts.push('U');
  if (has(bits, BTN.Down)) parts.push('D');
  if (has(bits, BTN.Left)) parts.push('L');
  if (has(bits, BTN.Right)) parts.push('R');
  if (has(bits, BTN.Dash)) parts.push('DASH');
  if (has(bits, BTN.Brace)) parts.push('BRACE');
  return parts.length ? parts.join('+') : 'idle';
}
