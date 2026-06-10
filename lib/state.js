'use strict';
// Structured state store (Phase 2). state.json holds FACTS — "what is true right now" —
// as typed component objects, overwritten in place. This is the working set every agent
// loads; it's tiny and authoritative. Narrative ("why") lives in decisions.json + memory.
// See ARCHITECTURE.md §2.
const fs = require('fs');
const path = require('path');

const STATUSES = ['planned', 'partial', 'working', 'broken', 'blocked', 'done'];
// Allowed status transitions; any status may go to broken/blocked.
const TRANSITIONS = {
  planned: ['partial', 'working', 'done'],
  partial: ['working', 'done', 'partial'],
  working: ['done', 'partial', 'working'],
  blocked: ['planned', 'partial', 'working'],
  broken: ['planned', 'partial', 'working'],
  done: ['working', 'partial'],
};

function open(wsDir) {
  const file = path.join(wsDir, 'state.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 0, components: {}, metrics: {} }; } };
  const write = (s) => { s.updated = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(s, null, 2)); };

  function ensure(s, comp) {
    if (!s.components[comp]) s.components[comp] = { status: 'planned', facts: {}, blockers: [], refs: [], rev: 0, updated: new Date().toISOString() };
    return s.components[comp];
  }

  return {
    get(comp) { return read().components[comp]; },
    all() { return read().components; },

    // set('trellis.facts.uv_mapping', true) — overwrite in place, bump rev + version.
    set(dotted, value) {
      const s = read();
      const [comp, ...rest] = dotted.split('.');
      const c = ensure(s, comp);
      if (rest.length === 0) Object.assign(c, value);
      else {
        let o = c;
        for (let i = 0; i < rest.length - 1; i++) o = (o[rest[i]] = o[rest[i]] || {});
        o[rest[rest.length - 1]] = value;
      }
      c.rev = (c.rev || 0) + 1; c.updated = new Date().toISOString();
      s.version = (s.version || 0) + 1;
      write(s);
      return c;
    },

    setStatus(comp, status) {
      if (!STATUSES.includes(status)) throw new Error(`bad status "${status}"`);
      const s = read();
      const c = ensure(s, comp);
      const from = c.status;
      const legal = status === 'broken' || status === 'blocked' || (TRANSITIONS[from] || []).includes(status);
      if (!legal) throw new Error(`illegal transition ${from} → ${status} for ${comp}`);
      c.status = status; c.rev = (c.rev || 0) + 1; c.updated = new Date().toISOString();
      s.version = (s.version || 0) + 1;
      write(s);
      return c;
    },

    // Apply a result envelope's state_updates ([{path,value}] or [{path,status}]).
    // Agent output is UNTRUSTED: every update is best-effort — a malformed one is skipped,
    // never thrown, so a bad LLM response can't crash the orchestrator.
    applyUpdates(updates = []) {
      const skipped = [];
      for (const u of updates || []) {
        try {
          if (!u || !u.path) { continue; }
          let st = u.status || (String(u.path).endsWith('.status') ? u.value : null);
          if (st != null) {
            st = String(st).toLowerCase().trim();
            const comp = String(u.path).split('.')[0];
            if (STATUSES.includes(st)) { try { this.setStatus(comp, st); } catch { this.set(comp + '.status', st); /* force if illegal transition */ } }
            else { this.set(comp + '.facts._reported_status', st); }   // keep the info as a fact, don't reject
          } else {
            this.set(u.path, u.value);
          }
        } catch (e) { skipped.push((u && u.path) + ': ' + e.message); }
      }
      return { version: read().version, skipped };
    },

    addBlocker(comp, text) { const s = read(); const c = ensure(s, comp); c.blockers = [...new Set([...(c.blockers || []), text])]; s.version++; write(s); },
    clearBlocker(comp, text) { const s = read(); const c = ensure(s, comp); c.blockers = (c.blockers || []).filter((b) => b !== text); s.version++; write(s); },

    metric(key, value) { const s = read(); s.metrics = s.metrics || {}; s.metrics[key] = value; write(s); },
    addCost(usd) { const s = read(); s.metrics = s.metrics || {}; s.metrics.cost_month_usd = +(((s.metrics.cost_month_usd || 0) + usd).toFixed(4)); write(s); return s.metrics.cost_month_usd; },

    // Small object for prompts: status + facts only, blockers if any. Cheap to inline.
    snapshot(comps) {
      const s = read(); const out = { version: s.version, components: {} };
      for (const [k, c] of Object.entries(s.components)) {
        if (comps && !comps.includes(k)) continue;
        out.components[k] = { status: c.status, facts: c.facts || {}, ...(c.blockers && c.blockers.length ? { blockers: c.blockers } : {}) };
      }
      return out;
    },

    // One-line digest per component for checkpoints/logs.
    digest() {
      const s = read();
      return Object.entries(s.components).map(([k, c]) => {
        const facts = Object.entries(c.facts || {}).map(([fk, fv]) => `${fk}=${JSON.stringify(fv)}`).join(', ');
        return `${k}: ${c.status}${facts ? ' (' + facts + ')' : ''}`;
      }).join('; ');
    },

    version() { return read().version; },
  };
}

module.exports = { open, STATUSES, TRANSITIONS };
