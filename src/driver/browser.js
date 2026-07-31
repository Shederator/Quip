/**
 * Browser plumbing: launch Chromium, clear the Cloudflare interstitial, and
 * inject the bot.
 *
 * Injection strategy
 * ------------------
 * The game ships as one top-level ES module. We intercept that response and
 * append a short epilogue that republishes the internals we need on
 * `globalThis` (see src/browser/discover.js). The identifiers are discovered by
 * pattern-matching the bundle itself, so a new release with fresh minified
 * names still works.
 *
 * The bot bundle is injected with addInitScript so it is present before the
 * game's own code runs and can hook the runner prototype the moment it exists.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { discover, buildEpilogue } from '../browser/discover.js';

export const STORAGE_PATH = path.resolve('recon/dump/storage.json');
const BOT_BUNDLE = path.resolve('dist/quip-bot.js');
const WORKER_BUNDLE = path.resolve('dist/quip-worker.js');

function requireBuild() {
  for (const p of [BOT_BUNDLE, WORKER_BUNDLE]) {
    if (!fs.existsSync(p)) {
      throw new Error(`missing ${path.relative(process.cwd(), p)} — run: node build.mjs`);
    }
  }
}

export async function launch({ headless = false, display = ':99', slowMo = 0 } = {}) {
  requireBuild();
  if (display && !process.env.DISPLAY) process.env.DISPLAY = display;

  const browser = await chromium.launch({
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1440,900',
      '--mute-audio',
    ],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    storageState: fs.existsSync(STORAGE_PATH) ? STORAGE_PATH : undefined,
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });

  // Ship the worker source as a global string, then the bot bundle.
  const workerSrc = fs.readFileSync(WORKER_BUNDLE, 'utf8');
  const botSrc = fs.readFileSync(BOT_BUNDLE, 'utf8');
  await ctx.addInitScript({
    content: `window.__QUIP_WORKER_SRC__ = ${JSON.stringify(workerSrc)};`,
  });
  await ctx.addInitScript({ content: botSrc });

  const page = await ctx.newPage();
  const discovered = { value: null };

  // Rewrite the game bundle on the fly to expose its internals.
  await page.route(/\/assets\/index-[\w-]+\.js(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const found = discover(body);
    discovered.value = found;
    const patched = body + buildEpilogue(found);
    await route.fulfill({
      response: res,
      body: patched,
      headers: { ...res.headers(), 'content-length': String(Buffer.byteLength(patched)) },
    });
  });

  return { browser, ctx, page, discovered };
}

/** Navigate and wait out the Cloudflare managed challenge. */
export async function open(page, url = 'https://play.quip.gg/', { timeout = 120000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    if (!/just a moment|attention required|verify you are human/i.test(title)) break;
    await page.waitForTimeout(1200);
  }
  // Dismiss the first-run onboarding modal if it appears.
  for (const label of ['Skip', 'Got it', 'Close']) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        break;
      }
    }
  }
  return page;
}

export async function saveStorage(ctx) {
  try {
    fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(await ctx.storageState(), null, 2));
  } catch { /* best effort */ }
}
