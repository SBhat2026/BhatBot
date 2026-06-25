'use strict';
// Chess rules core — the trusted ground-truth engine for BOTH the applet and the agent test.
//  • standard  → delegates entirely to chess.js (battle-tested legality).
//  • atomic    → a self-contained engine (chess.js can't do atomic; real Stockfish can't either —
//                only fairy-stockfish, so a deterministic rules oracle is actually STRONGER here for
//                legality verification). Atomic rules (lichess set): a capture explodes the capturing
//                piece, the captured piece, and every NON-PAWN piece on the 8 adjacent squares; pawns
//                are immune to the blast (only removed if directly captured, incl. en passant); the
//                king may NOT capture (it would explode itself); a move that removes your OWN king is
//                illegal; you WIN by exploding the enemy king; kings give no "check" to each other
//                (neither can capture the other), so kings may stand adjacent.
//
// Uniform interface (Game): legalMovesUci(), legalMovesSan(), move(uciOrSan), fen(), turn(),
// isGameOver(), result(), pieceCounts(), ascii(), variant. Moves accept UCI ("e2e4","e7e8q") or SAN.

let Chess = null;
try { ({ Chess } = require('chess.js')); } catch { /* browser bundles chess.js separately */ }

const FILES = 'abcdefgh';
const sq = (r, f) => FILES[f] + (r + 1);          // r,f 0..7 (r0 = rank 1) → "e4"
const parseSq = (s) => ({ f: FILES.indexOf(s[0]), r: Number(s[1]) - 1 });
const inB = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
const cloneBoard = (b) => b.map((row) => row.map((c) => (c ? { ...c } : null)));

const START = () => {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let f = 0; f < 8; f++) {
    b[0][f] = { t: back[f], c: 'w' }; b[1][f] = { t: 'p', c: 'w' };
    b[7][f] = { t: back[f], c: 'b' }; b[6][f] = { t: 'p', c: 'b' };
  }
  return b;
};

