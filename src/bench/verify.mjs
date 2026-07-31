#!/usr/bin/env node
/**
 * Offline verification of the reverse-engineered engine.
 *
 * The browser bot proves parity at runtime (it loads a live state into both the
 * game's own simulation and ours and compares checksums after 240 ticks). This
 * script proves the same things *without a browser*, straight against the
 * captured bundle, so a regression is caught in CI-time rather than at play
 * time.
 *
 * Checks
 *   1. fixed-point primitives           — independent reimplementation
 *   2. physics constants                — re-extracted from the raw bundle text
 *   3. tick-order / structural invariants of stepLive
 *   4. state serialisation round-trips  — save/load/saveFast agree
 *   5. input encoding round-trips
 *   6. reference bot: fast path == render-state path, for every difficulty
 *   7. determinism + golden checksums   — a fixed script must always produce
 *                                        the same trajectory checksum
 *   8. a full match is reproducible bit-for-bit
 *
 * Usage: node src/bench/verify.mjs [--bundle=path] [--update-golden]
 */

import fs from 'node:fs';
import path from 'node:path';
import { ONE, fx, toF, fmul, fdiv, isqrt, checksumArray } from '../engine/fixed.js';
import { BTN, encode, decodeAim, buttonsOf, sanitize, DIR_BITS, dirOf, FULL_MASK, AIM_MAX } from '../engine/input.js';
import { World } from '../engine/world.js';
import { SlingshotSim, STATE_WORDS, Phase, TICK_HZ } from '../engine/slingshot.js';
import * as C from '../engine/slingshot.js';
import { referenceBot, referenceBotFast } from '../ai/reference-bot.js';

/* ------------------------------------------------------------------ *
 * tiny test harness
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const eq = (a, b, name) => ok(a === b, name, `got ${a}, want ${b}`);

function group(title, fn) {
  const before = fail;
  process.stdout.write(`\n${title}\n`);
  fn();
  const delta = fail - before;
  process.stdout.write(`  ${delta === 0 ? 'ok' : `${delta} FAILED`}\n`);
}

/* ------------------------------------------------------------------ *
 * 1. fixed point
 * ------------------------------------------------------------------ */

group('1. Q16.16 fixed-point primitives', () => {
  eq(ONE, 65536, 'ONE = 1<<16');
  eq(fx(1), 65536, 'fx(1)');
  eq(fx(0.5), 32768, 'fx(0.5)');
  eq(fx(-2.25), -147456, 'fx(-2.25)');
  eq(toF(fx(3.25)), 3.25, 'toF round-trip');

  // fmul / fdiv must match the bundle's floor semantics exactly, including for
  // negatives (Math.floor, not truncation — this is the classic porting bug).
  const vals = [];
  for (let i = 0; i < 400; i++) {
    vals.push(Math.floor((Math.random() * 2 - 1) * 40 * ONE));
  }
  let mulOk = true;
  let divOk = true;
  for (let i = 0; i + 1 < vals.length; i += 2) {
    const a = vals[i];
    const b = vals[i + 1];
    if (fmul(a, b) !== Math.floor((a * b) / ONE)) mulOk = false;
    if (b !== 0 && fdiv(a, b) !== Math.floor((a * ONE) / b)) divOk = false;
  }
  ok(mulOk, 'fmul == floor(a*b/ONE) over 200 random pairs');
  ok(divOk, 'fdiv == floor(a*ONE/b) over 200 random pairs');
  eq(fdiv(1234, 0), 0, 'fdiv by zero returns 0 (matches bundle)');

  // isqrt: exact integer square root, never overshooting.
  let sqrtOk = true;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(Math.random() * 1e9);
    const r = isqrt(n);
    if (r * r > n || (r + 1) * (r + 1) <= n) sqrtOk = false;
  }
  ok(sqrtOk, 'isqrt is the exact floor of sqrt over 2000 samples');
  eq(isqrt(0), 0, 'isqrt(0)');
  eq(isqrt(-5), 0, 'isqrt(negative) clamps to 0');

  // FNV-1a checksum, as used by the netcode's desync detector.
  eq(checksumArray([]) >>> 0, checksumArray([]) >>> 0, 'checksum is pure');
  ok(checksumArray([1, 2, 3]) !== checksumArray([1, 2, 4]), 'checksum is sensitive');
});

