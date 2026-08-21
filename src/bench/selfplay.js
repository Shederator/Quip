#!/usr/bin/env node
/**
 * Headless benchmark: our agent vs the shipped bots, using the ported engine.
 *
 * Reproduces the exact practice-mode loop from the client:
 *     local  = readLocalInput()
 *     remote = game.bot(sim.getRenderState(), 1 - localSeat, botLevel)
 *     sim.step(localSeat === 0 ? [local, remote] : [remote, local])
 *
 * Usage:
 *   node src/bench/selfplay.js [--level=pro] [--matches=10] [--seat=0] [--quiet]
 *
 * Search-tuning flags (all optional, defaults come from DEFAULT_AGENT_OPTIONS):
 *   --beam=40                  beam width
 *   --rollout=420              stage-2 rollout length in ticks
 *   --schedule=2,2,3,4,5,6,8,10  macro-action schedule
 *   --replan=2                 replan interval in ticks
 *   --tag=name                 label printed with the summary
 */

import { SlingshotSim, STATE_WORDS, Phase, TICK_HZ } from '../engine/slingshot.js';
import { referenceBot } from '../ai/reference-bot.js';
import { SlingshotAgent } from '../ai/agent.js';

export function playMatch({ level = 'pro', seat = 0, agentOptions = {}, maxTicks = 60 * 60 * 8, delay = 2 } = {}) {
  const sim = new SlingshotSim(0);
  const agent = new SlingshotAgent({ seat, mode: 'practice', botLevel: level, ...agentOptions });
  const snap = new Int32Array(STATE_WORDS);
  const opp = 1 - seat;
  const inputs = [0, 0];

  let frame = 0;
  let planMsTotal = 0;
  let planCount = 0;

  while (!sim.isOver && frame < maxTicks) {
    sim.saveFast(snap);
    const local = agent.decide(snap, frame, delay);
    const remote = referenceBot(sim.getRenderState(), opp, level);
    agent.observeOpponentInput(remote);
    inputs[seat] = local;
    inputs[opp] = remote;
    sim.step(inputs);
    frame++;
    if (agent.telemetry.lastMs) {
      planMsTotal += agent.telemetry.lastMs;
      planCount = agent.telemetry.replans;
    }
  }

  return {
    won: sim.winner === seat,
    winner: sim.winner,
    scores: [...sim.scores],
    frames: frame,
    seconds: frame / TICK_HZ,
    over: sim.isOver,
    avgPlanMs: planCount ? planMsTotal / planCount : 0,
    peakPlanMs: agent.telemetry.peakMs,
    replans: agent.telemetry.replans,
    lastNodes: agent.telemetry.nodes,
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : def;
  };
  const quiet = args.includes('--quiet');
  const levels = opt('level', 'rookie,pro,shark').split(',');
  const matches = Number(opt('matches', '4'));
  const seats = opt('seat', '0,1').split(',').map(Number);
  const tag = opt('tag', '');

  const agentOptions = {};
  if (opt('beam')) agentOptions.beamWidth = Number(opt('beam'));
  if (opt('rollout')) agentOptions.rolloutTicks = Number(opt('rollout'));
  if (opt('replan')) agentOptions.replanEvery = Number(opt('replan'));
  if (opt('schedule')) agentOptions.schedule = opt('schedule').split(',').map(Number);

  const summary = [];
  for (const level of levels) {
    for (const seat of seats) {
      let wins = 0;
      let roundsFor = 0;
      let roundsAgainst = 0;
      let secs = 0;
      let peak = 0;
      let avg = 0;
      for (let i = 0; i < matches; i++) {
        // Vary the opening by giving the agent a different input delay, which
        // shifts the whole trajectory without needing RNG the game doesn't have.
        const r = playMatch({ level, seat, delay: 2 + (i % 4), agentOptions });
        wins += r.won ? 1 : 0;
        roundsFor += r.scores[seat];
        roundsAgainst += r.scores[1 - seat];
        secs += r.seconds;
        peak = Math.max(peak, r.peakPlanMs);
        avg += r.avgPlanMs;
        if (!quiet) {
          process.stdout.write(
            `  ${level} seat${seat} #${i} delay=${2 + (i % 4)} -> ${r.won ? 'WIN ' : 'LOSS'} ` +
              `${r.scores[seat]}-${r.scores[1 - seat]} in ${r.seconds.toFixed(1)}s ` +
              `(plan avg ${r.avgPlanMs.toFixed(2)}ms peak ${r.peakPlanMs.toFixed(1)}ms)\n`
          );
        }
      }
      summary.push({
        level,
        seat,
        wins,
        matches,
        winRate: wins / matches,
        roundsFor,
        roundsAgainst,
        avgSeconds: secs / matches,
        avgPlanMs: avg / matches,
        peakPlanMs: peak,
      });
    }
  }

  console.log(`\n=== summary ${tag ? `[${tag}] ` : ''}${JSON.stringify(agentOptions)} ===`);
  for (const s of summary) {
    console.log(
      `${s.level.padEnd(7)} seat${s.seat}  ${String(s.wins).padStart(2)}/${s.matches} ` +
        `(${(s.winRate * 100).toFixed(0)}%)  rounds ${s.roundsFor}-${s.roundsAgainst}  ` +
        `${s.avgSeconds.toFixed(1)}s/match  plan ${s.avgPlanMs.toFixed(2)}ms avg / ${s.peakPlanMs.toFixed(1)}ms peak`
      );
  }
  const totalWins = summary.reduce((a, s) => a + s.wins, 0);
  const totalMatches = summary.reduce((a, s) => a + s.matches, 0);
  const rf = summary.reduce((a, s) => a + s.roundsFor, 0);
  const ra = summary.reduce((a, s) => a + s.roundsAgainst, 0);
  console.log(
    `OVERALL ${totalWins}/${totalMatches} (${((totalWins / totalMatches) * 100).toFixed(1)}%)  rounds ${rf}-${ra}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
