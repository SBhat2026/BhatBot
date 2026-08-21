'use strict';
// ── VISUAL BUILD — turn a description (or what's on screen) into a video, via the Seedance connector ─
//
// The connector's raw tools are already exposed to the agent as `mcp__seedance__*`. This module is
// the layer that makes them USABLE as a build step rather than a raw API:
//
//   • generation is ASYNCHRONOUS. seedance_generate_video returns a task id, not a video. Left to the
//     agent, "make me a video" costs a generate call, then a get_task call, then another, then
//     another — each one a full model turn with the whole conversation re-sent. Polling belongs in
//     code. One tool call in, a finished video out.
//   • the response shape is not fixed. Depending on model and tier the URL comes back as `video_url`,
//     `url`, `data[0].video_url`, or inside a text blob. extractResult() handles the variants in one
//     place instead of the model guessing each time.
//   • a video the user cannot see is not a build artifact. main.js downloads it and pulls a poster
//     frame so the result lands in the conversation as an image, not a link.
//
// PURE: no fs, no network, no timers of its own — `callTool` and `sleep` are injected, so the whole
// poll loop is testable headless with no connector, no key and no spend.

const PLUGIN = 'seedance';
const T_GEN = `mcp__${PLUGIN}__seedance_generate_video`;
const T_GEN_IMG = `mcp__${PLUGIN}__seedance_generate_video_from_image`;
const T_TASK = `mcp__${PLUGIN}__seedance_get_task`;

/** Best-effort JSON out of an MCP text result (servers vary: raw JSON, fenced JSON, or prose+JSON). */
function parseMaybeJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  try { return JSON.parse(s); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const brace = s.indexOf('{'), end = s.lastIndexOf('}');
  if (brace >= 0 && end > brace) { try { return JSON.parse(s.slice(brace, end + 1)); } catch {} }
  return null;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+\.(?:mp4|mov|webm|m4v)(?:\?[^\s"'<>)\]]*)?/i;

/**
 * Pull { taskId, videoUrl, state, error } out of whatever the connector returned.
 * Tolerant by design — a shape we don't know about still yields a URL if one is anywhere in the text.
 */
function extractResult(raw) {
  const text = typeof raw === 'string' ? raw : (raw && typeof raw.result === 'string' ? raw.result : '');
  const j = parseMaybeJson(raw && raw.result !== undefined ? raw.result : raw) || {};
  const first = Array.isArray(j.data) ? (j.data[0] || {}) : (j.data && typeof j.data === 'object' ? j.data : {});
  const pick = (...keys) => {
    for (const k of keys) {
      for (const src of [j, first, j.task || {}, j.result || {}]) {
        const v = src && src[k];
        if (v != null && v !== '') return v;
      }
    }
    return null;
  };
  const videoUrl = pick('video_url', 'videoUrl', 'video', 'url', 'output_url')
    || (URL_RE.exec(text) || [])[0] || null;
  const taskId = pick('task_id', 'taskId', 'id', 'request_id') || null;
  const state = String(pick('state', 'status', 'task_status') || (videoUrl ? 'succeeded' : 'pending')).toLowerCase();
  const error = pick('error', 'message', 'fail_reason');
  return {
    taskId: taskId ? String(taskId) : null,
    videoUrl: videoUrl ? String(videoUrl) : null,
    state,
    error: (state.includes('fail') || state.includes('error')) && error ? String(error) : null,
  };
}

const DONE = /(success|succeed|complete|finish|done)/;
const FAILED = /(fail|error|cancel|reject)/;

/** Is this a terminal state? Used by the poll loop; exported for tests. */
function isTerminal(state, videoUrl) { return !!videoUrl || DONE.test(state) || FAILED.test(state); }

/**
 * Generate a video and wait for it.
 *
 * @param {object} spec  { prompt, image?, images?, model?, resolution?, aspect_ratio?, duration?, audio? }
 * @param {object} deps  { callTool(name, input) → tool result, sleep(ms), now?() , log?() }
 * @param {object} [opts] { timeoutMs=300000, pollMs=6000, maxPolls=60 }
 * @returns {Promise<{ ok, videoUrl, taskId, state, error, polls, ms }>}
 */
async function generate(spec = {}, deps = {}, opts = {}) {
  const { callTool, sleep, now = () => Date.now(), log = () => {} } = deps;
  if (typeof callTool !== 'function' || typeof sleep !== 'function') throw new Error('visualbuild.generate needs { callTool, sleep }');
  const timeoutMs = opts.timeoutMs || 300000;
  const pollMs = opts.pollMs || 6000;
  const maxPolls = opts.maxPolls || 60;
  const t0 = now();

  const images = spec.images || (spec.image ? [spec.image] : []);
  const useImage = images.length > 0;
  const input = { prompt: String(spec.prompt || '').slice(0, 2000) };
  for (const k of ['model', 'resolution', 'aspect_ratio', 'duration', 'audio', 'service_tier']) {
    if (spec[k] != null) input[k] = spec[k];
  }
  if (useImage) { input.image = images[0]; if (images[1]) input.last_frame_image = images[1]; }

  const started = await callTool(useImage ? T_GEN_IMG : T_GEN, input);
  if (started && started.success === false) {
    return { ok: false, videoUrl: null, taskId: null, state: 'error', error: started.error || 'generate call failed', polls: 0, ms: now() - t0 };
  }
  let r = extractResult(started);
  log(`[visual] task ${r.taskId || '(inline)'} — ${r.state}`);
  if (r.videoUrl) return { ok: true, ...r, polls: 0, ms: now() - t0 };
  if (!r.taskId) {
    return { ok: false, videoUrl: null, taskId: null, state: r.state, error: r.error || 'connector returned neither a video url nor a task id', polls: 0, ms: now() - t0 };
  }

  // Poll. Bounded on BOTH a wall clock and a poll count: a connector that answers instantly with a
  // non-terminal state forever would otherwise spin, and one that hangs would otherwise never return.
  let polls = 0;
  while (polls < maxPolls && (now() - t0) < timeoutMs) {
    await sleep(pollMs);
    polls++;
    const got = await callTool(T_TASK, { task_id: r.taskId, id: r.taskId });
    if (got && got.success === false) { log(`[visual] poll ${polls} failed: ${got.error}`); continue; }
    const next = extractResult(got);
    if (next.videoUrl || next.state !== 'pending') r = { ...r, ...next, taskId: r.taskId };
    if (isTerminal(r.state, r.videoUrl)) break;
  }
  const ok = !!r.videoUrl && !FAILED.test(r.state);
  return {
    ok, videoUrl: r.videoUrl, taskId: r.taskId, state: r.state, polls, ms: now() - t0,
    error: ok ? null : (r.error || (r.videoUrl ? null : `timed out after ${polls} poll(s) in state "${r.state}"`)),
  };
}

module.exports = { generate, extractResult, parseMaybeJson, isTerminal, PLUGIN, T_GEN, T_GEN_IMG, T_TASK };
