/**
 * Locates the game's internals inside its minified production bundle.
 *
 * The bundle is minified with fresh identifiers on every release, so nothing
 * here hard-codes a name like `Lkt`. Instead we anchor on strings and syntax
 * that the *build* cannot rename — the literal `id:"slingshot"`, the method
 * name `stepPractice`, the field `keyBits`, and so on — and read the minified
 * identifiers out of the surrounding code.
 *
 * The result is a small epilogue that we append to the bundle at request time
 * (via Playwright route interception). Because the bundle is a single top-level
 * ES module, those identifiers are in scope for the epilogue, which simply
 * re-publishes them on `globalThis`.
 */

/** Walk backwards from `idx` to the `class X{` / `class X extends` that encloses it. */
function enclosingClassName(src, idx) {
  const re = /class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[\w$.]+\s*)?\{/g;
  let best = null;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > idx) break;
    best = m[1];
  }
  return best;
}

/** Find `NAME = { id:"slingshot", ... }` and the sim class it constructs. */
function findSlingshot(src) {
  const defRe = /([A-Za-z_$][\w$]*)\s*=\s*\{\s*id:\s*"slingshot"/g;
  const m = defRe.exec(src);
  if (!m) return {};
  const gameDef = m[1];
  // createSim: t => new Lkt(t)
  const tail = src.slice(m.index, m.index + 800);
  const simM = /createSim:\s*[\w$]+\s*=>\s*new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(tail);
  const viewM = /createView:\s*[\w$]+\s*=>\s*new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(tail);
  const botM = /bot:\s*\([^)]*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/.exec(tail);
  return {
    gameDef,
    simClass: simM ? simM[1] : null,
    viewClass: viewM ? viewM[1] : null,
    botFn: botM ? botM[1] : null,
  };
}

/** The match runner is the only class with a `stepPractice` method. */
function findRunner(src) {
  const idx = src.indexOf('stepPractice(');
  if (idx < 0) return null;
  return enclosingClassName(src, idx);
}

/** The input source is the only class with a `keyBits` field. */
function findInputSource(src) {
  const idx = src.indexOf('keyBits=0');
  const at = idx < 0 ? src.indexOf('keyBits') : idx;
  if (at < 0) return null;
  return enclosingClassName(src, at);
}

/** Rollback session: the only class with `receiveRemoteInputs`. */
function findSession(src) {
  const idx = src.indexOf('receiveRemoteInputs(');
  if (idx < 0) return null;
  return enclosingClassName(src, idx);
}

/** Tick rate constant: `NAME=60,OTHER=1e3/NAME`. */
function findTickRate(src) {
  const m = /([A-Za-z_$][\w$]*)\s*=\s*60\s*,\s*[A-Za-z_$][\w$]*\s*=\s*1e3\s*\/\s*\1/.exec(src);
  return m ? m[1] : null;
}

export function discover(src) {
  const sling = findSlingshot(src);
  return {
    ...sling,
    runnerClass: findRunner(src),
    inputClass: findInputSource(src),
    sessionClass: findSession(src),
    tickRateConst: findTickRate(src),
  };
}

/**
 * Build the epilogue that republishes the discovered internals.
 * Everything is wrapped in try/catch per-field so a single failed lookup can
 * never break the page.
 */
export function buildEpilogue(found) {
  const entries = [
    ['SlingshotSim', found.simClass],
    ['SlingshotView', found.viewClass],
    ['gameDef', found.gameDef],
    ['referenceBot', found.botFn],
    ['Runner', found.runnerClass],
    ['InputSource', found.inputClass],
    ['Session', found.sessionClass],
    ['TICK_HZ', found.tickRateConst],
  ].filter(([, v]) => !!v);

  const body = entries
    .map(([k, v]) => `  try { o.${k} = ${v}; } catch (e) {}`)
    .join('\n');

  return `
;(function(){
  var o = {};
${body}
  o.__discovered = ${JSON.stringify(
    Object.fromEntries(Object.entries(found).filter(([, v]) => !!v))
  )};
  try {
    globalThis.__QUIP_INTERNALS__ = o;
    globalThis.dispatchEvent(new Event('quip-internals-ready'));
  } catch (e) {}
})();
`;
}

export default discover;
