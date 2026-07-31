/**
 * The planner.
 *
 * Slingshot Sumo has no RNG, so with a bit-exact copy of the physics the game
 * is a deterministic, perfect-information control problem. The planner is a
 * two-stage rolling-horizon search:
 *
 *  Stage 1 — beam search over macro-actions with a *progressive schedule*
 *      (2,2,3,4,6,8,... ticks). Fine granularity near the root keeps parry
 *      timing tick-accurate; coarse granularity deeper keeps the horizon long
 *      (~1.7 s) without exploding the tree.
 *
 *  Stage 2 — for each distinct *root* action, take the best plan that begins
 *      with it and continue the simulation for another ~5 s using a strong
 *      fallback policy for us and the opponent model for them. This converts a
 *      1.7 s search into a ~7 s judgement and, crucially, usually reaches an
 *      actual ring-out so the value is a real outcome instead of a heuristic.
 *
 * Everything runs on flat typed arrays with a two-instance simulation pool, so
 * a full replan allocates nothing on the hot path.
 */

import { SlingshotSim, STATE_WORDS, Phase } from '../engine/slingshot.js';
import { BTN, DIR_BITS } from '../engine/input.js';
import { evaluate, DEFAULT_WEIGHTS } from './evaluate.js';
import { referenceBotFast } from './reference-bot.js';

/**
 * Macro-action schedule: how many ticks each search level holds its action for.
 *
 * Progressive widening. The first levels are 2 ticks so parry windows (12) and
 * dash timing stay tick-accurate where it matters; later levels coarsen so the
 * horizon is bought cheaply. Total 37 ticks (0.62 s) of *searched* horizon,
 * which stage 2 then extends by a 600-tick rollout.
 *
 * Tuned empirically (see `--schedule` on src/bench/selfplay.js): spending the
 * tick budget on a wider beam and much longer rollouts beats spending it on
 * deeper coarse macros, because the rollouts usually reach a real ring-out and
 * therefore return an actual outcome rather than a heuristic.
 */
export const DEFAULT_SCHEDULE = [2, 2, 3, 4, 6, 8, 12];

export const DEFAULT_OPTIONS = {
  schedule: DEFAULT_SCHEDULE,
  beamWidth: 64,
  rolloutTicks: 600,
  weights: DEFAULT_WEIGHTS,
  seat: 0,
  /** continuation policy for *us* during stage-2 rollouts */
  fallback: (sim, seat) => referenceBotFast(sim, seat, 'shark'),
};

const MAX_ACTIONS = 18;

/**
 * Unit vectors of DIR_BITS, in the game's screen-space convention
 * (index 0 is "no direction" and is handled separately).
 */
const DIR_VEC = [
  [0, 0],
  [0, -1],
  [0.7071, -0.7071],
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
];

/**
 * Actions worth considering.
 *
 * All 9 movement options are always available (movement is cheap and the beam
 * needs the freedom), but dash is pruned hard: a dash is a ~17-unit commitment,
 * so only the directions that point roughly at the opponent, roughly away from
 * them, or roughly back toward the centre can ever be right. That cuts the
 * branching factor from 18 to ~12 with no measurable loss of strength.
 */
function candidateActions(sim, seat, out) {
  let n = 0;
  for (let i = 0; i < DIR_BITS.length; i++) out[n++] = DIR_BITS[i];

  if (sim.dashCd[seat] === 0) {
    const me = sim.world.bodies[seat];
    const op = sim.world.bodies[1 - seat];
    // Fixed-point deltas are fine here; we only need directions.
    let tx = op.px - me.px;
    let tz = op.pz - me.pz;
    let tl = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tl;
    tz /= tl;
    let cx = -me.px;
    let cz = -me.pz;
    const cl = Math.sqrt(cx * cx + cz * cz) || 1;
    cx /= cl;
    cz /= cl;

    for (let i = 1; i < DIR_BITS.length; i++) {
      const v = DIR_VEC[i];
      const toOpp = v[0] * tx + v[1] * tz;
      const toCentre = v[0] * cx + v[1] * cz;
      // cos(45 deg) = 0.7071 -> keep anything within 45 deg of a useful axis.
      if (toOpp > 0.7 || toOpp < -0.7 || toCentre > 0.7) out[n++] = DIR_BITS[i] | BTN.Dash;
    }
  }

  out[n++] = BTN.Brace;
  return n;
}

class Level {
  constructor(cap) {
    this.cap = cap;
    this.states = new Int32Array(cap * STATE_WORDS);
    this.value = new Float64Array(cap);
    this.scoreTick = new Int32Array(cap);
    this.dead = new Uint8Array(cap);
    this.parent = new Int32Array(cap);
    this.action = new Int32Array(cap);
    this.order = new Int32Array(cap);
    this.count = 0;
  }
  reset() {
    this.count = 0;
  }
}

