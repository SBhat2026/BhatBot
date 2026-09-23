'use strict';
// ── THE DAILY SPEND LEDGER ────────────────────────────────────────────────────────────────────────
// One file, ~/.bhatbot/costs.json, written by everything that spends money.
//
// WHY IT MOVED HERE. It lived inside main.js, so only the Electron process could reach it — and the
// headless worker, which runs unattended every thirty minutes and pays for embeddings and rationales,
// recorded its spend to a runtime-state SNAPSHOT instead. Two consequences, both bad:
//   • the daily total was wrong, silently, and always low;
//   • overBudget() could not see worker spend, so the one subsystem nobody is watching was also the
//     one the budget cap did not apply to.
// A budget that exempts the unattended process is not a budget.
//
// Append-only in effect and crash-tolerant by construction: a corrupt read starts a fresh ledger
// rather than throwing, because failing to RECORD a cost must never fail the work that incurred it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COSTS_PATH = path.join(os.homedir(), '.bhatbot', 'costs.json');
const KEEP_DAYS = 60;
const today = (d = new Date()) => d.toISOString().slice(0, 10);

function read() {
  try { return JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')) || {}; } catch { return {}; }
}

function write(led) {
  try {
    const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const k of Object.keys(led)) if (k < cut) delete led[k];
    fs.mkdirSync(path.dirname(COSTS_PATH), { recursive: true });
    fs.writeFileSync(COSTS_PATH, JSON.stringify(led));
  } catch {}
}

/**
 * record({ usd, model, source }) — fold a spend into today's total.
 * `source` distinguishes who spent it ('app', 'worker', a tool name), because "the worker is
 * expensive" and "the app is expensive" are different problems with different fixes, and the ledger
 * could not previously tell them apart at all.
 */
function record({ usd = 0, model = 'unknown', source = 'app' } = {}) {
  if (!usd || !isFinite(usd)) return null;
  const led = read();
  const d = today();
  const day = led[d] = led[d] || { usd: 0, calls: 0, byModel: {} };
  day.usd += usd;
  day.calls += 1;
  const mk = String(model || 'unknown').replace(/^claude-/, '');
  day.byModel[mk] = (day.byModel[mk] || 0) + usd;
  day.bySource = day.bySource || {};
  day.bySource[source] = (day.bySource[source] || 0) + usd;
  write(led);
  return day;
}

/** Today's total, in the same shape main.js has always returned. */
function todayTotal() {
  const led = read();
  return led[today()] || { usd: 0, calls: 0, byModel: {}, bySource: {} };
}

/**
 * recordTool(tool, usd) — a paid GENERATION tool (FLUX, TRELLIS, image-gen), folded into the same
 * daily total so the cost number is the whole picture rather than LLM tokens only. Kept separate
 * from record() because a tool spend has no model and no token count, and pretending otherwise
 * would put a nonsense entry in byModel.
 */
function recordTool(tool, usd) {
  if (!usd || !isFinite(usd)) return null;
  const led = read();
  const d = today();
  const day = led[d] = led[d] || { usd: 0, calls: 0, byModel: {} };
  day.usd += usd;
  day.toolUsd = (day.toolUsd || 0) + usd;
  day.byTool = day.byTool || {};
  day.byTool[tool] = (day.byTool[tool] || 0) + usd;
  write(led);
  return day;
}

module.exports = { record, recordTool, todayTotal, read, COSTS_PATH, KEEP_DAYS };
