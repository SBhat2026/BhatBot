/* ── THEME CONTROLLER ─────────────────────────────────────────────────────────────────────────────
 *
 * Decides which of the three palettes in theme.css is active, and sets `data-theme` on <html>.
 *
 *     pinned  >  standby  >  night (after sunset)  >  day
 *
 * Standby beats the clock deliberately: "it is idling" is a fact about the system, and "it is 11pm"
 * is only a fact about the clock. If it is ticking over on its own at midnight you should see the
 * standby palette, because what the colour is telling you is what it is DOING.
 *
 * DESIGNED TO NEED NO EDITS ANYWHERE ELSE. The renderer is ~2,900 lines of inline script with 131
 * live DOM ids, and the cheapest way to avoid breaking it is to not touch it. So this file observes
 * rather than integrates:
 *   • activity is inferred from real user input events and from the orb's own data-state attribute,
 *     which the existing code already maintains;
 *   • sunrise and sunset are computed locally from config.geo (already set to Atco NJ) — no network,
 *     no key, and it follows the seasons rather than a fixed hour;
 *   • the theme only ever changes while the agent is idle, so a palette never swaps underneath you
 *     mid-sentence.
 *
 * window.bhatbotTheme = { set, auto, current, status } for the settings panel and ⌘⇧U.
 */