/* ------------------------------------------------------------------ *
 * 2. constants, re-extracted from the raw bundle
 * ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

function findBundle() {
  const explicit = flag('bundle');
  if (explicit) return explicit;
  const pretty = path.resolve('recon/dump/index.pretty.js');
  if (fs.existsSync(pretty)) return pretty;
  const dir = path.resolve('recon/dump/assets');
  if (fs.existsSync(dir)) {
    const hit = fs.readdirSync(dir).find((f) => /index-.*\.js$/.test(f));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

group('2. physics constants vs the shipped bundle', () => {
  const bundle = findBundle();
  if (!bundle) {
    process.stdout.write('  (bundle not captured; run recon/capture.mjs — skipping)\n');
    return;
  }
  const src = fs.readFileSync(bundle, 'utf8');

  // The whole constant block, in bundle order. `Z(x)` is fx(x); bare numbers
  // are tick counts. We match on the *values* so minified names may change.
  const block = src.match(/Z\(11\)\s*,\s*[\s\S]{0,900}?Ikt?\s*=\s*84|Z\(11\)[\s\S]{0,900}?=\s*84/);
  ok(!!block, 'located the slingshot constant block');

  const expect = [
    ['ARENA_START', 'Z(11)', fx(11)],
    ['ARENA_MIN', 'Z(2.6)', fx(2.6)],
    ['SHRINK_DELAY', '240', 240],
    ['SHRINK_PER_TICK', 'Z(.0075)', fx(0.0075)],
    ['MAX_LIVE_TICKS', '3600', 3600],
    ['PUCK_RADIUS', 'Z(.85)', fx(0.85)],
    ['RESTITUTION', 'Z(.6)', fx(0.6)],
    ['DRAG', 'Z(.948)', fx(0.948)],
    ['MOVE_ACCEL', 'Z(.022)', fx(0.022)],
    ['TETHER_REST', 'Z(3.2)', fx(3.2)],
    ['TETHER_STIFF', 'Z(.02)', fx(0.02)],
    ['TETHER_MAX_IMP', 'Z(.09)', fx(0.09)],
    ['TETHER_TENSION_N', 'Z(3)', fx(3)],
    ['DASH_BASE', 'Z(.34)', fx(0.34)],
    ['DASH_SPEED_SCALE', 'Z(.55)', fx(0.55)],
    ['DASH_BONUS_CAP', 'Z(.36)', fx(0.36)],
    ['DASH_COOLDOWN', '60', 60],
    ['BRACE_DRAG', 'Z(.7)', fx(0.7)],
    ['BRACE_INV_MASS', 'Z(.34)', fx(0.34)],
    ['PARRY_WINDOW', '12', 12],
    ['PARRY_KNOCKBACK', 'Z(.72)', fx(0.72)],
    ['PARRY_FLASH', '18', 18],
    ['PARRY_WHIFF_CD', '36', 36],
    ['SPAWN_X', 'Z(3)', fx(3)],
    ['COUNTDOWN_TICKS', '180', 180],
    ['SCORED_TICKS', '84', 84],
    ['ROUNDS_TO_WIN', '3', 3],
  ];

  for (const [name, literal, value] of expect) {
    eq(C[name], value, `${name} == ${literal}`);
    // The literal must actually be present in the bundle too.
    const needle = literal.startsWith('Z(') ? literal : `= ${literal}`;
    ok(src.includes(needle) || src.includes(literal), `bundle contains ${literal} (${name})`);
  }

  eq(C.INV_MASS, ONE, 'INV_MASS == xe (unit mass)');
  eq(TICK_HZ, 60, 'tick rate is 60 Hz');
  ok(/D3\s*=\s*60|=\s*60\s*,\s*\w+\s*=\s*1e3\s*\/\s*/.test(src), 'bundle ties 1e3/60 to the tick rate');
  eq(JSON.stringify(C.Phase), JSON.stringify({ Countdown: 0, Live: 1, Scored: 2, Over: 3 }), 'Phase enum');
  ok(/Countdown:\s*0[\s\S]{0,60}Live:\s*1[\s\S]{0,60}Scored:\s*2[\s\S]{0,60}Over:\s*3/.test(src), 'bundle Phase enum order');
});

