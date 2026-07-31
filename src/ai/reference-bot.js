/**
 * Exact port of the game's built-in Slingshot Sumo opponents (`Nkt` + tables
 * Iv / Bq / g3e / Pkt / Rkt / Uq in the bundle).
 *
 * This is *not* our player. We need it because in warm-up / practice mode the
 * opponent is this function, and it is fully deterministic — so porting it
 * exactly turns the match into a solvable single-agent planning problem.
 */

import { BTN, bitsForVector } from '../engine/input.js';
import { Phase } from '../engine/slingshot.js';

const hyp = (x, z) => Math.sqrt(x * x + z * z);

/** Iv — movement dead-zone (higher = sloppier steering). */
const DEADZONE = { rookie: 0.5, pro: 0.4, shark: 0.28, tutorial: 0.5 };
/** Bq — periodic "asleep" mask; non-zero means the bot idles some ticks. */
const IDLE_MASK = { rookie: 3, pro: 0, shark: 0, tutorial: 3 };
/** g3e — predictive parry lookahead in ticks (0 = never parries on read). */
const PARRY_LOOKAHEAD = { rookie: 0, pro: 0, shark: 9, tutorial: 0 };
/** Pkt — uses the tether-slingshot dash opener. */
const USE_SLING = { rookie: 0, pro: 0, shark: 1, tutorial: 0 };
/** Rkt — braces to anchor a taut tether. */
const USE_ANCHOR = { rookie: 0, pro: 1, shark: 1, tutorial: 0 };
/** Uq — max range at which it will commit a dash. */
const DASH_RANGE = { rookie: 2, pro: 2.8, shark: 3.2, tutorial: 0 };

export const BOT_LEVELS = ['rookie', 'pro', 'shark', 'tutorial'];

/**
 * @param {object} rs   render state (sim.getRenderState())
 * @param {number} seat seat the bot is playing
 * @param {string} level 'rookie' | 'pro' | 'shark' | 'tutorial'
 * @returns {number} input word (button bits only)
 */
export function referenceBot(rs, seat, level = 'pro') {
  if (rs.phase !== Phase.Live) return 0;

  const me = rs.pucks[seat];
  const op = rs.pucks[1 - seat];
  const R = rs.arenaRadius;
  const myDist = hyp(me.x, me.z);
  const opDist = hyp(op.x, op.z);

  // Deliberate idle ticks (rookie / tutorial handicap).
  if (IDLE_MASK[level] !== 0 && ((rs.tick >> 4) & IDLE_MASK[level]) === IDLE_MASK[level]) return 0;

  // Panic-recover toward the centre when close to the rim.
  const rimGuard = R - 1.6;
  if (myDist > rimGuard) {
    let bits = bitsForVector(-me.x, -me.z, DEADZONE[level] * 0.5);
    if (level !== 'tutorial' && me.dashReady && myDist > R - 1) bits |= BTN.Dash;
    return bits;
  }

  if (level === 'tutorial') {
    const dx = op.x - me.x;
    const dz = op.z - me.z;
    const dist = hyp(dx, dz);
    if (myDist > 0.9) return bitsForVector(-me.x, -me.z, DEADZONE[level] * 0.6);
    if (dist < 2.2) return bitsForVector(-dz, dx, DEADZONE[level]);
    return 0;
  }

  const dx = op.x - me.x;
  const dz = op.z - me.z;
  const dist = hyp(dx, dz);
  // Closing speed of the opponent along the line between the pucks.
  const closing = dist > 0 ? -((op.vx - me.vx) * dx + (op.vz - me.vz) * dz) / dist : 0;
  const opSpeed = hyp(op.vx, op.vz);

  // Read-parry an incoming shove, or anchor against a taut tether.
  const readParry =
    PARRY_LOOKAHEAD[level] > 0 &&
    me.parryReady &&
    closing > 0.34 &&
    dist - 1.7 < closing * PARRY_LOOKAHEAD[level] &&
    dist - 1.7 > 0;
  const anchor =
    USE_ANCHOR[level] === 1 &&
    rs.tether.taut &&
    rs.tether.tension > 0.5 &&
    opDist > myDist + 0.8 &&
    opSpeed > 0.3;
  if (readParry || anchor) return BTN.Brace;

  // Slingshot opener: dash away while the rope has just enough tension.
  if (
    USE_SLING[level] === 1 &&
    rs.tether.taut &&
    rs.tether.tension > 0.2 &&
    rs.tether.tension < 0.62 &&
    me.dashReady &&
    myDist < R * 0.38 &&
    opDist > R * 0.5
  ) {
    return bitsForVector(-dx, -dz, DEADZONE[level]) | BTN.Dash;
  }

  // Lead the target six ticks ahead.
  const leadX = dx + op.vx * 6;
  const leadZ = dz + op.vz * 6;

  if (
    DASH_RANGE[level] > 0 &&
    me.dashReady &&
    dist < DASH_RANGE[level] &&
    closing > -0.05 &&
    me.dashPower > 0.25 &&
    myDist <= opDist + 0.4
  ) {
    return bitsForVector(leadX, leadZ, DEADZONE[level]) | BTN.Dash;
  }

  if (DASH_RANGE[level] > 0 && !me.dashReady && dist < 3.4 && myDist < R * 0.5) {
    return bitsForVector(-dx - me.x * 0.4, -dz - me.z * 0.4, DEADZONE[level]);
  }

  const pull = myDist > R * 0.55 ? 0.9 : 0.25;
  return bitsForVector(leadX - me.x * pull, leadZ - me.z * pull, DEADZONE[level]);
}

