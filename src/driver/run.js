#!/usr/bin/env node
/**
 * Orchestrator — opens play.quip.gg, injects the bot, and plays Slingshot Sumo
 * matches back to back, printing telemetry.
 *
 * Usage
 *   node src/driver/run.js                       # 3 warm-up matches vs Pro
 *   node src/driver/run.js --level=shark --matches=5
 *   node src/driver/run.js --mode=online --matches=3
 *   node src/driver/run.js --headed --keep-open
 *
 * Flags
 *   --mode=practice|online   practice = warm-up vs the built-in bot (default)
 *   --level=rookie|pro|shark difficulty for practice mode
 *   --matches=N              how many matches to play
 *   --headed                 show the browser (needs a display; Xvfb is fine)
 *   --keep-open              leave the browser running when finished
 *   --url=...                override the target URL
 *   --shot-dir=...           where to drop screenshots (default artifacts/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { launch, open, saveStorage } from './browser.js';
import {
  alive,
  dismissModals,
  selectSlingshot,
  selectFree,
  startWarmup,
  startOnline,
  waitForMatch,
  waitForMatchEnd,
  rematch,
  toLobby,
} from './lobby.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const bool = (name) => args.includes(`--${name}`);

const CFG = {
  url: flag('url', 'https://play.quip.gg/'),
  mode: flag('mode', 'practice'),
  level: flag('level', 'pro'),
  matches: Number(flag('matches', '3')),
  headless: !bool('headed'),
  keepOpen: bool('keep-open'),
  shotDir: flag('shot-dir', 'artifacts'),
};

fs.mkdirSync(CFG.shotDir, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: path.join(CFG.shotDir, `${name}.png`) }).catch(() => {});

const log = (...a) => console.log('[run]', ...a);

/** Poll the in-page bot for its telemetry. */
const telemetry = (page) =>
  page.evaluate(() => {
    const b = window.__quipBot;
    if (!b) return null;
    return {
      hooked: b.hooked,
      enabled: b.enabled,
      mode: b.mode,
      seat: b.seat,
      botLevel: b.botLevel,
      parity: b.parity,
      t: JSON.parse(JSON.stringify(b.telemetry)),
    };
  }).catch(() => null);

async function main() {
  log('config', CFG);
  const { browser, ctx, page, discovered } = await launch({ headless: CFG.headless });

  page.on('console', (m) => {
    const txt = m.text();
    if (txt.includes('[quip-bot]')) console.log('  page>', txt);
  });
  page.on('pageerror', (e) => console.log('  page!', String(e).slice(0, 300)));

  log('opening', CFG.url);
  await open(page, CFG.url);
  log('title:', await page.title());
  log('discovered internals:', discovered.value);
  await dismissModals(page);
  await shot(page, '01-lobby');

  // Wait for the bot to attach.
  await page
    .waitForFunction(() => window.__quipBot && window.__quipBot.hooked, { timeout: 45000 })
    .catch(() => log('WARN: bot did not report hooked yet'));
  const boot = await telemetry(page);
  log('bot attached:', !!boot?.hooked, 'parity:', boot?.parity?.detail || 'pending');

  await selectSlingshot(page);
  await selectFree(page);
  await shot(page, '02-selected');

  const results = [];
  for (let i = 0; i < CFG.matches; i++) {
    log(`--- match ${i + 1}/${CFG.matches} (${CFG.mode}${CFG.mode === 'practice' ? '/' + CFG.level : ''}) ---`);

    if (!alive(page)) {
      log('page closed; aborting remaining matches');
      break;
    }

    const before = (await telemetry(page))?.t?.matches ?? 0;

    let started = false;
    if (CFG.mode === 'practice') {
      started = await startWarmup(page, CFG.level);
    } else {
      started = await startOnline(page);
    }
    if (!started) {
      log('could not start a match; trying rematch/lobby recovery');
      if (!alive(page)) break;
      if (!(await rematch(page))) {
        await toLobby(page);
        await dismissModals(page);
        await selectSlingshot(page);
        await selectFree(page);
        if (!alive(page)) break;
        started = await startWarmup(page, CFG.level);
        if (!started) {
          log('recovery failed, skipping this match');
          continue;
        }
      }
    }

    const live = await waitForMatch(page, { timeout: 120000 });
    log('match live:', live);
    await shot(page, `03-match-${i + 1}-start`);

    const why = await waitForMatchEnd(page, before, { timeout: 300000 });
    log('match ended:', why);
    const info = await telemetry(page);
    const t = info?.t;
    const res = {
      match: i + 1,
      result: t?.lastResult || 'unknown',
      scores: t?.scores,
      reason: why,
      seat: info?.seat,
      planMs: t?.planMs,
      coverage:
        t && t.plannedFrames + t.reflexFrames
          ? t.plannedFrames / (t.plannedFrames + t.reflexFrames)
          : 0,
      parity: info?.parity?.ok,
    };
    results.push(res);
    log('result:', res);
    await shot(page, `04-match-${i + 1}-end`);

    // Back to a state where we can start another one.
    if (i + 1 < CFG.matches && alive(page)) {
      const r = await rematch(page);
      if (!r) {
        await toLobby(page);
        await dismissModals(page);
        await selectSlingshot(page);
        await selectFree(page);
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }
  }

  const final = await telemetry(page);
  console.log('\n=== session summary ===');
  for (const r of results) {
    console.log(
      `match ${r.match}: ${r.result}  seat=${r.seat}  plan=${(r.planMs || 0).toFixed(1)}ms  ` +
        `planned-frames=${(r.coverage * 100).toFixed(1)}%  engine-parity=${r.parity}`
    );
  }
  if (final) {
    console.log(
      `totals: ${final.t.wins}W-${final.t.losses}L, rounds ${final.t.roundsFor}-${final.t.roundsAgainst}`
    );
    console.log(`engine parity: ${final.parity?.detail}`);
  }
  fs.writeFileSync(
    path.join(CFG.shotDir, 'session.json'),
    JSON.stringify({ config: CFG, discovered: discovered.value, results, final }, null, 2)
  );

  await saveStorage(ctx);
  if (!CFG.keepOpen) await browser.close();
  else log('leaving browser open (--keep-open)');
}

main().catch(async (e) => {
  console.error('[run] fatal:', e);
  process.exit(1);
});