export class Solver {
  constructor(options = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.seat = this.opts.seat;

    const cap = this.opts.beamWidth * MAX_ACTIONS + 8;
    this.cur = new Level(cap);
    this.next = new Level(cap);

    /* Everything below is preallocated once. The first implementation built a
     * fresh Level (7 typed arrays) plus two Int32Arrays per beam depth, i.e.
     * ~36 allocations per replan at 30 replans/second — enough GC churn to show
     * up as multi-hundred-millisecond plan spikes. */
    this.levelCap = this.opts.beamWidth + 1;
    this.pool = [];
    this.history = [];
    this.histPool = [];
    for (let d = 0; d <= this.opts.schedule.length; d++) {
      this.pool.push(new Level(this.levelCap));
      this.histPool.push({
        parent: new Int32Array(this.levelCap),
        action: new Int32Array(this.levelCap),
        count: 0,
      });
    }
    /** Reused index array for the top-`beamWidth` selection. */
    this.idxArr = new Array(cap);

    this.simA = new SlingshotSim(0);
    this.simB = new SlingshotSim(0);
    this.tmpState = new Int32Array(STATE_WORDS);
    this.actionBuf = new Int32Array(MAX_ACTIONS);
    this.inputBuf = [0, 0];
    this.lastPlan = null;
    this.stats = { nodes: 0, ticks: 0, ms: 0, value: 0, rollouts: 0 };
  }

  setSeat(seat) {
    this.seat = seat;
    this.opts.seat = seat;
  }

  /** Step `sim` `ticks` times holding `action`; returns tick of any score change. */
  roll(sim, action, ticks, oppModel, baseElapsed) {
    const seat = this.seat;
    const opp = 1 - seat;
    const buf = this.inputBuf;
    const before = sim.scores[seat] - sim.scores[opp];
    let scoreTick = 0;
    for (let t = 0; t < ticks; t++) {
      buf[seat] = action;
      buf[opp] = oppModel(sim, opp, baseElapsed + t);
      sim.step(buf);
      if (scoreTick === 0 && sim.scores[seat] - sim.scores[opp] !== before) {
        scoreTick = baseElapsed + t + 1;
      }
      if (sim.phase === Phase.Over) {
        this.stats.ticks += t + 1;
        return scoreTick;
      }
    }
    this.stats.ticks += ticks;
    return scoreTick;
  }

  /** Long continuation with a real policy on both sides. */
  rollout(sim, ticks, oppModel, baseElapsed) {
    const seat = this.seat;
    const opp = 1 - seat;
    const buf = this.inputBuf;
    const fallback = this.opts.fallback;
    const before = sim.scores[seat] - sim.scores[opp];
    let scoreTick = 0;
    for (let t = 0; t < ticks; t++) {
      buf[seat] = fallback(sim, seat);
      buf[opp] = oppModel(sim, opp, baseElapsed + t);
      sim.step(buf);
      if (scoreTick === 0 && sim.scores[seat] - sim.scores[opp] !== before) {
        scoreTick = baseElapsed + t + 1;
        // A decided round is all the signal we need; stop early to save time.
        break;
      }
      if (sim.phase === Phase.Over) break;
    }
    this.stats.ticks += ticks;
    this.stats.rollouts++;
    return scoreTick;
  }

  copyState(level, idx, dst) {
    const base = idx * STATE_WORDS;
    for (let i = 0; i < STATE_WORDS; i++) dst[i] = level.states[base + i];
  }

  writeState(level, idx, src) {
    const base = idx * STATE_WORDS;
    for (let i = 0; i < STATE_WORDS; i++) level.states[base + i] = src[i];
  }

