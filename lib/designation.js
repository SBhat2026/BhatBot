'use strict';
// ── TASK DESIGNATIONS — what an agent is doing, and the one colour that means it ──────────────────
//
// The office colour-coded agents by STATE (idle / thinking / working / done). That answers "is
// anything happening", which you can already tell from the activity log, and it makes every agent in
// a busy fleet the same colour — so a room full of blue told you nothing about who was doing what.
// What you actually want to read across the room is the DIVISION OF LABOUR: two on research, one
// writing code, one driving a browser, and the orchestrator standing in the middle.
//
// So hue now means DESIGNATION and motion means STATE. They are orthogonal channels and both stay
// legible: a working agent pulses, an idle one dims and wanders, an errored one flashes the reserved
// red — none of which needs to borrow the hue.
//
// WHY THE COLOURS ARE COMPUTED AND NOT PICKED.
// Hand-picked palettes drift together. The first draft of this file had `science` at 170° and
// `research` at 187° — seventeen degrees apart, indistinguishable on a lit 3D surface at across-the-
// room size, which is the only place the colour is meant to be read. Spacing them by construction
// makes that impossible, and scripts/test-designation.js asserts the minimum separation so adding a
// ninth designation FAILS rather than quietly crowding the wheel.
//
// The red band (340°–20°) is reserved: red means error in this app, in the office, in the cards and
// in the legend. A designation that landed there would make a failing research agent and a healthy
// one look the same.
//
// This module is the SINGLE source of truth. src/presence.html (the 3D office), the agent cards in
// src/index.html, and lib/supervisor.js all read designations from here — if they each kept their own
// list, the legend would eventually describe a colour scheme the room no longer uses.
//
// Pure, dependency-free, no Electron: the renderer imports the generated JSON block, tests require it.

// Reserved for failure, in every surface. Nothing else may use it.
// Red at office brightness is PINK, not red — oklch(0.74, 0.17, 25) is #fd8fa0. So the error colour
// gets its own darker, more chromatic pair: a failing agent has to read as failing at a glance, and
// "slightly pinker than the browser agent" does not.
const ERROR_HUE = 25;
const ERROR_LC = { L: 0.62, C: 0.21 };
const RESERVED = [330, 38];          // wraps through 0 — the whole red/scarlet arc
const HUE_START = 50;                // first designation, clear of the reserved band
const HUE_SPAN = 280;                // 50 → 330, the whole wheel minus the reserved arc

// Order matters only for the legend; the hue each one gets is its index.
// `match` is how free text, a tool name or a role name resolves to this designation — longest match
// wins, so 'find_papers' lands on science rather than on research's 'paper'.
const SPEC = [
  { id: 'browser',     label: 'Browser',      match: ['browser', 'smart_login', 'open_in_browser', 'screen_parse', 'vision_click', 'ui_inspect', 'web page', 'website', 'click', 'log in', 'sign in', 'scrape'] },
  { id: 'science',     label: 'Science',      match: ['sci_compute', 'molecule', 'find_papers', 'make_model', 'bioart', 'predict_function', 'math_reason', 'simulate', 'protein', 'paper', 'arxiv', 'pubmed', 'experiment', 'dataset', 'chemistry', 'physics', 'biology'] },
  { id: 'code',        label: 'Code',         match: ['code', 'coding', 'claude_code', 'build_project', 'edit_file', 'write_file', 'run_shell', 'self_fix', 'self_improve', 'refactor', 'test', 'debug', 'repo', 'compile', 'implement'] },
  { id: 'research',    label: 'Research',     match: ['research', 'web_search', 'fetch_url', 'news', 'ask_ai', 'find out', 'look up', 'investigate', 'compare', 'summari'] },
  { id: 'comms',       label: 'Comms',        match: ['comms', 'gmail', 'calendar', 'triage_mail', 'notify_user', 'manage_schedule', 'drive', 'notion_write', 'notion_search', 'notion_log_activity', 'email', 'mail', 'meeting', 'schedule', 'reply', 'message'] },
  { id: 'orchestrate', label: 'Orchestrating', match: ['orchestrator', 'orchestrate', 'plan', 'plan_and_run', 'deploy_drones', 'agent_team', 'delegate_project', 'subagent', 'fleet', 'mission_plan', 'decompose', 'coordinate', 'supervise'] },
  { id: 'create',      label: 'Create',       match: ['creative', 'create', 'generate_image', 'generate_3d', 'make_asset', 'make_figure', 'make_printable', 'visual_build', 'blender', 'studio_write', 'davinci_resolve', 'design', 'render', 'image', 'video', 'model', 'draft'] },
  { id: 'memory',      label: 'Memory',       match: ['memory', 'save_memory', 'brain', 'recall', 'remember', 'graph', 'second brain', 'note'] },
  { id: 'forge',       label: 'Tool-forging', match: ['forge', 'forge_tool', 'toolforge', 'custom tool', 'build a tool', 'new tool', 'plugin'] },
];

// ── OKLCH, NOT HSL ────────────────────────────────────────────────────────────────────────────────
// The first version of this spaced hues evenly in HSL and the result was not evenly spaced to look
// at: nine designations over 298° put `code` at 108° and `research` at 141°, and in HSL's compressed
// green region those two are the same green at across-the-room size, while the identical 33° step
// between `orchestrate` (208°) and `create` (241°) reads as two obviously different colours. Equal
// numbers, unequal perception — which defeats the point of computing them.
//
// Oklch is perceptually near-uniform, so an equal hue step really is an equal-looking step, and
// fixing L and C means no designation is louder than its neighbours. Out-of-gamut combinations are
// brought back by REDUCING CHROMA rather than clipping channels, because clipping changes the hue
// (a clipped blue turns violet) and hue is the entire signal here.
function oklchToRgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s2 = s_ * s_ * s_;
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s2,
  ];
}
const inGamut = (rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);
const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** oklch(L, C, hue) → '#rrggbb', chroma-reduced until it fits sRGB so the hue survives intact. */
function oklch(L, C, Hdeg) {
  let c = C, rgb = oklchToRgb(L, c, Hdeg);
  // 40 halving-free steps is plenty: chroma never needs to drop more than ~60% at these lightnesses.
  for (let i = 0; i < 40 && !inGamut(rgb); i++) { c *= 0.95; rgb = oklchToRgb(L, c, Hdeg); }
  return '#' + rgb.map((v) => Math.round(255 * Math.min(1, Math.max(0, gamma(Math.min(1, Math.max(0, v)))))).toString(16).padStart(2, '0')).join('');
}

