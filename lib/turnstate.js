'use strict';
// T2 — single display-state reducer for one turn. Pure, ZERO deps (no Electron/fs/timers).
// Every progress emit (tool-update / plan / model / token) is folded into ONE coherent
// snapshot, so the renderer always has an authoritative, never-stuck picture of what the
// turn is doing. This is the fix for "goes quiet": the snapshot carries status + currentStep
// + a plan checklist + a monotonic seq, so a heartbeat OR a late subscriber can always redraw
// the true state instead of piecing together a stream of granular events that may have gaps.
//
// createTurnState() → { reduce(evt), snapshot(), subscribe(fn), reset() }
//   reduce(evt) folds one event, returns the fresh snapshot, and notifies subscribers.
//   snapshot()  returns the current public snapshot (internal fields stripped).
//   subscribe(fn) registers a listener (called with the snapshot on every change); returns unsub.
//
// The reducer is synchronous and timer-free by design — DEBOUNCING is the caller's job (main.js
// batches the actual IPC send). Keeping it pure makes it trivially testable and resume-safe.

const MAX_TOOLS = 40;

function blank() {
  return {
    status: 'idle',       // idle | working | tool | done | stopped | error
    phase: '',            // coarse label: starting | recall | planning | executing | tool
    currentStep: '',      // plain-English of what's happening right now
    plan: [],             // [{ text, done }] — the checklist, ticks as work completes
    tools: [],            // recent [{ name, ok, ts }] ring
    toolsRan: 0,
    model: '',
    provider: '',
    lastText: '',         // last streamed/thinking prose (short)
    error: '',
    turnText: '',         // the user's ask (short), for the strip title
    startedAt: 0,
    updatedAt: 0,
    seq: 0,               // monotonic — lets the renderer drop out-of-order snapshots
    _active: '',          // internal: name of the tool currently running
  };
}

function advancePlan(s) {
  const i = s.plan.findIndex((p) => !p.done);
  if (i >= 0) s.plan[i].done = true;
}

function createTurnState() {
  let s = blank();
  const subs = new Set();

  function pub() {
    const { _active, ...rest } = s;
    return { ...rest, plan: rest.plan.map((p) => ({ ...p })), tools: rest.tools.slice() };
  }

  function emit() {
    const snap = pub();
    for (const fn of subs) { try { fn(snap); } catch { /* a bad subscriber never breaks the reducer */ } }
    return snap;
  }

  function reduce(evt) {
    if (!evt || typeof evt !== 'object' || !evt.type) return pub();
    switch (evt.type) {
      case 'turn_start': {
        s = blank();
        s.status = 'working';
        s.phase = 'starting';
        s.turnText = String(evt.text || '').slice(0, 200);
        s.startedAt = evt.ts || 0;
        break;
      }
      case 'phase':
        s.phase = String(evt.phase || s.phase);
        if (evt.step) s.currentStep = String(evt.step).slice(0, 200);
        if (s.status === 'idle') s.status = 'working';
        break;
      case 'plan':
        if (Array.isArray(evt.steps) && evt.steps.length) {
          s.plan = evt.steps.slice(0, 12).map((x) => ({ text: String(x).slice(0, 160), done: false }));
          s.phase = 'executing';
          if (s.status === 'idle') s.status = 'working';
        }
        break;
      case 'tool_start':
        s.status = 'tool';
        s.phase = 'tool';
        s._active = evt.name || '';
        s.currentStep = String(evt.narrate || (evt.name || '').replace(/_/g, ' ')).slice(0, 200);
        break;
      case 'tool_done':
        s.toolsRan++;
        s.tools.push({ name: evt.name || 'tool', ok: evt.ok !== false, ts: evt.ts || 0 });
        if (s.tools.length > MAX_TOOLS) s.tools.shift();
        s._active = '';
        s.status = 'working';
        advancePlan(s);   // one completed tool ticks the next open plan item
        if (evt.ok === false) s.currentStep = String(evt.name || 'tool').replace(/_/g, ' ') + ' failed — recovering';
        break;
      case 'thinking':
        if (evt.text) {
          s.lastText = String(evt.text).slice(0, 200);
          if (s.status === 'idle') s.status = 'working';
        }
        break;
      case 'token':
        if (s.status === 'idle' || s.status === 'working') s.status = 'working';
        break;
      case 'model':
        if (evt.model) s.model = String(evt.model).replace(/^claude-/, '').replace(/-\d{6,}$/, '');
        if (evt.provider) s.provider = evt.provider;
        break;
      case 'turn_done':
        s.status = evt.stopped ? 'stopped' : (evt.error ? 'error' : 'done');
        if (evt.error) s.error = String(evt.error).slice(0, 200);
        s._active = '';
        s.currentStep = '';
        if (!evt.stopped && !evt.error) s.plan = s.plan.map((p) => ({ ...p, done: true }));
        break;
      default:
        return pub();   // unrelated channel — no state change, no emit
    }
    s.updatedAt = evt.ts || s.updatedAt;
    s.seq++;
    return emit();
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  function snapshot() { return pub(); }
  function reset() { s = blank(); return emit(); }

  return { reduce, snapshot, subscribe, reset };
}

module.exports = { createTurnState };
