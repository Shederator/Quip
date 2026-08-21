/**
 * Recon harness: loads play.quip.gg in a real (xvfb) Chromium, survives the
 * Cloudflare managed challenge, and dumps every JS/JSON/WASM asset plus a
 * transcript of all WebSocket traffic to ./recon/dump.
 *
 * Usage: xvfb-run -a node recon/capture.mjs [url]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const URL_TARGET = process.argv[2] || 'https://play.quip.gg/';
const OUT = path.resolve('recon/dump');
const ASSETS = path.join(OUT, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const manifest = [];
const wsLog = [];
const consoleLog = [];

function safeName(url) {
  const u = new URL(url);
  let base = path.basename(u.pathname) || 'index';
  if (!path.extname(base)) base += '.txt';
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `${hash}__${base}`.replace(/[^\w.\-]/g, '_');
}

const browser = await chromium.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
});

await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // eslint-disable-next-line no-proto
  window.chrome = window.chrome || { runtime: {} };
});

const page = await ctx.newPage();

page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));

page.on('response', async (res) => {
  const url = res.url();
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  const interesting =
    /\.(m?js|json|wasm|map)(\?|$)/.test(url) ||
    ct.includes('javascript') ||
    ct.includes('json') ||
    ct.includes('wasm');
  if (!interesting) return;
  if (url.includes('cdn-cgi/challenge-platform')) return;
  try {
    const body = await res.body();
    const file = safeName(url);
    fs.writeFileSync(path.join(ASSETS, file), body);
    manifest.push({ url, status: res.status(), ct, bytes: body.length, file });
  } catch { /* streamed/aborted */ }
});

page.on('websocket', (ws) => {
  wsLog.push({ t: Date.now(), dir: 'open', url: ws.url() });
  ws.on('framesent', (d) =>
    wsLog.push({ t: Date.now(), dir: 'tx', url: ws.url(), payload: String(d.payload).slice(0, 4000) }));
  ws.on('framereceived', (d) =>
    wsLog.push({ t: Date.now(), dir: 'rx', url: ws.url(), payload: String(d.payload).slice(0, 4000) }));
  ws.on('close', () => wsLog.push({ t: Date.now(), dir: 'close', url: ws.url() }));
});

console.log('→ navigating', URL_TARGET);
await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Wait out the Cloudflare interstitial.
for (let i = 0; i < 40; i++) {
  const title = await page.title().catch(() => '');
  if (!/just a moment|attention required/i.test(title)) break;
  console.log(`   cf challenge… (${i}) title="${title}"`);
  await page.waitForTimeout(1500);
}

await page.waitForTimeout(6000);
console.log('→ title:', await page.title());

const html = await page.content();
fs.writeFileSync(path.join(OUT, 'page.html'), html);
await page.screenshot({ path: path.join(OUT, 'landing.png'), fullPage: true });

// Dump global surface area that might hold game config.
const globals = await page.evaluate(() => {
  const keys = Object.keys(window).filter(
    (k) => !/^(webkit|on|chrome|_cf)/.test(k)
  );
  const out = {};
  for (const k of keys) {
    try {
      const v = window[k];
      const t = typeof v;
      if (t === 'object' && v !== null) {
        out[k] = { type: 'object', keys: Object.keys(v).slice(0, 60) };
      } else if (t !== 'function') {
        out[k] = { type: t, value: String(v).slice(0, 200) };
      }
    } catch { /* cross-origin */ }
  }
  return out;
});
fs.writeFileSync(path.join(OUT, 'globals.json'), JSON.stringify(globals, null, 2));

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'ws.json'), JSON.stringify(wsLog, null, 2));
fs.writeFileSync(path.join(OUT, 'console.log'), consoleLog.join('\n'));

// Persist the cleared-challenge cookies so later runs skip the interstitial.
fs.writeFileSync(path.join(OUT, 'storage.json'), JSON.stringify(await ctx.storageState(), null, 2));

console.log(`→ captured ${manifest.length} assets, ${wsLog.length} ws frames`);
await browser.close();