  search(rootState, oppModel, seed) {
    const { schedule, beamWidth, weights } = this.opts;
    const seat = this.seat;
    this.stats.nodes = 0;
    this.stats.ticks = 0;
    this.stats.rollouts = 0;

    // Root level.
    let cur = this.cur;
    const next = this.next;
    cur.reset();
    this.writeState(cur, 0, rootState);
    cur.value[0] = 0;
    cur.scoreTick[0] = 0;
    cur.dead[0] = 0;
    cur.parent[0] = -1;
    cur.action[0] = 0;
    cur.count = 1;
    this.history.length = 0;

    let elapsed = 0;
    for (let depth = 0; depth < schedule.length; depth++) {
      const span = schedule[depth];
      next.reset();
      for (let i = 0; i < cur.count; i++) {
        if (cur.dead[i]) {
          // Terminal: carry it forward once so it can still win the beam.
          const j = next.count++;
          this.copyState(cur, i, this.tmpState);
          this.writeState(next, j, this.tmpState);
          next.value[j] = cur.value[i];
          next.scoreTick[j] = cur.scoreTick[i];
          next.dead[j] = 1;
          next.parent[j] = i;
          next.action[j] = 0;
          continue;
        }
        this.copyState(cur, i, this.tmpState);
        this.simA.load(this.tmpState);
        const nActions = candidateActions(this.simA, seat, this.actionBuf);

        for (let k = 0; k < nActions; k++) {
          let action = this.actionBuf[k];
          // Expand the seeded plan's action first so ties favour commitment.
          if (seed && k === 0 && seed[depth] !== undefined) {
            for (let q = 0; q < nActions; q++) {
              if (this.actionBuf[q] === seed[depth]) {
                this.actionBuf[q] = action;
                action = seed[depth];
                this.actionBuf[0] = action;
                break;
              }
            }
          }
          if (next.count >= next.cap) break;
          this.simB.load(this.tmpState);
          const st = this.roll(this.simB, action, span, oppModel, elapsed);
          const scoreTick = cur.scoreTick[i] || st;
          this.simB.saveFast(this.tmpState);
          const j = next.count++;
          this.writeState(next, j, this.tmpState);
          next.scoreTick[j] = scoreTick;
          next.dead[j] = this.simB.phase === Phase.Over ? 1 : 0;
          next.parent[j] = i;
          next.action[j] = action;
          next.value[j] = evaluate(this.simB, seat, {
            scoreTick,
            elapsed: elapsed + span,
            weights,
          });
          this.stats.nodes++;
          // restore tmpState for the next sibling
          this.copyState(cur, i, this.tmpState);
        }
      }

      if (next.count === 0) break;
      elapsed += span;

      // Keep the best `beamWidth` children (reused index array, no allocation).
      const sub = this.idxArr;
      sub.length = next.count;
      for (let i = 0; i < next.count; i++) sub[i] = i;
      const val = next.value;
      sub.sort((a, b) => val[b] - val[a]);
      const keep = Math.min(beamWidth, next.count);

      // Record parent/action for path reconstruction, then compact.
      const hist = this.histPool[depth];
      const compact = this.pool[depth];
      compact.reset();
      for (let i = 0; i < keep; i++) {
        const src = sub[i];
        this.copyState(next, src, this.tmpState);
        this.writeState(compact, i, this.tmpState);
        compact.value[i] = next.value[src];
        compact.scoreTick[i] = next.scoreTick[src];
        compact.dead[i] = next.dead[src];
        compact.parent[i] = next.parent[src];
        compact.action[i] = next.action[src];
        hist.parent[i] = next.parent[src];
        hist.action[i] = next.action[src];
      }
      hist.count = keep;
      compact.count = keep;
      this.history.push(hist);

      // The compacted level becomes current for the next depth.
      cur = compact;
    }

    return { level: cur, elapsed };
  }

  /** Walk the history back to recover the action sequence for beam node `idx`. */
  pathOf(idx) {
    const out = [];
    let i = idx;
    for (let d = this.history.length - 1; d >= 0; d--) {
      const h = this.history[d];
      if (i < 0 || i >= h.count) break;
      out.push(h.action[i]);
      i = h.parent[i];
    }
    out.reverse();
    return out;
  }

  /**
   * Full decision: beam search, then a long rollout per distinct root action.
   * @returns {{actions:number[], value:number, stats:object}}
   */
  plan(rootState, oppModels) {
    const t0 = now();
    const models = Array.isArray(oppModels) ? oppModels : [oppModels];
    const seed = this.lastPlan ? this.lastPlan.slice(1) : null;
    const { weights, rolloutTicks } = this.opts;
    const seat = this.seat;

    // Stage 1 with the primary (most likely) model.
    const { level, elapsed } = this.search(rootState, models[0], seed);

    // Group beam leaves by their root action, keeping the best of each.
    const bestByRoot = new Map();
    for (let i = 0; i < level.count; i++) {
      const path = this.pathOf(i);
      const root = path.length ? path[0] : 0;
      const prev = bestByRoot.get(root);
      if (!prev || level.value[i] > prev.value) {
        bestByRoot.set(root, { value: level.value[i], idx: i, path });
      }
    }
    if (bestByRoot.size === 0) {
      this.stats.ms = now() - t0;
      return { actions: [0], value: 0, stats: { ...this.stats } };
    }

    // Stage 2: extend each candidate with a long rollout, under every model,
    // and keep the option with the best worst case.
    let bestRoot = null;
    let bestScore = -Infinity;
    let bestPath = null;
    for (const [root, cand] of bestByRoot) {
      let worst = Infinity;
      for (const model of models) {
        this.copyState(level, cand.idx, this.tmpState);
        this.simA.load(this.tmpState);
        let scoreTick = cand.scoreTick || level.scoreTick[cand.idx];
        let total = elapsed;
        if (this.simA.phase !== Phase.Over) {
          const st = this.rollout(this.simA, rolloutTicks, model, elapsed);
          if (!scoreTick) scoreTick = st;
          total = elapsed + rolloutTicks;
        }
        const v =
          0.25 * level.value[cand.idx] +
          0.75 * evaluate(this.simA, seat, { scoreTick, elapsed: total, weights });
        if (v < worst) worst = v;
      }
      if (worst > bestScore) {
        bestScore = worst;
        bestRoot = root;
        bestPath = cand.path;
      }
    }

    this.lastPlan = bestPath;
    this.stats.ms = now() - t0;
    this.stats.value = bestScore;
    return { actions: bestPath, value: bestScore, stats: { ...this.stats } };
  }
}

const now =
  typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Number(process.hrtime.bigint() / 1000n) / 1e6;

export default Solver;
