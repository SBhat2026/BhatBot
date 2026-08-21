'use strict';
// Visual building via the Seedance connector (lib/visualbuild.js).
//
// The point of this module is that video generation is ASYNCHRONOUS and the agent should not be the
// thing doing the polling: each poll left to the model is a full turn with the whole conversation
// re-sent. So the poll loop lives in code — and a poll loop is exactly the kind of thing that hangs,
// spins, or silently gives up, which is what these tests pin down. callTool and sleep are injected,
// so all of it runs with no connector, no API key and no spend.
const assert = require('assert');
const vb = require('../lib/visualbuild');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const URL_OK = 'https://cdn.example.com/out/abc123.mp4';

// ── response shape tolerance — servers disagree, and the model should not have to guess ────────
{
  const shapes = [
    ['inline video_url',   { result: JSON.stringify({ video_url: URL_OK }) }],
    ['data array',         { result: JSON.stringify({ data: [{ video_url: URL_OK, state: 'succeeded' }] }) }],
    ['nested task',        { result: JSON.stringify({ task: { url: URL_OK, status: 'success' } }) }],
    ['fenced json',        { result: '```json\n{"video_url":"' + URL_OK + '"}\n```' }],
    ['prose + json',       { result: 'Here you go!\n{"video_url":"' + URL_OK + '"}\nEnjoy.' }],
    ['bare url in prose',  { result: 'Your video is ready at ' + URL_OK + ' — expires in 24h.' }],
    ['object not string',  { result: { video_url: URL_OK } }],
  ];
  for (const [label, raw] of shapes) ok(vb.extractResult(raw).videoUrl === URL_OK, `url extracted from: ${label}`);
}
{
  const r = vb.extractResult({ result: JSON.stringify({ task_id: 'T-1', state: 'pending' }) });
  ok(r.taskId === 'T-1' && !r.videoUrl && r.state === 'pending', 'a queued response yields a task id and no url');
  ok(vb.extractResult({ result: JSON.stringify({ id: 'T-2' }) }).taskId === 'T-2', 'alternate id key is accepted');
  const f = vb.extractResult({ result: JSON.stringify({ state: 'failed', error: 'content policy' }) });
  ok(f.state === 'failed' && f.error === 'content policy', 'a failure carries its reason');
  ok(vb.extractResult({ result: 'total nonsense' }).videoUrl === null, 'unparseable output yields null, not a crash');
  ok(vb.extractResult(null).videoUrl === null, 'null input is handled');
  ok(vb.parseMaybeJson('not json') === null, 'parseMaybeJson gives up cleanly');
}
{
  ok(vb.isTerminal('pending', URL_OK) === true, 'a url is terminal whatever the state says');
  ok(vb.isTerminal('succeeded', null) === true && vb.isTerminal('failed', null) === true, 'success and failure are both terminal');
  ok(vb.isTerminal('running', null) === false, 'a running task is not terminal');
}

// ── the generate → poll → done path ───────────────────────────────────────────────────────────
function harness(script, { failEvery = 0 } = {}) {
  const calls = [];
  let sleeps = 0, clock = 0;
  const callTool = async (name, input) => {
    calls.push({ name, input });
    if (failEvery && calls.length % failEvery === 0) return { success: false, error: 'transient' };
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof step === 'function' ? step(calls.length) : step;
  };
  return { calls, deps: { callTool, sleep: async () => { sleeps++; clock += 6000; }, now: () => clock }, sleeps: () => sleeps };
}

