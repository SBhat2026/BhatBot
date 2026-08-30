'use strict';
// ── SLASH COMMANDS ────────────────────────────────────────────────────────────────────────────────
// Parsed at the FRONT DOOR, before classifyIntake, for the same reason the intake router exists:
// a command must never be swallowed by the tool-less chat path and answered *about* instead of run.
// "/agents" is a question-shaped short string — exactly the shape classifyIntake sends to fastReply.
//
// Two kinds:
//   BUILTIN — implemented in main.js because they need live state (jobs, fleet, tool schema).
//             The registry only declares them; it never executes.
//   CUSTOM  — markdown files in ~/.bhatbot/commands/<name>.md. The body is a prompt template; the
//             whole point is that a custom command is just a saved prompt, so authoring one cannot
//             introduce new capability or new risk. `$ARGUMENTS` (and $1..$9) interpolate.
//
// Deliberately NOT a tool. Tools are for the MODEL to choose; slash commands are for Siddhant to
// bypass model choice entirely and get a deterministic action. Adding 4 more entries to an 81-tool
// schema would also make retrieval worse for no benefit.
//
// Pure + fs + DI. See scripts/test-commands.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

const BUILTINS = [
  { name: 'help', args: '[command]', description: 'List every command, or explain one.' },
  { name: 'agents', args: '', description: 'Show the live fleet — every running agent, its job id, current step and spend.' },
  { name: 'agent', args: '<id> <message>', description: 'Send a message to ONE running agent. It lands on that agent\'s next step, not the whole fleet.' },
  { name: 'new-command', args: '<name> <what it should do>', description: 'Create a new command. Searches the existing 81 tools FIRST — most "I need a tool" is a discovery failure, not a real gap.' },
  { name: 'blender', args: '', description: 'Open the Blender Studio window — the live build log, renders and finished model from make_model.' },
];

/**
 * parse('/agent suit-2 focus on the tests') →
 *   { isCommand:true, name:'agent', argv:['suit-2','focus','on','the','tests'], args:'suit-2 focus on the tests' }
 *
 * A bare '/' or '/ ' is NOT a command (someone typing a path or a fraction), and neither is a slash
 * that appears anywhere other than the very start.
 */
function parse(text) {
  const raw = String(text == null ? '' : text);
  const t = raw.trim();
  if (!t.startsWith('/')) return { isCommand: false };
  const body = t.slice(1);
  if (!body || /^\s/.test(body)) return { isCommand: false };
  // A leading path like "/Users/..." or "/usr/bin/env" is not a command.
  if (body.includes('/') && !/^[a-z0-9_-]+(\s|$)/i.test(body)) return { isCommand: false };
  const m = /^([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(body);
  if (!m) return { isCommand: false };
  const args = (m[2] || '').trim();
  return { isCommand: true, name: m[1].toLowerCase(), args, argv: args ? args.split(/\s+/) : [], raw: t };
}

// Front-matter is optional; a bare .md file still works, described by its first line.
function parseCustom(name, src) {
  let description = '', body = src;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (fm) {
    body = src.slice(fm[0].length);
    const d = /^description:\s*(.+)$/m.exec(fm[1]);
    if (d) description = d[1].trim();
  }
  if (!description) description = (body.trim().split('\n')[0] || '').replace(/^#+\s*/, '').slice(0, 100);
  return { name, description, body: body.trim(), custom: true, args: '[arguments]' };
}

function createCommands({ dir = path.join(os.homedir(), '.bhatbot', 'commands'), log = () => {} } = {}) {
  function loadCustom() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return out; }
    for (const f of files) {
      const name = path.basename(f, '.md').toLowerCase();
      if (!NAME_RE.test(name)) continue;
      // A custom command may never shadow a builtin — otherwise a file on disk could silently
      // redefine /agent or /help into something else.
      if (BUILTINS.some((b) => b.name === name)) { log(`[commands] ignoring ${f}: "${name}" is a builtin`); continue; }
      try { out.push(parseCustom(name, fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
    }
    return out;
  }

  function list() { return [...BUILTINS.map((b) => ({ ...b, builtin: true })), ...loadCustom()]; }
  function get(name) { return list().find((c) => c.name === String(name || '').toLowerCase()) || null; }

  /** Autocomplete: everything whose name or description matches the typed prefix. */
  function match(prefix = '') {
    const p = String(prefix || '').replace(/^\//, '').toLowerCase();
    const all = list();
    if (!p) return all;
    // Shortest first, so typing "ag" offers /agent before /agents — the shorter name is the closer
    // match to what has been typed, and an exact hit must always be reachable with one more key.
    const starts = all.filter((c) => c.name.startsWith(p)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    const contains = all.filter((c) => !c.name.startsWith(p) && (c.name.includes(p) || (c.description || '').toLowerCase().includes(p)));
    return [...starts, ...contains];
  }

  /**
   * Expand a CUSTOM command into the prompt it stands for. $ARGUMENTS is the whole argument string;
   * $1..$9 are positional. Unfilled placeholders are stripped rather than left as literal "$3",
   * which would otherwise reach the model as noise.
   */
  function expand(cmd, args = '') {
    if (!cmd || !cmd.custom) return null;
    const argv = args.trim() ? args.trim().split(/\s+/) : [];
    let out = cmd.body.replace(/\$ARGUMENTS\b/g, args.trim());
    out = out.replace(/\$([1-9])\b/g, (_, d) => argv[Number(d) - 1] || '');
    return out.trim();
  }

  /** Write a new custom command. Refuses builtins and bad names; never overwrites silently. */
  function save(name, { description = '', body = '' } = {}, { overwrite = false } = {}) {
    const n = String(name || '').toLowerCase().trim();
    if (!NAME_RE.test(n)) return { ok: false, error: `"${name}" is not a valid command name (letters, digits, - and _ only).` };
    if (BUILTINS.some((b) => b.name === n)) return { ok: false, error: `"${n}" is a builtin command and cannot be replaced.` };
    const file = path.join(dir, n + '.md');
    if (!overwrite && fs.existsSync(file)) return { ok: false, error: `/${n} already exists. Pass overwrite to replace it.`, file };
    const src = `---\ndescription: ${String(description || '').replace(/\n/g, ' ').slice(0, 200)}\n---\n\n${String(body || '').trim()}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, src);
      return { ok: true, file, name: n };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function remove(name) {
    const n = String(name || '').toLowerCase();
    if (BUILTINS.some((b) => b.name === n)) return { ok: false, error: 'builtins cannot be removed' };
    try { fs.unlinkSync(path.join(dir, n + '.md')); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  /** Rendered /help text. */
  function help(name) {
    if (name) {
      const c = get(name);
      if (!c) return `No command /${name}. Try /help.`;
      return `/${c.name} ${c.args || ''}\n${c.description || ''}` + (c.custom ? `\n\n(custom — ${path.join(dir, c.name + '.md')})` : '');
    }
    const all = list();
    const b = all.filter((c) => c.builtin), cu = all.filter((c) => c.custom);
    const fmt = (c) => `  /${c.name}${c.args ? ' ' + c.args : ''}\n      ${c.description || ''}`;
    let out = 'COMMANDS\n' + b.map(fmt).join('\n');
    out += cu.length ? '\n\nYOUR COMMANDS\n' + cu.map(fmt).join('\n') : '\n\n(no custom commands yet — make one with /new-command)';
    return out;
  }

  return { parse, list, get, match, expand, save, remove, help, loadCustom, dir, BUILTINS };
}

module.exports = { createCommands, parse, parseCustom, BUILTINS, NAME_RE };
