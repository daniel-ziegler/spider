// A player that does not look at the face-down cards, for the analysis's
// rollouts (analysis-worker.js): a port of the line player, ../../src/lines.rs, as
// far as the analysis's configuration needs (LineConfig::rollout, and the
// cheaper LineConfig::fast: no replanning, no wider search before a deal). It
// decides exactly as the Rust does: the repository root's `cargo test` plays
// deals with both and compares the moves (test/lineplayer.mjs).
//
// It plays lines of up to fourteen steps. A step puts a run, or a sequence of
// several suits by way of the empty columns, from the top of a column onto a
// card one rank higher or into an empty column; a line ends when a card turns
// over. Where each line ends is scored from the visible cards (the best few
// lines that turn a card by the mean, over the cards that can come up, of the
// best score a step further on), and the best line that raises the score is
// played; failing that the best by a score that values empty columns low (a
// deal needs them filled); failing that it deals.
//
// A position is a Uint8Array of SIZE bytes: MAXC cards for each of ten
// columns, then each column's length, each column's number of face-down
// cards, and the suits completed. The search never reads a face-down card,
// and a card it turns over is BLANK in the position it reaches, so it knows
// only what is face up. Positions that differ only in the order of their
// columns count as one, as in the Rust.

export const NUM_COLS = 10;
export const MAXC = 48;
export const BLANK = 255;
export const LEN = NUM_COLS * MAXC, DOWN = LEN + NUM_COLS, DONE = DOWN + NUM_COLS, SIZE = DONE + 1;
const LOST = -1073741824;
const imul = Math.imul;

// LineConfig::fast in lines.rs: six-step lines, a beam of 50, no expectimax.
export function fastConfig(suits) {
  const base = {
    maxSteps: 6, touch: true, beam: 0, expectTop: 0, expectSteps: 4, expectBeam: 20, splits: suits === 1 ? 2 : 1,
    completed: 1000, hidden: 47, empty: 53, dealEmpty: -72, dealFlip: 0, endEmpty: 3, same: 0, off: -6, offRank: 3,
    king: 0, ranks: 9, runSq: 13, wrong: 0, clear: 0, hiddenSq: 0, dig: 0, turnable: 0,
  };
  if (suits === 1) {
    return { ...base, maxSteps: 2, hidden: 20, empty: 60, dealEmpty: -60, endEmpty: 0, same: 11, off: -2, offRank: 0, king: 11, ranks: 3, runSq: 13 };
  }
  if (suits === 2) {
    return { ...base, beam: 50, hidden: 22, empty: 26, dealEmpty: -28, endEmpty: 5, same: 5, off: -8, offRank: 4, king: -10, ranks: 8, runSq: 1 };
  }
  return { ...base, beam: 50, hidden: 71, empty: 103, endEmpty: 39, off: -10, runSq: 7, wrong: -3, clear: 16, hiddenSq: -4 };
}

// A position from columns of cards (bottom first) and their face-down counts.
export function makeState(columns, faceDown, completed) {
  const s = new Uint8Array(SIZE);
  for (let c = 0; c < NUM_COLS; c++) {
    s.set(columns[c], c * MAXC);
    s[LEN + c] = columns[c].length;
    s[DOWN + c] = faceDown[c];
  }
  s[DONE] = completed;
  return s;
}

// ---------------------------------------------------------------- hashing

// A column's hash is two 32-bit numbers, of its length, its face-down count
// and its face-up cards; a position's the sums of its columns', so the order
// of the columns does not matter.
let ha = 0, hb = 0;

function colHash(S, at, n, d) {
  let a = imul(n + 1, 0x01000193) ^ imul(d + 1, 0x7FEB352D), b = imul(n + 0x51, 0x2C1B3C6D) + d;
  for (let i = d; i < n; i++) {
    const x = S[at + i] + 1;
    a = imul(a ^ x, 0x01000193);
    b = imul(b + x, 0xCC9E2D51);
    b = (b << 15) | (b >>> 17);
  }
  a ^= a >>> 16; a = imul(a, 0x85EBCA6B); a ^= a >>> 13; a = imul(a, 0xC2B2AE35); a ^= a >>> 16;
  b ^= b >>> 15; b = imul(b, 0x2C1B3C6D); b ^= b >>> 12; b = imul(b, 0x297A2D39); b ^= b >>> 15;
  ha = a;
  hb = b;
}

