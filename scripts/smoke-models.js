#!/usr/bin/env node
'use strict';
// ── SMOKE TEST FOR THE 5.5 LINEUP ────────────────────────────────────────────────────────────────
//
// lib/reasoning.js shapes requests for Haiku 5.5 / Sonnet 5.5 / Opus 5.5 from the published migration
// notes, and config.modelGeneration = '5.5' would route real traffic to them. This is the paid check
// that has to pass before that switch is thrown. Every request is built by the SAME code the app
// uses (shapeRequest + the model ceiling), so a pass here is a pass for the shapes BhatBot sends —
// not for a hand-written body that happens to work.
//
// What it answers:
//   1. Does each model accept BhatBot's request shape and return text? (a 400 here is the whole point)
//   2. Does tool use come back as a tool_use block with auto tool_choice?
//   3. Do the two "thinking off" translations work (Sonnet 5.5 between_tools, Opus 5.5 → low)?
//   4. Does prompt caching actually hit on a repeated prefix? (usage.cache_read_input_tokens > 0)
//   5. TIME TO FIRST WORD — the number that decides voice. Siddhant's standing rule: never make a
//      response slower without asking. Haiku 5.5 is only a voice candidate if it is at least as fast
//      as what voice uses today.
//
// Spend is tracked against --cap (default $0.60) and the run stops before crossing it.
//   npm run smoke:models            (runs under Electron so the vaulted API key can be read)
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CAP = Number(arg('cap', 0.6));
const RUNS = Number(arg('runs', 3));

const reasoning = require(path.join(ROOT, 'lib', 'reasoning'));
const pricing = require(path.join(ROOT, 'lib', 'pricing'));
const modelpolicy = require(path.join(ROOT, 'lib', 'modelpolicy'));

let spent = 0;
const rows = [];
const log = (s) => console.log(s);

async function key() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const creds = require(path.join(ROOT, 'lib', 'credentials'));
  const c = creds.resolveRefs(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8')));
  if (!c.apiKey || /^CRED_REF/.test(c.apiKey)) throw new Error('API key unresolved — run under Electron (npm run smoke:models)');
  return c.apiKey;
}

/** Build the body exactly as the app would: the model ceiling, then lib/reasoning.js's shaping. */
function shaped(body, opts = {}) {
  const pol = modelpolicy.enforce(body.model, { opusApproved: true, fallback: 'claude-sonnet-5', ceiling: 'claude-opus-5-5' });
  const s = reasoning.shapeRequest({ ...body, model: pol.model }, opts);
  return { body: s.body, betas: s.betas };
}

/** One streamed request. Measures time to the first TEXT token, which is what a voice turn waits on. */
async function stream(apiKey, body, betas) {
  if (spent >= CAP) throw new Error(`spend cap $${CAP} reached`);
  const t0 = performance.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(betas && betas.length ? { 'anthropic-beta': betas.join(',') } : {}) },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) { const t = await res.text(); return { ok: false, status: res.status, error: t.slice(0, 400) }; }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', firstText = null, firstAny = null, text = '', stop = null, usage = {}, blocks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === 'message_start') usage = { ...usage, ...(ev.message && ev.message.usage) };
      if (ev.type === 'content_block_start') { blocks.push(ev.content_block.type); if (firstAny === null) firstAny = performance.now() - t0; }
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') { if (firstText === null) firstText = performance.now() - t0; text += ev.delta.text; }
      if (ev.type === 'message_delta') { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; if (ev.usage) usage = { ...usage, ...ev.usage }; }
    }
  }
  const total = performance.now() - t0;
  const usd = pricing.usd(body.model, usage);
  spent += usd;
  return { ok: true, firstText, firstAny, total, text, stop, usage, blocks, usd };
}

function record(test, model, r, extra = {}) {
  const row = { test, model, ok: !!r.ok, ...extra, status: r.status, stop: r.stop, firstTextMs: r.firstText && Math.round(r.firstText), totalMs: r.total && Math.round(r.total),
    inTok: r.usage && r.usage.input_tokens, outTok: r.usage && r.usage.output_tokens, cacheRead: r.usage && r.usage.cache_read_input_tokens, cacheWrite: r.usage && r.usage.cache_creation_input_tokens,
    blocks: r.blocks && r.blocks.join('+'), usd: r.usd, error: r.error };
  rows.push(row);
  return row;
}