const DIRS = {
  n: [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  k: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};
DIRS.q = DIRS.b.concat(DIRS.r);

// --- Atomic engine -----------------------------------------------------------------------------
class Atomic {
  constructor() { this.b = START(); this.turn = 'w'; this.cast = { wK: true, wQ: true, bK: true, bQ: true }; this.ep = null; this.over = null; this.plies = 0; }

  enemy(c) { return c === 'w' ? 'b' : 'w'; }

  // Pseudo-legal moves (no king-safety filtering yet). Returns {from:{r,f},to:{r,f},promo?,ep?,castle?}.
  pseudo(board, color, cast, ep) {
    const mv = []; const fwd = color === 'w' ? 1 : -1; const startRank = color === 'w' ? 1 : 6; const promoRank = color === 'w' ? 7 : 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = board[r][f]; if (!p || p.c !== color) continue;
      if (p.t === 'p') {
        if (inB(r + fwd, f) && !board[r + fwd][f]) {
          if (r + fwd === promoRank) for (const pr of ['q', 'r', 'b', 'n']) mv.push({ from: { r, f }, to: { r: r + fwd, f }, promo: pr });
          else { mv.push({ from: { r, f }, to: { r: r + fwd, f } }); if (r === startRank && !board[r + 2 * fwd][f]) mv.push({ from: { r, f }, to: { r: r + 2 * fwd, f }, dbl: true }); }
        }
        for (const df of [-1, 1]) {
          const tr = r + fwd, tf = f + df; if (!inB(tr, tf)) continue;
          const tp = board[tr][tf];
          if (tp && tp.c !== color) { if (tr === promoRank) for (const pr of ['q', 'r', 'b', 'n']) mv.push({ from: { r, f }, to: { r: tr, f: tf }, promo: pr, cap: true }); else mv.push({ from: { r, f }, to: { r: tr, f: tf }, cap: true }); }
          else if (ep && ep.r === tr && ep.f === tf) mv.push({ from: { r, f }, to: { r: tr, f: tf }, cap: true, epCap: { r, f: tf } });
        }
      } else if (p.t === 'n' || p.t === 'k') {
        for (const [dr, df] of DIRS[p.t]) { const tr = r + dr, tf = f + df; if (!inB(tr, tf)) continue; const tp = board[tr][tf]; if (!tp) mv.push({ from: { r, f }, to: { r: tr, f: tf } }); else if (tp.c !== color) mv.push({ from: { r, f }, to: { r: tr, f: tf }, cap: true }); }
        if (p.t === 'k') {   // castling (atomic uses standard castling legality; king-safety filtered later)
          const rank = color === 'w' ? 0 : 7;
          const ks = color === 'w' ? cast.wK : cast.bK, qs = color === 'w' ? cast.wQ : cast.bQ;
          if (ks && !board[rank][5] && !board[rank][6] && board[rank][7] && board[rank][7].t === 'r') mv.push({ from: { r, f }, to: { r: rank, f: 6 }, castle: 'K' });
          if (qs && !board[rank][1] && !board[rank][2] && !board[rank][3] && board[rank][0] && board[rank][0].t === 'r') mv.push({ from: { r, f }, to: { r: rank, f: 2 }, castle: 'Q' });
        }
      } else {
        for (const [dr, df] of DIRS[p.t]) { let tr = r + dr, tf = f + df; while (inB(tr, tf)) { const tp = board[tr][tf]; if (!tp) mv.push({ from: { r, f }, to: { r: tr, f: tf } }); else { if (tp.c !== color) mv.push({ from: { r, f }, to: { r: tr, f: tf }, cap: true }); break; } tr += dr; tf += df; } }
      }
    }
    return mv;
  }

  // Is square (r,f) attacked by `color`? excludeKing → king attacks ignored (atomic adjacency).
  attacked(board, r, f, color, excludeKing) {
    const fwd = color === 'w' ? 1 : -1;
    // pawns (they attack diagonally "forward")
    for (const df of [-1, 1]) { const pr = r - fwd, pf = f + df; if (inB(pr, pf)) { const p = board[pr][pf]; if (p && p.c === color && p.t === 'p') return true; } }
    for (const [dr, df] of DIRS.n) { const tr = r + dr, tf = f + df; if (inB(tr, tf)) { const p = board[tr][tf]; if (p && p.c === color && p.t === 'n') return true; } }
    if (!excludeKing) for (const [dr, df] of DIRS.k) { const tr = r + dr, tf = f + df; if (inB(tr, tf)) { const p = board[tr][tf]; if (p && p.c === color && p.t === 'k') return true; } }
    for (const [dr, df] of DIRS.b) { let tr = r + dr, tf = f + df; while (inB(tr, tf)) { const p = board[tr][tf]; if (p) { if (p.c === color && (p.t === 'b' || p.t === 'q')) return true; break; } tr += dr; tf += df; } }
    for (const [dr, df] of DIRS.r) { let tr = r + dr, tf = f + df; while (inB(tr, tf)) { const p = board[tr][tf]; if (p) { if (p.c === color && (p.t === 'r' || p.t === 'q')) return true; break; } tr += dr; tf += df; } }
    return false;
  }

  kingSq(board, color) { for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) { const p = board[r][f]; if (p && p.t === 'k' && p.c === color) return { r, f }; } return null; }

  // Apply a move to a board copy, handling atomic explosion. Returns {board, explosions:[sq]}.
  apply(board, m, color) {
    const b = cloneBoard(board); const piece = b[m.from.r][m.from.f];
    b[m.from.r][m.from.f] = null;
    const explosions = [];
    if (m.castle) {
      const rank = m.from.r;
      b[m.to.r][m.to.f] = piece;
      if (m.castle === 'K') { b[rank][5] = b[rank][7]; b[rank][7] = null; } else { b[rank][3] = b[rank][0]; b[rank][0] = null; }
      return { board: b, explosions };
    }
    if (m.epCap) b[m.epCap.r][m.epCap.f] = null;     // en-passant captured pawn
    const isCap = !!m.cap;
    b[m.to.r][m.to.f] = m.promo ? { t: m.promo, c: color } : piece;
    if (isCap) {
      // explosion centered on destination: remove the mover + all non-pawn pieces on the 8 neighbours
      b[m.to.r][m.to.f] = null; explosions.push(sq(m.to.r, m.to.f));
      for (const [dr, df] of DIRS.k) { const tr = m.to.r + dr, tf = m.to.f + df; if (!inB(tr, tf)) continue; const tp = b[tr][tf]; if (tp && tp.t !== 'p') { b[tr][tf] = null; explosions.push(sq(tr, tf)); } }
    }
    return { board: b, explosions };
  }

  legal() {
    if (this.over) return [];
    const color = this.turn;
    const out = [];
    for (const m of this.pseudo(this.b, color, this.cast, this.ep)) {
      if (this.b[m.from.r][m.from.f].t === 'k' && m.cap) continue;       // king may not capture (self-explode)
      // castling can't pass through / start in check (standard), computed on current board
      if (m.castle) {
        const rank = m.from.r; const through = m.castle === 'K' ? [4, 5, 6] : [4, 3, 2];
        if (through.some((ff) => this.attacked(this.b, rank, ff, this.enemy(color), true))) continue;
      }
      const { board: nb } = this.apply(this.b, m, color);
      const myKing = this.kingSq(nb, color); if (!myKing) continue;       // never blow up your own king
      const ek = this.kingSq(nb, this.enemy(color));
      if (!ek) { out.push(m); continue; }                                 // exploded enemy king → winning move, always legal
      if (this.attacked(nb, myKing.r, myKing.f, this.enemy(color), true)) continue;  // own king left in check (enemy king excluded)
      out.push(m);
    }
    return out;
  }

  toUci(m) { return sq(m.from.r, m.from.f) + sq(m.to.r, m.to.f) + (m.promo || ''); }
  // Long algebraic (unambiguous → no notation ambiguity): "Ng1-f3", "e4xd5", "O-O", promo "e7-e8=Q", "💥" on explode.
  toSan(m) {
    if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
    const p = this.b[m.from.r][m.from.f]; const pl = p.t === 'p' ? '' : p.t.toUpperCase();
    const sep = m.cap ? 'x' : '-';
    let s = pl + sq(m.from.r, m.from.f) + sep + sq(m.to.r, m.to.f);
    if (m.promo) s += '=' + m.promo.toUpperCase();
    if (m.cap) s += '💥';
    return s;
  }

  doMove(input) {
    const legals = this.legal();
    let m = legals.find((x) => this.toUci(x) === input);
    if (!m) m = legals.find((x) => this.toSan(x) === input);
    if (!m) return { ok: false, error: 'illegal move: ' + input };
    const enemy = this.enemy(this.turn);
    const san = this.toSan(m); const uci = this.toUci(m);
    const { board: nb, explosions } = this.apply(this.b, m, this.turn);
    // update castling rights (king/rook moved or rook square emptied)
    if (m.from && this.b[m.from.r][m.from.f].t === 'k') { if (this.turn === 'w') { this.cast.wK = this.cast.wQ = false; } else { this.cast.bK = this.cast.bQ = false; } }
    const rk = (r, f, side, color2) => { if (!nb[r][f] || nb[r][f].t !== 'r' || nb[r][f].c !== color2) this.cast[side] = false; };
    this.b = nb;
    rk(0, 7, 'wK', 'w'); rk(0, 0, 'wQ', 'w'); rk(7, 7, 'bK', 'b'); rk(7, 0, 'bQ', 'b');
    this.ep = m.dbl ? { r: (m.from.r + m.to.r) / 2, f: m.from.f } : null;
    this.turn = enemy; this.plies++;
    // resolve outcome
    if (!this.kingSq(this.b, enemy)) this.over = (enemy === 'w' ? '0-1' : '1-0');       // enemy king exploded
    else if (!this.kingSq(this.b, this.turn === 'w' ? 'b' : 'w')) { /* own king can't be gone */ }
    else if (this.legal().length === 0) {
      const k = this.kingSq(this.b, this.turn);
      const inCheck = k && this.attacked(this.b, k.r, k.f, this.enemy(this.turn), true);
      this.over = inCheck ? (this.turn === 'w' ? '0-1' : '1-0') : '1/2-1/2';
    }
    return { ok: true, san, uci, explosions };
  }

  counts() { const c = { w: 0, b: 0 }; for (const row of this.b) for (const p of row) if (p) c[p.c]++; return c; }
  fen() {   // board + turn only (enough for display/debug)
    let s = '';
    for (let r = 7; r >= 0; r--) { let e = 0; for (let f = 0; f < 8; f++) { const p = this.b[r][f]; if (!p) { e++; continue; } if (e) { s += e; e = 0; } s += p.c === 'w' ? p.t.toUpperCase() : p.t; } if (e) s += e; if (r) s += '/'; }
    return s + ' ' + this.turn + ' atomic';
  }
  ascii() { let s = ''; for (let r = 7; r >= 0; r--) { for (let f = 0; f < 8; f++) { const p = this.b[r][f]; s += p ? (p.c === 'w' ? p.t.toUpperCase() : p.t) : '.'; } s += '\n'; } return s; }
}

