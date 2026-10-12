// Can this FreeCell position still be won? Nothing is hidden, so this is a
// plain search: depth-first over single-card moves, never entering a position
// twice, the likeliest moves first. It answers 'won' with a winning line,
// 'lost' when every position that can be reached has been looked at and none
// is a win, or 'unknown' when `limit` positions were not enough.
//
// Depth-first search finds most wins within a few thousand positions and now
// and then wanders for millions, so it starts with short searches, each
// ordering the moves a little differently, then some longer ones (of deals
// 1-300, one search of 2,000,000 positions wins 290; the short ones win all of
// deals 1-1500, in 8,000 positions on average, about 10 ms). A lost position
// ends the first search it fits in, and the last, long one is what proves
// the bigger ones lost (deal 11982 from the start takes 60,000 positions).
//
// What keeps it small:
// * Cards that are safe on the foundations go there at once (as in the game,
//   see freecell.js); that never loses a win.
// * A position is known by a key that does not depend on the order of the
//   columns or of the free cells: a column hashes to the sum of a random
//   number per (height, card), mixed, and the key is the sum over the columns
//   plus a random number per card in a cell. (The foundations follow from the
//   rest.) Keys are two 32-bit halves, updated as cards move.
// * Only the first empty column and the first empty cell are moved to, and a
//   column's only card is not moved to another empty column.
//
// As a worker it is given {key, columns, cells, limit} and answers
// {key, lost, line}: line is a winning line in the game's moves if one was found.
import { encodeMoves } from './game.js';
import { COLS, CELLS, HOME } from './freecell.js';

const MAXH = 24; // a column never passes 19 cards
const SUIT = new Uint8Array(52), RANK = new Uint8Array(52), RED = new Uint8Array(52);
for (let c = 0; c < 52; c++) { SUIT[c] = c / 13 | 0; RANK[c] = c % 13; RED[c] = +(SUIT[c] === 1 || SUIT[c] === 2); }
const OPP1 = [1, 0, 0, 1], OPP2 = [2, 3, 3, 2]; // the two suits of the other colour

const ZL = new Int32Array(MAXH * 52), ZH = new Int32Array(MAXH * 52), CL = new Int32Array(52), CH = new Int32Array(52);
{
  let x = 0x2545F491;
  const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x; };
  for (const t of [ZL, ZH, CL, CH]) for (let i = 0; i < t.length; i++) t[i] = next();
}

// A set of keys: open addressing, at most half full.
class KeySet {
  constructor() {
    this.t = new Int32Array(1 << 17);
    this.mask = (1 << 16) - 1;
    this.n = 0;
  }

  // Add a key; false if it was there.
  add(lo, hi) {
    if ((lo | hi) === 0) lo = 1; // 0, 0 marks an empty place
    const t = this.t, mask = this.mask;
    let i = lo & mask;
    for (; ; i = (i + 1) & mask) {
      const a = t[2 * i], b = t[2 * i + 1];
      if (a === lo && b === hi) return false;
      if ((a | b) === 0) break;
    }
    t[2 * i] = lo;
    t[2 * i + 1] = hi;
    if (++this.n * 2 > mask) this.grow();
    return true;
  }

  grow() {
    const old = this.t;
    this.t = new Int32Array(old.length * 2);
    this.mask = this.mask * 2 + 1;
    this.n = 0;
    for (let i = 0; i < old.length; i += 2) if (old[i] | old[i + 1]) this.add(old[i], old[i + 1]);
  }
}

const grown = a => { const b = new Int32Array(a.length * 2); b.set(a); return b; };

// The short searches: [how many, of how many positions].
const PROBES = [[20, 5000], [12, 40_000]];

// columns: arrays of cards; cells: cards or null. Returns {verdict, nodes, line}.
export function solve(columns, cells, limit) {
  let nodes = 0, jitter = 0;
  for (const [count, size] of PROBES) {
    for (let i = 0; i < count && size < limit; i++, jitter += 7919) {
      const r = search(columns, cells, size, jitter);
      nodes += r.nodes;
      if (r.verdict !== 'unknown') return { ...r, nodes };
    }
  }
  const r = search(columns, cells, limit);
  return { ...r, nodes: nodes + r.nodes };
}

