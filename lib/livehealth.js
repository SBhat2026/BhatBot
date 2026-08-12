'use strict';
// ── LIVE HEALTH LANE (Pass C1) ────────────────────────────────────────────────────────────────────
// The deep self-heal lane (lib/selfheal.js) is structurally unable to fire when it's most needed.
// Its policy is `enabled:false, maxPerDay:3, minFailures:3, cooldownMin:45`, and probe() additionally
// requires `idle:true` plus a clean git tree. During an hours-long autonomous run the agent is BY
// DEFINITION never idle — so the repair loop can essentially never engage while you are actually
// relying on it. It is a between-sessions repair loop wearing the label of a self-healing system.
//
// This module is the other lane. It runs DURING a turn, and its scope is deliberately the opposite:
//
//                     deep lane (selfheal.js)          live lane (this file)
//   when              idle only                        mid-turn, under load
//   fixes             BhatBot's own source              the world around BhatBot
//   writes            git commits, code edits           nothing but caches/sessions
//   gate              verify-or-revert                  bounded attempts + backoff
//   cost              minutes                           seconds
//
// WHY THIS SPLIT IS THE RIGHT ONE. Almost nothing that kills a long run is a bug in this repo. It is
// an expired OAuth token, a Playwright page that stopped responding, a 429 with a Retry-After, an
// Ollama model that got evicted under memory pressure, a dropped cloud-bridge socket. Those need a
// fast in-run fixer, not a git-committing one — and crucially they need it WITHOUT the idle gate,
// because they only ever happen while busy.
//
// HARD RAILS (these are what keep a mid-turn healer from becoming a liability):
//   • NO git operations. No code edits. The frozen zone is not merely unwritten — it is unreachable,
//     because no remedy in this module writes source at all.
//   • BOUNDED. Each failure class gets `maxAttempts` per turn (default 2) and a global `maxPerTurn`
//     (default 6). Exhaustion is a real outcome that escalates, not a retry-forever.
//   • BACKOFF IS PART OF THE REMEDY, not a wrapper around it. Rate limits are healed by *waiting*,
//     and the wait must be honored (Retry-After) rather than guessed.
//   • IDEMPOTENT REMEDIES. Every remedy must be safe to run twice; the caller may re-enter after a
//     partial failure.
//   • NEVER SWALLOWS. A remedy that "succeeds" but leaves the tool still broken must report
//     `recovered:false` so the loop escalates rather than looping on a false green.
//
// CLASSIFICATION IS DETERMINISTIC. No model call — this runs on the hot path of a failing turn,
// which is exactly when you cannot afford a second thing to be slow or flaky.
//
// Pure + DI: every remedy is injected by main.js. No Electron, no network here. See
// scripts/test-livehealth.js.

const CLASSES = ['auth', 'browser', 'ratelimit', 'model', 'network', 'bridge', 'disk', 'unknown'];

const DEFAULTS = {
  maxAttempts: 2,        // per failure class, per turn
  maxPerTurn: 6,         // across all classes, per turn
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
};