const keyOf = (a, b) => (b & 0x1FFFFF) * 4294967296 + (a >>> 0);

// The player the analysis plays games out with and whose chance of winning
// its network gives: LineConfig::rollout in lines.rs (which see). Lines of up
// to fourteen steps (two with one suit), a beam of 100, and expectimax one
// step deep for the best four lines that turn a card: it wins some 89%, 68%,
// 50% and 31% of deals with one to four suits, at six times the work of
// fastConfig (86%, 63%, 42%, 25%).
export function rolloutConfig(suits) {
  return { ...fastConfig(suits), ...ROLLOUT[suits] };
}

const STRONGER = { maxSteps: 14, beam: 100, expectTop: 4, expectSteps: 1 };
const ROLLOUT = { 1: { expectTop: 4, expectSteps: 1 }, 2: STRONGER, 3: STRONGER, 4: STRONGER };


// The positions a search has reached: an open-addressed table, emptied by
// moving on to the next generation.
let tcap = 1 << 14, tA = new Int32Array(tcap), tB = new Int32Array(tcap), tG = new Uint32Array(tcap), gen = 0, tcount = 0;

function seenReset() {
  gen++;
  tcount = 0;
}

// Add a position; false if it was there.
function seenInsert(a, b) {
  const mask = tcap - 1;
  let i = (a ^ imul(b, 0x9E3779B1)) & mask;
  while (tG[i] === gen) {
    if (tA[i] === a && tB[i] === b) return false;
    i = (i + 1) & mask;
  }
  tG[i] = gen;
  tA[i] = a;
  tB[i] = b;
  if (++tcount * 2 > tcap) seenGrow();
  return true;
}

function seenGrow() {
  const [oA, oB, oG, ocap, ogen] = [tA, tB, tG, tcap, gen];
  tcap *= 2;
  tA = new Int32Array(tcap);
  tB = new Int32Array(tcap);
  tG = new Uint32Array(tcap);
  gen = 1;
  const mask = tcap - 1;
  for (let j = 0; j < ocap; j++) {
    if (oG[j] !== ogen) continue;
    let i = (oA[j] ^ imul(oB[j], 0x9E3779B1)) & mask;
    while (tG[i] === gen) i = (i + 1) & mask;
    tG[i] = gen;
    tA[i] = oA[j];
    tB[i] = oB[j];
  }
}

// ---------------------------------------------------------------- the search's positions

// Node k of a search: its position at k * SIZE in NS, its columns' hashes,
// the node it was reached from and by which moves ([from, to, count, ...]),
// whether that turned a card over, the columns its line has touched, and its
// evaluation in parts.
let cap = 4096, count = 0;
let NS = new Uint8Array(cap * SIZE);
let CA = new Int32Array(cap * NUM_COLS), CB = new Int32Array(cap * NUM_COLS);
let PA = new Int32Array(cap), PB = new Int32Array(cap);
let parent = new Int32Array(cap), leaf = new Uint8Array(cap), touched = new Uint16Array(cap);
let evBase = new Int32Array(cap), evEmpties = new Uint8Array(cap), evCards = new Uint16Array(cap);
let stepOf = [];

function grow() {
  cap *= 2;
  const bigger = (old, T, per) => { const a = new T(cap * per); a.set(old); return a; };
  NS = bigger(NS, Uint8Array, SIZE);
  CA = bigger(CA, Int32Array, NUM_COLS);
  CB = bigger(CB, Int32Array, NUM_COLS);
  PA = bigger(PA, Int32Array, 1);
  PB = bigger(PB, Int32Array, 1);
  parent = bigger(parent, Int32Array, 1);
  leaf = bigger(leaf, Uint8Array, 1);
  touched = bigger(touched, Uint16Array, 1);
  evBase = bigger(evBase, Int32Array, 1);
  evEmpties = bigger(evEmpties, Uint8Array, 1);
  evCards = bigger(evCards, Uint16Array, 1);
}

