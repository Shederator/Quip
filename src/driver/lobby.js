/**
 * Lobby automation.
 *
 * Selectors come from the live DOM (see recon/dump/page.html): game cards are
 * `button.game-card` containing the title, the free/USDC selector is
 * `button.queue-mode-seg`, bot difficulty buttons are plain ghost buttons
 * labelled Rookie / Pro / Shark, and the primary CTA is `button.play-btn`.
 *
 * Everything is defensive: every helper reports whether it actually did
 * something so the caller can decide how to proceed.
 */

const GAME_TITLE = 'Slingshot Sumo';

/** Playwright throws on a closed page/context; every helper checks this first. */
export function alive(page) {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

async function clickIfVisible(locator, timeout = 4000) {
  try {
    if (!(await locator.count())) return false;
    const el = locator.first();
    if (!(await el.isVisible())) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first-run onboarding is a 4-step carousel that mounts a moment after
 * hydration, so a single early pass at dismissing it loses the race. Poll for
 * `waitMs` and keep clicking until the primary CTA (`button.play-btn`) is
 * actually reachable.
 */
export async function dismissModals(page, { waitMs = 8000 } = {}) {
  const deadline = Date.now() + waitMs;
  let n = 0;
  while (Date.now() < deadline && alive(page)) {
    // Anything covering the play button counts as a modal.
    const blocked = await page
      .evaluate(() => {
        const play = document.querySelector('button.play-btn') || document.querySelector('button.game-card');
        if (!play) return true;
        const r = play.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(top === play || play.contains(top));
      })
      .catch(() => false);

    if (!blocked) break;

    let hit = false;
    for (const label of ['Skip', 'Got it', 'Continue', 'Close', 'Dismiss', 'Next']) {
      if (await clickIfVisible(page.locator(`button:has-text("${label}")`), 1200)) {
        hit = true;
        n++;
        await page.waitForTimeout(260);
        break;
      }
    }
    if (!hit) {
      // Nothing clickable yet — give the app a beat to mount the modal.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  return n;
}

/** Bring the Slingshot Sumo card into focus (it is a horizontal carousel). */
export async function selectSlingshot(page) {
  if (!alive(page)) return false;
  const card = page.locator(`button.game-card:has-text("${GAME_TITLE}")`).first();
  for (let i = 0; i < 12; i++) {
    if (!alive(page)) return false;
    if (await card.count().catch(() => 0)) {
      const pressed = await card.getAttribute('aria-pressed').catch(() => null);
      if (pressed === 'true') return true;
      if (await clickIfVisible(card)) {
        await page.waitForTimeout(400);
        if ((await card.getAttribute('aria-pressed').catch(() => null)) === 'true') return true;
      }
    }
    // Nudge the carousel and retry.
    const next = page.locator('button[aria-label*="ext"], .game-swipe-next, button:has-text("›")').first();
    if (!(await clickIfVisible(next, 1200))) break;
    await page.waitForTimeout(300);
  }
  if (!alive(page)) return false;
  return (await card.count().catch(() => 0))
    ? (await card.getAttribute('aria-pressed').catch(() => null)) === 'true'
    : false;
}

/** Choose the stake mode. Free is the default and the only one we ever want. */
export async function selectFree(page) {
  if (!alive(page)) return false;
  const seg = page.locator('button.queue-mode-seg.queue-mode-free').first();
  if (!(await seg.count().catch(() => 0))) return false;
  if ((await seg.getAttribute('aria-pressed').catch(() => null)) === 'true') return true;
  return clickIfVisible(seg);
}

/**
 * Start a warm-up match against the built-in bot at the given level.
 * This is the fully offline path: deterministic opponent, no wagering,
 * no matchmaking wait.
 */
export async function startWarmup(page, level = 'pro', { timeout = 25000 } = {}) {
  if (!alive(page)) return false;
  const label = level[0].toUpperCase() + level.slice(1);
  const base = (await signal(page))?.ticks ?? 0;

  // Several strategies, cheapest/most specific first. The live DOM (confirmed
  // with tools/probe-lobby.mjs) renders these as `button.btn.btn-ghost.btn-sm`.
  const candidates = [
    page.getByRole('button', { name: label, exact: true }),
    page.locator(`button.btn-ghost:has-text("${label}")`),
    page.locator(`button:has-text("${label}")`).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }),
    page.locator(`button:has-text("${label}")`),
  ];

  for (const c of candidates) {
    if (!alive(page)) return false;
    if (!(await clickIfVisible(c))) continue;
    // Success is not "the click resolved" — it is "the simulation is ticking".
    if (await confirmRunning(page, base, timeout)) return true;
  }

  // The click may well have landed while our confirmation window was too tight
  // (asset streaming, WebGL context creation). Give the runner one last look.
  return confirmRunning(page, base, 6000);
}

/** Cheap snapshot of "is a match running" evidence from the page. */
async function signal(page) {
  if (!alive(page)) return null;
  return page
    .evaluate(() => {
      const b = window.__quipBot;
      const canvas = document.querySelector('canvas');
      return {
        ticks: b ? b.telemetry.ticks | 0 : 0,
        frames: b ? b.telemetry.frames | 0 : 0,
        phase: b ? b.telemetry.phase : -1,
        canvas: !!canvas,
        lobby: !!document.querySelector('button.play-btn'),
      };
    })
    .catch(() => null);
}

/**
 * A match is running when the patched `readLocalInput` is being called, i.e.
 * when telemetry.ticks advances. That is frame-exact evidence straight out of
 * the game loop — far more reliable than any DOM heuristic.
 */
async function confirmRunning(page, baseTicks, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!alive(page)) return false;
    const s = await signal(page);
    if (s && s.ticks > baseTicks + 2) return true;
    // Fallback for a bot that failed to hook: canvas up and lobby CTA gone.
    if (s && s.canvas && !s.lobby) return true;
    await page.waitForTimeout(250).catch(() => {});
  }
  return false;
}

/** Start an online free match ("Play free"). */
export async function startOnline(page, { timeout = 90000 } = {}) {
  const play = page.locator('button.play-btn').first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await play.count())) break;
    const text = ((await play.textContent().catch(() => '')) || '').trim();
    const disabled = await play.isDisabled().catch(() => false);
    if (!disabled && /play/i.test(text)) {
      await play.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
    // "Connecting…" / "Queued…" — wait for the socket to come up.
    await page.waitForTimeout(700);
  }
  return false;
}