// ── classification ───────────────────────────────────────────────────────────────────────────────
// Ordered most-specific first. Rate limit is checked before auth because a 429 body frequently
// mentions "key"/"credentials", and treating it as auth would trigger a pointless re-auth storm
// against an endpoint that is already asking us to slow down.
const RULES = [
  { cls: 'ratelimit', re: /\b429\b|rate[ _-]?limit|too many requests|quota exceeded|overloaded_error|retry-after|slow down/i },
  { cls: 'auth', re: /\b401\b|\b403\b|unauthor|invalid[_ ]api[_ ]key|token (?:has )?expired|expired[_ ]token|invalid_grant|credentials? (?:are )?(?:invalid|missing)|not authenticated|permission denied/i },
  { cls: 'browser', re: /target (?:page|closed|crashed)|browser (?:has been )?(?:closed|disconnected)|execution context was destroyed|page\.(?:goto|click|evaluate).*timeout|playwright|puppeteer|chromium.*(?:crash|exit)|detached frame/i },
  // Ollama phrases this as `model "llama3" not found, try pulling it first` — the model NAME sits
  // between the two words, so a bare /model not found/ misses every real occurrence.
  { cls: 'model', re: /model\b[^.\n]{0,60}?\b(?:not found|is not loaded|unavailable|not loaded)|ollama|failed to load model|no such model|context (?:length|window) exceeded|model_not_found|try pulling it/i },
  { cls: 'bridge', re: /websocket|socket hang ?up|bridge (?:disconnected|closed)|ws (?:closed|error)|connection closed before/i },
  { cls: 'network', re: /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|network (?:error|timeout)|fetch failed|getaddrinfo/i },
  { cls: 'disk', re: /ENOSPC|no space left|EDQUOT|disk (?:is )?full|EMFILE|too many open files/i },
];

function classify(err, ctx = {}) {
  const msg = String((err && (err.message || err.error || err)) || '');
  const status = Number(err && (err.status || err.statusCode)) || 0;
  const hay = `${status ? status + ' ' : ''}${msg} ${ctx.tool || ''}`;
  if (status === 429) return 'ratelimit';
  if (status === 401 || status === 403) return 'auth';
  for (const r of RULES) if (r.re.test(hay)) return r.cls;
  return 'unknown';
}

// Retry-After may be seconds or an HTTP-date. Honor both; cap so a hostile/garbled header can't
// park a turn for an hour.
function retryAfterMs(err, cap) {
  const h = err && (err.retryAfter ?? (err.headers && (err.headers['retry-after'] || err.headers['Retry-After'])));
  if (h == null) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, cap);
  const t = Date.parse(h);
  if (!Number.isNaN(t)) return Math.min(Math.max(0, t - Date.now()), cap);
  return null;
}

