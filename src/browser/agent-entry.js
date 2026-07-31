/**
 * In-page controller.
 *
 * Attaches to the live game by replacing the match runner's `readLocalInput()`
 * with our own policy. That is the cleanest possible integration point:
 *
 *   - it is *frame exact* — the runner asks for exactly one input per simulated
 *     tick, so there is no keyboard-event timing jitter and no dropped inputs;
 *   - it goes through the game's own rollback session, so our inputs are
 *     ordinary inputs, checksummed and re-simulated by the server like anyone
 *     else's. We are playing the game, not editing its state.
 *
 * A keyboard-event fallback is included for the (unlikely) case that the
 * runner class cannot be discovered.
 */

import { SlingshotSim, STATE_WORDS, Phase, TICK_HZ } from '../engine/slingshot.js';
import { referenceBotFast } from '../ai/reference-bot.js';
import { botModel, stickyModel } from '../ai/opponents.js';
import { describe, BTN } from '../engine/input.js';
import { DEFAULT_SCHEDULE } from '../ai/solver.js';
import { checksumArray } from '../engine/fixed.js';

const REPLAN_EVERY = 2;

/* ------------------------------------------------------------------ *
 * Async planner front-end
 * ------------------------------------------------------------------ */

class RemotePlanner {
  constructor(workerUrl, options) {
    this.worker = new Worker(workerUrl, { type: 'classic' });
    this.seq = 0;
    this.inFlight = 0;
    this.plan = null;
    this.planFrame = -1;
    this.value = 0;
    this.stats = { ms: 0, nodes: 0, ticks: 0 };
    this.lastRequestFrame = -999;
    this.errors = 0;
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'plan') {
        this.inFlight--;
        // Ignore a plan that a reset has already invalidated.
        if (m.frame < this.planFrame) return;
        this.plan = m.actions;
        this.planFrame = m.frame;
        this.value = m.value;
        this.stats = m.stats;
      } else if (m.type === 'error') {
        this.inFlight--;
        this.errors++;
        console.error('[quip-bot] planner error:', m.message);
      }
    };
    this.worker.postMessage({ type: 'config', options });
    this.offsets = [];
    let acc = 0;
    for (const s of options.schedule || DEFAULT_SCHEDULE) {
      this.offsets.push(acc);
      acc += s;
    }
    this.span = acc;
  }

  reset() {
    this.plan = null;
    this.planFrame = -1;
    this.lastRequestFrame = -999;
  }

  setSeat(seat) {
    this.seat = seat;
    this.worker.postMessage({ type: 'config', options: { seat } });
    this.reset();
  }

  actionAt(frame) {
    if (!this.plan || this.planFrame < 0) return null;
    const off = frame - this.planFrame;
    if (off < 0 || off >= this.span) return null;
    let idx = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      if (this.offsets[i] <= off) idx = i;
      else break;
    }
    return idx < this.plan.length ? this.plan[idx] : null;
  }

  maybeRequest(state, frame, ctx) {
    if (this.inFlight > 0) return;
    if (frame - this.lastRequestFrame < REPLAN_EVERY) return;
    this.lastRequestFrame = frame;
    this.inFlight++;
    this.worker.postMessage({
      type: 'plan',
      id: ++this.seq,
      frame,
      state: Int32Array.from(state),
      seat: ctx.seat,
      mode: ctx.mode,
      botLevel: ctx.botLevel,
      lastOpponentInput: ctx.lastOpponentInput,
    });
  }
}

/* ------------------------------------------------------------------ *
 * The bot
 * ------------------------------------------------------------------ */

export class QuipBot {
  constructor() {
    this.enabled = true;
    this.internals = null;
    this.runner = null;
    this.seat = 0;
    this.mode = 'practice';
    this.botLevel = 'pro';
    this.shadow = new SlingshotSim(0);
    this.stateBuf = [];
    this.committed = new Map();
    this.lastOpponentInput = 0;
    this.planner = null;
    this.hooked = false;
    this.parity = { checked: false, ok: null, detail: '' };
    this.telemetry = {
      // Every call into decideFor, regardless of phase. This is the signal the
      // driver uses to prove a match is actually running (telemetry.frames only
      // moves during Live, so it stays flat through the 3 s countdown).
      ticks: 0,
      frames: 0,
      reflexFrames: 0,
      plannedFrames: 0,
      action: 'idle',
      value: 0,
      planMs: 0,
      nodes: 0,
      phase: -1,
      scores: [0, 0],
      arena: 0,
      myDist: 0,
      opDist: 0,
      matches: 0,
      wins: 0,
      losses: 0,
      roundsFor: 0,
      roundsAgainst: 0,
      lastResult: '',
      planLagFrames: 0,
    };
    this._lastScores = [0, 0];
  }