function rehashCol(k, c) {
  const o = k * SIZE;
  colHash(NS, o + c * MAXC, NS[o + LEN + c], NS[o + DOWN + c]);
  CA[k * NUM_COLS + c] = ha;
  CB[k * NUM_COLS + c] = hb;
}

function sumHash(k) {
  let a = imul(NS[k * SIZE + DONE], 0x9E3779B1), b = imul(NS[k * SIZE + DONE], 0x85EBCA77);
  for (let c = 0, i = k * NUM_COLS; c < NUM_COLS; c++, i++) {
    a = (a + CA[i]) | 0;
    b = (b + CB[i]) | 0;
  }
  PA[k] = a;
  PB[k] = b;
}

// The evaluation of node k (base_eval and Parts::of in lines.rs).
function evaluate(k, cfg) {
  const S = NS, o = k * SIZE;
  let score = cfg.completed * S[o + DONE];
  let topRanks = 0, offRank = 0, accepts = 0, anyEmpty = false, empties = 0, cards = 0;
  if (cfg.turnable !== 0) {
    for (let c = 0; c < NUM_COLS; c++) {
      const n = S[o + LEN + c];
      if (n === 0) anyEmpty = true;
      else {
        const top = S[o + c * MAXC + n - 1];
        if (top !== BLANK && top % 13 > 0) accepts |= 1 << (top % 13 - 1);
      }
    }
  }
  for (let c = 0; c < NUM_COLS; c++) {
    const n = S[o + LEN + c];
    if (n === 0) { empties++; continue; }
    cards += n;
    const d = S[o + DOWN + c], co = o + c * MAXC;
    score -= cfg.hidden * d + Math.trunc(cfg.hiddenSq * d * d / 16);
    if (d === 0) score += cfg.clear;
    // A card just turned over is unknown (BLANK): no place to put anything yet.
    const top = S[co + n - 1], low = S[co + d];
    if (top !== BLANK && top % 13 !== 0) topRanks |= 1 << (top % 13);
    if (low !== BLANK && low % 13 === 12) score += cfg.king;
    let run = 1, seq = true;
    for (let i = d + 1; i < n; i++) {
      const upper = S[co + i - 1], lower = S[co + i];
      if (upper % 13 === lower % 13 + 1) {
        if (((upper / 13) | 0) === ((lower / 13) | 0)) {
          score += cfg.same;
          run++;
          continue;
        }
        score += cfg.off;
        offRank += lower % 13;
      } else if (upper !== BLANK && lower !== BLANK) {
        score += cfg.wrong;
        seq = false;
      }
      score += Math.trunc(cfg.runSq * run * run / 16);
      run = 1;
    }
    score += Math.trunc(cfg.runSq * run * run / 16);
    if (d > 0 && seq) {
      score += cfg.dig;
      if (low === BLANK) score += Math.trunc(cfg.turnable / 2);
      else if (anyEmpty || accepts & (1 << (low % 13))) score += cfg.turnable;
    }
  }
  let bits = 0;
  for (let r = topRanks; r; r &= r - 1) bits++;
  evBase[k] = score + Math.trunc(cfg.offRank * offRank / 4) + cfg.ranks * bits;
  evEmpties[k] = empties;
  evCards[k] = cards;
}

const value = (k, dealsLeft, empty) => (dealsLeft > 0 && evCards[k] < NUM_COLS ? LOST : evBase[k] + empty * evEmpties[k]);

// Length of the same-suit run at the top of a column of the position at o.
function runLen(S, o, c) {
  const n = S[o + LEN + c], d = S[o + DOWN + c], co = o + c * MAXC;
  if (n === d) return 0;
  let k = 1;
  while (n - k > d) {
    const upper = S[co + n - k - 1], lower = S[co + n - k];
    if (upper - lower === 1 && upper % 13 !== 0) k++; // same suit, one rank higher
    else break;
  }
  return k;
}