(function () {
  'use strict';

  var HTML = document.documentElement;
  var MODES = ['day', 'standby', 'night'];

  var cfg = {
    idleStandbyMs: 5 * 60 * 1000,   // how long idle before it reads as "ticking over on its own"
    lat: 39.7698, lon: -74.8874,    // config.geo default; overridden by configure()
    enabled: true,
  };

  var pinned = null;                 // an explicit choice always wins
  var lastActivity = Date.now();
  var agentBusy = false;
  var current = null;

  /* ── sunrise / sunset, computed rather than fetched ──────────────────────────────────────────────
   * NOAA's low-precision algorithm. Accurate to about a minute, which is far beyond what choosing a
   * colour needs, and it costs nothing and works offline. Returns { sunrise, sunset } as Date, or
   * null above the arctic circle / on a polar day where the sun does not cross the horizon.
   */
  function sunTimes(date, lat, lon) {
    var rad = Math.PI / 180, deg = 180 / Math.PI;
    var start = Date.UTC(date.getUTCFullYear(), 0, 0);
    var day = Math.floor((date.getTime() - start) / 86400000);

    function calc(isSunrise) {
      var lngHour = lon / 15;
      var t = day + ((isSunrise ? 6 : 18) - lngHour) / 24;
      var M = (0.9856 * t) - 3.289;                                   // mean anomaly
      var L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
      L = (L + 360) % 360;                                            // true longitude
      var RA = deg * Math.atan(0.91764 * Math.tan(L * rad));
      RA = (RA + 360) % 360;
      RA += (Math.floor(L / 90) * 90) - (Math.floor(RA / 90) * 90);   // same quadrant as L
      RA /= 15;
      var sinDec = 0.39782 * Math.sin(L * rad);
      var cosDec = Math.cos(Math.asin(sinDec));
      var zenith = 90.833;                                            // official, allows for refraction
      var cosH = (Math.cos(zenith * rad) - (sinDec * Math.sin(lat * rad))) / (cosDec * Math.cos(lat * rad));
      if (cosH > 1 || cosH < -1) return null;                         // sun never rises / never sets
      var H = (isSunrise ? 360 - deg * Math.acos(cosH) : deg * Math.acos(cosH)) / 15;
      var T = H + RA - (0.06571 * t) - 6.622;
      var UT = ((T - lngHour) % 24 + 24) % 24;
      var d = new Date(date);
      d.setUTCHours(Math.floor(UT), Math.round((UT % 1) * 60), 0, 0);
      return d;
    }
    var sr = calc(true), ss = calc(false);
    return (sr && ss) ? { sunrise: sr, sunset: ss } : null;
  }

  function isAfterDark(now) {
    var t = sunTimes(now || new Date(), cfg.lat, cfg.lon);
    if (!t) return false;                                             // no horizon crossing → stay light
    var ms = (now || new Date()).getTime();
    return ms < t.sunrise.getTime() || ms >= t.sunset.getTime();
  }

  /* ── what it should be right now ── */
  function resolve() {
    if (pinned) return pinned;
    if (!cfg.enabled) return 'night';                                 // opt-out keeps the original HUD
    if (isAfterDark()) return 'night';
    if (!agentBusy && (Date.now() - lastActivity) >= cfg.idleStandbyMs) return 'standby';
    return 'day';
  }

  function apply(mode, why) {
    if (!MODES.includes(mode) || mode === current) return current;
    current = mode;
    HTML.setAttribute('data-theme', mode);
    try { window.bhatbot && window.bhatbot.syncWorkspaceTheme && window.bhatbot.syncWorkspaceTheme(); } catch {}
    try {
      HTML.dispatchEvent(new CustomEvent('bhatbot-theme', { detail: { mode: mode, why: why || '' } }));
    } catch (e) { /* older webview */ }
    return mode;
  }

  /* A theme never changes mid-turn. Swapping the palette while he is speaking is the interface
     moving under the person using it, which is worse than being the wrong colour for a minute. */
  function tick() {
    var want = resolve();
    if (want === current) return;
    if (agentBusy && want !== pinned) return;                         // wait for the turn to finish
    apply(want, 'auto');
  }

  /* ── activity ────────────────────────────────────────────────────────────────────────────────────
   * Real input only. A mousemove from a bumped desk should not count as presence, so pointer moves
   * are excluded and only deliberate acts reset the clock.
   */
  ['keydown', 'pointerdown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastActivity = Date.now(); tick(); }, { passive: true, capture: true });
  });

  /* The orb already carries the agent's state in an attribute the existing renderer maintains, so
     busy-ness can be read without touching that code at all. */
  function watchOrb() {
    var orb = document.getElementById('orb');
    if (!orb || typeof MutationObserver === 'undefined') return;
    var read = function () {
      var s = orb.getAttribute('data-state') || 'idle';
      var busy = (s !== 'idle');
      if (busy) lastActivity = Date.now();
      agentBusy = busy;
      tick();
    };
    new MutationObserver(read).observe(orb, { attributes: true, attributeFilter: ['data-state'] });
    read();
  }


  /* ── MODEL TIER ──────────────────────────────────────────────────────────────────────────────────
   * Derived by OBSERVATION, not integration. The renderer already writes the live model into
   * #railmodel on every `provider_used` event ("CLAUDE · SONNET-5"), so the tier can be read from
   * the DOM without touching the 2,900-line renderer script or adding an IPC listener.
   *
   * Unrecognised models fall to 'standard' rather than to a guess: a wrong tier is a lie about how
   * hard the machine is working, and the neutral middle is the honest default.
   */
  function tierFor(model) {
    var m = String(model || '').toLowerCase();
    if (!m) return null;
    if (/qwen|gemma|llama|mistral|phi|ollama|local/.test(m)) return 'local';
    if (/astra|gpt-6|opus/.test(m)) return /astra|gpt-6/.test(m) ? 'frontier' : 'heavy';
    if (/haiku/.test(m)) return 'local';
    if (/sonnet|terra|gpt-5/.test(m)) return 'standard';
    return 'standard';
  }

  function watchModel() {
    var rail = document.getElementById('railmodel');
    var orb = document.getElementById('orb');
    if (!rail || !orb || typeof MutationObserver === 'undefined') return;
    var read = function () {
      var t = tierFor(rail.textContent.replace(/^CLAUDE\s*·\s*/i, ''));
      if (t) orb.setAttribute('data-tier', t);
    };
    new MutationObserver(read).observe(rail, { childList: true, characterData: true, subtree: true });
    read();
  }


  /* ── the settings control ────────────────────────────────────────────────────────────────────────
   * Wired from here rather than from the renderer so that script stays untouched. "Auto" is a real
   * option, not the absence of one: unpinning is the state people want back after trying a palette,
   * and a row of three buttons with no way out cannot express it.
   */
  function wireSettings() {
    var row = document.getElementById('set-theme-row');
    if (!row) return;
    var msg = document.getElementById('set-theme-msg');
    var paint = function () {
      var want = pinned || 'auto';
      row.querySelectorAll('[data-theme-set]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === want));
      });
      if (msg) {
        var st = window.bhatbotTheme.status();
        var sunset = st.sunset ? st.sunset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        msg.textContent = pinned
          ? 'Pinned to ' + pinned + '.'
          : 'Auto — showing ' + current + '. Sunset today at ' + sunset + '.';
      }
    };
    row.addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme-set]');
      if (!b) return;
      var v = b.getAttribute('data-theme-set');
      window.bhatbotTheme.set(v === 'auto' ? null : v);
      paint();
    });
    try { HTML.addEventListener('bhatbot-theme', paint); } catch (e) {}
    paint();
  }

  /* ── THE ACCENT FOLLOWS THE SUN ──────────────────────────────────────────────────────────────────
   * 2026-11-25: "a gradient which slowly shifts from one to another as the day passes by, with
   * burgundy in the daytime and teal-blue at night."
   *
   * One accent for every palette, mixed continuously: pure burgundy at solar noon, pure teal-blue at
   * solar midnight, and halfway at sunrise and sunset. The mix runs in OKLCH along the SHORT way
   * round the hue wheel (burgundy → plum → indigo → teal), because RGB and OKLab both cut straight
   * through the middle of the colour space and pass through a muddy grey-brown at dusk.
   *
   * The palette still decides the ground; the accent only decides the ink. Light grounds (day,
   * standby) mix the deep pair; the dark night ground mixes a lighter pair so the accent keeps
   * ≥4.5:1 against near-black. Written as inline custom properties on <html>, which outrank the
   * :root[data-theme] blocks in theme.css — so every rgba(var(--accent-rgb), α) follows for free.
   */
  var ACCENTS = {
    light: { // [burgundy (noon), teal-blue (midnight)] — the orb stops are the standby and day orbs
      accent: ['#7A2E3E', '#0B6E8C'], ink: ['#6B2333', '#085468'], dim: ['#BCA6A6', '#7FA9BA'],
      orbCore: ['#C07A88', '#7FD3E8'], orbMid: ['#7E2B3C', '#1E8FAF'], orbRim: ['#4E1C27', '#0B6E8C'],
    },
    dark: {
      accent: ['#D9728A', '#2FA8C8'], ink: ['#EB95A8', '#5CC6E0'], dim: ['#5A2230', '#0E4A5E'],
      orbCore: ['#E8A0B0', '#8FE3F5'], orbMid: ['#B04860', '#2FA8C8'], orbRim: ['#5A2230', '#0E5F78'],
    },
  };
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function unlin(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); }
  function toOklch(rgb) {
    var r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return [L, Math.sqrt(A * A + B * B), Math.atan2(B, A)];
  }
  function fromOklch(L, C, h) {
    var A = C * Math.cos(h), B = C * Math.sin(h);
    var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    var m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    var s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
    return [unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            unlin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  function mix(pair, t) {
    var a = toOklch(hexRgb(pair[0])), b = toOklch(hexRgb(pair[1]));
    var dh = b[2] - a[2];
    if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;   // short way round
    return fromOklch(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + dh * t);
  }
  /** 0 = solar noon (burgundy) … 1 = solar midnight (teal-blue). A cosine, so it never jumps. */
  function nightness(now) {
    now = now || new Date();
    var t = sunTimes(now, cfg.lat, cfg.lon);
    var noon = t ? (t.sunrise.getTime() + t.sunset.getTime()) / 2
                 : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
    var phase = ((now.getTime() - noon) / 86400000) * 2 * Math.PI;
    return 0.5 - 0.5 * Math.cos(phase);
  }
  var accentMix = null;
  function paintAccent(now) {
    var t = nightness(now);
    var set = ACCENTS[current === 'night' ? 'dark' : 'light'];
    var key = (current === 'night' ? 'd' : 'l') + Math.round(t * 200);   // 0.5% steps; skip no-op repaints
    if (key === accentMix) return;
    accentMix = key;
    var a = mix(set.accent, t), ink = mix(set.ink, t), dim = mix(set.dim, t);
    var hex = function (c) { return '#' + c.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''); };
    var st = HTML.style, rgb = a.join(', ');
    st.setProperty('--accent', hex(a));
    st.setProperty('--accent-rgb', rgb);
    st.setProperty('--accent-soft', 'rgba(' + rgb + ', ' + (current === 'night' ? 0.10 : 0.09) + ')');
    st.setProperty('--accent-line', 'rgba(' + rgb + ', ' + (current === 'night' ? 0.34 : 0.32) + ')');
    st.setProperty('--accent-ink', hex(ink));
    st.setProperty('--accent-dim', hex(dim));
    // The orb is the accent's biggest surface: a burgundy UI around a teal orb was two palettes at once.
    var rim = mix(set.orbRim, t);
    st.setProperty('--orb-core', hex(mix(set.orbCore, t)));
    st.setProperty('--orb-mid', hex(mix(set.orbMid, t)));
    st.setProperty('--orb-rim', hex(rim));
    st.setProperty('--orb-glow', 'rgba(' + rim.join(', ') + ', 0.28)');
    HTML.setAttribute('data-accent-mix', t.toFixed(3));
    // Canvases cache the accent as a string (index.html accentRGB); tell them it moved.
    try { HTML.dispatchEvent(new CustomEvent('bhatbot-accent', { detail: { mix: t } })); } catch (e) {}
  }
  try { HTML.addEventListener('bhatbot-theme', function () { accentMix = null; paintAccent(); }); } catch (e) {}

  /* ── public surface ── */
  window.bhatbotTheme = {
    accentAt: function (date) { return { nightness: nightness(date) }; },
    paintAccent: paintAccent,
    /** Pin a palette. set(null) hands control back to the automatic rule. */
    set: function (mode) {
      pinned = MODES.includes(mode) ? mode : null;
      apply(pinned || resolve(), pinned ? 'pinned' : 'unpinned');
      return current;
    },
    /** Called by the settings panel with the live config. */
    configure: function (o) {
      o = o || {};
      if (o.geo && typeof o.geo.latitude === 'number') { cfg.lat = o.geo.latitude; cfg.lon = o.geo.longitude; }
      if (typeof o.idleStandbyMinutes === 'number') cfg.idleStandbyMs = o.idleStandbyMinutes * 60000;
      // `uiTheme: 'hud'` is the documented escape hatch and keeps the original dark HUD permanently.
      if (o.uiTheme === 'hud') { pinned = 'night'; }
      else if (MODES.includes(o.uiTheme)) { pinned = o.uiTheme; }
      if (o.autoTheme === false) cfg.enabled = false;
      apply(pinned || resolve(), 'configure');
      return current;
    },
    current: function () { return current; },
    tierFor: tierFor,
    status: function () {
      var t = sunTimes(new Date(), cfg.lat, cfg.lon);
      return {
        mode: current, pinned: pinned, agentBusy: agentBusy,
        idleMs: Date.now() - lastActivity,
        sunrise: t && t.sunrise, sunset: t && t.sunset, afterDark: isAfterDark(),
      };
    },
  };

  /* ⌘⇧U / Ctrl⇧U cycles day → standby → night → auto. The fourth press unpins, which is the state
     people actually want back and which a two-way toggle cannot express. */
  window.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || (e.key || '').toLowerCase() !== 'u') return;
    e.preventDefault();
    var order = ['day', 'standby', 'night', null];
    var i = order.indexOf(pinned);
    window.bhatbotTheme.set(order[(i + 1) % order.length]);
  });

  apply(resolve(), 'boot');
  paintAccent();
  setInterval(function () { paintAccent(); }, 60000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { watchOrb(); watchModel(); wireSettings(); });
  else { watchOrb(); watchModel(); wireSettings(); }
  setInterval(tick, 30000);
})();
