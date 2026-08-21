/**
 * Leaf evaluation for the Slingshot Sumo planner.
 *
 * Everything here is derived from the real physics constants rather than
 * guessed, which is what lets a fairly short search horizon still play well:
 *
 *  - Position update per tick is `v = (v + a) * drag; p += v`, so a velocity
 *    left alone carries the puck a further `v * drag/(1-drag)` = v * 18.23
 *    units. That "coast distance" is the single most important feature: a puck
 *    can be doomed long before it crosses the rim.
 *  - Top walking speed is `a * drag/(1-drag)` = 0.022 * 18.23 = 0.401 u/tick.
 *  - The tether caps its pull at 0.09 u/tick once stretch >= 4.5, and a braced
 *    puck only receives 34% of it while also having drag 0.7 (coast factor
 *    2.33 instead of 18.23). Anchoring therefore transfers almost all of the
 *    rope energy into the opponent — the core winning mechanic.
 */

import { toF } from '../engine/fixed.js';
import {
  Phase,
  ARENA_MIN,
  DRAG,
  BRACE_DRAG,
  SHRINK_PER_TICK,
  TETHER_REST,
  TETHER_STIFF,
  TETHER_MAX_IMP,
  BRACE_INV_MASS,
  DASH_COOLDOWN,
  PARRY_WHIFF_CD,
} from '../engine/slingshot.js';

const DRAG_F = toF(DRAG);
const BRACE_DRAG_F = toF(BRACE_DRAG);
/** Total future displacement per unit of current velocity. */
export const COAST = DRAG_F / (1 - DRAG_F); // 18.23
export const BRACE_COAST = BRACE_DRAG_F / (1 - BRACE_DRAG_F); // 2.33
const SHRINK_F = toF(SHRINK_PER_TICK);
const ARENA_MIN_F = toF(ARENA_MIN);
const REST_F = toF(TETHER_REST);
const STIFF_F = toF(TETHER_STIFF);
const MAX_IMP_F = toF(TETHER_MAX_IMP);
const BRACE_INV_F = toF(BRACE_INV_MASS);

export const DEFAULT_WEIGHTS = {
  score: 1_000_000,
  scoreTiming: 60,
  risk: 2600,
  doom: 9000,
  centre: 260,
  rope: 520,
  dash: 70,
  parry: 26,
  speed: 40,
  proximity: 34,
};

/**
 * Signed "how close to being ringed out" measure. 0 = dead centre,
 * 1 = exactly on the rim, >1 = already ejected once the coast plays out.
 */
function riskOf(x, z, vx, vz, coast, ropeAx, ropeAz, radius) {
  // Where the puck ends up if nothing else happens: current position plus the
  // full coast of its velocity, plus the rope's sustained contribution.
  const px = x + vx * coast + ropeAx * coast * 0.5;
  const pz = z + vz * coast + ropeAz * coast * 0.5;
  const proj = Math.sqrt(px * px + pz * pz);
  const now = Math.sqrt(x * x + z * z);
  // Use the worse of "where it is now" and "where it is heading".
  const d = Math.max(now, proj * 0.86 + now * 0.14);
  return d / radius;
}

/**
 * Evaluate a leaf state from `seat`'s point of view. Higher is better.
 *
 * @param {import('../engine/slingshot.js').SlingshotSim} sim
 * @param {number} seat
 * @param {object} ctx  { scoreTick, elapsed, weights }
 */