/* ------------------------------------------------------------------ *
 * 3. stepLive ordering + structural invariants
 * ------------------------------------------------------------------ */

group('3. simulation structure', () => {
  const sim = new SlingshotSim(0);
  eq(sim.phase, Phase.Countdown, 'a fresh sim starts in Countdown');
  eq(sim.phaseTimer, C.COUNTDOWN_TICKS, 'countdown is 180 ticks (3 s)');
  eq(sim.world.bodies[0].px, -C.SPAWN_X, 'seat 0 spawns at -3');
  eq(sim.world.bodies[1].px, C.SPAWN_X, 'seat 1 spawns at +3');
  eq(sim.arenaRadius, C.ARENA_START, 'arena starts at radius 11');

  // Countdown must freeze the pucks: no input can move them.
  const before = [sim.world.bodies[0].px, sim.world.bodies[0].pz];
  for (let i = 0; i < 60; i++) sim.step([BTN.Right | BTN.Dash, BTN.Left | BTN.Dash]);
  ok(sim.world.bodies[0].px === before[0] && sim.world.bodies[0].pz === before[1], 'pucks frozen during Countdown');
  eq(sim.phase, Phase.Countdown, 'still counting down after 60 ticks');

  // Reach Live and confirm the shrink only starts after SHRINK_DELAY.
  while (sim.phase === Phase.Countdown) sim.step([0, 0]);
  eq(sim.phase, Phase.Live, 'transitions Countdown -> Live');
  for (let i = 0; i < C.SHRINK_DELAY; i++) sim.step([0, 0]);
  eq(sim.arenaRadius, C.ARENA_START, 'no shrink for the first 240 live ticks');
  sim.step([0, 0]);
  eq(sim.arenaRadius, C.ARENA_START - C.SHRINK_PER_TICK, 'shrink begins on live tick 241');

  // Movement: integration is v = (v + a) * drag; p += v, so a constantly
  // accelerated body converges on a * drag/(1-drag). Tested on a bare World so
  // the tether and the opponent collision cannot contaminate the reading.
  const w = new World();
  const body = w.addBody({
    px: 0,
    pz: 0,
    radius: C.PUCK_RADIUS,
    invMass: C.INV_MASS,
    restitution: C.RESTITUTION,
    drag: C.DRAG,
  });
  for (let i = 0; i < 600; i++) {
    World.accelerate(body, C.MOVE_ACCEL, 0);
    w.step();
  }
  const topSpeed = toF(body.vx);
  const predicted = toF(C.MOVE_ACCEL) * (toF(C.DRAG) / (1 - toF(C.DRAG)));
  ok(
    Math.abs(topSpeed - predicted) < 0.01,
    'terminal walk speed matches a*drag/(1-drag) = 0.401 u/tick',
    `${topSpeed.toFixed(4)} vs ${predicted.toFixed(4)}`
  );
  // Coasting distance: releasing at speed v carries a further v*drag/(1-drag).
  const startX = body.px;
  const v0 = body.vx;
  for (let i = 0; i < 400; i++) w.step();
  const coasted = toF(body.px - startX);
  const coastPredicted = toF(v0) * (toF(C.DRAG) / (1 - toF(C.DRAG)));
  // 0.3% under the closed form: every tick floors the Q16.16 product toward
  // -infinity, so the geometric decay compounds slightly faster than the real
  // series. That bias is exactly what the game does, hence it is expected.
  ok(
    Math.abs(coasted - coastPredicted) < 0.05,
    'coast distance matches v*drag/(1-drag) = v*18.23 (within fixed-point drift)',
    `${coasted.toFixed(4)} vs ${coastPredicted.toFixed(4)}`
  );

  // The tether must never pull harder than TETHER_MAX_IMP per tick.
  const s2 = new SlingshotSim(0);
  while (s2.phase !== Phase.Live) s2.step([0, 0]);
  s2.world.bodies[0].px = -C.ARENA_START;
  s2.world.bodies[1].px = C.ARENA_START;
  s2.world.bodies[0].vx = 0;
  s2.world.bodies[1].vx = 0;
  const vBefore = s2.world.bodies[0].vx;
  s2.applyTether();
  const pull = s2.world.bodies[0].vx - vBefore;
  ok(
    pull > 0 && pull <= C.TETHER_MAX_IMP,
    'tether pull is inward and capped at 0.09 u/tick',
    `${toF(pull).toFixed(5)}`
  );

  // Bracing must cut the received rope impulse to BRACE_INV_MASS (34%).
  const s2b = new SlingshotSim(0);
  while (s2b.phase !== Phase.Live) s2b.step([0, 0]);
  s2b.world.bodies[0].px = -C.ARENA_START;
  s2b.world.bodies[1].px = C.ARENA_START;
  s2b.world.bodies[0].vx = 0;
  s2b.world.bodies[1].vx = 0;
  s2b.bracing[0] = true;
  s2b.world.bodies[0].invMass = C.BRACE_INV_MASS;
  s2b.applyTether();
  const bracedPull = s2b.world.bodies[0].vx;
  ok(
    bracedPull > 0 && bracedPull < pull,
    'a braced puck receives strictly less rope impulse',
    `${toF(bracedPull).toFixed(5)} < ${toF(pull).toFixed(5)}`
  );

  // Dash must go on cooldown for exactly DASH_COOLDOWN ticks.
  const s3 = new SlingshotSim(0);
  while (s3.phase !== Phase.Live) s3.step([0, 0]);
  eq(s3.dashCd[0], 0, 'dash available at round start');
  s3.step([BTN.Right | BTN.Dash, 0]);
  eq(s3.dashCd[0], C.DASH_COOLDOWN, 'dash sets a 60-tick cooldown');
  for (let i = 0; i < C.DASH_COOLDOWN; i++) s3.step([0, 0]);
  eq(s3.dashCd[0], 0, 'cooldown expires after exactly 60 ticks');

  // A puck pushed past the rim must be ringed out and the round scored.
  const s4 = new SlingshotSim(0);
  while (s4.phase !== Phase.Live) s4.step([0, 0]);
  const b = s4.world.bodies[1];
  b.px = C.ARENA_START + fx(1);
  b.pz = 0;
  s4.step([0, 0]);
  eq(s4.scores[0], 1, 'seat 0 scores when seat 1 leaves the disc');
  eq(s4.phase, Phase.Scored, 'phase becomes Scored');
  eq(s4.phaseTimer, C.SCORED_TICKS, 'Scored lasts 84 ticks');
});