// Move count cards in the position at o; a card turned over becomes `turned`
// if that is not -1 (the search does not know it). Returns whether a card
// turned.
export function applyMove(S, o, from, to, n, turned) {
  const fl = S[o + LEN + from], tl = S[o + LEN + to];
  const fo = o + from * MAXC + fl - n, t = o + to * MAXC + tl;
  for (let i = 0; i < n; i++) S[t + i] = S[fo + i];
  S[o + LEN + from] = fl - n;
  S[o + LEN + to] = tl + n;
  let flipped = false;
  if (fl - n > 0 && S[o + DOWN + from] === fl - n) {
    S[o + DOWN + from]--;
    if (turned >= 0) S[fo - 1] = turned;
    flipped = true;
  }
  return removeIfComplete(S, o, to, turned) || flipped;
}

export function removeIfComplete(S, o, c, turned) {
  const n = S[o + LEN + c];
  if (n < 13 || S[o + c * MAXC + n - 1] % 13 !== 0 || runLen(S, o, c) < 13) return false;
  S[o + LEN + c] = n - 13;
  S[o + DONE]++;
  if (n - 13 > 0 && S[o + DOWN + c] === n - 13) {
    S[o + DOWN + c]--;
    if (turned >= 0) S[o + c * MAXC + n - 14] = turned;
    return true;
  }
  return false;
}

// Move the top pieces of `from` (same-suit runs, sizes[lo..hi) from the
// bottom piece up) onto `to` by way of the empty columns free[f..nf), as
// move_pieces in lines.rs does: the top half aside, the bottom half across,
// the top half back on it.
const sizes = new Uint8Array(MAXC), free = new Uint8Array(NUM_COLS);
let nf = 0, step = null, stepFlip = false;

function movePieces(o, from, to, lo, hi, f) {
  const k = hi - lo;
  if (k === 0) return;
  if (k === 1) {
    if (applyMove(NS, o, from, to, sizes[lo], BLANK)) stepFlip = true;
    step.push(from, to, sizes[lo]);
    return;
  }
  const t = free[f], mid = lo + k - (k >> 1);
  movePieces(o, from, t, mid, hi, f + 1);
  movePieces(o, from, to, lo, mid, f + 1);
  movePieces(o, t, to, mid, hi, f + 1);
}

const tmp = new Uint8Array(2 * MAXC), emptyCols = new Uint8Array(NUM_COLS);

