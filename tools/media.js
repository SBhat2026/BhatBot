'use strict';
// Media control — Spotify (local AppleScript + Web API / Connect) + system volume.
// Extracted from main.js (SPLIT_PLAN step 7, C 2/2). osa/osaErr are SHARED with browser/system,
// so they (and loadConfig/saveConfig) are injected via ctx. `fetch` is a Node/Electron global.
//   ctx = { loadConfig, saveConfig, osa, osaErr }
module.exports = function makeMediaTools({ loadConfig, saveConfig, osa, osaErr }) {

// Spotify "play X by name" needs a track URI — AppleScript's `play track` rejects plain
// names. We resolve name→URI via the Spotify Web API (client-credentials = only a client
// id+secret, no user OAuth), then play that URI locally over AppleScript.
async function spotifyToken(c) {
  if (!c.spotifyClientId || !c.spotifyClientSecret) return null;
  try {
    const auth = Buffer.from(`${c.spotifyClientId}:${c.spotifyClientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}
async function spotifySearchUri(c, query) {
  const tok = await spotifyToken(c); if (!tok) return null;
  try {
    const r = await fetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(query)}`, { headers: { Authorization: 'Bearer ' + tok } });
    if (!r.ok) return null;
    const it = (((await r.json()).tracks || {}).items || [])[0];
    return it ? { uri: it.uri, label: `${it.name} — ${it.artists.map((a) => a.name).join(', ')}` } : null;
  } catch { return null; }
}

// --- Spotify Connect (Web API, user OAuth) — control playback on ANY device (phone,
// Mac, speakers) from anywhere. Needs a one-time login (scripts/spotify-auth.js stores
// spotifyRefreshToken) + Spotify Premium. Lets the phone PWA play ON the phone. ---
let _spotUserTok = { token: null, exp: 0 };
async function spotifyUserToken(c) {
  if (!c.spotifyRefreshToken) return null;
  if (_spotUserTok.token && Date.now() < _spotUserTok.exp - 10000) return _spotUserTok.token;
  try {
    const auth = Buffer.from(`${c.spotifyClientId}:${c.spotifyClientSecret}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.spotifyRefreshToken }).toString()
    });
    if (!r.ok) return null;
    const j = await r.json();
    _spotUserTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return _spotUserTok.token;
  } catch { return null; }
}
async function spotifyApi(c, method, p, body) {
  const tok = await spotifyUserToken(c);
  if (!tok) return { status: 401, ok: false, error: 'Spotify not linked — run `node ~/bhatbot/scripts/spotify-auth.js` once to log in.' };
  try {
    const r = await fetch('https://api.spotify.com/v1' + p, {
      method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    return { status: r.status, ok: r.ok, json: j, text: txt };
  } catch (e) { return { status: 0, ok: false, error: e.message }; }
}
async function spotifyDevices(c) {
  const r = await spotifyApi(c, 'GET', '/me/player/devices');
  const live = (r.json && r.json.devices) || [];
  // Remember every device we ever see (Spotify drops idle phones from the live list),
  // so we can still list + target them by a stable id later → "permanent" devices.
  try {
    const cache = { ...(c.spotifyDevices || {}) };
    for (const d of live) cache[d.id] = { id: d.id, name: d.name, type: d.type, lastSeen: Date.now() };
    saveConfig({ spotifyDevices: cache });
  } catch {}
  return live;
}
function matchDev(list, n) {
  return list.find((d) => d.name.toLowerCase().includes(n))
    || (/phone|iphone|mobile/.test(n) && list.find((d) => d.type === 'Smartphone'))
    || (/mac|computer|laptop|desktop/.test(n) && list.find((d) => d.type === 'Computer')) || null;
}
function pickDevice(devices, name, c) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const live = matchDev(devices, n);
  if (live) return { ...live, _live: true };
  // Fall back to a remembered device (may be asleep) — we'll try it and report if offline.
  const cached = matchDev(Object.values((c && c.spotifyDevices) || {}), n);
  return cached ? { ...cached, _live: false } : null;
}
function connErr(r) {
  if (r.error) return r.error;
  if (r.status === 404) return 'No active Spotify device. Open Spotify on the target device, then try "transfer to <device>".';
  if (r.status === 403) return 'Spotify rejected it — Connect playback control requires Spotify Premium.';
  return `Spotify API ${r.status}${r.text ? ': ' + r.text.slice(0, 160) : ''}`;
}
async function spotifyConnect(c, a, q, vol, deviceName) {
  const devices = await spotifyDevices(c);
  const dev = pickDevice(devices, deviceName, c);
  if (deviceName && !dev) {
    const known = Object.values(c.spotifyDevices || {}).map((d) => d.name);
    return { success: false, error: `Device "${deviceName}" not found. Open Spotify there first. Online: ${devices.map((d) => d.name).join(', ') || 'none'}.${known.length ? ' Known: ' + known.join(', ') + '.' : ''}` };
  }
  // Auto-target a device when the user didn't name one. Spotify often reports the Mac
  // app as is_active:false even while open — passing device_id on the play/control call
  // WAKES it, so we must always target a concrete device, never rely on "currently active".
  const computer = devices.find((d) => d.type === 'Computer');
  const active = devices.find((d) => d.is_active);
  const target = dev || active || computer || devices[0] || null;
  const dq = target && target._live !== false ? `?device_id=${target.id}` : (target ? `?device_id=${target.id}` : '');
  const ok = (r, msg) => (r.ok || r.status === 204) ? { success: true, result: msg } : { success: false, error: connErr(r) };
  switch (a) {
    case 'list_devices': {
      const liveIds = new Set(devices.map((d) => d.id));
      const cached = Object.values(c.spotifyDevices || {}).filter((d) => !liveIds.has(d.id));
      const lines = [
        ...devices.map((d) => `${d.name} (${d.type})${d.is_active ? ' [active]' : ' [online]'}`),
        ...cached.map((d) => `${d.name} (${d.type}) [offline — open Spotify on it]`),
      ];
      return { success: true, result: lines.length ? lines.join('\n') : 'No Spotify devices known yet. Open the Spotify app on your phone/Mac once to register it.' };
    }
    case 'transfer':
      if (!dev) return { success: false, error: 'No device matched. Run list_devices to see options.' };
      if (!dev._live) return { success: false, error: `${dev.name} is offline. Open Spotify on it, then transfer.` };
      return ok(await spotifyApi(c, 'PUT', '/me/player', { device_ids: [dev.id], play: true }), `Playback moved to ${dev.name}`);
    case 'pause':    return ok(await spotifyApi(c, 'PUT', '/me/player/pause' + dq), 'Paused');
    case 'resume':   return ok(await spotifyApi(c, 'PUT', '/me/player/play' + dq), 'Resumed');
    case 'next':     return ok(await spotifyApi(c, 'POST', '/me/player/next' + dq), 'Skipped');
    case 'previous': return ok(await spotifyApi(c, 'POST', '/me/player/previous' + dq), 'Previous track');
    case 'set_volume': return ok(await spotifyApi(c, 'PUT', `/me/player/volume?volume_percent=${vol}${target ? '&device_id=' + target.id : ''}`), `Volume ${vol}%`);
    case 'get_now_playing': {
      const r = await spotifyApi(c, 'GET', '/me/player/currently-playing');
      if (r.status === 204 || !r.json || !r.json.item) return { success: true, result: 'Nothing playing.' };
      const it = r.json.item;
      return { success: true, result: `${it.name} — ${it.artists.map((x) => x.name).join(', ')}${r.json.is_playing ? '' : ' (paused)'}` };
    }
    case 'play_track':
    case 'search_and_play': {
      if (!q) return { success: false, error: 'no query' };
      let uri = q, label = q;
      if (!/^spotify:|^https?:\/\/open\.spotify\.com/.test(q)) {
        const hit = await spotifySearchUri(c, q);
        if (!hit) return { success: false, error: `No match for "${q}".` };
        uri = hit.uri; label = hit.label;
      }
      if (!target) return { success: false, error: `No Spotify devices found. Open the Spotify app on your Mac or phone (and start any track once so it registers), then try again.` };
      // First attempt: play directly on the target (this wakes an inactive Mac).
      let pr = await spotifyApi(c, 'PUT', '/me/player/play' + dq, { uris: [uri] });
      // If Spotify says the device isn't ready (404), transfer playback to it then retry.
      if (pr.status === 404) {
        await spotifyApi(c, 'PUT', '/me/player', { device_ids: [target.id], play: false });
        await new Promise((r) => setTimeout(r, 600));
        pr = await spotifyApi(c, 'PUT', '/me/player/play' + dq, { uris: [uri] });
      }
      return ok(pr, `▶ ${label} on ${target.name}`);
    }
    default: return { success: false, error: `Unknown action: ${a}` };
  }
}

async function mediaControl(input) {
  const c = loadConfig();
  const a = input.action;
  const q = (input.query || '').trim();
  const vol = Math.max(0, Math.min(100, Number(input.volume)));
  const spotify = (body) => ['-e', `tell application "Spotify" to ${body}`];

  if (a === 'set_system_volume') {
    const r = await osa(['-e', `set volume output volume ${vol}`]);
    return r.ok ? { success: true, result: `System volume ${vol}%` } : { success: false, error: osaErr(r) };
  }
  // Create a playlist (+ optionally fill it) via the Web API. Needs the playlist-modify
  // scopes — re-run scripts/spotify-auth.js once if the token predates them (→ 403).
  if (a === 'make_playlist') {
    if (!c.spotifyRefreshToken) return { success: false, error: 'Spotify not linked — run `node ~/bhatbot/scripts/spotify-auth.js` once (needs Premium) to enable playlists.' };
    const scopeHint = 'Spotify token is missing playlist scopes — re-run `node ~/bhatbot/scripts/spotify-auth.js` to grant playlist access, then try again.';
    const me = await spotifyApi(c, 'GET', '/me');
    if (!me.ok || !me.json) return { success: false, error: me.status === 403 ? scopeHint : connErr(me) };
    const name = (input.name || q || 'BhatBot Playlist').slice(0, 100);
    const isPublic = input.public === true;
    const cr = await spotifyApi(c, 'POST', `/users/${encodeURIComponent(me.json.id)}/playlists`,
      { name, description: (input.description || 'Made by BhatBot').slice(0, 300), public: isPublic });
    if (!cr.ok || !cr.json) return { success: false, error: cr.status === 403 ? scopeHint : connErr(cr) };
    const pid = cr.json.id, url = (cr.json.external_urls || {}).spotify || '';
    // Resolve each track query → a Spotify URI (tracks: array of "song artist" strings).
    const seeds = Array.isArray(input.tracks) ? input.tracks : (q && !input.name ? [] : []);
    const uris = [], missed = [];
    for (const s of seeds.slice(0, 100)) { const hit = await spotifySearchUri(c, String(s)); if (hit) uris.push(hit.uri); else missed.push(String(s)); }
    if (uris.length) {
      const ar = await spotifyApi(c, 'POST', `/playlists/${pid}/tracks`, { uris });
      if (!ar.ok) return { success: true, result: `Created "${name}" (couldn't add tracks: ${connErr(ar)}). ${url}` };
    }
    return { success: true, result: `Created playlist "${name}" with ${uris.length} track(s)${missed.length ? ` (no match: ${missed.join(', ')})` : ''}. ${url}` };
  }
  // Spotify Connect path (controls any device incl. the phone) when linked AND a device
  // is targeted, device listing/transfer is asked, or Connect is the configured default.
  if (c.spotifyRefreshToken && (input.device || a === 'list_devices' || a === 'transfer' || c.spotifyUseConnect)) {
    return spotifyConnect(c, a, q, vol, input.device);
  }
  if (a === 'list_devices' || a === 'transfer') {
    return { success: false, error: 'Spotify Connect not linked. Run `node ~/bhatbot/scripts/spotify-auth.js` once (needs Premium) to control your phone/other devices.' };
  }
  // Make sure Spotify is up before any Spotify action (avoids "app not running" failures).
  await osa(['-e', 'if application "Spotify" is not running then tell application "Spotify" to activate']);

  if (a === 'get_now_playing') {
    const st = await osa(spotify('return player state'));
    if (!st.ok) return { success: false, error: osaErr(st) };
    if (st.out !== 'playing' && st.out !== 'paused') return { success: true, result: `Spotify is ${st.out || 'stopped'} — nothing playing.` };
    const np = await osa(spotify('return name of current track & " — " & artist of current track'));
    return np.ok ? { success: true, result: (st.out === 'paused' ? '(paused) ' : '') + np.out } : { success: false, error: osaErr(np) };
  }

  if (a === 'play_track' || a === 'search_and_play') {
    if (!q) return { success: false, error: 'no query' };
    if (/^spotify:|^https?:\/\/open\.spotify\.com/.test(q)) {           // already a URI/URL
      const r = await osa(spotify(`play track "${q.replace(/"/g, '')}"`));
      return r.ok ? { success: true, result: `Playing ${q}` } : { success: false, error: osaErr(r) };
    }
    const hit = await spotifySearchUri(c, q);                            // name → URI via Web API
    if (hit) {
      const r = await osa(spotify(`play track "${hit.uri}"`));
      return r.ok ? { success: true, result: `▶ ${hit.label}` } : { success: false, error: osaErr(r) };
    }
    // No Spotify Web API creds → can't resolve a name to a track. Open the in-app search.
    await osa(['-e', `open location "spotify:search:${encodeURIComponent(q)}"`]);
    return { success: true, result: `Opened Spotify search for "${q}". To play by name directly, set spotifyClientId + spotifyClientSecret in ~/.bhatbot/config.json (free Spotify developer app).` };
  }

  let args;
  switch (a) {
    case 'pause':    args = spotify('pause'); break;
    case 'resume':   args = spotify('play'); break;
    case 'next':     args = spotify('next track'); break;
    case 'previous': args = spotify('previous track'); break;
    case 'set_volume': args = spotify(`set sound volume to ${vol}`); break;
    default: return { success: false, error: `Unknown action: ${a}` };
  }
  const r = await osa(args);
  return r.ok ? { success: true, result: r.out || 'done' } : { success: false, error: osaErr(r) };
}

  return { mediaControl, spotifyConnect, spotifySearchUri, spotifyToken };
};