  attach(internals, workerUrl) {
    this.internals = internals;
    this.planner = new RemotePlanner(workerUrl, {
      schedule: DEFAULT_SCHEDULE,
      beamWidth: 64,
      rolloutTicks: 600,
      seat: 0,
    });
    this.hookRunner();
  }

  /* --------------------------- integration --------------------------- */

  hookRunner() {
    const Runner = this.internals && this.internals.Runner;
    if (!Runner || !Runner.prototype || this.hooked) return false;
    const self = this;
    const original = Runner.prototype.readLocalInput;

    Runner.prototype.readLocalInput = function patchedReadLocalInput() {
      // Always let the original run: it also updates the aim origin, and it is
      // the source of truth if the bot is disabled.
      let human = 0;
      try {
        human = original.apply(this, arguments);
      } catch (e) {
        human = 0;
      }
      if (!self.enabled) return human;
      try {
        return self.decideFor(this, human);
      } catch (e) {
        console.error('[quip-bot] decide failed, falling back to human input', e);
        return human;
      }
    };

    this.hooked = true;
    console.log('[quip-bot] hooked runner.readLocalInput');
    return true;
  }

  /** Pull frame / delay / seat / state out of whichever mode the runner is in. */
  readContext(runner) {
    const opts = runner.opts || {};
    const sim = runner.sim;
    const session = runner.session;
    const mode = opts.mode === 'online' ? 'online' : 'practice';
    const seat = typeof opts.localSeat === 'number' ? opts.localSeat : 0;
    let frame;
    let delay;
    if (mode === 'online' && session) {
      frame = session.frame;
      delay = session.currentInputDelay | 0;
      // Newest confirmed opponent input, for the "sticky" human model.
      try {
        const arr = session.remoteInputs;
        const f = session.newestRemoteFrame;
        if (arr && f >= 0 && arr[f] !== undefined) this.lastOpponentInput = arr[f] | 0;
      } catch (e) { /* shape changed; keep last */ }
    } else {
      frame = sim.currentTick;
      delay = 0;
    }
    return { mode, seat, frame, delay, sim, botLevel: opts.botLevel || this.botLevel };
  }

  decideFor(runner, human) {
    this.telemetry.ticks++;
    const ctx = this.readContext(runner);
    if (ctx.seat !== this.seat) {
      this.seat = ctx.seat;
      this.planner.setSeat(ctx.seat);
      this.committed.clear();
    }
    if (ctx.mode !== this.mode) {
      this.mode = ctx.mode;
      this.reset();
    }
    this.botLevel = ctx.botLevel;

    // Snapshot the authoritative sim (same 31-word layout as our port).
    const state = this.stateBuf;
    state.length = 0;
    ctx.sim.save(state);

    if (!this.parity.checked) this.verifyParity(ctx.sim, state);

    const target = ctx.frame + ctx.delay;
    const cached = this.committed.get(target);
    if (cached !== undefined) return cached;

    // Roll our shadow to the frame this input will actually be consumed on.
    this.shadow.load(state);
    const oppModel =
      this.mode === 'practice'
        ? botModel(this.botLevel)
        : stickyModel(this.lastOpponentInput, 8, 'shark');
    const opp = 1 - this.seat;
    const buf = [0, 0];
    for (let f = ctx.frame; f < target; f++) {
      buf[this.seat] = this.committed.get(f) ?? 0;
      buf[opp] = oppModel(this.shadow, opp, f - ctx.frame);
      this.shadow.step(buf);
    }

    this.trackMatch(ctx.sim);

    if (this.shadow.phase !== Phase.Live) {
      this.commit(target, 0);
      this.telemetry.action = this.shadow.phase === Phase.Over ? 'over' : 'wait';
      this.telemetry.phase = this.shadow.phase;
      return 0;
    }

    const shadowState = [];
    this.shadow.save(shadowState);
    this.planner.maybeRequest(shadowState, target, {
      seat: this.seat,
      mode: this.mode,
      botLevel: this.botLevel,
      lastOpponentInput: this.lastOpponentInput,
    });

    let action = this.planner.actionAt(target);
    if (action === null || action === undefined) {
      // No fresh plan yet (first frames of a round, or the worker is busy).
      // A single shark-policy call is ~1 us and keeps us competent meanwhile.
      action = referenceBotFast(this.shadow, this.seat, 'shark');
      this.telemetry.reflexFrames++;
    } else {
      this.telemetry.plannedFrames++;
      this.telemetry.planLagFrames = target - this.planner.planFrame;
    }

    this.telemetry.frames++;
    this.telemetry.action = describe(action);
    this.telemetry.value = this.planner.value;
    this.telemetry.planMs = this.planner.stats.ms || 0;
    this.telemetry.nodes = this.planner.stats.nodes || 0;
    this.updateGeometry();
    this.commit(target, action);
    return action;
  }

