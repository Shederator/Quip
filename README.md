# Slingshot Sumo — reverse-engineered physics + an automatic solver

A complete reverse-engineering of the **Slingshot Sumo** mini-game on
[play.quip.gg](https://play.quip.gg/), a **bit-exact re-implementation of its
physics engine**, and a **search-based agent that plays it automatically** —
injected into the real site through Chrome/Playwright.

The engine port is not "close enough". It is verified **bit-identical to the
shipped simulation at runtime**: the bot loads a live game state into both the
game's own class and our port, steps both 240 ticks with the same inputs, and
compares the game's own FNV-1a desync checksum.

```
[quip-bot] engine parity: bit-exact over 240 ticks (checksum 0xc6b3efb1)
```

---

## 1. Contents

| Path | What it is |
| --- | --- |
| `recon/capture.mjs` | Recon harness: clears the Cloudflare challenge, dumps every JS/JSON/WASM asset, logs all WebSocket frames, persists the cleared session |
| `src/engine/` | The ported game: Q16.16 fixed-point math, rigid-body world, input codec, `SlingshotSim` |
| `src/ai/reference-bot.js` | Exact port of the shipped opponent bots (Rookie / Pro / Shark / tutorial) |
| `src/ai/evaluate.js` | Leaf evaluation derived from the real physics constants |
| `src/ai/solver.js` | Two-stage rolling-horizon (MPC) beam search + long policy rollouts |
| `src/ai/opponents.js` | Opponent models, incl. the robust ensemble used against unknown humans |
| `src/ai/agent.js` | Input-delay-compensated agent (the thing that emits one word per tick) |
| `src/bench/verify.mjs` | 142-check offline verification of the port against the captured bundle |
| `src/bench/selfplay.js` | Headless benchmark vs the shipped bots |
| `src/browser/` | Injected browser layer: minified-name discovery, planning Web Worker, HUD |
| `src/driver/` | Playwright driver: launch, Cloudflare bypass, injection, lobby automation |

---

## 2. Quick start

```bash
npm install
npx playwright install chromium

node build.mjs              # bundle the injected browser payloads
npm run verify              # 142 offline checks on the ported engine
npm run bench -- --level=pro --matches=2      # headless self-play vs the shipped bot

# Play on the real site (needs a display; Xvfb is fine)
Xvfb :99 -screen 0 1440x900x24 &
DISPLAY=:99 node src/driver/run.js --matches=3 --level=pro --headed
```

If you have never captured the site before, run the recon harness first — it
produces `recon/dump/storage.json`, which lets every later run skip the
Cloudflare interstitial:

```bash
DISPLAY=:99 node recon/capture.mjs
```

---

## 3. What the site is

| | |
| --- | --- |
| Front end | Single-page app, one top-level ES module (`/assets/index-<hash>.js`, ~4.9 MB minified) |
| Edge | Cloudflare, **managed challenge** on first visit — plain HTTP clients get `403` |
| Backend | `wss://quip-rust.quipgg.workers.dev/` — Rust on Cloudflare Workers, wire protocol version 2 |
| Netcode | Deterministic lockstep with rollback (GGPO-style): local/remote input ring buffers, snapshots, resimulation, FNV-1a state checksums sent every 20 frames and re-verified server-side |
| Modes | Free / PHYS / USDC staked online matches, plus an offline "warm up vs bot" at three difficulties |

Because the server re-simulates and checksum-verifies, **any bot has to be
frame-accurate and deterministic**. Synthesising keyboard events would be both
jittery and detectable as desync. This project instead feeds inputs through the
game's own input path, one word per simulated tick (see §7).

### Recon method

Cloudflare's managed challenge cannot be cleared by a plain crawler, so
`recon/capture.mjs` drives a **real headed Chromium under Xvfb**, waits out the
interstitial, and then:

* dumps all 49 network assets to `recon/dump/assets/`,
* records every WebSocket open/close/frame to `recon/dump/ws.json`,
* snapshots `globalThis` shape, the hydrated DOM, and a screenshot,
* saves `storageState` so later runs start already-cleared.

The 4.9 MB bundle was beautified to 208 951 lines
(`recon/dump/index.pretty.js`) and the simulation located by anchoring on tokens
minifiers cannot rename — `id:"slingshot"`, `stepPractice`, `keyBits`,
`receiveRemoteInputs`.

---

## 4. The physics, in full

Everything below is transcribed from the bundle, not inferred. Minified names
are given so each item can be re-checked against `recon/dump/index.pretty.js`.
`src/bench/verify.mjs` re-extracts every constant from the raw bundle text and
fails if the port drifts.

### 4.1 Fixed point (Q16.16)

The whole simulation is integer maths — that is what makes lockstep rollback
safe across machines.

```js
const SHIFT = 16, ONE = 1 << SHIFT;         // rRe, xe
const fx    = t => Math.round(t * ONE);     // Z    float -> fixed
const toF   = t => t / ONE;                 // Se   fixed -> float
const fmul  = (a, b) => Math.floor(a * b / ONE);          // pe
const fdiv  = (a, b) => b === 0 ? 0 : Math.floor(a * ONE / b); // Vn
function isqrt(t) {                          // ai
  if (t <= 0) return 0;
  let e = Math.floor(Math.sqrt(t));
  while (e > 0 && e * e > t) e--;
  while ((e + 1) * (e + 1) <= t) e++;
  return e;                                  // exact integer sqrt
}
```

Two details are load-bearing and easy to get wrong: rounding is **`Math.floor`,
not truncation** (they differ for negatives), and `isqrt` runs correction loops
so it is the exact floor even where `Math.sqrt` is off by one ULP.

The desync checksum is FNV-1a over the packed state words (`ja`).

### 4.2 Constants

| Port name | Bundle | Value | Meaning |
| --- | --- | --- | --- |
| `ARENA_START` | `fte` | `Z(11)` | starting disc radius |
| `ARENA_MIN` | `pte` | `Z(2.6)` | floor of the shrink |
| `SHRINK_DELAY` | `_kt` | `240` | live ticks before the disc starts shrinking (4 s) |
| `SHRINK_PER_TICK` | `xkt` | `Z(.0075)` | 0.45 units/second |
| `MAX_LIVE_TICKS` | `Skt` | `3600` | 60 s round cap |
| `PUCK_RADIUS` | `gOe` | `Z(.85)` | |
| `INV_MASS` | `r3e` | `xe` | unit mass |
| `RESTITUTION` | `Ekt` | `Z(.6)` | |
| `DRAG` | `i3e` | `Z(.948)` | per-tick velocity multiplier |
| `MOVE_ACCEL` | `a3e` | `Z(.022)` | walk acceleration |
| `TETHER_REST` | `Fq` | `Z(3.2)` | rope rest length |
| `TETHER_STIFF` | `Ckt` | `Z(.02)` | rope spring constant |
| `TETHER_MAX_IMP` | `o3e` | `Z(.09)` | **hard cap** on rope impulse per tick |
| `TETHER_TENSION_N` | `c3e` | `Z(3)` | tension normaliser for the HUD |
| `DASH_BASE` | `Akt` | `Z(.34)` | flat dash impulse |
| `DASH_SPEED_SCALE` | `l3e` | `Z(.55)` | fraction of current speed added |
| `DASH_BONUS_CAP` | `iC` | `Z(.36)` | cap on that bonus |
| `DASH_COOLDOWN` | `u3e` | `60` | 1 s |
| `BRACE_DRAG` | `kkt` | `Z(.7)` | drag while bracing |
| `BRACE_INV_MASS` | `Tkt` | `Z(.34)` | inverse mass while bracing |
| `PARRY_WINDOW` | `DR` | `12` | 200 ms active window |
| `PARRY_KNOCKBACK` | `d3e` | `Z(.72)` | impulse on a successful parry |
| `PARRY_FLASH` | `h3e` | `18` | cosmetic |
| `PARRY_WHIFF_CD` | `f3e` | `36` | 600 ms punish for a missed parry |
| `SPAWN_X` | `FR` | `Z(3)` | seats spawn at ∓3 |
| `COUNTDOWN_TICKS` | `p3e`,`Mkt` | `180` | 3 s |
| `SCORED_TICKS` | `Ikt` | `84` | 1.4 s |
| `ROUNDS_TO_WIN` | `m3e` | `3` | best of 5 |
| tick rate | `D3` | `60` Hz | `y3 = 1e3 / D3` |

### 4.3 Integration

`World` (bundle class `Er`) steps in a strict order — get it wrong and the
checksums diverge within a few frames:

```
for each body:  hit = false;  v *= drag;  p += v
for each pair:  de-penetrate (split by inverse mass), then normal impulse
                using min(restitution_a, restitution_b)
```

Two consequences the evaluator leans on heavily:

* Sustained acceleration `a` converges on `a · drag/(1−drag)` = **0.401 u/tick**
  top walking speed.
* Releasing at speed `v` carries the puck a further `v · drag/(1−drag)` =
  **v × 18.23** units. A puck can be doomed long before it reaches the rim —
  which is why the evaluator's primary feature is projected position, not
  current position.
* While bracing, `drag = 0.7`, so the coast factor collapses to **2.33**.

### 4.4 `stepLive` — the authoritative tick order

```js
stepLive(inputs) {
  // decrement dashCd, parryFlashCd, parryWhiffCd
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
```

Phases are `Countdown(0) → Live(1) → Scored(2) → Over(3)`. Pucks are frozen and
re-spawned during Countdown and Scored, so no input matters there.

### 4.5 The mechanics that decide games

**The tether.** The two pucks are roped together. Beyond `TETHER_REST = 3.2` the
rope pulls both inward with impulse `min(stretch × 0.02, 0.09)` per tick,
scaled by each puck's inverse mass.

**Bracing / anchoring.** Holding Brace sets `drag = 0.7` *and*
`invMass = 0.34`. A braced puck barely moves and barely accepts rope impulse —
so nearly all the rope tension goes into the *other* puck. Anchoring while the
opponent is radially outside you is the single strongest way to win a round, and
the Pro and Shark bots both know it (`USE_ANCHOR = 1`).

**Dash.** `impulse = DASH_BASE + min(speed × DASH_SPEED_SCALE, DASH_BONUS_CAP)`,
i.e. 0.34 to 0.70 units in one tick, on a 60-tick cooldown. At the coast factor
of 18.23 that is a **6–13 unit** displacement — more than half the disc. Dash is
the only way to cross the arena quickly and the main way to shove someone out.

**Parry.** Brace also opens a 12-tick parry window. A parry that lands applies
`PARRY_KNOCKBACK = 0.72` to the attacker; a parry that whiffs locks the parry
for 36 ticks. This makes Brace a genuine risk/reward choice rather than a free
turtle.

**Ring-out.** `checkKnockout` scores when `|p| > arenaRadius`. Simultaneous
ring-outs and the 60-second timeout resolve by whoever is closer to the centre.

### 4.6 Input encoding

An 18-bit word: 6 button bits plus two signed 6-bit aim fields.

```
bit  0 Up   1 Down   2 Left   3 Right   4 Dash   5 Brace
bits 6-11  aimX  (signed, -31..31)
bits 12-17 aimZ  (signed, -31..31)
```

Slingshot Sumo only consumes the button bits (via `dirOf`), but the aim payload
is part of the wire format and is reproduced faithfully. Note the screen-space
convention: **Up decreases z.**

### 4.7 The shipped opponents

`Nkt` is a reactive one-tick policy, parameterised by difficulty. Ported exactly:

| | Rookie | Pro | Shark | tutorial |
| --- | --- | --- | --- | --- |
| deadzone (`Iv`) | 0.5 | 0.4 | 0.28 | 0.5 |
| idle mask (`Bq`) | 3 | 0 | 0 | 3 |
| parry lookahead (`g3e`) | 0 | 0 | 9 | 0 |
| uses slingshot (`Pkt`) | no | no | **yes** | no |
| uses anchor (`Rkt`) | no | **yes** | **yes** | no |
| dash range (`Uq`) | 2.0 | 2.8 | 3.2 | 0 |

**This is the key strategic fact about the whole project:** Slingshot Sumo has
**zero RNG**. With a bit-exact engine *and* an exact port of the opponent,
practice mode stops being a game and becomes an exact single-agent planning
problem — the future is fully computable.

---

## 5. The solver

Rolling-horizon control (MPC): replan every 2 ticks, execute the first action,
throw the rest away.

### Stage 1 — beam search over macro-actions

A **progressively widening macro schedule** `[2,2,3,4,5,6,8,10,12,14,16,18]`
(100 ticks ≈ 1.7 s). Fine granularity near the root keeps parry and dash timing
tick-accurate where it matters; coarse granularity deeper buys horizon cheaply.
A uniform 2-tick schedule of the same depth would be `50` levels and utterly
unaffordable; a uniform 18-tick schedule could not time a 12-tick parry window.

Branching is 9 movement directions + Brace, plus dash — and **dash is pruned**
to directions within 45° of *toward the opponent*, *away from the opponent*, or
*toward the centre*. A dash is a 6–13 unit commitment, so nothing else can ever
be right. That cuts the branching factor from 18 to ~12 with no measurable loss.

### Stage 2 — long rollouts per root action

Beam leaves are grouped by their **root** action. Each distinct root gets a
320-tick (5.3 s) continuation using a strong policy for us and the exact
opponent model for them, then the leaf is re-evaluated:

```
value = 0.25 × beamValue + 0.75 × rolloutValue
```

This turns a 1.7 s search into a ~7 s judgement and — crucially — usually
reaches a **real ring-out**, so the value is an actual outcome rather than a
heuristic guess.

### Evaluation

Derived from the constants rather than tuned blind. The dominant term is
`riskOf()`: project position + full velocity coast + the rope's sustained
contribution against a *shrink-adjusted* radius, and take the worse of "where it
is now" and "where it is heading". Plus score (with a timing discount so we
prefer to win sooner and lose later), a hard "already doomed" cliff past the
rim, centring, **rope leverage** (bonus ×1.6 while braced — the anchoring
mechanic), dash/parry availability, and a mild speed penalty near the rim.