/** Oklab coordinates of an oklch triple — what perceptual distance is measured in. */
function oklab(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}
/** deltaE(a, b) — perceptual distance between two {L,C,hue}. ~0.02 is a just-noticeable difference. */
function deltaE(A, B) {
  const p = oklab(A.L, A.C, A.hue), q = oklab(B.L, B.C, B.hue);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// Two variants because the same colour cannot serve both surfaces:
//   glow — what the 3D office tints an avatar and its aura with. Light and chromatic; it is read at
//          distance under scene lighting, which desaturates everything it touches.
//   ink  — what a legend dot, a card border or a label uses. Darker, so it still clears WCAG AA
//          against the app's light surface (scripts/visual-doctor.js checks the rendered result).
const GLOW = { L: 0.74, C: 0.17 };
const INK = { L: 0.52, C: 0.15 };

const DESIGNATIONS = SPEC.map((d, i) => {
  const hue = Math.round((HUE_START + (HUE_SPAN * i) / SPEC.length) % 360);
  return { id: d.id, label: d.label, hue, glow: oklch(GLOW.L, GLOW.C, hue), ink: oklch(INK.L, INK.C, hue), match: d.match };
});

const BY_ID = new Map(DESIGNATIONS.map((d) => [d.id, d]));
// Anything unclassifiable is grey, never a real designation's colour. A wrong colour is worse than
// no colour: it asserts a division of labour that is not happening.
const UNKNOWN = { id: 'general', label: 'General', hue: null, glow: '#8fa6b8', ink: '#5c7386', match: [] };

/** get(id) → the designation, or the grey fallback. Never throws, never guesses. */
function get(id) { return BY_ID.get(String(id || '').toLowerCase()) || UNKNOWN; }

/**
 * classify(text) → designation id.
 *
 * Takes a role name, a tool name, a plan item, or a whole sentence — the supervisor has all four at
 * different moments and should not have to care which it holds. LONGEST MATCH WINS so a specific
 * token beats a generic substring of it: 'find_papers' contains neither 'research' nor 'code', but
 * 'make_model' contains 'model' (create) and is also science's — and science's token is longer.
 */
function classify(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return UNKNOWN.id;
  let best = null, bestLen = 0;
  for (const d of DESIGNATIONS) {
    for (const m of d.match) {
      if (s.includes(m) && m.length > bestLen) { best = d.id; bestLen = m.length; }
    }
  }
  return best || UNKNOWN.id;
}

/** The smallest angle between two hues, in degrees (0–180). */
function hueGap(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

/**
 * glowGap(a, b) — how far apart two designations LOOK, in Oklab units, at office brightness.
 *
 * This is the number the test asserts on, not the hue gap: hue degrees are the input, and the whole
 * reason this file moved to Oklch is that equal degrees are not equal appearance. A ninth designation
 * that crowds the wheel fails on this, which is the only version of the check worth having.
 */
function glowGap(a, b) {
  return deltaE({ ...GLOW, hue: get(a).hue }, { ...GLOW, hue: get(b).hue });
}

/** inReserved(hue) — is this hue inside the red error band? */
function inReserved(hue) { return hue >= RESERVED[0] || hue <= RESERVED[1]; }

/**
 * legend(active) → the rows a legend should show.
 *
 * Given the designations currently on the floor, return only those — a legend listing nine colours
 * when three agents are working is a legend nobody reads. Pass nothing for the full set.
 */
function legend(active) {
  const want = active && active.length ? new Set(active.map((x) => String(x).toLowerCase())) : null;
  const rows = DESIGNATIONS.filter((d) => !want || want.has(d.id)).map((d) => ({ id: d.id, label: d.label, ink: d.ink, glow: d.glow }));
  if (want && want.has(UNKNOWN.id)) rows.push({ id: UNKNOWN.id, label: UNKNOWN.label, ink: UNKNOWN.ink, glow: UNKNOWN.glow });
  return rows;
}

/**
 * forRenderer() → the plain-data block the 3D office and the cards embed.
 *
 * src/presence.html runs on file:// inside an iframe and cannot require() this module, so the values
 * are pushed in as data. Exporting the block from HERE is what stops the renderer keeping a second,
 * drifting copy of the palette — the failure this module exists to prevent.
 */
function forRenderer() {
  return {
    error: oklch(ERROR_LC.L, ERROR_LC.C, ERROR_HUE),
    errorInk: oklch(0.48, 0.19, ERROR_HUE),
    unknown: { id: UNKNOWN.id, label: UNKNOWN.label, glow: UNKNOWN.glow, ink: UNKNOWN.ink },
    designations: DESIGNATIONS.map(({ id, label, hue, glow, ink }) => ({ id, label, hue, glow, ink })),
  };
}

module.exports = { DESIGNATIONS, UNKNOWN, ERROR_HUE, ERROR_LC, RESERVED, GLOW, INK, get, classify, legend, hueGap, glowGap, inReserved, forRenderer, oklch, deltaE };