const median = (a) => { const s = [...a].filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function main() {
  const k = await key();
  const M = { haiku: 'claude-haiku-5-5', sonnet55: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', sonnet5: 'claude-sonnet-5' };
  log(`smoke: cap $${CAP} · ${RUNS} voice runs per model\n`);

  // ── 1. each model accepts BhatBot's shape and answers ──
  for (const m of [M.haiku, M.sonnet55, M.opus]) {
    const { body, betas } = shaped({ model: m, max_tokens: 400, messages: [{ role: 'user', content: 'Reply with exactly: ready' }] }, {});
    const r = await stream(k, body, betas);
    const row = record('accepts-shape', m, r, { effort: body.output_config && body.output_config.effort, thinking: body.thinking && body.thinking.type });
    log(`${r.ok && /ready/i.test(r.text) ? '✅' : '❌'} ${m.padEnd(18)} accepts the shaped request (effort ${row.effort}, thinking ${row.thinking}) → "${(r.text || r.error || '').trim().slice(0, 60)}" · blocks ${row.blocks || '—'}`);
  }

  // ── 2. tool use with auto tool_choice ──
  const tools = [{ name: 'get_weather', description: 'Current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }, strict: true }];
  for (const m of [M.haiku, M.sonnet55]) {
    const { body, betas } = shaped({ model: m, max_tokens: 1024, tools, messages: [{ role: 'user', content: 'What is the weather in Princeton right now? Use the tool.' }] }, {});
    const r = await stream(k, body, betas);
    record('tool-use', m, r);
    log(`${r.ok && r.stop === 'tool_use' ? '✅' : '❌'} ${m.padEnd(18)} calls a tool under auto tool_choice (stop ${r.stop || r.status}) · blocks ${(r.blocks || []).join('+') || (r.error || '').slice(0, 120)}`);
  }

  // ── 3. the "thinking off" translations ──
  {
    const { body, betas } = shaped({ model: M.sonnet55, max_tokens: 400, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Say: off' }] }, {});
    const r = await stream(k, body, betas);
    record('disabled→between_tools', M.sonnet55, r, { sent: JSON.stringify(body.thinking) });
    log(`${r.ok ? '✅' : '❌'} Sonnet 5.5 "disabled" is sent as ${JSON.stringify(body.thinking)} and accepted${r.ok ? '' : ': ' + r.error}`);
    const o = shaped({ model: M.opus, max_tokens: 400, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Say: off' }] }, {});
    const r2 = await stream(k, o.body, o.betas);
    record('disabled→low', M.opus, r2, { sent: JSON.stringify(o.body.thinking), effort: o.body.output_config && o.body.output_config.effort });
    log(`${r2.ok ? '✅' : '❌'} Opus 5.5 "disabled" is sent as ${JSON.stringify(o.body.thinking)} at effort ${o.body.output_config && o.body.output_config.effort} and accepted${r2.ok ? '' : ': ' + r2.error}`);
  }

  // ── 4. prompt caching hits on a repeated prefix ──
  {
    // ~3,000 tokens of stable system prompt, over every model's minimum cacheable length.
    const big = 'You are BhatBot, a personal assistant. ' + Array.from({ length: 260 }, (_, i) => `Rule ${i + 1}: keep answers short, accurate and in plain English unless detail is asked for.`).join(' ');
    for (const m of [M.haiku, M.sonnet55]) {
      const mk = (q) => shaped({ model: m, max_tokens: 300, system: [{ type: 'text', text: big, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: q }] }, {});
      const a = mk('Say: one'); const r1 = await stream(k, a.body, a.betas);
      const b = mk('Say: two'); const r2 = await stream(k, b.body, b.betas);
      record('cache-write', m, r1); record('cache-read', m, r2);
      const hit = r2.ok && (r2.usage.cache_read_input_tokens || 0) > 0;
      log(`${hit ? '✅' : '❌'} ${m.padEnd(18)} prompt cache: 1st wrote ${r1.usage && r1.usage.cache_creation_input_tokens || 0} tok, 2nd READ ${r2.usage && r2.usage.cache_read_input_tokens || 0} tok`);
    }
  }

  // ── 5. time to first word — the voice decision ──
  // The same short conversational question, shaped the way a voice turn is shaped today
  // (depth 'conversational'), on what voice uses now (Sonnet 5) and on the two candidates.
  log('');
  const voiceQ = 'Is it a good evening for a walk if it is 45 degrees and clear? One sentence.';
  const voice = {};
  for (const m of [M.sonnet5, M.haiku, M.sonnet55]) {
    voice[m] = [];
    for (let i = 0; i < RUNS; i++) {
      const { body, betas } = shaped({ model: m, max_tokens: 300, messages: [{ role: 'user', content: voiceQ + (i ? ` (${i})` : '') }] }, { depth: 'conversational' });
      const r = await stream(k, body, betas);
      record('voice-ttft', m, r, { effort: body.output_config && body.output_config.effort, run: i });
      voice[m].push(r.firstText);
    }
    // And at low effort, the lever that buys speed on the 5.5 models.
    if (m !== M.sonnet5) {
      voice[m + '@low'] = [];
      for (let i = 0; i < RUNS; i++) {
        const { body, betas } = shaped({ model: m, max_tokens: 300, messages: [{ role: 'user', content: voiceQ + ` [${i}]` }] }, { effort: 'low' });
        const r = await stream(k, body, betas);
        record('voice-ttft-low', m, r, { effort: 'low', run: i });
        voice[m + '@low'].push(r.firstText);
      }
    }
  }
  log('time to first word (median of ' + RUNS + '):');
  const base = median(voice[M.sonnet5]);
  for (const [m, xs] of Object.entries(voice)) {
    const md = median(xs);
    log(`   ${m.padEnd(22)} ${md == null ? '—' : Math.round(md) + ' ms'}${m === M.sonnet5 ? '   ← what voice uses today' : base && md ? `   (${md <= base ? 'faster' : 'slower'} by ${Math.abs(Math.round(md - base))} ms)` : ''}`);
  }

  log(`\nspent $${spent.toFixed(4)} of a $${CAP} cap`);
  const out = path.join(os.homedir(), '.bhatbot', 'bench', `smoke-models-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), spentUsd: spent, voice, rows }, null, 1)); log('record: ' + out); } catch {}
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) log(`\n${failed.length} request(s) were rejected — see the record for the API's own error text.`);
  return failed.length ? 1 : 0;
}

if (process.versions.electron) {
  const { app } = require('electron');
  try { app.setName('bhatbot'); } catch {}
  if (app.dock) app.dock.hide();
  app.whenReady().then(main).then((code) => app.exit(code)).catch((e) => { console.error('✗ ' + e.message); app.exit(1); });
} else {
  main().then((code) => process.exit(code)).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
}