### Robustness online

Practice mode is exact. Against an unknown human it is not, so online play
switches to **minimax over an ensemble of models** (sticky / shark / rusher /
turtle) and picks the plan with the best worst case.

---

## 6. Results

Headless self-play vs the shipped bots (`npm run bench`). Openings are varied by
input delay 2–5 ticks, which shifts the whole trajectory — there is no RNG to
seed.

```
=== summary ===
rookie  seat0   4/4 (100%)  rounds 12-1
rookie  seat1   4/4 (100%)  rounds 12-0
pro     seat0   4/4 (100%)  rounds 12-0
pro     seat1   4/4 (100%)  rounds 12-1
shark   seat0   4/4 (100%)  rounds 12-2
shark   seat1   4/4 (100%)  rounds 12-3
OVERALL 24/24 (100.0%)  rounds 72-7
```

Engine verification (`npm run verify`): **142 checks, 0 failures** — fixed-point
primitives, every constant re-extracted from the raw bundle, structural
invariants of `stepLive`, serialisation round-trips, input codec, both reference
bot implementations agreeing over full matches, and golden trajectory checksums.

---

## 7. How it plays the real site

### Discovery, not hard-coded names

`src/browser/discover.js` finds the minified identifiers by anchoring on tokens
that cannot be renamed, then the driver appends a small epilogue to the game's
module (via Playwright `page.route`) republishing them on `globalThis`:

| Role | Anchor | Found in the live bundle |
| --- | --- | --- |
| game definition | `id:"slingshot"` | `RD` |
| simulation | `createSim: … => new X(` | `Lkt` |
| renderer | (sibling of the sim) | `zkt` |
| bot | (sibling of the sim) | `Nkt` |
| runner | `stepPractice(` | `uO` |
| input | `keyBits=0` | `LXe` |
| net session | `receiveRemoteInputs(` | `wx` |
| tick rate | `X=60, Y=1e3/X` | `D3` |

A new release with fresh names still works.

### The integration point

`Runner.prototype.readLocalInput` is patched. The original is called first (it
also updates the aim origin, and is the fallback if the bot is disabled), then
the bot returns its own word.

This is the right seam for three reasons: it is called **exactly once per
simulated tick**, so there is no synthetic-keyboard jitter; the value flows
through the game's own legitimate rollback and checksum path; and it gives us
the authoritative `sim` object to snapshot.

### Input-delay compensation

`session.advance(input)` assigns the word to frame `currentFrame + inputDelay`.
So the planner must plan from the **future** state: the bot rolls a shadow sim
from the current frame to `frame + delay` using its own already-committed inputs
plus the opponent model, and plans from there. Committed words are cached per
frame so a rollback that re-asks for frame *N* gets the same answer.