function createLiveHealth({
  remedies = {},                 // { auth, browser, model, network, bridge, disk } → async () => bool
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
  record = () => {},             // (entry) → void — rstate.event / audit sink
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let attempts = new Map();      // class -> count, this turn
  let total = 0;
  let ledger = [];               // this turn's attempts, for the escalation report

  function beginTurn() { attempts = new Map(); total = 0; ledger = []; }

  function budgetLeft(cls) {
    if (total >= cfg.maxPerTurn) return false;
    return (attempts.get(cls) || 0) < cfg.maxAttempts;
  }

  // Exponential backoff on the class's own attempt count, so a class that keeps failing waits
  // progressively longer while unrelated classes stay responsive.
  function backoffFor(cls) {
    const n = attempts.get(cls) || 0;
    return Math.min(cfg.baseBackoffMs * Math.pow(2, n), cfg.maxBackoffMs);
  }

  // heal — attempt in-run recovery for one failure. Returns:
  //   { recovered:true,  cls, action, ms }                       → caller retries the tool
  //   { recovered:false, cls, reason:'budget'|'no-remedy'|'failed', ... } → caller escalates
  // Never throws: a healer that can itself sink the turn is a net negative.
  async function heal(err, ctx = {}) {
    const cls = classify(err, ctx);
    const t0 = now();
    if (!budgetLeft(cls)) {
      const out = { recovered: false, cls, reason: 'budget', attempts: attempts.get(cls) || 0, total };
      ledger.push({ ...out, ts: t0, tool: ctx.tool || null });
      return out;
    }
    attempts.set(cls, (attempts.get(cls) || 0) + 1);
    total++;

    let action = null, ok = false, waited = 0;
    try {
      if (cls === 'ratelimit') {
        // The remedy IS the wait. Honor Retry-After when the server gave one; it is authoritative
        // and guessing shorter just burns the next attempt too.
        waited = retryAfterMs(err, cfg.maxBackoffMs) ?? backoffFor(cls);
        action = `backoff ${Math.round(waited / 1000)}s`;
        await sleep(waited);
        ok = true;
      } else {
        const fn = remedies[cls];
        if (!fn) {
          const out = { recovered: false, cls, reason: 'no-remedy', tool: ctx.tool || null };
          ledger.push({ ...out, ts: t0 });
          log(`[livehealth] ${cls}: no remedy wired`);
          return out;
        }
        action = cls;
        // A transient class gets a short settle before the remedy — reconnecting into the same
        // half-open socket immediately usually just reproduces the failure.
        if (cls === 'network' || cls === 'bridge') { waited = backoffFor(cls); await sleep(waited); }
        ok = (await fn({ err, ctx })) !== false;
      }
    } catch (e) {
      ok = false;
      log(`[livehealth] ${cls} remedy threw: ${e && e.message}`);
    }

    const entry = {
      ts: t0, ms: now() - t0, cls, action, waited,
      recovered: ok, tool: ctx.tool || null,
      error: String((err && (err.message || err)) || '').slice(0, 200),
      attempt: attempts.get(cls), total,
    };
    ledger.push(entry);
    try { record(entry); } catch {}
    log(`[livehealth] ${cls} → ${ok ? 'recovered' : 'failed'} (${action}, attempt ${entry.attempt}/${cfg.maxAttempts})`);
    return ok
      ? { recovered: true, cls, action, ms: entry.ms, waited }
      : { recovered: false, cls, reason: 'failed', action, ms: entry.ms };
  }

  // blockerReport — C3. When the lane is exhausted, the turn should PARK with a concrete account of
  // what was tried and what a human would need to supply, not fail with a stack trace. This is the
  // text that goes into the mission park note and the notification.
  function blockerReport({ goal = '', step = null } = {}) {
    if (!ledger.length) return '';
    const byCls = new Map();
    for (const e of ledger) {
      const g = byCls.get(e.cls) || { cls: e.cls, tries: 0, lastError: '', recovered: false };
      g.tries++; g.lastError = e.error || g.lastError; g.recovered = g.recovered || !!e.recovered;
      byCls.set(e.cls, g);
    }
    const NEEDS = {
      auth: 'a fresh credential — re-run the relevant auth flow (e.g. `npm run google:auth`) or add the key to Keychain',
      browser: 'a working browser session — the automated Chromium could not be revived',
      model: 'the local model to be available (check `ollama list` / free memory)',
      network: 'network connectivity to the failing host',
      bridge: 'the cloud bridge to be reachable',
      disk: 'free disk space',
      ratelimit: 'the rate window to drain — this one resolves on its own with time',
      unknown: 'a look from you — the failure did not match a known class',
    };
    const lines = ['I could not recover this on my own. Here is exactly what I tried:'];
    for (const g of byCls.values()) {
      lines.push(`• ${g.cls} — ${g.tries} attempt(s)${g.recovered ? ' (recovered at least once, then failed again)' : ''}: ${g.lastError || 'no message'}`);
    }
    const worst = [...byCls.values()].filter((g) => !g.recovered);
    if (worst.length) {
      lines.push('', 'What I need:');
      for (const g of worst) lines.push(`• ${NEEDS[g.cls] || NEEDS.unknown}`);
    }
    if (step != null) lines.push('', `Parked at step ${step}. The work so far is saved — say "continue" and I'll resume from here.`);
    if (goal) lines.push(`Goal: ${String(goal).slice(0, 300)}`);
    return lines.join('\n');
  }

  function stats() {
    return { total, byClass: Object.fromEntries(attempts), ledger: ledger.slice(), exhausted: total >= cfg.maxPerTurn };
  }

  return { beginTurn, heal, classify: (e, c) => classify(e, c), blockerReport, stats, budgetLeft, CLASSES };
}

module.exports = { createLiveHealth, classify, retryAfterMs, CLASSES, DEFAULTS };
