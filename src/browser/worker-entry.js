/**
 * Planning worker.
 *
 * The search costs ~10-15 ms per replan. Running that on the page's main thread
 * would blow the 16.6 ms frame budget, stall the render loop and — worse —
 * make the rollback netcode think the client is stalling. So the planner lives
 * here and the main thread only ever reads the most recent plan.
 *
 * Protocol
 *   in : { type:'config', options }
 *        { type:'plan', id, frame, state:Int32Array, mode, botLevel, lastOpponentInput }
 *   out: { type:'plan', id, frame, actions, value, stats }
 */

import { Solver } from '../ai/solver.js';
import { botModel, onlineEnsemble } from '../ai/opponents.js';
import { DEFAULT_SCHEDULE } from '../ai/solver.js';

let solver = null;
let options = {
  schedule: DEFAULT_SCHEDULE,
  beamWidth: 28,
  rolloutTicks: 320,
  seat: 0,
};

function ensureSolver() {
  if (!solver) solver = new Solver(options);
  return solver;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg) return;

  if (msg.type === 'config') {
    options = { ...options, ...msg.options };
    solver = null;
    ensureSolver();
    self.postMessage({ type: 'ready', options: { ...options, fallback: undefined } });
    return;
  }

  if (msg.type === 'plan') {
    const s = ensureSolver();
    if (msg.seat !== undefined && msg.seat !== s.seat) s.setSeat(msg.seat);
    const models =
      msg.mode === 'practice'
        ? [botModel(msg.botLevel || 'pro')]
        : onlineEnsemble(msg.lastOpponentInput | 0);
    let res;
    try {
      res = s.plan(msg.state, models);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err && err.stack || err) });
      return;
    }
    self.postMessage({
      type: 'plan',
      id: msg.id,
      frame: msg.frame,
      actions: res.actions,
      value: res.value,
      stats: res.stats,
    });
  }
};