### Off the main thread

A full replan costs 12–35 ms. On the page's main thread that would blow the
16.6 ms frame budget and trip the netcode's own stall detector, so planning runs
in a **Web Worker** (bundled as a string and injected, so no extra network
fetch). The main thread only ever does a plan lookup, with a single
shark-policy reflex call (~1 µs) covering the first frames of a round before the
first plan lands.

### Live HUD

The injected overlay shows mode/seat, engine parity, phase, score, arena radius
and both distances, the current action, plan cost/nodes/lag, the share of frames
that were planned rather than reflexed, the current value, and the W–L record.

---

## 8. Driver usage

```
node src/driver/run.js [flags]

  --mode=practice|online   practice = warm-up vs the built-in bot (default)
  --level=rookie|pro|shark difficulty for practice mode
  --matches=N              how many matches to play
  --headed                 show the browser (Xvfb is fine)
  --keep-open              leave the browser running when finished
  --url=...                override the target URL
  --shot-dir=...           where to drop screenshots (default artifacts/)
```

Screenshots and a machine-readable `session.json` land in `artifacts/`.

Match start is confirmed from **observed simulation state**, not from a click
resolving: `startWarmup` waits for `telemetry.ticks` to advance, which is
frame-exact evidence out of the game loop, and falls back to DOM evidence only
if the bot failed to hook.

---

## 9. Benchmark & verification usage

```
node src/bench/verify.mjs [--bundle=path] [--update-golden]

node src/bench/selfplay.js [--level=rookie,pro,shark] [--seat=0,1] [--matches=4] [--quiet]
                           [--beam=40] [--rollout=480] [--schedule=2,2,3,4,5,6,8,10] [--replan=2]
                           [--tag=name]
```

`verify.mjs` skips the constant-extraction group if `recon/dump/` has not been
captured (the raw bundle is gitignored — it is a large third-party asset);
everything else runs standalone.

---

## 10. Notes and limitations

* The recon capture and the storage state are gitignored: the bundle is a large
  third-party asset and `storage.json` holds live session cookies.
* Online mode is implemented and delay-compensated, but the numbers above are
  from practice mode, where the opponent model is exact and results are
  reproducible.
* This is a technical study of a deterministic physics game. Using it against
  human opponents, and especially in staked matches, is against the spirit (and
  very likely the terms) of the site.
