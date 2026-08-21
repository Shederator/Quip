/**
 * Opponent models fed to the planner.
 *
 * Signature: (sim, seat, elapsed) => inputWord
 *
 * `elapsed` is how many ticks into the plan we are, which lets a model behave
 * differently in the near term (where we have real observations) than in the
 * long term (where we must fall back on a policy prior).
 */

import { referenceBotFast } from './reference-bot.js';
import { BTN, bitsForVector } from '../engine/input.js';
import { toF } from '../engine/fixed.js';
import { Phase } from '../engine/slingshot.js';

/** The exact shipped bot at a given difficulty — used for warm-up matches. */
export function botModel(level) {
  return (sim, seat) => referenceBotFast(sim, seat, level);
}

/**
 * Human prior: for the first `holdTicks` we assume they keep doing whatever we
 * last observed, then they revert to shipped-shark behaviour.
 */
export function stickyModel(lastInput, holdTicks, level = 'shark') {
  return (sim, seat, elapsed) => {
    if (elapsed < holdTicks) return lastInput;
    return referenceBotFast(sim, seat, level);
  };
}

/** Maximally aggressive: always drive at us and spend dash on cooldown. */
export function rusherModel(sim0, seat0) {
  return (sim, seat) => {
    if (sim.phase !== Phase.Live) return 0;
    const me = sim.world.bodies[seat];
    const op = sim.world.bodies[1 - seat];
    const dx = toF(op.px - me.px);
    const dz = toF(op.pz - me.pz);
    let bits = bitsForVector(dx, dz, 0.2);
    if (sim.dashCd[seat] === 0 && dx * dx + dz * dz < 3.4 * 3.4) bits |= BTN.Dash;
    return bits;
  };
}

/** Ultra-defensive: hug the centre, brace on contact threat. */
export function turtleModel() {
  return (sim, seat) => {
    if (sim.phase !== Phase.Live) return 0;
    const me = sim.world.bodies[seat];
    const op = sim.world.bodies[1 - seat];
    const mx = toF(me.px);
    const mz = toF(me.pz);
    const dx = toF(op.px - me.px);
    const dz = toF(op.pz - me.pz);
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 2.0 && sim.parryWhiffCd[seat] === 0) return BTN.Brace;
    return bitsForVector(-mx, -mz, 0.25);
  };
}

/** Do-nothing baseline, useful for tests. */
export const idleModel = () => 0;

/** Robust ensemble for online play against an unknown human. */
export function onlineEnsemble(lastInput) {
  return [stickyModel(lastInput, 8, 'shark'), botModel('shark'), rusherModel(), turtleModel()];
}
