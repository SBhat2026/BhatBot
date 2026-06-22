'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// FIFA World Cup 2026 — live bracket + predictive engine (self-contained, no API key).
//
// Data: ESPN's public soccer feed (league "fifa.world"). We pull every fixture in the
// tournament window, compute group tables ourselves (FIFA tiebreakers), maintain a World-
// Football-style Elo updated from real results, and run a Monte-Carlo of the rest of the
// tournament for advancement / title odds + match-level win/draw/loss predictions.
//
// Pure-ish: only `fetch` + Math. No Electron/fs, so it runs standalone (`node lib/worldcup.js`)
// for the self-improvement harness and is trivially testable.
// ─────────────────────────────────────────────────────────────────────────────

const LEAGUE = 'fifa.world';
const SB = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard`;
const WINDOW = '20260611-20260719';      // 2026 tournament span (group stage → final)

// Seed Elo by ESPN abbreviation (World-Football-Elo scale). Unlisted teams start at DEFAULT and
// self-correct from results as the tournament plays out. Approximate, pre-tournament strengths.
const SEED = {
  ARG: 2100, FRA: 2080, ESP: 2060, BRA: 2040, ENG: 2010, POR: 1990, NED: 1965, GER: 1960,
  BEL: 1945, ITA: 1940, CRO: 1905, URU: 1900, COL: 1885, MAR: 1875, MEX: 1825, USA: 1820,
  SUI: 1820, JPN: 1835, SEN: 1820, DEN: 1825, ECU: 1800, AUT: 1820, KOR: 1790, AUS: 1755,
  CAN: 1785, POL: 1800, UKR: 1790, SRB: 1790, WAL: 1780, TUN: 1700, IRN: 1740, QAT: 1650,
  GHA: 1720, CMR: 1720, CIV: 1730, EGY: 1740, ALG: 1760, NGA: 1750, RSA: 1700, CPV: 1640,
  KSA: 1660, IRQ: 1640, JOR: 1620, UZB: 1660, NZL: 1600, PAN: 1660, CRC: 1700, HON: 1640,
  PAR: 1740, PER: 1720, CHI: 1720, BOL: 1600, VEN: 1700, HAI: 1560, CUW: 1560, SCO: 1790,
  NOR: 1820, TUR: 1810, GRE: 1760, CZE: 1770,
};
const DEFAULT_ELO = 1610;
const MU = 1.32;                          // baseline expected goals per side at parity
const HOME_ADV = 35;                      // small nominal home edge (ESPN flags home/away)

// ── fetch + parse ────────────────────────────────────────────────────────────
async function fetchEvents(window = WINDOW) {
  const r = await fetch(`${SB}?dates=${window}&limit=300`, { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.events)) throw new Error('no events array in feed');
  return j.events;
}

// One match → normalized record. ESPN lists competitor[0]=home, [1]=away for soccer.
function parseMatch(ev) {
  const c = (ev.competitions || [])[0]; if (!c) return null;
  const cs = c.competitors || []; if (cs.length < 2) return null;
  const H = cs.find((x) => x.homeAway === 'home') || cs[0];
  const A = cs.find((x) => x.homeAway === 'away') || cs[1];
  const st = (c.status || ev.status || {}).type || {};
  const team = (t) => ({ id: t.team && t.team.id, abbr: (t.team && t.team.abbreviation) || '?', name: (t.team && (t.team.displayName || t.team.name)) || '?' });
  const gm = String(c.altGameNote || '').match(/Group\s+([A-L])/i);
  return {
    id: ev.id,
    date: ev.date,
    group: gm ? gm[1].toUpperCase() : null,    // official group letter from ESPN's altGameNote
    stage: ((ev.season || {}).slug) || 'group-stage',
    state: st.state || 'pre',                 // pre | in | post
    completed: !!st.completed,
    home: team(H), away: team(A),
    hs: H.score != null && H.score !== '' ? Number(H.score) : null,
    as: A.score != null && A.score !== '' ? Number(A.score) : null,
    hWin: H.winner === true, aWin: A.winner === true,
    detail: st.detail || st.shortDetail || '',
  };
}

// ── groups via connected components of the group-stage match graph ────────────
function buildGroups(matches) {
  const gms = matches.filter((m) => m.stage === 'group-stage');
  // Prefer ESPN's OFFICIAL group letters (from altGameNote) — exact + matches the real draw.
  if (gms.some((m) => m.group)) {
    const byL = {}; const meta = {};
    for (const m of gms) {
      if (!m.group) continue;
      (byL[m.group] = byL[m.group] || new Set()).add(m.home.abbr);
      byL[m.group].add(m.away.abbr);
      meta[m.home.abbr] = m.home; meta[m.away.abbr] = m.away;
    }
    return Object.keys(byL).sort().map((L) => ({
      label: L,
      teams: [...byL[L]].map((ab) => meta[ab]),
      matches: gms.filter((m) => m.group === L),
    }));
  }
  // Fallback only if the feed omits letters: connected components of the match graph.
  const adj = new Map(); const meta = new Map();
  const touch = (t) => { if (!adj.has(t.abbr)) { adj.set(t.abbr, new Set()); meta.set(t.abbr, t); } };
  const firstSeen = new Map();
  for (const m of gms) {
    touch(m.home); touch(m.away);
    adj.get(m.home.abbr).add(m.away.abbr); adj.get(m.away.abbr).add(m.home.abbr);
    const t = new Date(m.date).getTime();
    for (const ab of [m.home.abbr, m.away.abbr]) if (!firstSeen.has(ab) || t < firstSeen.get(ab)) firstSeen.set(ab, t);
  }
  const seen = new Set(); const comps = [];
  for (const node of adj.keys()) {
    if (seen.has(node)) continue;
    const comp = []; const stack = [node];
    while (stack.length) { const n = stack.pop(); if (seen.has(n)) continue; seen.add(n); comp.push(n); for (const nb of adj.get(n)) if (!seen.has(nb)) stack.push(nb); }
    comps.push(comp);
  }
  // Label groups A.. by earliest kickoff among their teams (matches official ordering closely).
  comps.sort((a, b) => Math.min(...a.map((t) => firstSeen.get(t))) - Math.min(...b.map((t) => firstSeen.get(t))));
  return comps.map((teams, i) => ({
    label: String.fromCharCode(65 + i),
    teams: teams.map((ab) => meta.get(ab)),
    matches: gms.filter((m) => teams.includes(m.home.abbr) && teams.includes(m.away.abbr)),
  }));
}

// FIFA group table: points, then GD, then GF (head-to-head omitted in v1 → logged TODO).
function computeTable(group) {
  const row = {};
  for (const t of group.teams) row[t.abbr] = { abbr: t.abbr, name: t.name, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 };
  for (const m of group.matches) {
    if (!m.completed || m.hs == null || m.as == null) continue;
    const h = row[m.home.abbr], a = row[m.away.abbr]; if (!h || !a) continue;
    h.P++; a.P++; h.GF += m.hs; h.GA += m.as; a.GF += m.as; a.GA += m.hs;
    if (m.hs > m.as) { h.W++; a.L++; h.Pts += 3; } else if (m.hs < m.as) { a.W++; h.L++; a.Pts += 3; } else { h.D++; a.D++; h.Pts++; a.Pts++; }
  }
  const rows = Object.values(row).map((r) => ({ ...r, GD: r.GF - r.GA }));
  rows.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.name.localeCompare(y.name));
  return rows;
}

// ── Elo ──────────────────────────────────────────────────────────────────────
function seedElo(matches) {
  const elo = {};
  const all = new Set();
  for (const m of matches) { all.add(m.home.abbr); all.add(m.away.abbr); }
  for (const ab of all) elo[ab] = SEED[ab] != null ? SEED[ab] : DEFAULT_ELO;
  // Apply completed results chronologically (World Football Elo).
  const done = matches.filter((m) => m.completed && m.hs != null && m.as != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const m of done) {
    const ra = (elo[m.home.abbr] ?? DEFAULT_ELO) + HOME_ADV, rb = elo[m.away.abbr] ?? DEFAULT_ELO;
    const Ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const diff = Math.abs(m.hs - m.as);
    const G = diff <= 1 ? 1 : diff === 2 ? 1.5 : (11 + diff) / 8;
    const Wa = m.hs > m.as ? 1 : m.hs < m.as ? 0 : 0.5;
    const K = 40 * G;
    elo[m.home.abbr] += K * (Wa - Ea);
    elo[m.away.abbr] += K * ((1 - Wa) - (1 - Ea));
  }
  return elo;
}

// ── prediction primitives ─────────────────────────────────────────────────────
function lambdas(eloA, eloB, homeAdvA = 0) {
  const dr = (eloA + homeAdvA) - eloB;
  const la = Math.max(0.18, Math.min(4.6, MU * 10 ** (dr / 800)));
  const lb = Math.max(0.18, Math.min(4.6, MU * 10 ** (-dr / 800)));
  return [la, lb];
}
function pois(k, l) { return Math.exp(-l) * l ** k / fact(k); }
const _f = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
function fact(n) { return _f[n] != null ? _f[n] : n * fact(n - 1); }

// Analytic win/draw/loss from the same Poisson model the sim uses (grid 0..10).
function predict(elo, aAbbr, bAbbr, { home = false } = {}) {
  const ea = elo[aAbbr] ?? DEFAULT_ELO, eb = elo[bAbbr] ?? DEFAULT_ELO;
  const [la, lb] = lambdas(ea, eb, home ? HOME_ADV : 0);
  let pa = 0, pd = 0, pb = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, la) * pois(j, lb);
    if (i > j) pa += p; else if (i === j) pd += p; else pb += p;
  }
  const s = pa + pd + pb || 1;
  return { a: aAbbr, b: bAbbr, pHome: pa / s, pDraw: pd / s, pAway: pb / s, la, lb };
}

// ── Monte-Carlo of the remainder of the tournament ────────────────────────────
function samplePois(l) { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; }
function simMatch(elo, a, b, homeA = 0) {
  const [la, lb] = lambdas(elo[a] ?? DEFAULT_ELO, elo[b] ?? DEFAULT_ELO, homeA);
  return [samplePois(la), samplePois(lb)];
}
function knockoutWinner(elo, a, b) {
  const [ga, gb] = simMatch(elo, a, b, 0);
  if (ga !== gb) return ga > gb ? a : b;
  // penalties — coin flip slightly tilted by Elo
  const ea = elo[a] ?? DEFAULT_ELO, eb = elo[b] ?? DEFAULT_ELO;
  const pa = 0.5 + Math.max(-0.15, Math.min(0.15, (ea - eb) / 2000));
  return Math.random() < pa ? a : b;
}

function simulateTournament(state, N = 8000) {
  const { groups, elo, matches } = state;
  const teams = []; for (const g of groups) for (const t of g.teams) teams.push(t.abbr);
  const reach = {}; for (const ab of teams) reach[ab] = { R32: 0, R16: 0, QF: 0, SF: 0, F: 0, W: 0 };
  const remainingGroup = matches.filter((m) => m.stage === 'group-stage' && !m.completed);

  for (let n = 0; n < N; n++) {
    // 1) finish group stage from current real results
    const tbl = {};
    for (const g of groups) for (const r of computeTable(g)) tbl[r.abbr] = { ...r };
    for (const m of remainingGroup) {
      const [hs, as] = simMatch(elo, m.home.abbr, m.away.abbr, HOME_ADV);
      const h = tbl[m.home.abbr], a = tbl[m.away.abbr]; if (!h || !a) continue;
      h.GF += hs; h.GA += as; a.GF += as; a.GA += hs; h.GD = h.GF - h.GA; a.GD = a.GF - a.GA;
      if (hs > as) h.Pts += 3; else if (hs < as) a.Pts += 3; else { h.Pts++; a.Pts++; }
    }
    // 2) rank within groups → 12 winners, 12 runners-up, 8 best thirds = 32
    const winners = [], runners = [], thirds = [];
    for (const g of groups) {
      const rows = g.teams.map((t) => tbl[t.abbr]).sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || Math.random() - 0.5);
      if (rows[0]) winners.push(rows[0].abbr);
      if (rows[1]) runners.push(rows[1].abbr);
      if (rows[2]) thirds.push(rows[2]);
    }
    thirds.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || Math.random() - 0.5);
    const bestThirds = thirds.slice(0, 8).map((r) => r.abbr);
    let bracket = [...winners, ...runners, ...bestThirds].filter(Boolean);
    for (const ab of bracket) if (reach[ab]) reach[ab].R32++;
    // 3) seed by Elo and run single-elim (approx of official slotting — see TODO)
    bracket.sort((a, b) => (elo[b] ?? DEFAULT_ELO) - (elo[a] ?? DEFAULT_ELO));
    while (bracket.length > 1 && bracket.length % 2) bracket.pop();   // safety: even field
    const half = bracket.length;
    let pairs = []; for (let i = 0; i < half / 2; i++) pairs.push([bracket[i], bracket[half - 1 - i]]);
    const rounds = ['R16', 'QF', 'SF', 'F', 'W'];
    let ri = 0;
    while (pairs.length >= 1) {
      const next = [];
      for (const [a, b] of pairs) { const w = b ? knockoutWinner(elo, a, b) : a; next.push(w); }
      const stageKey = rounds[ri++];
      if (stageKey === 'W') { if (reach[next[0]]) reach[next[0]].W++; break; }
      for (const w of next) if (reach[w] && reach[w][stageKey] != null) reach[w][stageKey]++;
      if (next.length === 1) { if (reach[next[0]]) reach[next[0]].W++; break; }
      pairs = []; for (let i = 0; i < next.length; i += 2) pairs.push([next[i], next[i + 1]]);
    }
  }
  const odds = {};
  for (const ab of teams) { const r = reach[ab]; odds[ab] = {}; for (const k of Object.keys(r)) odds[ab][k] = r[k] / N; }
  return odds;
}

// ── public snapshot (cached) ──────────────────────────────────────────────────
let _cache = null, _cacheAt = 0;
// sims:0 SKIPS the Monte-Carlo tournament simulation (the expensive part) → a cheap
// standings/Elo-only snapshot for predict/group. Only the explicit "odds" action pays for sims.
async function snapshot({ ttlMs = 60000, sims = 8000 } = {}) {
  if (_cache && Date.now() - _cacheAt < ttlMs && (sims === 0 || (_cache.odds && Object.keys(_cache.odds).length))) return _cache;
  const events = await fetchEvents();
  const matches = events.map(parseMatch).filter(Boolean);
  if (!matches.length) throw new Error('parsed 0 matches');
  const groups = buildGroups(matches);
  const elo = seedElo(matches);
  const tables = groups.map((g) => ({ label: g.label, table: computeTable(g) }));
  const odds = sims > 0 ? simulateTournament({ groups, elo, matches }, sims) : {};
  const live = matches.filter((m) => m.state === 'in');
  const upcoming = matches.filter((m) => m.state === 'pre').sort((a, b) => new Date(a.date) - new Date(b.date));
  _cache = { fetchedAt: Date.now(), matches, groups, tables, elo, odds, live, upcoming, stages: [...new Set(matches.map((m) => m.stage))] };
  _cacheAt = Date.now();
  return _cache;
}

// ── human-readable report ──────────────────────────────────────────────────────
function report(s) {
  const L = [];
  L.push('# FIFA World Cup 2026 — live bracket & predictions');
  L.push(`_Updated ${new Date(s.fetchedAt).toLocaleString()} · ${s.matches.length} matches · stages: ${s.stages.join(', ')}_`);
  if (s.live.length) { L.push('\n## ● LIVE'); for (const m of s.live) L.push(`- ${m.home.abbr} ${m.hs}–${m.as} ${m.away.abbr}  (${m.detail})`); }
  L.push('\n## Group standings');
  for (const g of s.tables) {
    L.push(`\n**Group ${g.label}**`);
    L.push('| # | Team | P | W | D | L | GD | Pts |');
    L.push('|--|--|--|--|--|--|--|--|');
    g.table.forEach((r, i) => L.push(`| ${i + 1} | ${r.name} | ${r.P} | ${r.W} | ${r.D} | ${r.L} | ${r.GD >= 0 ? '+' : ''}${r.GD} | ${r.Pts} |`));
  }
  L.push('\n## Title odds (Monte-Carlo)');
  const ranked = Object.entries(s.odds).sort((a, b) => b[1].W - a[1].W).slice(0, 12);
  L.push('| Team | Win % | Final % | Semi % |');
  L.push('|--|--|--|--|');
  for (const [ab, o] of ranked) L.push(`| ${ab} | ${(o.W * 100).toFixed(1)} | ${(o.F * 100).toFixed(1)} | ${(o.SF * 100).toFixed(1)} |`);
  if (s.upcoming.length) {
    L.push('\n## Next matches — model prediction');
    for (const m of s.upcoming.slice(0, 8)) {
      const p = predict(s.elo, m.home.abbr, m.away.abbr, { home: true });
      L.push(`- ${m.home.abbr} vs ${m.away.abbr}: ${(p.pHome * 100).toFixed(0)}% / draw ${(p.pDraw * 100).toFixed(0)}% / ${(p.pAway * 100).toFixed(0)}%  (${new Date(m.date).toLocaleString()})`);
    }
  }
  return L.join('\n');
}

// ── "what should I watch" briefing ─────────────────────────────────────────────
// Recent form (last n completed results) for a team, from that team's perspective.
function recentForm(matches, abbr, n = 5) {
  const done = matches.filter((m) => m.completed && m.hs != null && m.as != null && (m.home.abbr === abbr || m.away.abbr === abbr))
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, n);
  return done.map((m) => {
    const home = m.home.abbr === abbr;
    const gf = home ? m.hs : m.as, ga = home ? m.as : m.hs;
    const res = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    return { res, gf, ga, opp: home ? m.away.abbr : m.home.abbr, score: `${gf}-${ga}` };
  });
}
// Where a team sits in its group table (for stakes).
function groupSpot(snap, abbr) {
  for (const g of snap.tables) { const i = g.table.findIndex((r) => r.abbr === abbr); if (i >= 0) return { label: g.label, pos: i + 1, row: g.table[i], size: g.table.length }; }
  return null;
}
// Compact, machine insights for one match (no LLM, no tokens spent here).
function matchInsights(snap, m) {
  const out = [];
  const p = predict(snap.elo, m.home.abbr, m.away.abbr, { home: true });
  const ea = Math.round(snap.elo[m.home.abbr] ?? 1610), eb = Math.round(snap.elo[m.away.abbr] ?? 1610);
  const fav = ea >= eb ? m.home.abbr : m.away.abbr;
  out.push(`Model: ${m.home.abbr} ${(p.pHome * 100).toFixed(0)}% / draw ${(p.pDraw * 100).toFixed(0)}% / ${m.away.abbr} ${(p.pAway * 100).toFixed(0)}% (xG ${p.la.toFixed(1)}–${p.lb.toFixed(1)}).`);
  out.push(`Strength: ${fav} edge, Elo ${ea} vs ${eb} (gap ${Math.abs(ea - eb)}).`);
  for (const ab of [m.home.abbr, m.away.abbr]) {
    const f = recentForm(snap.matches, ab, 5);
    if (f.length) out.push(`${ab} form: ${f.map((x) => x.res).join('')} (last: ${f.map((x) => x.opp + ' ' + x.score).slice(0, 3).join(', ')}).`);
  }
  if (m.group) {
    for (const ab of [m.home.abbr, m.away.abbr]) {
      const s = groupSpot(snap, ab);
      if (s) out.push(`${ab}: Group ${s.label} #${s.pos}, ${s.row.Pts} pts (${s.row.W}-${s.row.D}-${s.row.L}).`);
    }
  }
  if (m.state === 'in') out.push(`LIVE NOW: ${m.home.abbr} ${m.hs}–${m.as} ${m.away.abbr} (${m.detail}).`);
  return { prediction: p, insights: out, favorite: fav, closeness: 1 - Math.abs(p.pHome - p.pAway) };
}
// Pick the single most-worth-watching match: live drama first, else the most compelling upcoming
// game in the next window (two strong sides + a close projected result + soon).
function pickWatch(snap) {
  if (snap.live.length) {
    return snap.live.map((m) => ({ m, s: 1 - Math.abs((m.hs ?? 0) - (m.as ?? 0)) * 0.2 })).sort((a, b) => b.s - a.s)[0].m;
  }
  const now = Date.now();
  const soon = snap.upcoming.filter((m) => new Date(m.date).getTime() - now < 72 * 3600e3);
  const pool = soon.length ? soon : snap.upcoming.slice(0, 6);
  let best = null, bestScore = -1e9;
  for (const m of pool) {
    const p = predict(snap.elo, m.home.abbr, m.away.abbr, { home: true });
    const ea = snap.elo[m.home.abbr] ?? 1610, eb = snap.elo[m.away.abbr] ?? 1610;
    const hrs = Math.max(0, (new Date(m.date).getTime() - now) / 3600e3);
    const score = (ea + eb) / 2 + 500 * (1 - Math.abs(p.pHome - p.pAway)) - hrs * 1.5;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best || snap.upcoming[0] || null;
}
// Quick public web scan — Google News RSS (no key) → top headlines (the "what people are saying").
async function buzz(query, n = 5) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', 'cache-control': 'no-cache' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n);
    const dec = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    return items.map((it) => { const t = it[1].match(/<title>([\s\S]*?)<\/title>/); return t ? dec(t[1]) : ''; }).filter(Boolean);
  } catch { return []; }
}
// Full informative briefing: live games, a recommended watch, key insights, and web buzz.
async function watchBrief({ maxBuzz = 5 } = {}) {
  const snap = await snapshot({ ttlMs: 30000, sims: 0 });
  const pick = pickWatch(snap);
  const live = snap.live.map((m) => `${m.home.abbr} ${m.hs}–${m.as} ${m.away.abbr} (${m.detail})`);
  let rec = null, headlines = [];
  if (pick) {
    const ins = matchInsights(snap, pick);
    // Try the specific matchup first; Google News RSS often has nothing for niche pairings,
    // so fall back to one team, then the tournament, so there is always some live buzz.
    for (const q of [`${pick.home.name} ${pick.away.name} World Cup`, `${pick.home.name} World Cup 2026`, 'World Cup 2026']) {
      headlines = await buzz(q, maxBuzz);
      if (headlines.length) break;
    }
    rec = {
      matchup: `${pick.home.name} vs ${pick.away.name}`,
      abbr: `${pick.home.abbr} vs ${pick.away.abbr}`,
      state: pick.state,
      kickoff: pick.date,
      kickoffLocal: pick.state === 'pre' ? new Date(pick.date).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null,
      stage: pick.group ? `Group ${pick.group}` : (pick.stage || '').replace(/-/g, ' '),
      prediction: ins.prediction,
      insights: ins.insights,
    };
  }
  return { generatedAt: snap.fetchedAt, live, recommendation: rec, buzz: headlines, liveCount: snap.live.length, upcomingCount: snap.upcoming.length };
}
// Render the brief into a compact text block the model riffs on (its own opinion + phrasing).
function formatWatch(b) {
  const L = [];
  if (b.live && b.live.length) { L.push('LIVE NOW:'); for (const m of b.live) L.push('• ' + m); L.push(''); }
  const r = b.recommendation;
  if (r) {
    L.push(`TOP PICK TO WATCH: ${r.matchup}${r.state === 'in' ? ' — LIVE NOW' : r.kickoffLocal ? ' — ' + r.kickoffLocal : ''}${r.stage ? ' (' + r.stage + ')' : ''}`);
    for (const i of r.insights) L.push('• ' + i);
    if (b.buzz && b.buzz.length) { L.push('WHAT PEOPLE ARE SAYING (web):'); for (const h of b.buzz) L.push('• ' + h); }
  } else L.push('No live or upcoming matches found in the current window.');
  return L.join('\n');
}

// Live, auto-updating standings/scores page to open in a browser — zero compute, zero model
// tokens (the cheap default for "what's the World Cup update / standings"). Google's sports panel
// renders live group tables + scores + schedule.
const STANDINGS_URL = 'https://www.google.com/search?q=fifa+world+cup+2026+standings';

module.exports = { snapshot, report, predict, simulateTournament, buildGroups, computeTable, seedElo, fetchEvents, parseMatch, recentForm, matchInsights, pickWatch, buzz, watchBrief, formatWatch, LEAGUE, WINDOW, STANDINGS_URL };

// CLI / self-test harness entry: `node lib/worldcup.js`
if (require.main === module) {
  (async () => {
    try {
      const s = await snapshot({ ttlMs: 0, sims: Number(process.env.WC_SIMS) || 4000 });
      console.log(report(s));
      console.log('\n[ok] groups=%d matches=%d champion-favorite=%s',
        s.groups.length, s.matches.length, Object.entries(s.odds).sort((a, b) => b[1].W - a[1].W)[0][0]);
      process.exit(0);
    } catch (e) { console.error('[FAIL]', e.stack || e.message); process.exit(1); }
  })();
}