// One search; jitter, if not 0, seeds random changes to the order of the moves.
export function search(columns, cells, limit, jitter = 0) {
  const col = new Uint8Array(COLS * MAXH), len = new Uint8Array(COLS);
  const cell = new Int8Array(CELLS).fill(-1), found = new Uint8Array(4).fill(13);
  const rawL = new Int32Array(COLS), rawH = new Int32Array(COLS), mixL = new Int32Array(COLS), mixH = new Int32Array(COLS);
  let keyL = 0, keyH = 0, home = 52;
  let trail = new Int32Array(1024), tn = 0; // the single-card moves made: from | to << 8, a foundation being 12 + suit

  // A column's part of the key, from the sum of its cards' numbers.
  const remix = c => {
    let lo = rawL[c], hi = rawH[c];
    lo = Math.imul(lo ^ (hi >>> 15) ^ 0x9E3779B1, 0x85EBCA6B);
    hi = Math.imul(hi ^ (lo >>> 13), 0xC2B2AE35);
    lo = Math.imul(lo ^ (hi >>> 16), 0x27D4EB2F);
    hi = Math.imul(hi ^ (lo >>> 15), 0x165667B1);
    lo ^= hi >>> 14;
    hi ^= lo >>> 16;
    keyL = (keyL - mixL[c] + lo) | 0;
    keyH = (keyH - mixH[c] + hi) | 0;
    mixL[c] = lo;
    mixH[c] = hi;
  };
  const put = (to, card) => {
    if (to < COLS) {
      const h = len[to]++, z = h * 52 + card;
      col[to * MAXH + h] = card;
      rawL[to] += ZL[z];
      rawH[to] += ZH[z];
      remix(to);
    } else if (to < HOME) {
      cell[to - COLS] = card;
      keyL = (keyL + CL[card]) | 0;
      keyH = (keyH + CH[card]) | 0;
    } else {
      found[to - HOME]++;
      home++;
    }
  };
  const take = from => {
    let card;
    if (from < COLS) {
      const h = --len[from];
      card = col[from * MAXH + h];
      const z = h * 52 + card;
      rawL[from] -= ZL[z];
      rawH[from] -= ZH[z];
      remix(from);
    } else if (from < HOME) {
      card = cell[from - COLS];
      cell[from - COLS] = -1;
      keyL = (keyL - CL[card]) | 0;
      keyH = (keyH - CH[card]) | 0;
    } else {
      card = (from - HOME) * 13 + --found[from - HOME];
      home--;
    }
    return card;
  };
  const move = (from, to) => {
    put(to, take(from));
    if (tn === trail.length) trail = grown(trail);
    trail[tn++] = from | to << 8;
  };
  const undoTo = mark => {
    while (tn > mark) {
      const t = trail[--tn];
      put(t & 255, take(t >> 8));
    }
  };
  const safe = card => {
    const r = RANK[card], s = SUIT[card];
    return r === found[s] && (r <= 1 || (found[OPP1[s]] >= r && found[OPP2[s]] >= r));
  };
  const autoplay = () => {
    for (let again = true; again;) {
      again = false;
      for (let c = 0; c < COLS; c++) {
        while (len[c] && safe(col[c * MAXH + len[c] - 1])) { move(c, HOME + SUIT[col[c * MAXH + len[c] - 1]]); again = true; }
      }
      for (let k = 0; k < CELLS; k++) {
        if (cell[k] >= 0 && safe(cell[k])) { move(COLS + k, HOME + SUIT[cell[k]]); again = true; }
      }
    }
  };

  for (let c = 0; c < COLS; c++) remix(c);
  columns.forEach((cards, c) => { for (const card of cards) { put(c, card); found[SUIT[card]]--; home--; } });
  cells.forEach((card, k) => { if (card != null) { put(COLS + k, card); found[SUIT[card]]--; home--; } });
  autoplay();
  tn = 0;

  // The moves of a position, best first, into mvs from `at`; returns their
  // end. A move is score << 16 | from << 8 | to.
  let mvs = new Int32Array(4096);
  const dig = new Int32Array(COLS);
  const gen = at => {
    if (at + 128 > mvs.length) mvs = grown(mvs);
    let n = at, emptyCol = -1, emptyCell = -1, used = 0;
    for (let k = CELLS - 1; k >= 0; k--) { if (cell[k] < 0) emptyCell = k; else used++; }
    for (let c = COLS - 1; c >= 0; c--) {
      if (!len[c]) { emptyCol = c; continue; }
      // Worth digging in: a column with the next card of a foundation, the more the nearer the top it is.
      let d = 0;
      for (let h = len[c] - 2, base = c * MAXH; h >= 0; h--) {
        const card = col[base + h];
        if (RANK[card] === found[SUIT[card]]) { d = Math.max(d, 60 - 6 * (len[c] - 2 - h)); break; }
      }
      dig[c] = d;
    }
    const add = (score, from, to) => {
      if (jitter) { jitter ^= jitter << 13; jitter ^= jitter >>> 17; jitter ^= jitter << 5; score += jitter & 127; }
      mvs[n++] = (score + 2000) << 16 | from << 8 | to;
    };
    for (let c = 0; c < COLS; c++) {
      const h = len[c];
      if (!h) continue;
      const card = col[c * MAXH + h - 1], r = RANK[card], s = SUIT[card];
      // What the move leaves: an empty column, or a card uncovered.
      let u = 40;
      if (h > 1) {
        const under = col[c * MAXH + h - 2];
        u = dig[c] + (RANK[under] === RANK[card] + 1 && RED[under] !== RED[card] ? -40 : 0);
      }
      if (r === found[s]) add(500, c, HOME + s);
      for (let t = 0; t < COLS; t++) {
        if (t === c || !len[t]) continue;
        const top = col[t * MAXH + len[t] - 1];
        if (RANK[top] === r + 1 && RED[top] !== RED[card]) add(100 + u, c, t);
      }
      if (emptyCol >= 0 && h > 1) add(-30 + u + (r === 12 ? 30 : 0), c, emptyCol);
      if (emptyCell >= 0) add(-50 - 20 * used + u, c, COLS + emptyCell);
    }
    for (let k = 0; k < CELLS; k++) {
      const card = cell[k];
      if (card < 0) continue;
      const r = RANK[card], s = SUIT[card];
      if (r === found[s]) add(500, COLS + k, HOME + s);
      for (let t = 0; t < COLS; t++) {
        if (!len[t]) continue;
        const top = col[t * MAXH + len[t] - 1];
        if (RANK[top] === r + 1 && RED[top] !== RED[card]) add(150, COLS + k, t);
      }
      if (emptyCol >= 0) add(r === 12 ? 40 : 0, COLS + k, emptyCol);
    }
    for (let i = at + 1; i < n; i++) { // sort, best first
      const m = mvs[i];
      let j = i;
      for (; j > at && mvs[j - 1] < m; j--) mvs[j] = mvs[j - 1];
      mvs[j] = m;
    }
    return n;
  };

  let nodes = 0, depth = 0;
  // Per depth: where its moves start and end in mvs and which is next, the
  // trail before the move that led to it, and the move taken from it.
  let start = new Int32Array(1024), end = new Int32Array(1024), cur = new Int32Array(1024), mark = new Int32Array(1024), path = new Int32Array(1024);
  const line = n => Array.from(path.subarray(0, n), m => ({ from: (m >> 8) & 255, to: Math.min(m & 255, HOME), count: 1 }));
  if (home === 52) return { verdict: 'won', nodes, line: [] };
  const seen = new KeySet();
  seen.add(keyL, keyH);
  end[0] = gen(0);
  for (;;) {
    if (cur[depth] < end[depth]) {
      const m = mvs[cur[depth]++], before = tn;
      move((m >> 8) & 255, m & 255);
      autoplay();
      path[depth] = m;
      if (home === 52) return { verdict: 'won', nodes, line: line(depth + 1) };
      if (!seen.add(keyL, keyH)) { undoTo(before); continue; }
      if (++nodes >= limit) return { verdict: 'unknown', nodes, line: null };
      if (++depth === start.length) [start, end, cur, mark, path] = [start, end, cur, mark, path].map(grown);
      mark[depth] = before;
      start[depth] = cur[depth] = end[depth - 1];
      end[depth] = gen(start[depth]);
    } else {
      if (depth === 0) return { verdict: 'lost', nodes, line: null };
      undoTo(mark[depth]);
      depth--;
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data: { key, columns, cells, limit } }) => {
    const r = solve(columns, cells, limit);
    postMessage({ key, lost: r.verdict === 'lost', line: r.line && encodeMoves(r.line) });
  };
}
