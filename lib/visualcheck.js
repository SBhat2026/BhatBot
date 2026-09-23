'use strict';
// ── ASSERTIONS ABOUT WHAT IS ON SCREEN ────────────────────────────────────────────────────────────
// There are already three scripts in this repo that render the UI and save PNGs. Not one of them
// FAILS — they produce pictures for a human to look at, and when nobody looks, a regression ships.
// That is how the centre of the COMMAND view came to be empty for weeks with the orb sitting at 0×0,
// how the office rendered its characters as silhouettes against a light theme, and how SYNAPSE drew
// a blank white field indistinguishable from a broken panel.
//
// A screenshot cannot tell me any of that. Geometry and computed style can, exactly:
//   • an element that should be visible is 0×0, or clipped, or fully transparent;
//   • text whose contrast against its ACTUAL painted background is unreadable;
//   • content wider than the box meant to hold it;
//   • two things the user is supposed to click sitting on top of each other;
//   • a canvas with nothing drawn in it.
//
// PURE. Every function here takes a plain snapshot — collected in the page by the driver — and
// returns findings. No browser, no DOM, no I/O, so the rules are testable without rendering anything.

/** WCAG relative luminance. */
function luminance({ r, g, b }) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1..21. */
function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function parseColor(s) {
  const m = String(s || '').match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x));
  return { r, g, b, a: a == null ? 1 : a };
}

// WCAG AA: 4.5 for body text, 3.0 for large text (>=24px, or >=18.66px bold). Applied as written
// rather than softened, because "it looked fine on my screen" is what produced the silhouettes.
const AA_NORMAL = 4.5, AA_LARGE = 3.0;
function requiredContrast(fontPx, weight) {
  const large = fontPx >= 24 || (fontPx >= 18.66 && Number(weight) >= 700);
  return large ? AA_LARGE : AA_NORMAL;
}

/**
 * check(snapshot) → findings[]
 *
 * snapshot.elements: [{ sel, w, h, x, y, display, visibility, opacity, color, bg, fontPx, weight,
 *                       text, scrollW, clientW, clientH, scrollH, interactive, shouldShow, isCanvas, canvasBlank }]
 * Each finding: { level: 'error'|'warn', rule, sel, detail }
 */
function check(snapshot = {}) {
  const els = snapshot.elements || [];
  const out = [];
  const add = (level, rule, sel, detail) => out.push({ level, rule, sel, detail });

  for (const e of els) {
    const hidden = e.display === 'none' || e.visibility === 'hidden' || Number(e.opacity) === 0;

    // 1. INVISIBLE WHEN IT SHOULD BE VISIBLE. The orb was `display:block` and 0×0 for weeks — present
    //    in the DOM, absent on screen, and invisible to every test that only asked whether it existed.
    if (e.shouldShow) {
      if (hidden) { add('error', 'hidden', e.sel, `should be visible but is ${e.display === 'none' ? 'display:none' : e.visibility === 'hidden' ? 'visibility:hidden' : 'opacity:0'}`); continue; }
      if (!e.w || !e.h) { add('error', 'zero-size', e.sel, `renders at ${e.w}×${e.h} — in the DOM, absent on screen`); continue; }
    }
    if (hidden) continue;          // everything below is about things that ARE painted

    // 2. UNREADABLE TEXT against the background it is actually painted on — not the one it inherits
    //    on paper. This is what turned the office characters into silhouettes on the light themes.
    if (e.text && e.color && e.bg) {
      const fg = parseColor(e.color), bg = parseColor(e.bg);
      if (fg && bg && fg.a > 0.1) {
        const need = requiredContrast(e.fontPx, e.weight);
        const got = contrast(fg, bg);
        if (got < need) add(got < need * 0.75 ? 'error' : 'warn', 'contrast', e.sel,
          `${got.toFixed(2)}:1 against its painted background, needs ${need}:1 (${e.fontPx}px${Number(e.weight) >= 700 ? ' bold' : ''}) — "${String(e.text).slice(0, 40)}"`);
      }
    }

    // 3. CONTENT WIDER THAN ITS BOX — but only where that actually COSTS something. An element with
    //    `overflow: visible` painting outside its bounds is how every glow, ring and drop-shadow
    //    works; the orb legitimately spills 21px of halo past a 232px box and nothing is lost. The
    //    finding is only real when the overflow is CLIPPED or turned into a scrollbar.
    const clips = /hidden|auto|scroll|clip/.test(String(e.overflowX || e.overflow || ''));
    if (clips && e.scrollW && e.clientW && e.scrollW - e.clientW > 8) {
      add('warn', 'overflow-x', e.sel, `content is ${e.scrollW}px wide in a ${e.clientW}px box with overflow:${e.overflowX || e.overflow} — ${e.scrollW - e.clientW}px is cut off or scrolls`);
    }

    // 4. A CANVAS THAT DREW NOTHING. Blank is indistinguishable from broken, which is precisely what
    //    made the empty SYNAPSE panel look like a failure to load.
    if (e.isCanvas && e.canvasBlank) {
      add('warn', 'blank-canvas', e.sel, 'canvas is present and entirely uniform — nothing was drawn, or nothing had been loaded yet');
    }
  }

  // 5. INVARIANTS — facts about the SCREEN, not about one element.
  //
  // `shouldShow` per element cannot express "the input bar is visible unless voice-first hid it", and
  // asserting it unconditionally produced a false error on exactly that. What is actually guaranteed
  // is weaker and more useful: there is ALWAYS a way to reach BhatBot. Either the voice stage is up
  // or the text bar is — losing both is the real failure, and it is one nobody would notice in a
  // screenshot because the rest of the page looks perfectly healthy.
  const shown = (sel) => {
    const e = els.find((x) => x.sel === sel);
    return !!(e && e.w > 0 && e.h > 0 && e.display !== 'none' && e.visibility !== 'hidden' && Number(e.opacity) !== 0);
  };
  for (const inv of (snapshot.invariants || [])) {
    if (!inv || !Array.isArray(inv.anyOf)) continue;
    if (!inv.anyOf.some(shown)) {
      add('error', 'invariant', inv.name, `${inv.detail || 'none of these is visible'}: ${inv.anyOf.join(' / ')}`);
    }
  }

  // 6. TWO THINGS TO CLICK, IN THE SAME PLACE. Whichever is on top silently eats the other.
  const clickable = els.filter((e) => e.interactive && e.w > 0 && e.h > 0 && e.display !== 'none' && e.visibility !== 'hidden');
  for (let i = 0; i < clickable.length; i++) {
    for (let j = i + 1; j < clickable.length; j++) {
      const a = clickable[i], b = clickable[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox <= 2 || oy <= 2) continue;
      const overlap = ox * oy;
      const smaller = Math.min(a.w * a.h, b.w * b.h);
      // Only a SUBSTANTIAL overlap of two separate controls; nesting (a button inside a toolbar)
      // is normal and would otherwise drown the report in noise.
      if (overlap > smaller * 0.6 && !a.sel.includes(b.sel) && !b.sel.includes(a.sel)) {
        add('warn', 'overlap', `${a.sel} / ${b.sel}`, `two interactive elements overlap by ${Math.round((overlap / smaller) * 100)}% — one is unclickable`);
      }
    }
  }
  return out;
}

module.exports = { check, contrast, luminance, parseColor, requiredContrast, AA_NORMAL, AA_LARGE };
