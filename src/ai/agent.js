/**
 * The player.
 *
 * Responsibilities:
 *  - hold a bit-exact shadow simulation,
 *  - compensate for the netcode's input delay (the word we hand back is
 *    consumed `delay` frames in the future, so we plan from that future state),
 *  - keep a rolling plan and only re-search every `replanEvery` ticks,
 *  - emit exactly one input word per tick, and remember it (the game may ask
 *    for the same frame twice while rolling back).
 */

import { SlingshotSim, STATE_WORDS, Phase } from '../engine/slingshot.js';
import { Solver, DEFAULT_SCHEDULE } from './solver.js';
import { DEFAULT_WEIGHTS } from './evaluate.js';
import { botModel, onlineEnsemble } from './opponents.js';
import { describe } from '../engine/input.js';

export const DEFAULT_AGENT_OPTIONS = {
  seat: 0,
  replanEvery: 2,
  schedule: DEFAULT_SCHEDULE,
  beamWidth: 64,
  rolloutTicks: 600,
  weights: DEFAULT_WEIGHTS,
  mode: 'practice', // 'practice' | 'online'
  botLevel: 'pro',
  maxPlanMs: 14,
  adaptive: false,
};

export class SlingshotAgent {
  constructor(options = {}) {
    this.opts = { ...DEFAULT_AGENT_OPTIONS, ...options };
    this.solver = new Solver({
      schedule: this.opts.schedule,
      beamWidth: this.opts.beamWidth,
      rolloutTicks: this.opts.rolloutTicks,
      weights: this.opts.weights,
      seat: this.opts.seat,
    });
    this.shadow = new SlingshotSim(0);
    this.scratchState = new Int32Array(STATE_WORDS);
    this.plan = null;
    this.planFrame = -1;
    this.committed = new Map();
    this.lastOpponentInput = 0;
    this.telemetry = {
      decisions: 0,
      replans: 0,
      lastMs: 0,
      avgMs: 0,
      peakMs: 0,
      value: 0,
      action: 'idle',
      nodes: 0,
      simTicks: 0,
      beamWidth: this.opts.beamWidth,
    };

    // Cumulative tick offsets of the macro schedule, for plan lookup.
    this.offsets = [];
    let acc = 0;
    for (const s of this.opts.schedule) {
      this.offsets.push(acc);
      acc += s;
    }
    this.planSpan = acc;
  }

  setSeat(seat) {
    this.opts.seat = seat;
    this.solver.setSeat(seat);
  }

  setMode(mode, botLevel) {
    this.opts.mode = mode;
    if (botLevel) this.opts.botLevel = botLevel;
  }

  reset() {
    this.plan = null;
    this.planFrame = -1;
    this.committed.clear();
    this.solver.lastPlan = null;
  }

  observeOpponentInput(word) {
    this.lastOpponentInput = word | 0;
  }

  opponentModels() {
    if (this.opts.mode === 'practice') return [botModel(this.opts.botLevel)];
    return onlineEnsemble(this.lastOpponentInput);
  }

  /** Which action does the cached plan prescribe `offset` ticks in? */
  planActionAt(offset) {
    if (!this.plan || !this.plan.length) return null;
    if (offset < 0 || offset >= this.planSpan) return null;
    let idx = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i] <= offset) idx = i;
      else break;
    }
    if (idx >= this.plan.length) return null;
    return this.plan[idx];
  }

  /**
   * @param {Int32Array|number[]} rootState snapshot of the authoritative sim
   * @param {number} frame the frame `rootState` corresponds to
   * @param {number} delay the input we return is consumed at `frame + delay`
   * @returns {number} input word
   */
  decide(rootState, frame, delay = 0) {
    const targetFrame = frame + delay;
    const cached = this.committed.get(targetFrame);
    if (cached !== undefined) return cached;

    // Roll the shadow sim forward to the frame our input will actually land on.
    this.shadow.load(rootState);
    const models = this.opponentModels();
    const primary = models[0];
    const seat = this.opts.seat;
    const opp = 1 - seat;
    const buf = [0, 0];
    for (let f = frame; f < targetFrame; f++) {
      buf[seat] = this.committed.get(f) ?? 0;
      buf[opp] = primary(this.shadow, opp, f - frame);
      this.shadow.step(buf);
    }

    // Nothing to decide while the round is frozen or the match is done.
    if (this.shadow.phase !== Phase.Live) {
      this.commit(targetFrame, 0);
      this.telemetry.action = this.shadow.phase === Phase.Over ? 'over' : 'wait';
      return 0;
    }

    this.shadow.saveFast(this.scratchState);

    const age = this.planFrame < 0 ? Infinity : targetFrame - this.planFrame;
    let action = age >= 0 && age < this.opts.replanEvery ? this.planActionAt(age) : null;

    if (action === null || action === undefined) {
      const res = this.solver.plan(this.scratchState, models);
      this.plan = res.actions;
      this.planFrame = targetFrame;
      action = res.actions[0] ?? 0;
      const t = this.telemetry;
      t.replans++;
      t.lastMs = res.stats.ms;
      t.peakMs = Math.max(t.peakMs, res.stats.ms);
      t.avgMs = t.avgMs === 0 ? res.stats.ms : t.avgMs * 0.9 + res.stats.ms * 0.1;
      t.value = res.value;
      t.nodes = res.stats.nodes;
      t.simTicks = res.stats.ticks;
      if (this.opts.adaptive) this.adapt();
    }

    this.telemetry.decisions++;
    this.telemetry.action = describe(action);
    this.commit(targetFrame, action);
    return action;
  }

  commit(frame, word) {
    this.committed.set(frame, word);
    if (this.committed.size > 300) {
      const cutoff = frame - 180;
      for (const k of this.committed.keys()) if (k < cutoff) this.committed.delete(k);
    }
  }

  /** Trim the search if we overrun the frame budget; grow back when we have slack. */
  adapt() {
    const budget = this.opts.maxPlanMs;
    const ms = this.telemetry.avgMs;
    const s = this.solver.opts;
    if (ms > budget * 1.3 && s.beamWidth > 6) {
      s.beamWidth = Math.max(6, Math.floor(s.beamWidth * 0.75));
    } else if (ms < budget * 0.55 && s.beamWidth < this.opts.beamWidth) {
      s.beamWidth = Math.min(this.opts.beamWidth, s.beamWidth + 2);
    }
    this.telemetry.beamWidth = s.beamWidth;
  }
}

export default SlingshotAgent;