export function evaluate(sim, seat, ctx) {
  const W = ctx.weights || DEFAULT_WEIGHTS;
  const opp = 1 - seat;

  if (sim.phase === Phase.Over) {
    const win = sim.winner === seat;
    return (win ? 1 : -1) * (W.score * 8) - (win ? ctx.elapsed * W.scoreTiming : -ctx.elapsed * W.scoreTiming);
  }

  const diff = sim.scores[seat] - sim.scores[opp];
  let v = diff * W.score;
  // Prefer scoring sooner and conceding later.
  if (ctx.scoreTick > 0 && diff !== 0) v -= Math.sign(diff) * ctx.scoreTick * W.scoreTiming;

  // During Scored/Countdown the pucks are frozen and repositioned, so the
  // positional terms carry no information — the score term is the whole story.
  if (sim.phase !== Phase.Live) return v;

  const a = sim.world.bodies[seat];
  const b = sim.world.bodies[opp];
  const ax = toF(a.px);
  const az = toF(a.pz);
  const bx = toF(b.px);
  const bz = toF(b.pz);
  const avx = toF(a.vx);
  const avz = toF(a.vz);
  const bvx = toF(b.vx);
  const bvz = toF(b.vz);

  // Arena radius by the time the coast has played out.
  const R = Math.max(ARENA_MIN_F, toF(sim.arenaRadius) - SHRINK_F * COAST);

  // --- tether ---------------------------------------------------------
  const tdx = bx - ax;
  const tdz = bz - az;
  const sep = Math.sqrt(tdx * tdx + tdz * tdz);
  const stretch = Math.max(0, sep - REST_F);
  const imp = Math.min(stretch * STIFF_F, MAX_IMP_F);
  let ropeAx = 0;
  let ropeAz = 0;
  let ropeBx = 0;
  let ropeBz = 0;
  if (stretch > 0 && sep > 0) {
    const ux = tdx / sep;
    const uz = tdz / sep;
    const myScale = sim.bracing[seat] ? BRACE_INV_F : 1;
    const opScale = sim.bracing[opp] ? BRACE_INV_F : 1;
    ropeAx = ux * imp * myScale;
    ropeAz = uz * imp * myScale;
    ropeBx = -ux * imp * opScale;
    ropeBz = -uz * imp * opScale;
  }

  const myCoast = sim.bracing[seat] ? BRACE_COAST : COAST;
  const opCoast = sim.bracing[opp] ? BRACE_COAST : COAST;

  const riskMe = riskOf(ax, az, avx, avz, myCoast, ropeAx, ropeAz, R);
  const riskOp = riskOf(bx, bz, bvx, bvz, opCoast, ropeBx, ropeBz, R);

  v += (riskOp - riskMe) * W.risk;

  // Hard "already lost / already won" shaping: risk above 1 means the puck
  // leaves the disc unless it spends effort recovering.
  if (riskMe > 1) v -= (riskMe - 1) * W.doom;
  if (riskOp > 1) v += (riskOp - 1) * W.doom;

  // --- staying central ------------------------------------------------
  const dMe = Math.sqrt(ax * ax + az * az) / R;
  const dOp = Math.sqrt(bx * bx + bz * bz) / R;
  v -= dMe * dMe * W.centre;
  v += dOp * dOp * W.centre;

  // --- rope leverage ---------------------------------------------------
  // The rope drags the opponent toward us. That is only good when we sit
  // radially *outside* them, and it is best when we are braced (they take the
  // full 0.09/tick while we barely move).
  if (stretch > 0) {
    const tension = Math.min(stretch, 4.5) / 4.5;
    const lever = (dMe - dOp) * tension;
    const anchorBonus = sim.bracing[seat] ? 1.6 : 1;
    v += lever * W.rope * anchorBonus;
  }

  // --- resources -------------------------------------------------------
  v += (1 - sim.dashCd[seat] / DASH_COOLDOWN) * W.dash;
  v -= (1 - sim.dashCd[opp] / DASH_COOLDOWN) * W.dash;
  v += (sim.parryWhiffCd[seat] === 0 ? 1 : 0) * W.parry;
  v -= (sim.parryWhiffCd[opp] === 0 ? 1 : 0) * W.parry;

  // Excess speed near the rim is dangerous; mild penalty keeps us controllable.
  const mySpeed = Math.sqrt(avx * avx + avz * avz);
  v -= mySpeed * dMe * W.speed;

  // Slight preference for keeping the rope slack-but-short: being adjacent lets
  // us convert a dash into a shove, and denies them a free slingshot.
  v -= Math.abs(sep - REST_F * 0.75) * W.proximity * 0.1;

  return v;
}

export default evaluate;