// Every step from node i (steps in lines.rs) as new nodes: with `require`
// not zero, only steps touching one of those columns.
function expand(i, splits, require, cfg) {
  const o = i * SIZE;
  let ne = 0;
  for (let c = 0; c < NUM_COLS; c++) if (NS[o + LEN + c] === 0) emptyCols[ne++] = c;
  for (let from = 0; from < NUM_COLS; from++) {
    const n = NS[o + LEN + from], d = NS[o + DOWN + from];
    if (n === d) continue;
    const co = o + from * MAXC;
    // The descending sequence (of any suits) at the top of the column.
    let start = n - 1;
    while (start > d && NS[co + start - 1] % 13 === NS[co + start] % 13 + 1) start--;
    for (let p = start; p < n; p++) {
      const bottom = NS[co + p], suit = (bottom / 13) | 0;
      // Cutting inside a same-suit run splits it.
      const split = p > start && ((NS[co + p - 1] / 13) | 0) === suit;
      if (split && splits === 0) continue;
      // The same-suit pieces of what moves, bottom first.
      let np = 0;
      for (let a = p; a < n;) {
        let b = a + 1;
        while (b < n && ((NS[co + b] / 13) | 0) === ((NS[co + b - 1] / 13) | 0)) b++;
        sizes[np++] = b - a;
        a = b;
      }
      let triedEmpty = false;
      for (let to = 0; to < NUM_COLS; to++) {
        if (to === from) continue;
        const tl = NS[o + LEN + to], to0 = o + to * MAXC;
        if (tl === 0) {
          // Empty columns are all one; a whole column into one changes nothing.
          if (triedEmpty || p === 0 || (split && splits < 2)) continue;
          triedEmpty = true;
        } else {
          const top = NS[to0 + tl - 1];
          if (top % 13 !== bottom % 13 + 1) continue;
          if (split && splits < 3 && ((top / 13) | 0) !== suit) continue;
        }
        if (tl + n - p > MAXC) continue;
        nf = 0;
        for (let e = 0; e < ne; e++) if (emptyCols[e] !== to) free[nf++] = emptyCols[e];
        if (np > 1 << nf) continue;
        if (require !== 0 && (require & (1 << from | 1 << to)) === 0) continue;
        // The position's hash before building it: only two columns change,
        // unless a suit completes.
        const td = NS[o + DOWN + to], nt = tl + n - p;
        let completes = false;
        if (nt - td >= 13 && NS[co + n - 1] % 13 === 0) {
          // The run at the top of the new column, through the join.
          let r = 1, x = NS[co + n - 1];
          while (r < 13) {
            const j = nt - r - 1; // the card under the run so far
            if (j < td) break;
            const y = j >= tl ? NS[co + p + j - tl] : NS[to0 + j];
            if (y - x !== 1 || y % 13 === 0) break;
            x = y;
            r++;
          }
          completes = r === 13;
        }
        if (!completes) {
          const df = p > 0 && p === d ? d - 1 : d;
          const turns = df < d; // (the card turned will be BLANK)
          if (turns) {
            tmp[d - 1] = BLANK;
            colHash(tmp, 0, p, d - 1);
          } else colHash(NS, co, p, d);
          let a = (PA[i] - CA[i * NUM_COLS + from] - CA[i * NUM_COLS + to] + ha) | 0;
          let b = (PB[i] - CB[i * NUM_COLS + from] - CB[i * NUM_COLS + to] + hb) | 0;
          for (let j = td; j < tl; j++) tmp[j] = NS[to0 + j];
          for (let j = p; j < n; j++) tmp[tl + j - p] = NS[co + j];
          colHash(tmp, 0, nt, td);
          a = (a + ha) | 0;
          b = (b + hb) | 0;
          if (!seenInsert(a, b)) continue;
        }
        if (count === cap) grow();
        const k = count, ko = k * SIZE;
        NS.copyWithin(ko, o, o + SIZE);
        step = [];
        stepFlip = false;
        movePieces(ko, from, to, 0, np, 0);
        CA.copyWithin(k * NUM_COLS, i * NUM_COLS, (i + 1) * NUM_COLS);
        CB.copyWithin(k * NUM_COLS, i * NUM_COLS, (i + 1) * NUM_COLS);
        rehashCol(k, from);
        rehashCol(k, to);
        sumHash(k);
        if (completes && !seenInsert(PA[k], PB[k])) continue;
        count++;
        parent[k] = i;
        stepOf[k] = step;
        leaf[k] = stepFlip ? 1 : 0;
        touched[k] = touched[i] | 1 << from | 1 << to;
        evaluate(k, cfg);
      }
    }
  }
}

// Every line from the position `root`: the nodes 0 (the root) to count - 1
// (search_state in lines.rs). A position reached by several lines is kept
// once; with a beam, only the best positions of each depth are taken further.
function search(root, cfg, splits, beam) {
  NS.set(root, 0);
  searchFrom(0, cfg, splits, cfg.maxSteps, beam);
}

// The same from the position already in place as node r: the nodes r to
// count - 1 (those below r are left alone, but for the table of positions
// reached, which is this search's from here on).
function searchFrom(r, cfg, splits, maxSteps, beam) {
  count = r + 1;
  if (count >= cap) grow();
  for (let c = 0; c < NUM_COLS; c++) rehashCol(r, c);
  sumHash(r);
  seenReset();
  seenInsert(PA[r], PB[r]);
  parent[r] = -1;
  leaf[r] = 0;
  touched[r] = 0;
  evaluate(r, cfg);
  let frontier = [r];
  for (let depth = 0; depth < maxSteps; depth++) {
    const first = count;
    for (const i of frontier) expand(i, splits, cfg.touch && depth > 0 ? touched[i] : 0, cfg);
    frontier = [];
    for (let k = first; k < count; k++) if (!leaf[k]) frontier.push(k);
    if (beam > 0 && frontier.length > beam) {
      const keep = new Set();
      for (const [empty, n] of [[cfg.empty, beam - (beam >> 1)], [cfg.dealEmpty, beam >> 1]]) {
        const ranked = frontier.slice().sort((x, y) => value(y, 0, empty) - value(x, 0, empty) || x - y);
        for (let j = 0; j < n; j++) keep.add(ranked[j]);
      }
      frontier = frontier.filter(k => keep.has(k));
    }
    if (!frontier.length) break;
  }
}

