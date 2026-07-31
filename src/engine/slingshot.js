/**
 * Slingshot Sumo — bit-exact port of class `Lkt` from the quip.gg bundle.
 *
 * Two pucks share a shrinking disc and are joined by an elastic tether. A
 * round is lost the moment a puck's *centre* leaves the disc. First to three
 * ring-outs wins the match. There is no RNG anywhere in the simulation, so a
 * match against a known opponent policy is a fully deterministic,
 * perfect-information planning problem.
 *
 * Constant name map (bundle -> here):
 *   fte  ARENA_START      pte  ARENA_MIN        _kt SHRINK_DELAY
 *   xkt  SHRINK_PER_TICK  Skt  MAX_LIVE_TICKS   gOe PUCK_RADIUS
 *   r3e  INV_MASS         Ekt  RESTITUTION      i3e DRAG
 *   a3e  MOVE_ACCEL       Fq   TETHER_REST      Ckt TETHER_STIFF
 *   o3e  TETHER_MAX_IMP   c3e  TETHER_TENSION_N Akt DASH_BASE
 *   l3e  DASH_SPEED_SCALE iC   DASH_BONUS_CAP   u3e DASH_COOLDOWN
 *   kkt  BRACE_DRAG       Tkt  BRACE_INV_MASS   DR  PARRY_WINDOW
 *   d3e  PARRY_KNOCKBACK  X2e/h3e PARRY_FLASH   f3e PARRY_WHIFF_CD
 *   FR   SPAWN_X          p3e  COUNTDOWN_TICKS  Ikt SCORED_TICKS
 *   Mkt  ROUND_COUNTDOWN  m3e  ROUNDS_TO_WIN
 */

import { ONE, fx, fxInt, toF, fmul, fdiv, isqrt, fnorm, fmin, checksumArray } from './fixed.js';
import { World } from './world.js';
import { BTN, has, dirOf } from './input.js';

export const TICK_HZ = 60;            // D3
export const TICK_MS = 1000 / TICK_HZ; // y3

export const ARENA_START = fx(11);
export const ARENA_MIN = fx(2.6);
export const SHRINK_DELAY = 240;
export const SHRINK_PER_TICK = fx(0.0075);
export const MAX_LIVE_TICKS = 3600;
export const PUCK_RADIUS = fx(0.85);
export const INV_MASS = ONE;
export const RESTITUTION = fx(0.6);
export const DRAG = fx(0.948);
export const MOVE_ACCEL = fx(0.022);
export const TETHER_REST = fx(3.2);
export const TETHER_STIFF = fx(0.02);
export const TETHER_MAX_IMP = fx(0.09);
export const TETHER_TENSION_N = fx(3);
export const DASH_BASE = fx(0.34);
export const DASH_SPEED_SCALE = fx(0.55);
export const DASH_BONUS_CAP = fx(0.36);
export const DASH_COOLDOWN = 60;
export const BRACE_DRAG = fx(0.7);
export const BRACE_INV_MASS = fx(0.34);
export const PARRY_WINDOW = 12;
export const PARRY_KNOCKBACK = fx(0.72);
export const PARRY_FLASH = 18;
export const PARRY_WHIFF_CD = 36;
export const SPAWN_X = fx(3);
export const COUNTDOWN_TICKS = 180;
export const ROUND_COUNTDOWN = 180;
export const SCORED_TICKS = 84;
export const ROUNDS_TO_WIN = 3;

export const Phase = { Countdown: 0, Live: 1, Scored: 2, Over: 3 };

/** Number of scalars produced by packInto() — 8 body words + 23 sim words. */
export const STATE_WORDS = 8 + 23;