// --- Uniform Game wrapper ----------------------------------------------------------------------
class Game {
  constructor(variant = 'standard') {
    this.variant = variant === 'atomic' ? 'atomic' : 'standard';
    if (this.variant === 'atomic') this.e = new Atomic();
    else { if (!Chess) throw new Error('chess.js not available'); this.c = new Chess(); }
  }
  turn() { return this.variant === 'atomic' ? this.e.turn : this.c.turn(); }
  legalMovesUci() {
    if (this.variant === 'atomic') return this.e.legal().map((m) => this.e.toUci(m));
    return this.c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
  }
  legalMovesSan() {
    if (this.variant === 'atomic') return this.e.legal().map((m) => this.e.toSan(m));
    return this.c.moves();
  }
  move(input) {
    if (this.variant === 'atomic') return this.e.doMove(input);
    try {
      let m = this.c.move(input, { sloppy: true });
      if (!m && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(input)) m = this.c.move({ from: input.slice(0, 2), to: input.slice(2, 4), promotion: input[4] });
      if (!m) return { ok: false, error: 'illegal move: ' + input };
      return { ok: true, san: m.san, uci: m.from + m.to + (m.promotion || ''), captured: m.captured };
    } catch (e) { return { ok: false, error: 'illegal move: ' + input }; }
  }
  isGameOver() { return this.variant === 'atomic' ? !!this.e.over : this.c.isGameOver(); }
  result() {
    if (this.variant === 'atomic') return this.e.over;
    if (!this.c.isGameOver()) return null;
    if (this.c.isCheckmate()) return this.c.turn() === 'w' ? '0-1' : '1-0';
    return '1/2-1/2';
  }
  fen() { return this.variant === 'atomic' ? this.e.fen() : this.c.fen(); }
  pieceCount() { if (this.variant === 'atomic') return this.e.counts(); const b = this.c.board(); const c = { w: 0, b: 0 }; for (const row of b) for (const p of row) if (p) c[p.color]++; return c; }
  ascii() { return this.variant === 'atomic' ? this.e.ascii() : this.c.ascii(); }
}

module.exports = { Game, Atomic };
