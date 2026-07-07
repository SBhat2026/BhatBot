#!/usr/bin/env node
'use strict';
// PROCEDURAL MEMORY + SHARED READ-CACHE — the "learns to navigate, gets faster" machinery.
// procedural.js: records recurring step-series, recalls the known path for look-alike requests,
// gains confidence with repetition, and lets broken paths decay/expire.
// readcache.js: TTL read-cache that dedups fleet reads, rides in-flight prefetches, invalidates on
// write. Fully headless (temp file + fake clock). Run: node scripts/test-procedural.js (in verify).
const fs = require('fs'), os = require('os'), path = require('path');
const proc = require('../lib/procedural');
const { createReadCache } = require('../lib/readcache');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.error('❌ ' + m); } };

(async () => {
  // ── procedural: pure helpers ──────────────────────────────────────────────
  ok(proc.seqSig(['a', 'a', 'b', 'c']) === 'a→b→c', 'seqSig: collapses consecutive dups into an ordered path');
  ok(proc.jaccard(new Set(['x', 'y']), new Set(['x', 'z'])) === 1 / 3, 'jaccard: overlap ratio');
  ok(proc.keywords('Play a song on Spotify please').has('spotify') && !proc.keywords('the a to').size, 'keywords: content tokens, drops stopwords');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-proc-')), 'p.json');
  let t = 1_000_000_000_000; const now = () => t;

  // ── record: a single ≥2-step series seeds a routine; a lone step does not ──
  ok(proc.record(file, { trigger: 'open spotify and play jazz', steps: ['browser'], ok: true }, { now }) === null, 'record: a single tool is NOT a series (ignored)');
  const r1 = proc.record(file, { trigger: 'open spotify and play jazz', steps: ['browser', 'screen_parse', 'vision_click'], ok: true, firstRead: null }, { now });
  ok(r1 && r1.sig === 'browser→screen_parse→vision_click' && r1.uses === 1, 'record: ≥2-step series seeds a routine');

  // ── recall: not yet eligible (needs MIN_USES repetitions) ─────────────────
  ok(proc.recall(file, 'please open spotify and play some jazz', { now }).length === 0, 'recall: a once-seen routine is not suggested yet (needs repetition)');

  // ── repeat the SAME kind of task → clusters onto the routine, becomes eligible ──
  t += 60_000;
  const r2 = proc.record(file, { trigger: 'spotify play jazz music', steps: ['browser', 'screen_parse', 'vision_click'], ok: true, firstRead: { name: 'read_file', input: { path: '/x' } } }, { now });
  ok(r2 && r2.id === r1.id && r2.uses === 2, 'record: a look-alike request reinforces the SAME routine (uses→2)');
  const rec = proc.recall(file, 'open spotify, play jazz', { now });
  ok(rec.length === 1 && rec[0].sig === 'browser→screen_parse→vision_click', 'recall: now suggests the learned path for a look-alike request');
  ok(rec[0].confidence >= 0.7, 'recall: two clean wins → high confidence');
  ok(rec[0].firstRead && rec[0].firstRead.name === 'read_file', 'recall: carries the first-read prefetch hint');

  // ── an UNRELATED task does not match ──────────────────────────────────────
  ok(proc.recall(file, 'what is the weather in Tokyo', { now }).length === 0, 'recall: unrelated request → no false match');

  // ── decay: a routine that keeps FAILING expires and stops being suggested ──
  t += 60_000; proc.record(file, { trigger: 'delete old logs then rebuild', steps: ['run_shell', 'run_shell', 'write_file'], ok: true }, { now });
  t += 60_000; proc.record(file, { trigger: 'delete old logs rebuild again', steps: ['run_shell', 'run_shell', 'write_file'], ok: false }, { now });
  proc.reinforce(file, proc.load(file).routines.find((x) => x.sig.startsWith('run_shell')).id, false, { now });
  proc.reinforce(file, proc.load(file).routines.find((x) => x.sig.startsWith('run_shell')).id, false, { now });
  ok(proc.recall(file, 'delete old logs and rebuild', { now }).length === 0, 'decay: a routine that keeps failing is not suggested (self-pruning)');

  // ── format: compact hint block ────────────────────────────────────────────
  ok(/LEARNED ROUTINES/.test(proc.format(rec)) && /browser→screen_parse→vision_click/.test(proc.format(rec)), 'format: renders a usable hint block');
  ok(proc.format([]) === '', 'format: empty → empty');

  // ── read-cache: dedup + prefetch + invalidation ───────────────────────────
  {
    let ct = 5_000_000; const cnow = () => ct;
    const cache = createReadCache({ ttlMs: 1000, now: cnow });
    ok(cache.get('read_file', { path: '/a' }) === undefined, 'cache: cold miss');
    cache.set('read_file', { path: '/a' }, { success: true, content: 'hi' });
    ok(cache.get('read_file', { path: '/a' }).content === 'hi', 'cache: warm hit returns stored value');
    ok(cache.get('read_file', { path: '/a', extra: 1 }) === undefined, 'cache: different input → separate key');

    // prefetch: a concurrent getAsync rides the SAME in-flight request (dedup, one run)
    let runs = 0;
    cache.prefetch('fetch_url', { url: 'u' }, async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { success: true, body: 'X' }; });
    const [a, b] = await Promise.all([cache.getAsync('fetch_url', { url: 'u' }), cache.getAsync('fetch_url', { url: 'u' })]);
    ok(a.body === 'X' && b.body === 'X' && runs === 1, 'cache: prefetch warms it; concurrent readers dedup onto ONE run');

    // invalidation: a write to a path drops its cached read
    cache.set('read_file', { path: '/proj/f.js' }, { success: true, content: 'old' });
    cache.invalidatePath('/proj/f.js');
    ok(cache.get('read_file', { path: '/proj/f.js' }) === undefined, 'cache: write invalidates the stale cached read');

    // TTL: an expired entry is a miss
    cache.set('maps', { q: 'z' }, { ok: 1 });
    ct += 2000;
    ok(cache.get('maps', { q: 'z' }) === undefined, 'cache: entry past its TTL is a miss');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