export class SlingshotSim {
  constructor(_seed = 0) {
    this.world = new World();
    this.tick = 0;
    this.phase = Phase.Countdown;
    this.phaseTimer = COUNTDOWN_TICKS;
    this.phaseLen = COUNTDOWN_TICKS;
    this.liveTicks = 0;
    this.scores = [0, 0];
    this.arenaRadius = ARENA_START;
    this.dashCd = [0, 0];
    this.bracing = [false, false];
    this.bracedPrev = [false, false];
    this.braceStartTick = [-1, -1];
    this.parryFlashCd = [0, 0];
    this.parryWhiffCd = [0, 0];
    this.parryAttemptActive = [false, false];
    this.roundLoser = -1;
    this.lastScorer = -1;
    this.winner = -1;

    for (const px of [-SPAWN_X, SPAWN_X]) {
      this.world.addBody({
        px,
        pz: 0,
        radius: PUCK_RADIUS,
        invMass: INV_MASS,
        restitution: RESTITUTION,
        drag: DRAG,
      });
    }
  }

  step(inputs) {
    this.tick++;
    switch (this.phase) {
      case Phase.Live:
        this.stepLive(inputs);
        break;
      case Phase.Countdown:
      case Phase.Scored:
        if (--this.phaseTimer <= 0) this.advancePhase();
        break;
      default:
        break;
    }
  }

  stepLive(inputs) {
    if (this.dashCd[0] > 0) this.dashCd[0]--;
    if (this.dashCd[1] > 0) this.dashCd[1]--;
    if (this.parryFlashCd[0] > 0) this.parryFlashCd[0]--;
    if (this.parryFlashCd[1] > 0) this.parryFlashCd[1]--;
    if (this.parryWhiffCd[0] > 0) this.parryWhiffCd[0]--;
    if (this.parryWhiffCd[1] > 0) this.parryWhiffCd[1]--;

    this.applyControl(0, inputs[0]);
    this.applyControl(1, inputs[1]);
    this.applyTether();
    this.world.step();
    this.resolveParries();
    this.expireParryAttempts();

    this.liveTicks++;
    if (this.liveTicks > SHRINK_DELAY) {
      this.arenaRadius -= SHRINK_PER_TICK;
      if (this.arenaRadius < ARENA_MIN) this.arenaRadius = ARENA_MIN;
    }
    this.checkKnockout();
  }

  applyControl(seat, word) {
    const body = this.world.bodies[seat];
    const brace = has(word, BTN.Brace);

    // Rising edge of brace arms a parry attempt, unless we are on whiff cooldown.
    if (brace && !this.bracedPrev[seat]) {
      if (this.parryWhiffCd[seat] === 0) {
        this.braceStartTick[seat] = this.tick;
        this.parryAttemptActive[seat] = true;
      } else {
        this.braceStartTick[seat] = -1;
      }
    } else if (!brace) {
      this.braceStartTick[seat] = -1;
    }
    this.bracedPrev[seat] = brace;
    this.bracing[seat] = brace;

    if (brace) {
      body.drag = BRACE_DRAG;
      body.invMass = BRACE_INV_MASS;
      return; // bracing forfeits movement and dash
    }

    body.drag = DRAG;
    body.invMass = INV_MASS;

    const d = dirOf(word);
    if (d.x === 0 && d.z === 0) return;

    const n = fnorm(fxInt(d.x), fxInt(d.z));
    World.accelerate(body, fmul(n.x, MOVE_ACCEL), fmul(n.z, MOVE_ACCEL));

    if (has(word, BTN.Dash) && this.dashCd[seat] === 0) {
      const speed = isqrt(body.vx * body.vx + body.vz * body.vz);
      const scaled = fmul(speed, DASH_SPEED_SCALE);
      const bonus = scaled > DASH_BONUS_CAP ? DASH_BONUS_CAP : scaled;
      const mag = DASH_BASE + bonus;
      World.accelerate(body, fmul(n.x, mag), fmul(n.z, mag));
      this.dashCd[seat] = DASH_COOLDOWN;
    }
  }

  tetherStretch() {
    const [a, b] = this.world.bodies;
    const dx = b.px - a.px;
    const dz = b.pz - a.pz;
    const stretch = isqrt(dx * dx + dz * dz) - TETHER_REST;
    return stretch > 0 ? stretch : 0;
  }