// Expectimax (expect_flips in lines.rs) for the best cfg.expectTop lines that
// turn a card, by the normal score and by the other (an empty column worth
// `empty`): node -> [normal, other], each the mean, over the cards `unseen`
// (how many of each card the player has not seen) that can come up, of the
// best score a smaller search reaches with that card there. The smaller
// searches use the nodes above the search's own, which stay as they are.
function expectFlips(dealsLeft, visited, cfg, empty, unseen) {
  const n = count, picked = [];
  for (const e of [cfg.empty, empty]) {
    const leaves = [];
    for (let k = 1; k < n; k++) if (leaf[k] && value(k, dealsLeft, e) > LOST && !visited.has(keyOf(PA[k], PB[k]))) leaves.push(k);
    leaves.sort((x, y) => value(y, dealsLeft, e) - value(x, dealsLeft, e) || x - y);
    for (let j = 0; j < cfg.expectTop && j < leaves.length; j++) if (!picked.includes(leaves[j])) picked.push(leaves[j]);
  }
  const out = new Map();
  if (!picked.length) return out;
  let total = 0;
  for (let card = 0; card < 52; card++) total += unseen[card];
  for (const k of picked) {
    // The card turned: the only face-up card of its column.
    let at = -1;
    for (let c = 0; c < NUM_COLS && at < 0; c++) {
      const len = NS[k * SIZE + LEN + c];
      if (len > 0 && NS[k * SIZE + DOWN + c] + 1 === len && NS[k * SIZE + c * MAXC + len - 1] === BLANK) at = c * MAXC + len - 1;
    }
    let sum0 = 0, sum1 = 0;
    for (let card = 0; card < 52; card++) {
      if (!unseen[card]) continue;
      if (n >= cap) grow();
      NS.copyWithin(n * SIZE, k * SIZE, (k + 1) * SIZE);
      NS[n * SIZE + at] = card;
      searchFrom(n, cfg, cfg.splits, cfg.expectSteps, cfg.expectBeam);
      let best0 = LOST, best1 = LOST;
      for (let j = n; j < count; j++) {
        if (dealsLeft > 0 && evCards[j] < NUM_COLS) continue; // (lost)
        const v0 = evBase[j] + cfg.empty * evEmpties[j], v1 = evBase[j] + empty * evEmpties[j];
        if (v0 > best0) best0 = v0;
        if (v1 > best1) best1 = v1;
      }
      sum0 += unseen[card] * Math.max(best0, LOST / 2);
      sum1 += unseen[card] * Math.max(best1, LOST / 2);
    }
    out.set(k, [Math.trunc(sum0 / total), Math.trunc(sum1 / total)]);
  }
  count = n;
  return out;
}

// The moves of the line to node k, as [from, to, count, ...].
function lineTo(k) {
  const steps = [];
  for (; k !== 0; k = parent[k]) steps.push(stepOf[k]);
  return steps.reverse().flat();
}

const DEAL = 'deal', STUCK = 'stuck';

