'use strict';
// macOS system automation (Phase 4/5 split — extracted from main.js). systemControl = AppleScript /
// System Events GUI automation (open/quit apps, keystroke, shortcut, menu, clipboard, notification).
// Confirm/permission GATES stay in main.js (executeTool) per SPLIT_PLAN — this module is pure capability.
// osa/osaErr are SHARED (browser native-login + ambient also use them), so they are injected via ctx.
module.exports = function makeSystemTools({ spawn, osa, osaErr, EXEC_PATH }) {
async function systemControl(input) {
  const a = input.action;
  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let r;
  switch (a) {
    case 'applescript':
      r = await osa(['-e', String(input.script || '')]); break;
    case 'activate_app':
    case 'open_app': {
      // Launch via LaunchServices (`open -a`) directly — needs NO Automation/Accessibility
      // permission, unlike `tell app to activate` (an Apple event that TCC blocks in the
      // packaged app → the long-standing "app opening doesn't work in Bhatbot" bug).
      r = await new Promise((res) => {
        const p = spawn('open', ['-a', String(input.app || '')], { env: { ...process.env, PATH: EXEC_PATH } });
        let e = ''; p.stderr.on('data', (d) => e += d);
        p.on('error', (er) => res({ ok: false, err: er.message }));
        p.on('close', (c) => res(c === 0 ? { ok: true, out: `Opened ${input.app}` } : { ok: false, err: (e.trim() || `Unable to open "${input.app}" — check the exact app name`) }));
      });
      break;
    }
    case 'quit_app': {
      // Graceful AppleScript quit; if Automation isn't granted, fall back to pkill (SIGTERM).
      let rr = await osa(['-e', `tell application "${esc(input.app)}" to quit`]);
      if (!rr.ok) {
        const killed = await new Promise((res) => { const p = spawn('pkill', ['-x', String(input.app || '')], { env: { ...process.env, PATH: EXEC_PATH } }); p.on('error', () => res(false)); p.on('close', (c) => res(c === 0)); });
        rr = killed ? { ok: true, out: `Quit ${input.app}` } : rr;
      }
      r = rr; break;
    }
    case 'keystroke':
      r = await osa(['-e', `tell application "System Events" to keystroke "${esc(input.text)}"`]); break;
    case 'shortcut': {                                   // key + modifiers, e.g. key:"s" modifiers:["command"]
      const mods = (input.modifiers || []).map((m) => `${m} down`).join(', ');
      const using = mods ? ` using {${mods}}` : '';
      r = await osa(['-e', `tell application "System Events" to keystroke "${esc(input.key)}"${using}`]); break;
    }
    case 'menu': {                                       // app + menuPath:["File","Save"]
      const p = input.menuPath || [];
      if (p.length < 2) return { success: false, error: 'menuPath needs at least [menu, item]' };
      const menu = esc(p[0]); const item = esc(p[p.length - 1]);
      const script = `tell application "${esc(input.app)}" to activate
delay 0.2
tell application "System Events" to tell process "${esc(input.app)}" to click menu item "${item}" of menu "${menu}" of menu bar 1`;
      r = await osa(['-e', script]); break;
    }
    case 'clipboard_get':
      r = await osa(['-e', 'the clipboard as text']); break;
    case 'clipboard_set':
      r = await osa(['-e', `set the clipboard to "${esc(input.text)}"`]); break;
    case 'notification':
      r = await osa(['-e', `display notification "${esc(input.text)}" with title "${esc(input.title || 'Bhatbot')}"`]); break;
    default:
      return { success: false, error: `Unknown action: ${a}` };
  }
  return r.ok ? { success: true, result: r.out || 'done' } : { success: false, error: osaErr(r) };
}
  return { systemControl };
};