  applyTether() {
    const [a, b] = this.world.bodies;
    const dx = b.px - a.px;
    const dz = b.pz - a.pz;
    const dist = isqrt(dx * dx + dz * dz);
    const stretch = dist - TETHER_REST;
    if (stretch <= 0 || dist === 0) return;

    let imp = fmul(stretch, TETHER_STIFF);
    if (imp > TETHER_MAX_IMP) imp = TETHER_MAX_IMP;

    const nx = fdiv(dx, dist);
    const nz = fdiv(dz, dist);
    const ia = fmul(imp, a.invMass);
    const ib = fmul(imp, b.invMass);
    a.vx += fmul(nx, ia);
    a.vz += fmul(nz, ia);
    b.vx -= fmul(nx, ib);
    b.vz -= fmul(nz, ib);
  }

  resolveParries() {
    const hits = [];
    for (const seat of [0, 1]) {
      const me = this.world.bodies[seat];
      if (!me.hit || !this.bracing[seat]) continue;
      const age = this.tick - this.braceStartTick[seat];
      if (age < 0 || age >= PARRY_WINDOW) continue;
      const other = this.world.bodies[1 - seat];
      const dx = other.px - me.px;
      const dz = other.pz - me.pz;
      const dist = isqrt(dx * dx + dz * dz);
      if (dist === 0) continue;
      const nx = fdiv(dx, dist);
      const nz = fdiv(dz, dist);
      hits.push({ seat, kx: fmul(nx, PARRY_KNOCKBACK), kz: fmul(nz, PARRY_KNOCKBACK) });
    }
    for (const h of hits) {
      const victim = this.world.bodies[1 - h.seat];
      victim.vx += h.kx;
      victim.vz += h.kz;
    }
    for (const h of hits) {
      const me = this.world.bodies[h.seat];
      me.vx = 0;
      me.vz = 0;
      this.parryFlashCd[h.seat] = PARRY_FLASH;
      this.parryAttemptActive[h.seat] = false;
    }
  }

  expireParryAttempts() {
    for (const seat of [0, 1]) {
      if (!this.parryAttemptActive[seat]) continue;
      const stillInWindow =
        this.bracing[seat] &&
        this.braceStartTick[seat] >= 0 &&
        this.tick - this.braceStartTick[seat] < PARRY_WINDOW;
      if (stillInWindow) continue;
      this.parryAttemptActive[seat] = false;
      this.parryWhiffCd[seat] = PARRY_WHIFF_CD;
    }
  }

  checkKnockout() {
    const a = this.world.bodies[0];
    const b = this.world.bodies[1];
    const da = isqrt(a.px * a.px + a.pz * a.pz);
    const db = isqrt(b.px * b.px + b.pz * b.pz);
    const aOut = da > this.arenaRadius;
    const bOut = db > this.arenaRadius;
    const timeout = !aOut && !bOut && this.liveTicks >= MAX_LIVE_TICKS;
    if (!aOut && !bOut && !timeout) return;

    let loser;
    if (timeout || (aOut && bOut)) {
      // Whoever sits further from the centre loses; exact ties alternate.
      loser = da > db ? 0 : db > da ? 1 : (this.scores[0] + this.scores[1]) % 2;
    } else {
      loser = aOut ? 0 : 1;
    }
    this.roundLoser = loser;
    const winner = loser === 0 ? 1 : 0;
    this.scores[winner]++;
    this.lastScorer = winner;
    this.freezePucks();
    this.setPhase(Phase.Scored, SCORED_TICKS);
  }

  advancePhase() {
    if (this.phase === Phase.Countdown) {
      this.liveTicks = 0;
      this.setPhase(Phase.Live, 0);
      return;
    }
    if (this.phase !== Phase.Scored) return;
    if (this.scores[0] >= ROUNDS_TO_WIN || this.scores[1] >= ROUNDS_TO_WIN) {
      this.winner = this.scores[0] > this.scores[1] ? 0 : 1;
      this.setPhase(Phase.Over, 1);
    } else {
      this.resetRound();
      this.setPhase(Phase.Countdown, ROUND_COUNTDOWN);
    }
  }