/* ------------------------------------------------------------------ *
 * 4. serialisation
 * ------------------------------------------------------------------ */

group('4. state serialisation', () => {
  const sim = new SlingshotSim(0);
  const inputs = [0, 0];
  for (let i = 0; i < 500; i++) {
    inputs[0] = i % 3 === 0 ? BTN.Right : BTN.Up | (i % 7 === 0 ? BTN.Dash : 0);
    inputs[1] = i % 5 === 0 ? BTN.Left | BTN.Brace : BTN.Down;
    sim.step(inputs);
  }

  const a = [];
  sim.save(a);
  eq(a.length, STATE_WORDS, `save() writes ${STATE_WORDS} words`);

  const fastBuf = new Int32Array(STATE_WORDS);
  sim.saveFast(fastBuf);
  let same = true;
  for (let i = 0; i < STATE_WORDS; i++) if (fastBuf[i] !== a[i]) same = false;
  ok(same, 'saveFast() is word-identical to save()');

  const clone = new SlingshotSim(0);
  clone.load(a);
  eq(clone.checksum() >>> 0, sim.checksum() >>> 0, 'load(save(x)) reproduces the checksum');

  // ... and the two continue to agree indefinitely.
  let diverged = -1;
  for (let i = 0; i < 600; i++) {
    inputs[0] = i % 4 === 0 ? BTN.Left | BTN.Dash : BTN.Down;
    inputs[1] = i % 6 === 0 ? BTN.Brace : BTN.Up;
    sim.step(inputs);
    clone.step(inputs);
    if (clone.checksum() !== sim.checksum()) {
      diverged = i;
      break;
    }
  }
  eq(diverged, -1, 'a restored sim stays bit-identical for 600 further ticks');
});