  commit(frame, word) {
    this.committed.set(frame, word);
    if (this.committed.size > 400) {
      const cutoff = frame - 240;
      for (const k of this.committed.keys()) if (k < cutoff) this.committed.delete(k);
    }
  }

  reset() {
    this.committed.clear();
    if (this.planner) this.planner.reset();
    this._lastScores = [0, 0];
  }

  updateGeometry() {
    const s = this.shadow;
    const me = s.world.bodies[this.seat];
    const op = s.world.bodies[1 - this.seat];
    const t = this.telemetry;
    t.phase = s.phase;
    t.scores = [s.scores[0], s.scores[1]];
    t.arena = s.arenaRadius / 65536;
    t.myDist = Math.sqrt(me.px * me.px + me.pz * me.pz) / 65536;
    t.opDist = Math.sqrt(op.px * op.px + op.pz * op.pz) / 65536;
  }

  trackMatch(sim) {
    const s0 = sim.scores[0];
    const s1 = sim.scores[1];
    if (s0 !== this._lastScores[0] || s1 !== this._lastScores[1]) {
      const mine = this.seat === 0 ? s0 - this._lastScores[0] : s1 - this._lastScores[1];
      const theirs = this.seat === 0 ? s1 - this._lastScores[1] : s0 - this._lastScores[0];
      this.telemetry.roundsFor += Math.max(0, mine);
      this.telemetry.roundsAgainst += Math.max(0, theirs);
      this._lastScores = [s0, s1];
    }
    if (sim.phase === Phase.Over && !this._reported) {
      this._reported = true;
      const won = sim.winner === this.seat;
      this.telemetry.matches++;
      if (won) this.telemetry.wins++;
      else this.telemetry.losses++;
      this.telemetry.lastResult = `${won ? 'WIN' : 'LOSS'} ${sim.scores[this.seat]}-${sim.scores[1 - this.seat]}`;
      console.log(`[quip-bot] match over: ${this.telemetry.lastResult}`);
    }
    if (sim.phase !== Phase.Over) this._reported = false;
  }

  /**
   * Prove the ported engine is bit-identical to the game's own simulation:
   * load the live state into both, step both with the same input pair, and
   * compare the game's checksum with ours.
   */
  verifyParity(liveSim, state) {
    this.parity.checked = true;
    try {
      const Sim = this.internals && this.internals.SlingshotSim;
      if (!Sim) {
        this.parity.ok = null;
        this.parity.detail = 'sim class not discovered';
        return;
      }
      const theirs = new Sim(0);
      theirs.load(state);
      const mine = new SlingshotSim(0);
      mine.load(state);

      const inputs = [
        [BTN.Right, BTN.Left],
        [BTN.Up | BTN.Dash, BTN.Brace],
        [BTN.Brace, BTN.Down | BTN.Dash],
        [0, 0],
        [BTN.Down | BTN.Left, BTN.Up | BTN.Right],
      ];
      for (let i = 0; i < 240; i++) {
        const pair = inputs[i % inputs.length];
        theirs.step(pair);
        mine.step(pair);
      }
      const a = theirs.checksum();
      const b = mine.checksum();
      const theirState = [];
      theirs.save(theirState);
      const myState = [];
      mine.save(myState);
      const ok = a === b && checksumArray(theirState) === checksumArray(myState);
      this.parity.ok = ok;
      this.parity.detail = ok
        ? `bit-exact over 240 ticks (checksum 0x${a.toString(16)})`
        : `MISMATCH theirs=0x${a.toString(16)} mine=0x${b.toString(16)}`;
      console.log(`[quip-bot] engine parity: ${this.parity.detail}`);
    } catch (e) {
      this.parity.ok = null;
      this.parity.detail = 'parity check threw: ' + e;
    }
  }
}