  resetRound() {
    const a = this.world.bodies[0];
    const b = this.world.bodies[1];
    a.px = -SPAWN_X;
    a.pz = 0;
    b.px = SPAWN_X;
    b.pz = 0;
    this.freezePucks();
    this.arenaRadius = ARENA_START;
    this.dashCd[0] = 0;
    this.dashCd[1] = 0;
    this.parryFlashCd[0] = 0;
    this.parryFlashCd[1] = 0;
    this.parryWhiffCd[0] = 0;
    this.parryWhiffCd[1] = 0;
    this.parryAttemptActive[0] = false;
    this.parryAttemptActive[1] = false;
    this.braceStartTick[0] = -1;
    this.braceStartTick[1] = -1;
    this.bracedPrev[0] = false;
    this.bracedPrev[1] = false;
    this.liveTicks = 0;
    this.roundLoser = -1;
  }

  freezePucks() {
    for (const b of this.world.bodies) {
      b.vx = 0;
      b.vz = 0;
    }
    this.bracing[0] = false;
    this.bracing[1] = false;
  }

  setPhase(phase, timer) {
    this.phase = phase;
    this.phaseTimer = timer;
    this.phaseLen = timer > 0 ? timer : 1;
  }

  /* ------------------------- serialisation ------------------------- */

  packInto(out) {
    this.world.pack(out, out.length);
    out.push(
      this.tick,
      this.phase,
      this.phaseTimer,
      this.phaseLen,
      this.liveTicks,
      this.scores[0],
      this.scores[1],
      this.arenaRadius,
      this.dashCd[0],
      this.dashCd[1],
      this.bracedPrev[0] ? 1 : 0,
      this.bracedPrev[1] ? 1 : 0,
      this.braceStartTick[0],
      this.braceStartTick[1],
      this.parryFlashCd[0],
      this.parryFlashCd[1],
      this.parryWhiffCd[0],
      this.parryWhiffCd[1],
      this.parryAttemptActive[0] ? 1 : 0,
      this.parryAttemptActive[1] ? 1 : 0,
      this.roundLoser,
      this.lastScorer,
      this.winner
    );
    return out;
  }

  save(out) {
    this.packInto(out);
  }

  /**
   * Allocation-free snapshot into a preallocated Int32Array(STATE_WORDS).
   * Field order is identical to packInto() so load() accepts it directly.
   */
  saveFast(a) {
    const b0 = this.world.bodies[0];
    const b1 = this.world.bodies[1];
    a[0] = b0.px; a[1] = b0.pz; a[2] = b0.vx; a[3] = b0.vz;
    a[4] = b1.px; a[5] = b1.pz; a[6] = b1.vx; a[7] = b1.vz;
    a[8] = this.tick;
    a[9] = this.phase;
    a[10] = this.phaseTimer;
    a[11] = this.phaseLen;
    a[12] = this.liveTicks;
    a[13] = this.scores[0];
    a[14] = this.scores[1];
    a[15] = this.arenaRadius;
    a[16] = this.dashCd[0];
    a[17] = this.dashCd[1];
    a[18] = this.bracedPrev[0] ? 1 : 0;
    a[19] = this.bracedPrev[1] ? 1 : 0;
    a[20] = this.braceStartTick[0];
    a[21] = this.braceStartTick[1];
    a[22] = this.parryFlashCd[0];
    a[23] = this.parryFlashCd[1];
    a[24] = this.parryWhiffCd[0];
    a[25] = this.parryWhiffCd[1];
    a[26] = this.parryAttemptActive[0] ? 1 : 0;
    a[27] = this.parryAttemptActive[1] ? 1 : 0;
    a[28] = this.roundLoser;
    a[29] = this.lastScorer;
    a[30] = this.winner;
    return a;
  }

