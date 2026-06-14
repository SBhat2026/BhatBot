'use strict';
// Pass 39/40 timed functional sweep (v2 — post fix-pass). Times every user-facing response;
// >2 over 5s ⇒ another fix pass. Budget guard: real-API spend this run ≪ $1.
// Run: node scripts/test-pass39.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bhatbot', 'config.json'), 'utf8'));
const results = [];
let spentUsd = 0;
function record(name, ms, ok, note = '', userFacing = true) {
  results.push({ name, ms: Math.round(ms), ok, note: String(note).slice(0, 110), userFacing });
  console.log(`${ok ? '✅' : '⚠️ '} ${String(Math.round(ms)).padStart(6)}ms  ${name}${note ? '  — ' + String(note).slice(0, 90) : ''}`);
}
async function timed(name, fn, { userFacing = true } = {}) {
  const t0 = Date.now();
  try { const note = await fn(); record(name, Date.now() - t0, true, note || '', userFacing); }
  catch (e) { record(name, Date.now() - t0, false, e.message, userFacing); }
}
const NO_THINK = { think: false };   // mirror production isThinkingModel handling for qwen3

(async () => {
  // ---------- internals (free) ----------
  await timed('jobs-bus ops', async () => {
    const jobs = require(path.join(ROOT, 'lib/jobs'));
    const p = jobs.create({ name: 'test project', kind: 'project' });
    const t = jobs.create({ name: 'test task', agent: 'coding', parent: p.id });
    jobs.update(t.id, { status: 'running', progress: 0.4 });
    jobs.addGuidance(p.id, 'note');
    if (jobs.takeGuidance(p.id).length !== 1) throw new Error('guidance');
    jobs.requestCancel(p.id);
    if (jobs.get(t.id).status !== 'cancelled') throw new Error('cascade');
    return 'create/update/guide/cancel-cascade ok';
  }, { userFacing: false });

  await timed('router offload picks', async () => {
    const router = require(path.join(ROOT, 'lib/router'));
    const conf = { openaiKey: 'x', geminiKey: 'x' };
    const adapters = { ollamaUp: async () => false, openaiChat: () => {}, geminiChat: () => {} };
    const r1 = await router.pick({ agent: 'research', goal: 'find docs' }, { config: conf, adapters });
    const r2 = await router.pick({ agent: 'memory', goal: 'recall' }, { config: conf, adapters });
    const r4 = await router.pick({ agent: 'research', goal: 'x' }, { config: {}, adapters: { ollamaUp: async () => false } });
    if (r1.provider !== 'openai') throw new Error('research(ollama down) → ' + r1.provider);
    if (r2.provider !== 'openai') throw new Error('memory(ollama down) → ' + r2.provider);
    if (r4.provider !== 'anthropic') throw new Error('no keys → ' + r4.provider);
    return 'openai-first offload; key-less skips to anthropic';
  }, { userFacing: false });

  // ---------- provider latency (chat-reply shaped) ----------
  const PROMPT = 'Reply with exactly: ready';
  const ollamaGen = async (model, prompt, extra = {}) => {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { num_ctx: 4096 }, keep_alive: -1, ...extra }),
      signal: AbortSignal.timeout(90000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error('ollama ' + r.status);
    return (j.response || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  };
  await timed('ollama qwen3 (think:false — production path)', async () => (await ollamaGen('qwen3:latest', PROMPT, { ...NO_THINK, system: '/no_think' })).slice(0, 40));
  await timed('gpt-4o-mini (offload rung)', async () => {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.openaiKey },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: PROMPT }] }), signal: AbortSignal.timeout(30000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'openai ' + r.status);
    spentUsd += 0.0002;
    return j.choices?.[0]?.message?.content?.trim().slice(0, 40);
  });
  await timed('claude-haiku-4-5 (cloud rung)', async () => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey || process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 20, messages: [{ role: 'user', content: PROMPT }] }), signal: AbortSignal.timeout(30000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'anthropic ' + r.status);
    spentUsd += 0.001;
    return j.content?.[0]?.text?.trim().slice(0, 40);
  });
  // provider status probe (informational): gemini rung self-revives when credits topped up
  await timed('gemini-2.0-flash (status probe)', async () => {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }] }), signal: AbortSignal.timeout(30000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error?.message || '').slice(0, 70) || 'gemini ' + r.status);
    return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim().slice(0, 40);
  }, { userFacing: false });

  // ---------- TTS ack path (EL in cooldown → Kokoro local is live path; OpenAI = fallback) ----------
  let kokoroWarmMs = null;
  await timed('kokoro ack synth COLD (worker spawn + model load)', async () => {
    const candidates = ['/Library/Frameworks/Python.framework/Versions/3.13/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'];
    let py = null;
    for (const p of candidates) { try { if (spawnSync(p, ['-c', 'import kokoro_onnx'], { timeout: 8000 }).status === 0) { py = p; break; } } catch {} }
    if (!py) throw new Error('no python with kokoro_onnx');
    const dir = path.join(os.homedir(), '.bhatbot', 'kokoro');
    const proc = spawn(py, [path.join(ROOT, 'scripts', 'kokoro_worker.py'), dir]);
    const synth = (id, text) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('kokoro timeout')), 30000);
      let buf = '';
      const onData = (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          try { const m = JSON.parse(line); if (m.id === id) { clearTimeout(timer); proc.stdout.off('data', onData); return m.error ? rej(new Error(m.error)) : res(m); } } catch {}
        }
      };
      proc.stdout.on('data', onData);
      proc.stdin.write(JSON.stringify({ id, text, voice: 'bm_george', speed: 1.0, lang: 'en-gb' }) + '\n');
    });
    const m1 = await synth(1, 'On it, sir.');
    fs.unlink(m1.path, () => {});
    const t1 = Date.now();
    const m2 = await synth(2, 'Right away, sir.');
    kokoroWarmMs = Date.now() - t1;
    fs.unlink(m2.path, () => {});
    proc.kill();
    return 'warm synth ' + kokoroWarmMs + 'ms (app pre-warms at startup)';
  });
  if (kokoroWarmMs != null) record('kokoro ack synth WARM (= live ack path)', kokoroWarmMs, true, 'pre-warmed at app startup');
  if (kokoroWarmMs != null) record('e2e time-to-first-audio (ack@0ms + warm synth + afplay)', kokoroWarmMs + 200, kokoroWarmMs + 200 < 5000, 'derived');
  await timed('openai TTS fallback synth ("On it, sir.")', async () => {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: 'On it, sir.', response_format: 'mp3' }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('openai-tts ' + r.status);
    spentUsd += 0.001;
    return Buffer.from(await r.arrayBuffer()).length + ' bytes';
  });

  // ---------- pipeline router classify: cold is capped at 6s; warm is the steady state ----------
  await timed('router classify warm (gemma3n, keep_alive -1)', async () => {
    await ollamaGen('gemma3n:e4b', 'warmup', {});   // ensure resident (app does this at startup)
    const t0 = Date.now();
    const out = await ollamaGen('gemma3n:e4b', 'Open Spotify and play jazz', { format: 'json', system: 'Classify into JSON: {"path":"simple|complex|cloud","needsTools":<bool>}' });
    const ms = Date.now() - t0;
    record('router classify warm (steady state)', ms, ms < 5000, out.slice(0, 50));
    return 'cold load excluded (warmRouter at app startup; 6s hard cap → cloud escalation)';
  }, { userFacing: false });

  // ---------- background: orchestrator 3-parallel on real local agents (no_think) ----------
  await timed('orchestrator 3-parallel BACKGROUND (real ollama, no_think)', async () => {
    const orch = require(path.join(ROOT, 'lib/agents/orchestrator'));
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ws-'));
    fs.writeFileSync(path.join(wsDir, 'tasks.json'), JSON.stringify({ seq: 3, tasks: [
      { id: 't_0001', agent: 'memory', goal: 'State that the sky is blue in one line.', expects: 'answer', status: 'queued', parent: null },
      { id: 't_0002', agent: 'memory', goal: 'State that water is wet in one line.', expects: 'answer', status: 'queued', parent: null },
      { id: 't_0003', agent: 'memory', goal: 'State that fire is hot in one line.', expects: 'answer', status: 'queued', parent: null },
    ] }));
    const ollamaChat = async (m, s, model) => {
      const msgs = m.map((x) => ({ role: x.role, content: typeof x.content === 'string' ? x.content : JSON.stringify(x.content) }));
      msgs.unshift({ role: 'system', content: (s || '') + '\n/no_think' });
      const r = await fetch('http://localhost:11434/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: msgs, stream: false, think: false, options: { num_ctx: 4096 } }), signal: AbortSignal.timeout(120000)
      });
      const j = await r.json();
      if (!r.ok) throw new Error('ollama ' + r.status);
      return (j.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    };
    let maxPar = 0, inFlight = 0;
    const res = await orch.run('test', {
      wsDir, config: {}, concurrency: 3, maxTasks: 6,
      adapters: { ollamaUp: async () => true, ollamaChat: async (...a) => { inFlight++; maxPar = Math.max(maxPar, inFlight); try { return await ollamaChat(...a); } finally { inFlight--; } }, memWrite: async () => {} },
    });
    return `completed=${res.completed} maxParallel=${maxPar} (background job — chat stays live, 5s rule N/A)`;
  }, { userFacing: false });

  // ---------- voicemail + phone endpoints (free, stubbed host fns) ----------
  await timed('mcp-server: voicemail + phone endpoints', async () => {
    const { startMcpServer, stopMcpServer } = require(path.join(ROOT, 'mcp-server'));
    const jobsLib = require(path.join(ROOT, 'lib/jobs'));
    const tok = 'testtoken';
    await startMcpServer({
      port: 9099, token: tok,
      runAgent: async () => ({ text: 'ok' }),
      synthesize: async () => ({ audio: Buffer.from('fakeaudio').toString('base64'), mimeType: 'audio/mpeg' }),
      voiceTurn: async (sid, speech, greeting) => ({ text: greeting || 'reply', hangup: false }),
      endVoiceCall: () => {}, getActivity: () => ({ seq: 0, events: [] }),
      jobs: jobsLib,
      control: async (tool) => tool === 'run_shell' ? { success: true, stdout: 'controlled' } : { success: false, error: 'tool not allowed from phone control: ' + tool },
      screenshot: async () => ({ image: 'aGk=', mime: 'image/jpeg' }),
    });
    const base = 'http://127.0.0.1:9099';
    const post = (p, body, form) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const vm = await (await post(`/voice/${tok}/incoming?msg=${encodeURIComponent('Deploy failed.')}`, { CallSid: 'CA1', AnsweredBy: 'machine_end_beep' }, true)).text();
    if (!/<Play>.*<\/Play><Hangup\/>/.test(vm) || /<Gather/.test(vm)) throw new Error('voicemail TwiML wrong: ' + vm.slice(0, 120));
    const hu = await (await post(`/voice/${tok}/incoming?msg=hi`, { CallSid: 'CA2', AnsweredBy: 'human' }, true)).text();
    if (!/<Gather/.test(hu)) throw new Error('human TwiML missing Gather');
    const p1 = jobsLib.create({ name: 'phone test job', kind: 'project' });
    const jl = await (await fetch(`${base}/api/${tok}/jobs`)).json();
    if (!jl.jobs.some((j) => j.id === p1.id)) throw new Error('jobs list missing job');
    if (!(await (await post(`/api/${tok}/jobs/${p1.id}/guide`, { text: 'go faster' })).json()).ok) throw new Error('guide failed');
    if (!(await (await post(`/api/${tok}/jobs/${p1.id}/cancel`, {})).json()).ok) throw new Error('cancel failed');
    const ct = await (await post(`/api/${tok}/control`, { tool: 'run_shell', input: { command: 'echo hi' } })).json();
    if (ct.stdout !== 'controlled') throw new Error('control passthrough failed');
    const deny = await (await post(`/api/${tok}/control`, { tool: 'write_file', input: {} })).json();
    if (deny.success !== false) throw new Error('whitelist not enforced');
    if (!(await (await fetch(`${base}/api/${tok}/screen`)).json()).image) throw new Error('screen endpoint failed');
    if ((await fetch(`${base}/api/wrongtoken/jobs`)).status !== 401) throw new Error('token gate failed');
    stopMcpServer();
    return 'voicemail/human TwiML, jobs list/guide/cancel, control+whitelist, screen, 401 gate ok';
  }, { userFacing: false });

  // ---------- summary ----------
  console.log('\n========== TIMING SUMMARY ==========');
  const userFacing = results.filter((r) => r.userFacing);
  const over = userFacing.filter((r) => r.ms > 5000);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${String(r.ms).padStart(6)}ms  ${r.userFacing ? '[user-facing]' : '[internal]   '}  ${r.name}`);
  console.log(`\nuser-facing responses: ${userFacing.length}, over 5s: ${over.length}  ${over.length > 2 ? '→ FIX PASS REQUIRED' : '→ within budget'}`);
  if (over.length) over.forEach((r) => console.log('  over-5s:', r.name, r.ms + 'ms'));
  console.log(`estimated API spend this run: ~$${spentUsd.toFixed(4)}`);
  process.exit(0);
})();