/** True once a match canvas / HUD is on screen. */
export async function waitForMatch(page, { timeout = 120000 } = {}) {
  if (!alive(page)) return false;
  try {
    await page.waitForFunction(
      () => {
        const b = window.__quipBot;
        if (b && b.hooked && b.telemetry.ticks > 0) return true;
        return !!document.querySelector('canvas');
      },
      { timeout, polling: 250 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Block until the match reports Over (phase 3) or the completed-match counter
 * moves past `baseMatches`. Returns the reason it stopped.
 */
export async function waitForMatchEnd(page, baseMatches = 0, { timeout = 300000 } = {}) {
  const deadline = Date.now() + timeout;
  let idle = 0;
  let lastTicks = -1;
  while (Date.now() < deadline) {
    if (!alive(page)) return 'page-closed';
    const s = await signal(page);
    if (!s) return 'no-telemetry';
    const m = await page
      .evaluate(() => (window.__quipBot ? window.__quipBot.telemetry.matches | 0 : 0))
      .catch(() => 0);
    if (m > baseMatches) return 'match-over';
    if (s.phase === 3) return 'phase-over';
    // The runner stopping (back to lobby, disconnect) shows up as frozen ticks.
    if (s.ticks === lastTicks) {
      if (++idle > 24) return 'stalled';
    } else {
      idle = 0;
      lastTicks = s.ticks;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
  return 'timeout';
}

/** Click whatever "play again" affordance is on the post-match screen. */
export async function rematch(page) {
  if (!alive(page)) return null;
  for (const label of ['Rematch', 'Play again', 'Again', 'Next match', 'Play free', 'Continue']) {
    if (await clickIfVisible(page.locator(`button:has-text("${label}")`), 2000)) return label;
  }
  return null;
}

/** Return to the lobby. */
export async function toLobby(page) {
  if (!alive(page)) return false;
  for (const sel of ['button.topnav-mark', 'button.topnav-link:has-text("Play")']) {
    if (await clickIfVisible(page.locator(sel), 2500)) {
      await page.waitForTimeout(600);
      return true;
    }
  }
  return false;
}