  load(src) {
    let k = this.world.unpack(src, 0);
    this.tick = src[k++];
    this.phase = src[k++];
    this.phaseTimer = src[k++];
    this.phaseLen = src[k++];
    this.liveTicks = src[k++];
    this.scores[0] = src[k++];
    this.scores[1] = src[k++];
    this.arenaRadius = src[k++];
    this.dashCd[0] = src[k++];
    this.dashCd[1] = src[k++];
    this.bracedPrev[0] = src[k++] !== 0;
    this.bracedPrev[1] = src[k++] !== 0;
    this.braceStartTick[0] = src[k++];
    this.braceStartTick[1] = src[k++];
    this.parryFlashCd[0] = src[k++];
    this.parryFlashCd[1] = src[k++];
    this.parryWhiffCd[0] = src[k++];
    this.parryWhiffCd[1] = src[k++];
    this.parryAttemptActive[0] = src[k++] !== 0;
    this.parryAttemptActive[1] = src[k++] !== 0;
    this.roundLoser = src[k++];
    this.lastScorer = src[k++];
    this.winner = src[k++];
    // `bracing` is not serialised by the game; it is re-derived on the next
    // applyControl. Mirror bracedPrev so evaluation right after a load is sane.
    this.bracing[0] = this.bracedPrev[0];
    this.bracing[1] = this.bracedPrev[1];
  }

  checksum() {
    const out = [];
    this.packInto(out);
    return checksumArray(out);
  }

  get isOver() {
    return this.phase === Phase.Over;
  }

  get matchWinner() {
    return this.winner;
  }

  get currentTick() {
    return this.tick;
  }

  get currentPhase() {
    return this.phase;
  }

  /* ---------------------- render / bot state ---------------------- */

  getRenderState() {
    const stretch = this.tetherStretch();
    const tension = fdiv(fmin(stretch, TETHER_TENSION_N), TETHER_TENSION_N);
    return {
      phase: this.phase,
      phaseProgress: this.phaseLen > 0 ? 1 - this.phaseTimer / this.phaseLen : 1,
      phaseTimer: this.phaseTimer,
      arenaRadius: toF(this.arenaRadius),
      scores: [this.scores[0], this.scores[1]],
      pucks: [this.puckRender(0), this.puckRender(1)],
      tether: {
        taut: stretch > 0,
        tension: toF(tension),
        stretch: toF(stretch),
        rest: toF(TETHER_REST),
      },
      winner: this.winner,
      roundLoser: this.roundLoser,
      tick: this.tick,
    };
  }

  puckRender(seat) {
    const b = this.world.bodies[seat];
    const dist = isqrt(b.px * b.px + b.pz * b.pz);
    let parryArmed = 0;
    if (this.bracing[seat] && this.braceStartTick[seat] >= 0) {
      const age = this.tick - this.braceStartTick[seat];
      if (age >= 0 && age < PARRY_WINDOW) parryArmed = 1 - age / PARRY_WINDOW;
    }
    const speed = isqrt(b.vx * b.vx + b.vz * b.vz);
    const scaled = fmul(speed, DASH_SPEED_SCALE);
    const capped = fmin(scaled, DASH_BONUS_CAP);
    const dashPower = DASH_BONUS_CAP > 0 ? toF(capped) / toF(DASH_BONUS_CAP) : 0;
    return {
      x: toF(b.px),
      z: toF(b.pz),
      vx: toF(b.vx),
      vz: toF(b.vz),
      out: dist > this.arenaRadius,
      hit: b.hit,
      dashReady: this.dashCd[seat] === 0,
      dashCharge: 1 - this.dashCd[seat] / DASH_COOLDOWN,
      braced: this.bracing[seat],
      parryArmed,
      parryFlash: this.parryFlashCd[seat] / PARRY_FLASH,
      parryReady: this.parryWhiffCd[seat] === 0,
      parryCooldown: this.parryWhiffCd[seat] / PARRY_WHIFF_CD,
      dashPower,
    };
  }
}

export default SlingshotSim;
