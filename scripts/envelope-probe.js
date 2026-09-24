#!/usr/bin/env node
'use strict';
// ── DOES CLAUDE ACTUALLY FILL THE ENVELOPE? ───────────────────────────────────────────────────────
//
// The one part of the hour-long lane that has never run. The supervisor has been soaked for a full
// hour against a local model and every wall, every refusal and every durability property is covered
// by tests. What none of that touches is whether CLAUDE, given the worker's prompt and schema,
// reliably comes back with the structured envelope the supervisor routes on:
//
//     { status, summary, need: { kind: "tool" | "human" | "decompose" } }
//
// If it does not, a long run still fails safely — items come back as bare `partial`s, get retried
// twice and are marked blocked — but it never forges anything and never asks for help, which is most
// of what makes the lane worth having.
//
// THIS COSTS REAL MONEY, so it is not wired into `verify` and nothing runs it on its own. Three
// calls, a few hundred output tokens each: roughly two cents. It is the narrowest possible test of
// the untested part.
//
//   node scripts/envelope-probe.js          # three scenarios, ~$0.02
//   node scripts/envelope-probe.js --dry    # print exactly what it would send, spend nothing
//
// It uses lib/llm.js rather than main.js's caller, so it runs without Electron. That is a real
// difference and it is stated in the output: what is being proved is that the MODEL fills the
// schema, not that main.js's plumbing around it is correct (the structural contract between those
// two files is checked, for free, in scripts/test-tool-wiring.js).
const llm = require('../lib/llm');
// The SAME sealing main.js's calls go through, so this probe exercises the real shaping rather than a
// hand-written schema that happens to work. The first run of this file 400'd on all three calls
// because the API requires `additionalProperties: false` on every object and nothing was adding it —
// which would have made every envelope call in a real long run fail before reaching the model.
const { sealSchema } = require('../lib/reasoning');

const DRY = process.argv.includes('--dry');
const MODEL = process.argv.includes('--opus') ? 'claude-opus-5' : 'claude-sonnet-5';

// The worker's own instruction, close enough to main.js supervisedWorker that a failure here is a
// failure there. Kept short on purpose: if it only works with a page of coaxing, that is worth
// knowing too.
const SYSTEM = [
  'You are one of several agents working in parallel on one mission. You have just finished working an',
  'item of a plan, using whatever tools you had. Report on it as JSON ONLY.',
  '',
  'status: "done" only if the item is genuinely finished; "partial" if real progress was made but it is',
  'not; "blocked" if it cannot proceed.',
  '',
  'If it is blocked or partial BECAUSE something is missing, fill `need`:',
  '  kind="tool"      — no tool could do this. Give name, purpose, code (a JS function body taking',
  '                     `input`), and tests: [{ input, expected }].',
  '  kind="human"     — a fact or decision only Siddhant can supply. Give question and assumption.',
  '  kind="decompose" — this item is really several. Give items: [...].',
  'Otherwise omit `need`.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    need: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tool', 'human', 'decompose', 'none'] },
        question: { type: 'string' }, why: { type: 'string' }, assumption: { type: 'string' },
        name: { type: 'string' }, purpose: { type: 'string' }, code: { type: 'string' },
        // `tests` IS REQUIRED BY THE FORGE and was missing from this schema. Before every object was
        // sealed the model could sometimes smuggle it in anyway; with `additionalProperties: false`
        // it became structurally impossible, so every forge request arrived without the one thing
        // the forge refuses to build without. The envelope probe caught it on its first clean run.
        //
        // The two fields are typed DIFFERENTLY, and the reason is what the API's schema subset can
        // express. It rejects an empty node ("Empty schema"), a type union containing 'object', and
        // `additionalProperties: true` — all measured, not guessed. So there is no way to say "any
        // object" at all:
        //   • `input` is a JSON STRING, parsed by lib/toolforge. A tool's argument is usually an
        //     object and that is the only way to carry one through.
        //   • `expected` is a real value via anyOf, because the answer is almost always a scalar and
        //     passing it straight through avoids the one ambiguity a JSON string would add — whether
        //     "123" means the number or the string.
        tests: { type: 'array', items: { type: 'object', required: ['input', 'expected'], properties: {
          input: { type: 'string', description: 'JSON for the argument, e.g. {"n": 1994}' },
          expected: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }], description: 'the value the tool must return for that input' },
        } } },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind'],
    },
    newItems: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
};

// Each case is a situation with ONE right answer, stated in terms of what the supervisor would do
// with it. A case the model could satisfy two ways proves nothing about routing.
const CASES = [
  {
    name: 'needs a tool',
    want: 'tool',
    transcript: 'ITEM: Write the Roman numeral for 1994 into a file.\n'
      + 'WHAT HAPPENED: I have read_file, write_file, list_directory and web_search. None of them converts a number to Roman numerals, '
      + 'and I am not willing to write "MCMXCIV" from memory and call it verified. I can write a file once I have the string.',
  },
  {
    name: 'needs Siddhant',
    want: 'human',
    transcript: 'ITEM: Draft the reply to the department about the seminar slot and put it in the right calendar.\n'
      + 'WHAT HAPPENED: The draft is written. There are three calendars connected — personal, school and sb9699@princeton.edu — '
      + 'and nothing in the item or anywhere I can read says which one the seminar belongs in. Guessing wrong puts a department '
      + 'commitment on the wrong calendar.',
  },
  {
    name: 'plainly finished',
    want: null,
    transcript: 'ITEM: Count the lines in scripts/test-mission.js and write the number to work/out.txt.\n'
      + 'WHAT HAPPENED: count_lines returned 312. I called write_file with "312" and read it back; the file contains 312.',
  },
];