/* ------------------------------------------------------------------ *
 * 5. input encoding
 * ------------------------------------------------------------------ */

group('5. input word encoding', () => {
  eq(BTN.Up | BTN.Down | BTN.Left | BTN.Right | BTN.Dash | BTN.Brace, 63, 'six buttons occupy bits 0-5');
  eq(FULL_MASK, 0x3ffff, 'the wire word is 18 bits: 6 buttons + two 6-bit signed aim fields');
  eq(AIM_MAX, 31, 'aim components are signed 6-bit (-31..31)');

  // Buttons and both signed aim components must survive a round trip.
  let roundTrip = true;
  for (let btn = 0; btn < 64; btn++) {
    for (const ax of [-31, -7, 0, 1, 15, 31]) {
      for (const az of [-31, 0, 31]) {
        const w = encode(btn, ax, az);
        const aim = decodeAim(w);
        if (buttonsOf(w) !== btn || aim.x !== ax || aim.z !== az) roundTrip = false;
      }
    }
  }
  ok(roundTrip, 'encode/decode round-trips over every button mask and signed aim pair');
  eq(encode(0, 99, -99), encode(0, 31, -31), 'aim components clamp to +/-31');
  eq(sanitize(0xffffffff), FULL_MASK, 'sanitize discards bits above the 18-bit word');
  eq(sanitize(-1), FULL_MASK, 'sanitize handles negative words');

  // The nine direction words must map to nine distinct vectors, and Up must
  // decrease z (screen-space convention, easy to get backwards).
  const seen = new Set();
  for (const bits of DIR_BITS) seen.add(`${dirOf(bits).x},${dirOf(bits).z}`);
  eq(seen.size, DIR_BITS.length, 'the direction table has no duplicates');
  eq(DIR_BITS.length, 9, 'eight directions plus "no movement"');
  ok(dirOf(BTN.Up).z < 0, 'Up decreases z');
  ok(dirOf(BTN.Right).x > 0, 'Right increases x');
  // dirOf returns the raw +/-1 sum; normalisation happens inside applyControl,
  // so a diagonal is (1,-1) here and only becomes unit length in the sim.
  const diag = dirOf(BTN.Up | BTN.Right);
  ok(diag.x === 1 && diag.z === -1, 'diagonals are the raw component sum (normalised later)');
  ok(dirOf(BTN.Up | BTN.Down).z === 0, 'opposite buttons cancel');
});

/* ------------------------------------------------------------------ *
 * 6. reference bot: the two implementations must never disagree
 * ------------------------------------------------------------------ */

group('6. shipped-bot port (fast path == render-state path)', () => {
  for (const level of ['rookie', 'pro', 'shark', 'tutorial']) {
    const sim = new SlingshotSim(0);
    let mismatch = -1;
    for (let i = 0; i < 1200; i++) {
      const slow0 = referenceBot(sim.getRenderState(), 0, level);
      const fast0 = referenceBotFast(sim, 0, level);
      const slow1 = referenceBot(sim.getRenderState(), 1, level);
      const fast1 = referenceBotFast(sim, 1, level);
      if (slow0 !== fast0 || slow1 !== fast1) {
        mismatch = i;
        break;
      }
      sim.step([fast0, fast1]);
      if (sim.isOver) break;
    }
    eq(mismatch, -1, `${level}: identical inputs for a whole bot-vs-bot match`);
  }
});