// What to do in the position `root` with this many deals left
// (decide_steps in lines.rs): a line's moves, DEAL or STUCK. `visited` has
// the keys of the positions never to return to, `tempo.dealing` says that the
// player is about to deal, `tempo.work` counts the positions looked at (those
// of the expectimax apart, as in the Rust). `unseen` is asked for the cards
// not seen (see expectFlips) if they are needed.
function decide(root, dealsLeft, visited, tempo, cfg, unseen) {
  search(root, cfg, cfg.splits, cfg.beam);
  tempo.work += count;
  const fresh = k => !visited.has(keyOf(PA[k], PB[k]));
  const empty = dealsLeft > 0 ? cfg.dealEmpty : cfg.endEmpty;
  const expected = cfg.expectTop > 0 ? expectFlips(dealsLeft, visited, cfg, empty, unseen()) : null;
  const scored = expected?.size ? (k, mode, e) => expected.get(k)?.[mode] ?? value(k, dealsLeft, e) : (k, mode, e) => value(k, dealsLeft, e);
  if (!tempo.dealing) {
    let best = 0, bestScore = value(0, dealsLeft, cfg.empty);
    for (let k = 1; k < count; k++) {
      const sc = scored(k, 0, cfg.empty);
      if (sc > bestScore && fresh(k)) { best = k; bestScore = sc; }
    }
    if (best) return lineTo(best);
  }
  // About to deal or, with the stock gone, to give up.
  const dealValue = k => { const v = scored(k, 1, empty); return v > LOST && leaf[k] ? v + cfg.dealFlip : v; };
  let best = 0, bestScore = value(0, dealsLeft, empty);
  for (let k = 1; k < count; k++) {
    const sc = dealValue(k);
    if (sc > bestScore && fresh(k)) { best = k; bestScore = sc; }
  }
  if (best) {
    tempo.dealing = true;
    return lineTo(best);
  }
  if (dealsLeft === 0) return STUCK;
  if (evEmpties[0] === 0) return DEAL;
  // An empty column that no line fills at a profit: fill it as cheaply as
  // can be, splitting runs if there is no other way.
  tempo.dealing = true;
  const fill = () => {
    let at = 0, most = 0;
    for (let k = 1; k < count; k++) {
      if (evEmpties[k] !== 0 || !fresh(k)) continue;
      const v = value(k, dealsLeft, empty);
      if (!at || v > most) { at = k; most = v; }
    }
    return at && most > LOST ? at : 0;
  };
  let k = fill();
  if (k) return lineTo(k);
  search(root, cfg, 3, Math.max(cfg.beam, 100));
  tempo.work += count;
  k = fill();
  return k ? lineTo(k) : STUCK;
}

// Play the game on from the position `s`, changing it, with the stock (dealt
// from the end, a card for each column from the first) until it is won or the
// player gives up (play_until in lines.rs). Returns {won, completed, work},
// and the moves in `moves` if one is given ({from, to, count} or {deal: true}).
// With `toShow` it stops right after the first move that turns a card or
// deals (and returns nothing).
export function playOut(s, stock, cfg, moves = null, toShow = false) {
  const visited = new Set(), tempo = { dealing: false, work: 0 };
  let left = stock.length, played = 0;
  // How many of each card are face down or in the stock.
  const counts = new Uint8Array(52);
  const unseen = () => {
    counts.fill(0);
    for (let c = 0; c < NUM_COLS; c++) for (let i = 0; i < s[DOWN + c]; i++) counts[s[c * MAXC + i]]++;
    for (let i = 0; i < left; i++) counts[stock[i]]++;
    return counts;
  };
  const progress = () => {
    let down = 0;
    for (let c = 0; c < NUM_COLS; c++) down += s[DOWN + c];
    return down * 10000 + left * 10 + s[DONE];
  };
  while (s[DONE] < 8 && played < 5000) {
    const before = progress();
    const d = decide(s, left / NUM_COLS, visited, tempo, cfg, unseen);
    visited.add(keyOf(PA[0], PB[0])); // (the position it stood in, as the search hashed it; decide only asks about others)
    if (d === STUCK) break;
    if (d === DEAL) {
      played++;
      moves?.push({ deal: true });
      let room = true;
      for (let c = 0; c < NUM_COLS; c++) if (s[LEN + c] >= MAXC) room = false;
      if (!room) break; // a column too long for the search ends the game
      for (let c = 0; c < NUM_COLS; c++) s[c * MAXC + s[LEN + c]++] = stock[--left];
      for (let c = 0; c < NUM_COLS; c++) removeIfComplete(s, 0, c, -1);
    } else {
      for (let j = 0; j < d.length; j += 3) {
        const turned = applyMove(s, 0, d[j], d[j + 1], d[j + 2], -1);
        moves?.push({ from: d[j], to: d[j + 1], count: d[j + 2] });
        if (turned && toShow) return null; // (a step may go on after its card turns: the rest is left out)
      }
      played += d.length / 3;
    }
    if (progress() !== before) {
      tempo.dealing = false;
      if (toShow && Math.floor(progress() / 10) !== Math.floor(before / 10)) break;
    }
  }
  return { won: s[DONE] === 8, completed: s[DONE], work: tempo.work };
}