(async () => {
  {
    const h = harness([{ result: JSON.stringify({ video_url: URL_OK }) }]);
    const r = await vb.generate({ prompt: 'a cat' }, h.deps);
    ok(r.ok && r.videoUrl === URL_OK, 'a synchronous response returns immediately');
    ok(r.polls === 0 && h.sleeps() === 0, 'and does not poll or sleep at all');
    ok(h.calls[0].name === vb.T_GEN, 'text-to-video uses the text tool');
  }
  {
    const h = harness([{ result: JSON.stringify({ video_url: URL_OK }) }]);
    await vb.generate({ prompt: 'a cat', image: 'https://x/y.png' }, h.deps);
    ok(h.calls[0].name === vb.T_GEN_IMG, 'supplying an image routes to the image-to-video tool');
    ok(h.calls[0].input.image === 'https://x/y.png', 'and passes it through');
  }
  {
    const h = harness([{ result: JSON.stringify({ video_url: URL_OK }) }]);
    await vb.generate({ prompt: 'a cat', images: ['a.png', 'b.png'] }, h.deps);
    ok(h.calls[0].input.image === 'a.png' && h.calls[0].input.last_frame_image === 'b.png', 'an [first,last] pair becomes first-frame + last-frame control');
  }
  {
    const h = harness([{ result: JSON.stringify({ video_url: URL_OK }) }]);
    await vb.generate({ prompt: 'p', model: 'm', resolution: '1080p', aspect_ratio: '9:16', duration: 8, audio: true, nonsense: 'x' }, h.deps);
    const i = h.calls[0].input;
    ok(i.model === 'm' && i.resolution === '1080p' && i.aspect_ratio === '9:16' && i.duration === 8 && i.audio === true, 'known options are forwarded');
    ok(i.nonsense === undefined, 'unknown keys are NOT forwarded — the connector should not have to reject our noise');
  }
  {
    const h = harness([
      { result: JSON.stringify({ task_id: 'T-9', state: 'pending' }) },
      { result: JSON.stringify({ task_id: 'T-9', state: 'running' }) },
      { result: JSON.stringify({ task_id: 'T-9', state: 'running' }) },
      { result: JSON.stringify({ task_id: 'T-9', state: 'succeeded', video_url: URL_OK }) },
    ]);
    const r = await vb.generate({ prompt: 'p' }, h.deps);
    ok(r.ok && r.videoUrl === URL_OK, 'the loop polls until the video is ready');
    ok(r.polls === 3, 'and reports how many polls it took');
    ok(h.calls.slice(1).every((c) => c.name === vb.T_TASK && c.input.task_id === 'T-9'), 'every poll targets the task id from the generate call');
    ok(r.ms > 0, 'elapsed time is measured from the injected clock');
  }
  {
    const h = harness([
      { result: JSON.stringify({ task_id: 'T-5' }) },
      { result: JSON.stringify({ state: 'failed', error: 'content policy' }) },
    ]);
    const r = await vb.generate({ prompt: 'p' }, h.deps);
    ok(!r.ok && r.error === 'content policy', 'a failed task stops the loop and surfaces the reason');
    ok(r.polls === 1, 'failure is terminal — it does not keep polling a dead task');
  }
  {
    // The dangerous case: a connector that answers instantly, forever, without ever finishing.
    const h = harness([{ result: JSON.stringify({ task_id: 'T-∞' }) }, { result: JSON.stringify({ state: 'running' }) }]);
    const r = await vb.generate({ prompt: 'p' }, h.deps, { maxPolls: 4 });
    ok(!r.ok && r.polls === 4, 'a never-finishing task is bounded by maxPolls, not left to spin');
    ok(/timed out after 4 poll/.test(r.error), 'and says it timed out rather than reporting a silent failure');
  }
  {
    const h = harness([{ result: JSON.stringify({ task_id: 'T-t' }) }, { result: JSON.stringify({ state: 'running' }) }]);
    const r = await vb.generate({ prompt: 'p' }, h.deps, { maxPolls: 999, timeoutMs: 30000, pollMs: 6000 });
    ok(!r.ok && r.polls <= 6, 'the wall clock bounds the loop independently of the poll count');
  }
  {
    const h = harness([
      { result: JSON.stringify({ task_id: 'T-r' }) },
      null,                                       // slot 2 is overwritten by failEvery
      { result: JSON.stringify({ state: 'succeeded', video_url: URL_OK }) },
    ], { failEvery: 2 });
    const r = await vb.generate({ prompt: 'p' }, h.deps, { maxPolls: 6 });
    ok(r.ok, 'a transient poll failure is survived rather than aborting the whole generation');
  }
  {
    const h = harness([{ success: false, error: 'not authenticated' }]);
    const r = await vb.generate({ prompt: 'p' }, h.deps);
    ok(!r.ok && /not authenticated/.test(r.error) && r.polls === 0, 'a failed generate call returns its error without polling');
  }
  {
    const h = harness([{ result: 'no id, no url, just words' }]);
    const r = await vb.generate({ prompt: 'p' }, h.deps);
    ok(!r.ok && /neither a video url nor a task id/.test(r.error), 'an unusable response is reported precisely, not retried blindly');
  }
  {
    let threw = null;
    try { await vb.generate({ prompt: 'p' }, {}); } catch (e) { threw = e.message; }
    ok(/needs \{ callTool, sleep \}/.test(threw || ''), 'missing dependencies fail loudly at the call, not mysteriously mid-loop');
  }
  {
    const h = harness([{ result: JSON.stringify({ video_url: URL_OK }) }]);
    await vb.generate({ prompt: 'x'.repeat(5000) }, h.deps);
    ok(h.calls[0].input.prompt.length === 2000, 'a runaway prompt is clipped before it is sent');
  }

  console.log(`✅ visualbuild: ${pass} assertions passed`);
})().catch((e) => { console.error('❌ visualbuild:', e.message); process.exit(1); });
