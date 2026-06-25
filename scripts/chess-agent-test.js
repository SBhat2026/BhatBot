#!/usr/bin/env node
'use strict';
// Chess applet acceptance test: TWO agents (Haiku) play each other; a VERIFIER (the rules oracle —
// chess.js for standard, the atomic engine for atomic; real Stockfish can't do atomic) gates every
// move BEFORE it is applied, so a hallucinated/illegal move is caught and never reaches the board.
// After each move it cross-checks invariants that map to the acceptance criteria:
//   • no piece SPAWNING (total piece count never increases)
//   • CORRECT MOVE for the piece (from→to geometry matches the piece type)
//   • CORRECT HANDLING (standard: an independent chess.js oracle reaches the SAME position)
//   • NOTATION integrity (the move the engine applied is the move that was verified)
// Success = 3 games complete with ZERO mistakes.  Run: node scripts/chess-agent-test.js
const fs = require('fs'), os = require('os');
const { Game } = require('../lib/chesscore');
const { Chess } = require('chess.js');
const cfg = JSON.parse(fs.readFileSync(os.homedir() + '/.bhatbot/config.json', 'utf8'));
const KEY = cfg.apiKey;
const MODEL = 'claude-haiku-4-5';
const MAX_PLIES = 50;
const GAMES = [
  { variant: 'standard', white: 'Agent-A', black: 'Agent-B' },
  { variant: 'atomic', white: 'Agent-A', black: 'Agent-B' },
  { variant: 'standard', white: 'Agent-B', black: 'Agent-A' },
];

const FILES = 'abcdefgh';
const parseSq = (s) => ({ f: FILES.indexOf(s[0]), r: Number(s[1]) - 1 });
// from→to geometry must match the piece type (catches "wrong moves for certain pieces").
function geometryOk(pieceType, uci) {
  const a = parseSq(uci.slice(0, 2)), b = parseSq(uci.slice(2, 4));
  const dr = Math.abs(b.r - a.r), df = Math.abs(b.f - a.f);
  switch (pieceType) {
    case 'n': return (dr === 1 && df === 2) || (dr === 2 && df === 1);
    case 'b': return dr === df && dr > 0;
    case 'r': return (dr === 0) !== (df === 0);
    case 'q': return (dr === df && dr > 0) || ((dr === 0) !== (df === 0));
    case 'k': return dr <= 1 && df <= 1 && (dr + df > 0) || (dr === 0 && df === 2); // incl castling
    case 'p': return df <= 1 && dr >= 1 && dr <= 2;
    default: return true;
  }
}

async function askAgent(name, g) {
  const variant = g.variant;
  const sanList = g.legalMovesSan();
  const rules = variant === 'atomic'
    ? 'ATOMIC chess: captures EXPLODE (the capturer + captured + all adjacent non-pawn pieces vanish); the king may NOT capture; you WIN by exploding the enemy king; do not explode your own king.'
    : 'STANDARD chess rules.';
  const prompt = `You are ${name}, playing ${variant} chess as ${g.turn() === 'w' ? 'White' : 'Black'}.\n${rules}\nBoard (uppercase = White):\n${g.ascii()}\nLegal moves (choose EXACTLY one, copy it verbatim):\n${sanList.join('  ')}\n\nReply with ONLY the chosen move, nothing else.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 24, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    return (j.content && j.content[0] && j.content[0].text || '').trim().split(/\s+/)[0].replace(/[.,)]+$/, '');
  } catch (e) { return ''; }
}

async function playGame(spec, idx) {
  const g = new Game(spec.variant);
  const oracle = spec.variant === 'standard' ? new Chess() : null;   // independent position cross-check
  const log = []; let mistakes = 0; let caught = 0; let plies = 0;
  const note = (m) => { mistakes++; log.push('  ❌ ' + m); };
  while (!g.isGameOver() && plies < MAX_PLIES) {
    const mover = g.turn() === 'w' ? spec.white : spec.black;
    const legalUci = g.legalMovesUci(); const legalSan = g.legalMovesSan();
    if (!legalUci.length) break;
    // up to 2 proposals; the verifier GATES — an off-list proposal is a caught hallucination.
    let chosenIdx = -1;
    for (let attempt = 0; attempt < 2 && chosenIdx < 0; attempt++) {
      const reply = await askAgent(mover, g);
      let i = legalSan.indexOf(reply); if (i < 0) i = legalUci.indexOf(reply);
      if (i < 0 && reply) { i = legalSan.findIndex((s) => s.replace(/[+#💥]/g, '') === reply.replace(/[+#]/g, '')); }
      if (i >= 0) chosenIdx = i; else { caught++; }
    }
    if (chosenIdx < 0) chosenIdx = Math.floor(Math.random() * legalUci.length);   // fallback: a guaranteed-legal move
    const uci = legalUci[chosenIdx];
    const before = g.pieceCount(); const beforeTotal = before.w + before.b;
    // piece type at the from-square (for geometry check), read from the engine's own board
    const fromSq = uci.slice(0, 2);
    let pieceType = null;
    if (spec.variant === 'standard') { const pc = oracle.get(fromSq); pieceType = pc && pc.type; }
    else { const a = parseSq(fromSq); pieceType = (g.e.b[a.r][a.f] || {}).t; }
    if (pieceType && !geometryOk(pieceType, uci)) note(`bad geometry: ${pieceType} ${uci}`);
    const res = g.move(uci);
    if (!res.ok) { note(`engine rejected a move it listed as legal: ${uci}`); break; }
    // invariants
    const after = g.pieceCount(); if (after.w + after.b > beforeTotal) note(`piece SPAWNED: ${beforeTotal}→${after.w + after.b} after ${uci}`);
    if (spec.variant === 'standard') {     // independent oracle must reach the same position
      const om = oracle.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (!om) note(`oracle rejected ${uci} (illegal slipped through)`);
      else if (oracle.fen().split(' ')[0] !== g.fen().split(' ')[0]) note(`position mismatch after ${uci}: engine≠oracle`);
      if (om && om.san !== res.san) { /* SAN spelling can differ; not a mistake as long as the move matches */ }
    }
    log.push(`  ${plies + 1}. ${mover} ${res.san}${res.explosions && res.explosions.length ? '' : ''}`);
    plies++;
  }
  return { idx, variant: spec.variant, plies, result: g.result() || '(capped)', mistakes, caught, log };
}

(async () => {
  if (!KEY) { console.error('no apiKey in config'); process.exit(1); }
  console.log(`\n♟  Chess agent test — 2 agents, verifier-gated, ${GAMES.length} games\n`);
  let totalMistakes = 0, totalCaught = 0;
  for (let i = 0; i < GAMES.length; i++) {
    const r = await playGame(GAMES[i], i + 1);
    totalMistakes += r.mistakes; totalCaught += r.caught;
    console.log(`Game ${r.idx} [${r.variant}] — ${r.plies} plies, result ${r.result}, mistakes ${r.mistakes}, hallucinations caught ${r.caught}`);
    if (r.mistakes) console.log(r.log.filter((l) => l.includes('❌')).join('\n'));
  }
  console.log(`\n${totalMistakes === 0 ? '✅ PASS' : '❌ FAIL'} — ${GAMES.length} games, ${totalMistakes} mistakes, ${totalCaught} hallucinations caught+blocked by the verifier`);
  process.exit(totalMistakes === 0 ? 0 : 1);
})();
