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

  /* ── public surface ── */
  window.bhatbotTheme = {
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { watchOrb(); watchModel(); wireSettings(); });
  else { watchOrb(); watchModel(); wireSettings(); }
  setInterval(tick, 30000);
})();