function parseLoose(s) {
  const t = String(s || '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

(async () => {
  if (DRY) {
    console.log('── what it would send ──────────────────────────────────────────────\n');
    console.log('SYSTEM:\n' + SYSTEM + '\n');
    for (const c of CASES) console.log(`CASE "${c.name}" (expects need.kind=${c.want || 'none'}):\n${c.transcript}\n`);
    console.log(`model: ${MODEL} · ${CASES.length} calls · roughly two cents · nothing was sent.`);
    process.exit(0);
  }
  if (!llm.hasKey('anthropic')) {
    console.error('✗ no Anthropic key reachable (env, Keychain, or a non-vaulted config value).');
    console.error('  A vaulted CRED_REF only decrypts inside Electron, so run this from a shell with ANTHROPIC_API_KEY set.');
    process.exit(2);
  }

  console.log(`── envelope probe ── ${MODEL} ── ${CASES.length} real calls, roughly two cents\n`);
  const fails = [];
  let inTok = 0, outTok = 0;

  for (const c of CASES) {
    process.stdout.write(`  ${c.name.padEnd(18)}`);
    let r;
    try {
      r = await llm.anthropicRequest({
        model: MODEL, max_tokens: 900, system: SYSTEM,
        messages: [{ role: 'user', content: c.transcript + '\n\nReport your envelope now. JSON only.' }],
        output_config: { format: { type: 'json_schema', schema: sealSchema(SCHEMA) } },
      }, { retries: 2 });
    } catch (e) {
      console.log('✗ call failed: ' + String(e && e.message || e).slice(0, 120));
      fails.push(`${c.name}: the call itself failed`);
      continue;
    }
    const u = r.usage || {};
    inTok += u.input_tokens || 0; outTok += u.output_tokens || 0;
    const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = parseLoose(text);

    if (!j) { console.log('✗ did not return parseable JSON: ' + text.slice(0, 90)); fails.push(`${c.name}: unparseable`); continue; }
    if (!j.status || !j.summary) { console.log(`✗ missing status/summary: ${JSON.stringify(j).slice(0, 90)}`); fails.push(`${c.name}: incomplete envelope`); continue; }

    const kind = j.need && j.need.kind && j.need.kind !== 'none' ? j.need.kind : null;
    const okKind = kind === c.want;
    console.log(`${okKind ? '✓' : '✗'} status=${j.status} need=${kind || 'none'}${okKind ? '' : ` (wanted ${c.want || 'none'})`}`);
    if (!okKind) { fails.push(`${c.name}: routed to ${kind || 'none'}, wanted ${c.want || 'none'}`); continue; }

    // The kind alone is not enough — the supervisor needs the FIELDS, and a need without them is an
    // item that blocks for a reason nobody can act on.
    if (kind === 'tool') {
      const t = j.need;
      const missing = ['name', 'purpose', 'code'].filter((k) => !String(t[k] || '').trim());
      const tests = Array.isArray(t.tests) ? t.tests : [];
      if (missing.length) fails.push(`${c.name}: tool need is missing ${missing.join(', ')}`);
      if (!tests.length) fails.push(`${c.name}: tool need declared no tests — the forge refuses that`);
      else {
        // Run it through the real forge, which is the only thing that settles whether it was usable.
        const { createForge } = require('../lib/toolforge');
        const os = require('os'), fs = require('fs'), path = require('path');
        const forge = createForge({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), sandbox: require('../lib/sandbox') });
        const f = await forge.forge({ name: t.name, purpose: t.purpose, code: t.code, tests, allow: t.allow });
        console.log(`    → the real forge ${f.ok ? 'BUILT it' : 'refused it: ' + (f.errors || []).join('; ').slice(0, 140)}`);
        if (!f.ok) fails.push(`${c.name}: the forge refused what Claude proposed (${f.stage})`);
      }
    }
    if (kind === 'human') {
      if (!String(j.need.question || '').trim()) fails.push(`${c.name}: human need with no question`);
      if (!String(j.need.assumption || '').trim()) {
        fails.push(`${c.name}: human need with NO assumption — that item stalls until the idle timeout instead of proceeding`);
      } else {
        console.log(`    → asks: "${String(j.need.question).slice(0, 80)}"  assuming: "${String(j.need.assumption).slice(0, 50)}"`);
      }
    }
  }

  const usd = (inTok / 1e6) * 3 + (outTok / 1e6) * 15;
  console.log(`\n  ${inTok} in / ${outTok} out ≈ $${usd.toFixed(4)}`);
  console.log('  (lib/llm.js, not main.js — this proves the MODEL fills the schema. The contract between');
  console.log('   main.js and the supervisor is checked for free in scripts/test-tool-wiring.js.)\n');

  if (fails.length) {
    console.log(`✗ the envelope is not reliable yet — ${fails.length} problem(s):`);
    for (const f of fails) console.log('    ✗ ' + f);
    console.log('\n  A long run would still fail SAFELY: items come back as bare partials, get retried twice and');
    console.log('  are marked blocked. It just would not forge anything or ask for help.');
    process.exit(1);
  }
  console.log('✓ Claude fills the envelope: it asks for a tool when no tool fits, builds one the forge accepts,');
  console.log('  asks Siddhant when only he knows, always with a fallback, and says nothing is wrong when nothing is.');
})().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