/* ------------------------------------------------------------------ *
 * Allocation-free variant used inside the search loop.
 *
 * `referenceBot` needs a full render-state object; building one per simulated
 * tick would dominate the planner's cost and thrash the GC. This version pulls
 * the handful of fields the policy actually reads straight out of the sim,
 * reproducing every float conversion exactly so the two agree bit-for-bit
 * (verified by test/reference-bot-parity.test.mjs).
 * ------------------------------------------------------------------ */

import { isqrt, fmul, fdiv, fmin, toF } from '../engine/fixed.js';
import { DASH_SPEED_SCALE, DASH_BONUS_CAP, TETHER_REST, TETHER_TENSION_N } from '../engine/slingshot.js';

const CAP_F = toF(DASH_BONUS_CAP);

function dashPowerOf(body) {
  const speed = isqrt(body.vx * body.vx + body.vz * body.vz);
  const scaled = fmul(speed, DASH_SPEED_SCALE);
  const capped = fmin(scaled, DASH_BONUS_CAP);
  return CAP_F > 0 ? toF(capped) / CAP_F : 0;
}

export function referenceBotFast(sim, seat, level = 'pro') {
  if (sim.phase !== Phase.Live) return 0;

  const mb = sim.world.bodies[seat];
  const ob = sim.world.bodies[1 - seat];
  const R = toF(sim.arenaRadius);
  const mx = toF(mb.px);
  const mz = toF(mb.pz);
  const ox = toF(ob.px);
  const oz = toF(ob.pz);
  const mvx = toF(mb.vx);
  const mvz = toF(mb.vz);
  const ovx = toF(ob.vx);
  const ovz = toF(ob.vz);
  const myDist = hyp(mx, mz);
  const opDist = hyp(ox, oz);
  const dz0 = DEADZONE[level];

  if (IDLE_MASK[level] !== 0 && ((sim.tick >> 4) & IDLE_MASK[level]) === IDLE_MASK[level]) return 0;

  const rimGuard = R - 1.6;
  if (myDist > rimGuard) {
    let bits = bitsForVector(-mx, -mz, dz0 * 0.5);
    if (level !== 'tutorial' && sim.dashCd[seat] === 0 && myDist > R - 1) bits |= BTN.Dash;
    return bits;
  }

  const dx = ox - mx;
  const dz = oz - mz;
  const dist = hyp(dx, dz);

  if (level === 'tutorial') {
    if (myDist > 0.9) return bitsForVector(-mx, -mz, dz0 * 0.6);
    if (dist < 2.2) return bitsForVector(-dz, dx, dz0);
    return 0;
  }

  const closing = dist > 0 ? -((ovx - mvx) * dx + (ovz - mvz) * dz) / dist : 0;
  const opSpeed = hyp(ovx, ovz);
  const myParryReady = sim.parryWhiffCd[seat] === 0;
  const myDashReady = sim.dashCd[seat] === 0;

  // Tether readings, matching getRenderState() exactly.
  const tdx = ob.px - mb.px;
  const tdz = ob.pz - mb.pz;
  const stretchFx = isqrt(tdx * tdx + tdz * tdz) - TETHER_REST;
  const stretch = stretchFx > 0 ? stretchFx : 0;
  const taut = stretch > 0;
  const tension = toF(fdiv(fmin(stretch, TETHER_TENSION_N), TETHER_TENSION_N));

  const readParry =
    PARRY_LOOKAHEAD[level] > 0 &&
    myParryReady &&
    closing > 0.34 &&
    dist - 1.7 < closing * PARRY_LOOKAHEAD[level] &&
    dist - 1.7 > 0;
  const anchor =
    USE_ANCHOR[level] === 1 && taut && tension > 0.5 && opDist > myDist + 0.8 && opSpeed > 0.3;
  if (readParry || anchor) return BTN.Brace;

  if (
    USE_SLING[level] === 1 &&
    taut &&
    tension > 0.2 &&
    tension < 0.62 &&
    myDashReady &&
    myDist < R * 0.38 &&
    opDist > R * 0.5
  ) {
    return bitsForVector(-dx, -dz, dz0) | BTN.Dash;
  }

  const leadX = dx + ovx * 6;
  const leadZ = dz + ovz * 6;

  if (
    DASH_RANGE[level] > 0 &&
    myDashReady &&
    dist < DASH_RANGE[level] &&
    closing > -0.05 &&
    dashPowerOf(mb) > 0.25 &&
    myDist <= opDist + 0.4
  ) {
    return bitsForVector(leadX, leadZ, dz0) | BTN.Dash;
  }

  if (DASH_RANGE[level] > 0 && !myDashReady && dist < 3.4 && myDist < R * 0.5) {
    return bitsForVector(-dx - mx * 0.4, -dz - mz * 0.4, dz0);
  }

  const pull = myDist > R * 0.55 ? 0.9 : 0.25;
  return bitsForVector(leadX - mx * pull, leadZ - mz * pull, dz0);
}

export default referenceBot;