/* ------------------------------------------------------------------ *
 * 7 + 8. determinism and golden checksums
 * ------------------------------------------------------------------ */

const GOLDEN_PATH = path.resolve('src/bench/golden.json');

function scriptedChecksum(seedWord) {
  // A deterministic pseudo-input script — no RNG, just an integer recurrence,
  // so the trajectory is reproducible across machines and Node versions.
  const sim = new SlingshotSim(0);
  let s = seedWord | 0;
  const inputs = [0, 0];
  for (let i = 0; i < 1800; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    inputs[0] = sanitize(s >>> 3);
    inputs[1] = sanitize(s >>> 11);
    sim.step(inputs);
    if (sim.isOver) break;
  }
  return { checksum: sim.checksum() >>> 0, ticks: sim.tick, scores: [...sim.scores] };
}

function botMatchChecksum(level, seat) {
  const sim = new SlingshotSim(0);
  const inputs = [0, 0];
  while (!sim.isOver && sim.tick < 60 * 60 * 8) {
    inputs[seat] = referenceBotFast(sim, seat, level);
    inputs[1 - seat] = referenceBotFast(sim, 1 - seat, level === 'shark' ? 'pro' : 'shark');
    sim.step(inputs);
  }
  return { checksum: sim.checksum() >>> 0, ticks: sim.tick, scores: [...sim.scores], winner: sim.winner };
}

group('7. determinism', () => {
  for (const seed of [1, 7, 12345]) {
    const a = scriptedChecksum(seed);
    const b = scriptedChecksum(seed);
    eq(a.checksum, b.checksum, `scripted run seed=${seed} is reproducible`);
  }
  const x = scriptedChecksum(1);
  const y = scriptedChecksum(2);
  ok(x.checksum !== y.checksum, 'different scripts produce different trajectories');
});

const observed = {
  scripted: {},
  botMatches: {},
};
for (const seed of [1, 7, 12345]) observed.scripted[seed] = scriptedChecksum(seed);
for (const level of ['rookie', 'pro', 'shark']) {
  for (const seat of [0, 1]) observed.botMatches[`${level}:${seat}`] = botMatchChecksum(level, seat);
}

group('8. golden trajectory checksums', () => {
  if (args.includes('--update-golden') || !fs.existsSync(GOLDEN_PATH)) {
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(observed, null, 2) + '\n');
    process.stdout.write(`  wrote ${path.relative(process.cwd(), GOLDEN_PATH)} (${fs.existsSync(GOLDEN_PATH) ? 'baseline established' : ''})\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  for (const k of Object.keys(golden.scripted)) {
    eq(observed.scripted[k]?.checksum, golden.scripted[k].checksum, `scripted seed=${k} checksum`);
    eq(observed.scripted[k]?.ticks, golden.scripted[k].ticks, `scripted seed=${k} tick count`);
  }
  for (const k of Object.keys(golden.botMatches)) {
    eq(observed.botMatches[k]?.checksum, golden.botMatches[k].checksum, `bot match ${k} checksum`);
    eq(observed.botMatches[k]?.winner, golden.botMatches[k].winner, `bot match ${k} winner`);
    eq(
      JSON.stringify(observed.botMatches[k]?.scores),
      JSON.stringify(golden.botMatches[k].scores),
      `bot match ${k} final score`
    );
  }
});

/* ------------------------------------------------------------------ */

process.stdout.write('\n=== verify ===\n');
for (const f of failures) process.stdout.write(`FAIL  ${f}\n`);
process.stdout.write(`${pass} passed, ${fail} failed\n`);
if (fail === 0) {
  process.stdout.write('engine matches the shipped physics; trajectories are reproducible.\n');
}
process.exit(fail === 0 ? 0 : 1);