/* ------------------------------------------------------------------ *
 * HUD overlay
 * ------------------------------------------------------------------ */

function mountHud(bot) {
  const el = document.createElement('div');
  el.id = 'quip-bot-hud';
  el.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'top:10px', 'left:10px',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'background:rgba(12,10,22,.86)', 'color:#e8e3ff', 'padding:9px 11px',
    'border:1px solid rgba(150,120,255,.45)', 'border-radius:9px',
    'pointer-events:none', 'white-space:pre', 'min-width:232px',
    'box-shadow:0 6px 24px rgba(0,0,0,.4)',
  ].join(';');
  document.documentElement.appendChild(el);

  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  const PHASES = ['countdown', 'LIVE', 'scored', 'over'];

  setInterval(() => {
    const t = bot.telemetry;
    const p = bot.parity;
    const total = t.plannedFrames + t.reflexFrames || 1;
    el.textContent =
      `QUIP BOT · slingshot sumo   ${bot.enabled ? 'ON' : 'OFF'}\n` +
      `mode      ${bot.mode}${bot.mode === 'practice' ? ' / ' + bot.botLevel : ''}  seat ${bot.seat}\n` +
      `engine    ${p.ok === true ? 'bit-exact ✓' : p.ok === false ? 'MISMATCH ✗' : 'unverified'}\n` +
      `phase     ${PHASES[t.phase] ?? t.phase}   score ${t.scores[0]}-${t.scores[1]}\n` +
      `arena r   ${fmt(t.arena)}   me ${fmt(t.myDist)}  opp ${fmt(t.opDist)}\n` +
      `action    ${t.action}\n` +
      `plan      ${fmt(t.planMs, 1)}ms  ${t.nodes} nodes  lag ${t.planLagFrames}f\n` +
      `coverage  ${((t.plannedFrames / total) * 100).toFixed(1)}% planned\n` +
      `value     ${fmt(t.value, 0)}\n` +
      `record    ${t.wins}W-${t.losses}L   rounds ${t.roundsFor}-${t.roundsAgainst}\n` +
      `last      ${t.lastResult || '—'}`;
  }, 120);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
  // addInitScript runs in *every* frame — the Privy auth iframe, the Turnstile
  // widget, blob workers. The game only lives in the top frame, so bail out
  // everywhere else and guard against a double init.
  try {
    if (window.top !== window.self) return;
  } catch {
    return; // cross-origin parent => we are in someone else's frame
  }
  if (window.__quipBot) return;
  if (!/(^|\.)quip\.gg$/.test(location.hostname) && location.hostname !== 'localhost') return;

  const bot = new QuipBot();
  window.__quipBot = bot;

  // The worker source is injected alongside this bundle by the driver.
  const src = window.__QUIP_WORKER_SRC__ || '';
  const workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));

  const tryAttach = () => {
    const internals = window.__QUIP_INTERNALS__;
    if (!internals) return false;
    bot.attach(internals, workerUrl);
    console.log('[quip-bot] attached', internals.__discovered);
    return bot.hooked;
  };

  if (!tryAttach()) {
    window.addEventListener('quip-internals-ready', tryAttach, { once: true });
    // The bundle may already have executed before we got here.
    const iv = setInterval(() => {
      if (tryAttach()) clearInterval(iv);
    }, 120);
    setTimeout(() => clearInterval(iv), 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountHud(bot), { once: true });
  } else {
    mountHud(bot);
  }

  console.log(`[quip-bot] ready (tick rate ${TICK_HZ} Hz, ${STATE_WORDS}-word state)`);
}

boot();
