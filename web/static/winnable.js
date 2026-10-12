// The peeking solver: can this game still be won? It looks at the face-down
// cards and the stock. A port of the class search in src/solver.rs (its
// default configuration), which explains the algorithm; the search is the
// same step for step, so for the same position and budget both give the same
// verdict, work and winning line (`cargo test` in the repository root
// compares them through test/winnable.mjs). In short: positions joined by
// reversible moves form a class, enumerated breadth-first; the search goes
// depth-first over the irreversible moves out of classes, best evaluation
// first, in resumable slices per stock stage. Runs that could split are only
// split in later passes, which run when the first finds no win. Certificates
// (certify.rs) prove some positions lost without a search: the position to
// be solved with a deal left or none, and positions of the search once the
// stock is empty.
//
// Only the layout differs from solver.rs, to keep the work in typed arrays:
// * A position being worked on is "expanded": MS bytes, each column in its
//   own MAXC bytes. The members of the class being enumerated are slots of
//   one array (M), each with IS ints (MI) of hashes and scores.
// * A position waiting in a queue is "packed": PACKED bytes, the cards of all
//   columns end to end, a record in an arena (PA) with a free list.
// * A column hashes to the sum of a random number per (height, card), mixed;
//   a position's key is the sum over its columns, so it does not depend on
//   the order of the columns and updates cheaply for a move. Keys are two
//   32-bit halves.
//
// As a worker: gets {key, suits, seed, moves, budgets} and solves with each
// budget in turn until one gives a verdict, replying {key, verdict, line,
// last} after each.
import { Game, DEAL, parseMoves, encodeMoves } from './game.js';

const NC = 10, MAXC = 48;
const MS = 512, LEN = 480, DOWN = 490, DONE = 500, DEALT = 501;
const IS = 64, RAWL = 0, RAWH = 10, PARL = 20, PARH = 30, SUML = 40, SUMH = 41, PARENT = 42, MOVE = 43, DEALSC = 44;
const PACKED = 128; // completed, deals done, 10 lengths, 10 face-down counts, up to 104 cards

// The default configuration of solver.rs.
const W_COMPLETED = 1000, W_HIDDEN = 12, W_SAME = 4, W_DIFF = 1, W_WRONG = 2, W_EMPTY = 30, W_KING = 3;
const CLASS_CAP = 20000, SUSPEND_KEEP = 20000, STAGE_CAP_MIN = 20000;
const CERTIFY_LIMIT = 10000, ROOT_CERTIFY_LIMIT = 200000;
const DEALS_PER_CLASS = 4, DEALS_PER_STAGE = 8, RESUME_TAX = 30, SUB_ALLOC = 8, SUB_GROWTH = 2, DEPTH_W = 100000;

const SOLVABLE = 'solvable', UNSOLVABLE = 'unsolvable', NOT_FOUND = 'not found', UNKNOWN = 'unknown';
const DEAL_MOVE = -1; // a move is otherwise from << 16 | to << 8 | count

// Random numbers per (height in the column, card), and per (completed, deals done).
const ZL = new Int32Array(MAXC * 52), ZH = new Int32Array(MAXC * 52), HL = new Int32Array(128), HH = new Int32Array(128);
{
  let x = 0x2545F491;
  const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x; };
  for (const t of [ZL, ZH, HL, HH]) for (let i = 0; i < t.length; i++) t[i] = next();
}

// A column's part of the key, from the sum of its cards' numbers and its
// face-down count: into F0, F1.
let F0 = 0, F1 = 0;
function part(lo, hi, down) {
  lo = Math.imul(lo ^ (hi >>> 15) ^ Math.imul(down + 1, 0x9E3779B1), 0x85EBCA6B);
  hi = Math.imul(hi ^ (lo >>> 13), 0xC2B2AE35);
  lo = Math.imul(lo ^ (hi >>> 16), 0x27D4EB2F);
  hi = Math.imul(hi ^ (lo >>> 15), 0x165667B1);
  F0 = lo ^ (hi >>> 14);
  F1 = hi ^ (F0 >>> 16);
}

// A set of keys: open addressing, at most half full.
class KeySet {
  constructor() {
    this.t = new Int32Array(1 << 15);
    this.mask = (1 << 14) - 1;
    this.n = 0;
  }

  has(lo, hi) {
    if ((lo | hi) === 0) lo = 1; // 0, 0 marks an empty place
    const t = this.t, mask = this.mask;
    for (let i = lo & mask; ; i = (i + 1) & mask) {
      const a = t[2 * i], b = t[2 * i + 1];
      if (a === lo && b === hi) return true;
      if ((a | b) === 0) return false;
    }
  }

  // Add a key that is not there.
  add(lo, hi) {
    if ((lo | hi) === 0) lo = 1;
    if (2 * ++this.n > this.mask) {
      const old = this.t;
      this.t = new Int32Array(old.length * 2);
      this.mask = this.mask * 2 + 1;
      for (let j = 0; j < old.length; j += 2) if ((old[j] | old[j + 1]) !== 0) this.put(old[j], old[j + 1]);
    }
    this.put(lo, hi);
  }

  put(lo, hi) {
    const t = this.t, mask = this.mask;
    let i = lo & mask;
    while ((t[2 * i] | t[2 * i + 1]) !== 0) i = (i + 1) & mask;
    t[2 * i] = lo;
    t[2 * i + 1] = hi;
  }

  clear() {
    this.t.fill(0);
    this.n = 0;
  }
}

// Max-heaps of things ordered by `gt`.
function heapPush(h, x, gt) {
  let i = h.length;
  h.push(x);
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!gt(x, h[up])) break;
    h[i] = h[up];
    i = up;
  }
  h[i] = x;
}

function heapPop(h, gt) {
  const top = h[0], x = h.pop(), n = h.length;
  if (n > 0) {
    let i = 0;
    for (;;) {
      let kid = 2 * i + 1;
      if (kid >= n) break;
      if (kid + 1 < n && gt(h[kid + 1], h[kid])) kid++;
      if (!gt(h[kid], x)) break;
      h[i] = h[kid];
      i = kid;
    }
    h[i] = x;
  }
  return top;
}

// ---------------------------------------------------------------- the certificate with deals and empty columns

// Is this position proved lost by the certificate of certify.rs
// (lost_certificate, which explains it)? It is the top-rank certificate (see
// topRankDead below) carried across deals and past the emptying of columns:
// a search of a small game that every line of real play maps onto up to the
// first suit completed. A position of it is, per column, how many cards have
// never moved (LEFT) or, with none, the rank at its bottom plus one (BASE);
// the ranks of the tops (TOPS) and those they have ever had (EVER); the
// deals made, whose cards are still in place (PLACE) and which of the ranks
// each deal covered are unaccounted for (POOL); and per deal made and column
// the cards its card may lie on (`under`, 7 bytes of bits a column).
// cols: the columns, bottom card first; down: face-down cards per column;
// deals: the deals to come. Returns whether the position is lost, with the
// positions looked at (at most limit before giving up) in lostNodes.
const C_LEFT = 0, C_BASE = 10, C_TOPS = 20, C_EVER = 34, C_DEALS = 36, C_PLACE = 37, C_POOL = 47, C_SIZE = 112;
const MAX_DEALS = 5, ANY_RANK = 0x3FFF;
let lostNodes = 0;

function lost(cols, down, deals, limit) {
  lostNodes = 0;
  if (deals.length > MAX_DEALS) return false;
  const unit = (c, left) => {
    const col = cols[c], d = down[c];
    let u = left - 1;
    while (u > d && col[u - 1] === col[u] + 1 && col[u] % 13 !== 12) u--;
    return u;
  };
  const ever = b => b[C_EVER] | b[C_EVER + 1] << 8;
  const setEver = (b, v) => { b[C_EVER] = v & 255; b[C_EVER + 1] = v >> 8; };
  const inPlace = (b, j, c) => (b[C_PLACE + 2 * j + (c >> 3)] >> (c & 7)) & 1;
  const take = (b, j, c) => { b[C_PLACE + 2 * j + (c >> 3)] &= ~(1 << (c & 7)); };
  // The last deal whose card on column c is still in place, or -1.
  const dealtOn = (b, c) => {
    for (let j = b[C_DEALS] - 1; j >= 0; j--) if (inPlace(b, j, c)) return j;
    return -1;
  };
  const ofRank = (set, rank) => set[rank] | set[rank + 13] | set[rank + 26] | set[rank + 39];
  // The cards that may have moved: those above what has never moved, those
  // of a top unit above a place where it could have been split, and the
  // dealt cards no longer in place.
  const movedSet = b => {
    const set = new Uint8Array(52), ev = ever(b);
    for (let c = 0; c < NC; c++) {
      const col = cols[c], left = b[C_LEFT + c];
      for (let i = left; i < col.length; i++) set[col[i]] = 1;
      if (left > 0) {
        for (let i = unit(c, left) + 1; i < left; i++) {
          if ((ev >> (col[i] % 13 + 1)) & 1) {
            for (let k = i; k < left; k++) set[col[k]] = 1;
            break;
          }
        }
      }
    }
    for (let j = 0; j < b[C_DEALS]; j++) for (let c = 0; c < NC; c++) if (!inPlace(b, j, c)) set[deals[j][c]] = 1;
    return set;
  };
  // Might some suit be completed: has one of its kings moved, or is it on
  // top of what has not moved of its column with only cards of its suit
  // dealt onto it since, and has every card of the suit not in place on
  // the king moved (it has to, onto the run) or been dealt there?
  const completable = (b, moved) => {
    // The cards dealt and in place on columns emptied and refilled, where a
    // king that moved may be.
    const refilled = moved.slice();
    for (let j = 0; j < b[C_DEALS]; j++) {
      for (let c = 0; c < NC; c++) if (b[C_LEFT + c] === 0 && inPlace(b, j, c)) refilled[deals[j][c]] = 1;
    }
    const all = (ace, lowest, have) => {
      for (let card = ace; card < lowest; card++) if (!have[card]) return false;
      return true;
    };
    for (let suit = 0; suit < 4; suit++) {
      const king = suit * 13 + 12, ace = suit * 13;
      if (moved[king] && all(ace, king, refilled)) return true;
      for (let c = 0; c < NC; c++) {
        // The cards dealt onto the column and in place, last first: a king
        // of the suit there, or under them all, will do if those above it
        // are of the suit.
        const have = moved.slice();
        let clear = true;
        for (let j = b[C_DEALS] - 1; j >= 0 && clear; j--) {
          if (!inPlace(b, j, c)) continue;
          const v = deals[j][c];
          if (v === king && all(ace, king, have)) return true;
          if (Math.floor(v / 13) !== suit) clear = false;
          have[v] = 1;
        }
        const left = b[C_LEFT + c];
        if (clear && left > 0 && cols[c][unit(c, left)] === king && all(ace, cols[c][left - 1], have)) return true;
      }
    }
    return false;
  };

  const seen = new Set(), stack = [];
  // Look at one position: whether a suit might be completed in it, and if
  // not and it is new, the positions one step on, onto the stack.
  const step = st => {
    const b = st.b, L = deals.length;
    // Units that come off onto a top without changing the tops cost nothing.
    for (let free = true; free; ) {
      free = false;
      for (let c = 0; c < NC; c++) {
        if (b[C_LEFT + c] === 0 || dealtOn(b, c) >= 0) continue;
        const u = unit(c, b[C_LEFT + c]), rank = cols[c][u] % 13;
        if (u > 0 && b[C_TOPS + rank + 1] > 0 && cols[c][u - 1] % 13 === rank + 1) {
          b[C_LEFT + c] = u;
          free = true;
        }
      }
    }
    const dealtAll = b[C_DEALS] === L;
    // After the last deal, columns with nothing that never moved and
    // nothing dealt in place are alike.
    if (dealtAll) {
      const which = [], bases = [];
      for (let c = 0; c < NC; c++) {
        if (b[C_LEFT + c] === 0 && dealtOn(b, c) < 0) {
          which.push(c);
          bases.push(b[C_BASE + c]);
        }
      }
      bases.sort((x, y) => x - y);
      which.forEach((c, i) => { b[C_BASE + c] = bases[i]; });
    }
    let empty = [];
    for (let c = 0; c < NC; c++) if (b[C_LEFT + c] === 0 && b[C_BASE + c] === 0) empty.push(c);
    if (empty.length) setEver(b, ANY_RANK);
    const moved = movedSet(b);
    if (completable(b, moved)) return true;
    const key = String.fromCharCode.apply(null, b) + st.ukey;
    if (seen.has(key)) return false;
    seen.add(key);
    const canDeal = !dealtAll && empty.length === 0;
    if (dealtAll) empty = empty.slice(0, 1); // empty columns are alike too
    const push = t => stack.push({ b: t, under: st.under, ukey: st.ukey });
    for (let c = 0; c < NC; c++) {
      const j = dealtOn(b, c);
      if (j >= 0) {
        // The card dealt onto the column.
        const card = deals[j][c], rank = card % 13, u = st.under[j], o = c * 7;
        const may = v => (u[o + (v >> 3)] >> (v & 7)) & 1;
        // As part of the run of the next card of its suit, if it may lie on one.
        if (rank < 12 && b[C_POOL + j * 13 + rank + 1] > 0 && may(card + 1)) {
          const t = b.slice();
          take(t, j, c);
          t[C_POOL + j * 13 + rank + 1]--;
          push(t);
        }
        for (let gives = 0; gives < 13; gives++) {
          if (b[C_POOL + j * 13 + gives] === 0 || !(may(gives) | may(gives + 13) | may(gives + 26) | may(gives + 39))) continue;
          const t = b.slice();
          take(t, j, c);
          t[C_POOL + j * 13 + gives]--;
          t[C_TOPS + gives]++;
          setEver(t, ever(t) | 1 << gives);
          if (b[C_TOPS + rank + 1] > 0) {
            const t2 = t.slice();
            t2[C_TOPS + rank + 1]--;
            push(t2);
          }
          for (const e of empty) {
            const t2 = t.slice();
            t2[C_BASE + e] = rank + 1;
            push(t2);
          }
        }
        continue;
      }
      const left = b[C_LEFT + c];
      if (left === 0) {
        // A refilled column is emptied.
        const base = b[C_BASE + c];
        if (base > 0 && b[C_TOPS + base] > 0) {
          const t = b.slice();
          t[C_BASE + c] = 0;
          t[C_TOPS + base]--;
          push(t);
        }
        continue;
      }
      const u = unit(c, left), rank = cols[c][u] % 13, under = u > 0 ? cols[c][u - 1] % 13 : -1;
      if (b[C_TOPS + rank + 1] > 0) {
        // The top unit goes onto a top.
        const t = b.slice();
        t[C_LEFT + c] = u;
        t[C_TOPS + rank + 1]--;
        if (under >= 0) {
          t[C_TOPS + under]++;
          setEver(t, ever(t) | 1 << under);
        }
        push(t);
      }
      if (under >= 0) {
        // The top unit goes into an empty column.
        for (const e of empty) {
          const t = b.slice();
          t[C_LEFT + c] = u;
          t[C_TOPS + under]++;
          t[C_BASE + e] = rank + 1;
          push(t);
        }
      }
    }
    for (const e of empty) {
      // A card that has moved, or of a top unit, goes into an empty column,
      // uncovering a card one rank higher.
      const loose = moved.slice();
      for (let c = 0; c < NC; c++) {
        const left = b[C_LEFT + c];
        if (left > 0 && dealtOn(b, c) < 0) for (let i = unit(c, left) + 1; i < left; i++) loose[cols[c][i]] = 1;
      }
      for (let rank = 0; rank < 12; rank++) {
        if (!ofRank(loose, rank)) continue;
        const t = b.slice();
        t[C_BASE + e] = rank + 1;
        t[C_TOPS + rank + 1]++;
        push(t);
      }
    }
    if (canDeal) {
      const j = b[C_DEALS], t = b.slice(), u = new Uint8Array(70), ev = ever(b);
      for (let c = 0; c < NC; c++) {
        // What may be on top of the column: its dealt card, a card of its
        // top unit or the one at its bottom if it was refilled, or moved
        // cards chained down from those.
        const top = new Uint8Array(52), k = dealtOn(b, c), col = cols[c], left = b[C_LEFT + c];
        if (k >= 0) top[deals[k][c]] = 1;
        else if (left > 0) {
          for (let i = unit(c, left); i < left; i++) if (i === left - 1 || (ev >> (col[i + 1] % 13 + 1)) & 1) top[col[i]] = 1;
        } else {
          const rank = b[C_BASE + c] - 1;
          for (let v = rank; v < 52; v += 13) top[v] = moved[v];
        }
        for (let rank = 12; rank >= 1; rank--) {
          if (ofRank(top, rank)) for (let v = rank - 1; v < 52; v += 13) top[v] |= moved[v];
        }
        for (let v = 0; v < 52; v++) if (top[v]) u[c * 7 + (v >> 3)] |= 1 << (v & 7);
      }
      let ev2 = ev;
      for (let r = 0; r < 13; r++) {
        t[C_POOL + j * 13 + r] = b[C_TOPS + r];
        t[C_TOPS + r] = 0;
      }
      for (let c = 0; c < NC; c++) {
        const rank = deals[j][c] % 13;
        t[C_TOPS + rank]++;
        ev2 |= 1 << rank;
      }
      setEver(t, ev2);
      t[C_PLACE + 2 * j] = 0xFF;
      t[C_PLACE + 2 * j + 1] = 0x03;
      t[C_DEALS]++;
      stack.push({ b: t, under: [...st.under, u], ukey: st.ukey + String.fromCharCode.apply(null, u) });
    }
    return false;
  };

  const b = new Uint8Array(C_SIZE);
  let ev = 0;
  for (let c = 0; c < NC; c++) {
    const n = cols[c].length;
    b[C_LEFT + c] = n;
    if (n > 0) {
      const rank = cols[c][n - 1] % 13;
      b[C_TOPS + rank]++;
      ev |= 1 << rank;
    } else ev = ANY_RANK;
  }
  setEver(b, ev);
  stack.push({ b, under: [], ukey: '' });
  while (stack.length) {
    const st = stack.pop();
    if (++lostNodes > limit) return false;
    // Depth first, the steps in the order `step` gives them.
    const from = stack.length;
    if (step(st)) return false;
    for (let i = from, k = stack.length - 1; i < k; i++, k--) [stack[i], stack[k]] = [stack[k], stack[i]];
  }
  return true;
}

const candGt = (a, b) => a.key > b.key || (a.key === b.key && a.seq > b.seq);

class Solver {
  // game: {columns, faceDown, stock, completed} as in game.js. budget bounds
  // the work: positions enumerated within classes plus exits.
  constructor(game, budget) {
    this.deals = [];
    for (let end = game.stock.length; end >= NC; end -= NC) this.deals.push(game.stock.slice(end - NC, end).reverse());
    this.budget = budget;
    this.stageCap = Math.max(Math.floor(budget / 100), STAGE_CAP_MIN);
    this.endCap = this.stageCap;
    this.work = 0;
    this.classes = 0;
    this.seq = 0;
    this.aborted = false;
    this.splits = false; // sub-runs of a same-suit run may move
    this.splitExits = false; // and those moves, and same-suit joins, are irreversible
    this.found = new KeySet(); // keys of the members of every class expanded so far

    // Expanded positions: the members of the class being enumerated, and one more to build in.
    this.M = new Uint8Array((CLASS_CAP + 2) * MS);
    this.MI = new Int32Array((CLASS_CAP + 2) * IS);
    this.moves = new Int32Array(512);
    this.withTop = new Int32Array(14);
    this.tops = new Int32Array(NC);
    this.nmem = 0;
    this.exits = []; // per exit kept: record, member, move, index among all exits, key (two halves)
    this.nexits = 0;
    this.win = null; // {member, move} that wins outright

    // Packed positions waiting in a stage's heap (or for their deal), and per record:
    // its key in the heap, tie-break, parent node, depth in the stage, path from the parent.
    this.pcap = 1024;
    this.PA = new Uint8Array(this.pcap * PACKED);
    this.pkey = new Int32Array(this.pcap);
    this.pseq = new Float64Array(this.pcap);
    this.pparent = new Int32Array(this.pcap);
    this.pdepth = new Int32Array(this.pcap);
    this.poff = new Int32Array(this.pcap);
    this.plen = new Int32Array(this.pcap);
    this.pn = 0;
    this.free = [];
    this.pendingGt = (a, b) => this.pkey[a] > this.pkey[b] || (this.pkey[a] === this.pkey[b] && this.pseq[a] > this.pseq[b]);

    // Paths (moves through a class, two bytes each or 255 for a deal), and the
    // expanded classes as nodes: parent and the path from it.
    this.paths = new Uint8Array(1 << 16);
    this.pathN = 0;
    this.pathLen = 0; // of the path encodePath just wrote
    this.nparent = new Int32Array(1024);
    this.noff = new Int32Array(1024);
    this.nlen = new Int32Array(1024);
    this.nn = 0;
    this.winNode = -1;

    this.stages = [];
    this.queue = []; // heap of candidates: deal points to open as stages, and stages to resume
    this.incomplete = false; // something was cut short, so an exhausted search proves nothing

    this.root = new Uint8Array(PACKED);
    const M = this.M;
    M[DONE] = game.completed.length;
    for (let c = 0; c < NC; c++) {
      const col = game.columns[c];
      if (col.length > MAXC) throw new Error('column too long');
      M.set(col, c * MAXC);
      M[LEN + c] = col.length;
      M[DOWN + c] = game.faceDown[c];
    }
    this.packInto(0, this.root, 0);
  }

  // ---------------------------------------------------------------- positions

  packInto(slot, A, o) {
    const M = this.M, b = slot * MS;
    A[o] = M[b + DONE];
    A[o + 1] = M[b + DEALT];
    let at = o + 22;
    for (let c = 0; c < NC; c++) {
      const n = M[b + LEN + c], col = b + c * MAXC;
      A[o + 2 + c] = n;
      A[o + 12 + c] = M[b + DOWN + c];
      for (let i = 0; i < n; i++) A[at++] = M[col + i];
    }
  }

  // Expand a packed position into a slot, with its hashes.
  unpackFrom(A, o, slot) {
    const M = this.M, b = slot * MS, ib = slot * IS;
    M[b + DONE] = A[o];
    M[b + DEALT] = A[o + 1];
    let at = o + 22;
    for (let c = 0; c < NC; c++) {
      const n = A[o + 2 + c], col = b + c * MAXC;
      M[b + LEN + c] = n;
      M[b + DOWN + c] = A[o + 12 + c];
      for (let i = 0; i < n; i++) M[col + i] = A[at++];
    }
    this.rehash(b, ib);
  }

  rehash(b, ib) {
    const MI = this.MI;
    let sl = 0, sh = 0;
    for (let c = 0; c < NC; c++) {
      this.rehashCol(b, ib, c);
      sl = (sl + MI[ib + PARL + c]) | 0;
      sh = (sh + MI[ib + PARH + c]) | 0;
    }
    MI[ib + SUML] = sl;
    MI[ib + SUMH] = sh;
  }

  rehashCol(b, ib, c) {
    const M = this.M, MI = this.MI, n = M[b + LEN + c], col = b + c * MAXC;
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      const z = i * 52 + M[col + i];
      lo = (lo + ZL[z]) | 0;
      hi = (hi + ZH[z]) | 0;
    }
    MI[ib + RAWL + c] = lo;
    MI[ib + RAWH + c] = hi;
    part(lo, hi, M[b + DOWN + c]);
    MI[ib + PARL + c] = F0;
    MI[ib + PARH + c] = F1;
  }

  // Longest same-suit descending run at the top of a column.
  runLen(b, c) {
    const M = this.M, n = M[b + LEN + c], d = M[b + DOWN + c], col = b + c * MAXC;
    if (n === d) return 0;
    let k = 1;
    while (n - k > d && M[col + n - k - 1] === M[col + n - k] + 1 && M[col + n - k] % 13 !== 12) k++;
    return k;
  }

  flipIfNeeded(b, c) {
    const M = this.M;
    if (M[b + LEN + c] > 0 && M[b + DOWN + c] === M[b + LEN + c]) M[b + DOWN + c]--;
  }

  removeIfComplete(b, c) {
    const M = this.M, n = M[b + LEN + c];
    if (n >= 13 && M[b + c * MAXC + n - 1] % 13 === 0 && this.runLen(b, c) >= 13) {
      M[b + LEN + c] = n - 13;
      M[b + DONE]++;
      this.flipIfNeeded(b, c);
    }
  }

  // A column's part of the evaluation: n cards at o, d of them face down.
  colScore(o, n, d) {
    if (n === 0) return W_EMPTY;
    const M = this.M;
    let score = -W_HIDDEN * d, run = 1;
    for (let i = d > 1 ? d : 1; i < n; i++) {
      const upper = M[o + i - 1], lower = M[o + i];
      if (upper % 13 === lower % 13 + 1) {
        if (upper === lower + 1) {
          score += W_SAME;
          run++;
        } else {
          score += W_DIFF + run * run;
          run = 1;
        }
      } else {
        score += run * run - W_WRONG;
        run = 1;
      }
    }
    score += run * run;
    if (d === 0 && M[o] % 13 === 12) score += W_KING;
    return score;
  }

  // Static evaluation: higher is closer to winning.
  evalAt(b) {
    const M = this.M;
    let score = W_COMPLETED * M[b + DONE];
    for (let c = 0; c < NC; c++) score += this.colScore(b + c * MAXC, M[b + LEN + c], M[b + DOWN + c]);
    return score;
  }

  // What column c adds to the evaluation once `card` is dealt onto it,
  // including the completed run if that completes one.
  dealColScore(b, c, card) {
    const M = this.M, o = b + c * MAXC;
    let n = M[b + LEN + c], d = M[b + DOWN + c], score = 0;
    if (n === 0 || n >= MAXC) return 0; // no deal from here
    M[o + n++] = card; // above the column's cards, where nothing looks
    if (card % 13 === 0 && n - d >= 13) {
      let k = 1;
      while (k < 13 && M[o + n - 1 - k] === card + k) k++;
      if (k === 13) {
        n -= 13;
        score = W_COMPLETED;
        if (n > 0 && d === n) d--;
      }
    }
    return score + this.colScore(o, n, d);
  }

  // Every legal move except dealing, into this.moves; returns how many.
  // Empty columns are interchangeable, so only the first is a target.
  legalMoves(b) {
    const M = this.M, out = this.moves, splits = this.splits;
    // The columns with each top rank as a bit set (13: the first empty column).
    const withTop = this.withTop, tops = this.tops;
    withTop.fill(0);
    for (let c = 0; c < NC; c++) {
      const n = M[b + LEN + c];
      if (n > 0) {
        tops[c] = M[b + c * MAXC + n - 1] % 13;
        withTop[tops[c]] |= 1 << c;
      } else if (withTop[13] === 0) withTop[13] = 1 << c;
    }
    let count = 0;
    for (let from = 0; from < NC; from++) {
      const fl = M[b + LEN + from];
      if (fl === 0) continue;
      const run = this.runLen(b, from), top = tops[from];
      // The run, or with splits any top part of it, fits a card as many
      // ranks above its top card as it is long.
      const lo = splits ? 1 : run, hi = Math.min(run, 12 - top);
      let targets = withTop[13];
      for (let k = lo; k <= hi; k++) targets |= withTop[top + k];
      while (targets !== 0) {
        const to = 31 - Math.clz32(targets & -targets);
        targets &= targets - 1;
        if (M[b + LEN + to] === 0) {
          for (let k = lo; k <= run; k++) if (k !== fl) out[count++] = from << 16 | to << 8 | k; // not a whole column to another empty one
        } else out[count++] = from << 16 | to << 8 | (tops[to] - top);
      }
    }
    return count;
  }

  // Can the moved run immediately be moved back as a whole? Not if a card
  // was turned over or a run completed, if it left a card that is not one
  // rank higher, or if it joined its own suit (undoing that is a split),
  // unless splits are in the classes.
  reversibleMove(b, from, to, count) {
    const M = this.M, fl = M[b + LEN + from], tl = M[b + LEN + to], down = M[b + DOWN + from];
    const col = b + from * MAXC, bottom = M[col + fl - count];
    if (count === fl - down && down > 0) return false;
    if (tl > 0 && Math.floor(M[b + to * MAXC + tl - 1] / 13) === Math.floor(bottom / 13)) {
      if (!this.splits || this.splitExits) return false;
      if (M[col + fl - 1] % 13 === 0 && this.runLen(b, to) + count >= 13) return false;
    }
    if (this.splits && this.splitExits && count < this.runLen(b, from)) return false;
    return count === fl || M[col + fl - count - 1] % 13 === bottom % 13 + 1;
  }

  // ---------------------------------------------------------------- the top-rank certificate

  // Is the position at b, the stock being empty, proved lost by the
  // top-rank certificate (certify.rs, which has the argument)? While no
  // column is empty the ranks of the ten top cards change only when a card
  // leaves a card that is not one rank higher, and a card can only leave a
  // card that is not the next of its suit while some top card is one rank
  // higher. So a small game is searched instead: per column how many cards
  // have never moved, in whole units (a card and the same-suit run on it),
  // and the ranks of the tops. If it cannot empty a column or complete a
  // suit, neither can the real one. this.certNodes counts its positions.
  topRankDead(b) {
    const M = this.M, left = new Uint8Array(NC), tops = new Uint8Array(14);
    this.certNodes = 0;
    for (let c = 0; c < NC; c++) {
      const n = M[b + LEN + c];
      if (n === 0) return false;
      left[c] = n;
      tops[M[b + c * MAXC + n - 1] % 13]++;
    }
    this.certSeen = new Set();
    return !this.certEvent(b, left, tops);
  }

  // Where the top unit of column c starts when `left` cards have not moved.
  certUnit(b, c, left) {
    const M = this.M, o = b + c * MAXC, d = M[b + DOWN + c];
    let u = left - 1;
    while (u > d && M[o + u - 1] === M[o + u] + 1 && M[o + u] % 13 !== 12) u--;
    return u;
  }

  // Can a column be emptied or a suit completed? Says yes when it gives up.
  certEvent(b, left, tops) {
    if (++this.certNodes > CERTIFY_LIMIT) return true;
    const M = this.M;
    // Steps that leave the tops' ranks as they are cost nothing: take them
    // all. The others: column, cards left after, rank taken, rank given.
    let steps;
    for (let free = true; free; ) {
      steps = [];
      free = false;
      for (let c = 0; c < NC; c++) {
        const u = this.certUnit(b, c, left[c]), o = b + c * MAXC + u, rank = M[o] % 13;
        if (tops[rank + 1] === 0) continue;
        if (u === 0) return true; // the column is emptied
        const under = M[o - 1] % 13;
        if (under === rank + 1) {
          left[c] = u;
          free = true;
        } else steps.push(c, u, rank + 1, under);
      }
    }
    if (this.certCompletable(b, left)) return true;
    const key = String.fromCharCode(...left);
    if (this.certSeen.has(key)) return false;
    this.certSeen.add(key);
    for (let i = 0; i < steps.length; i += 4) {
      const l = left.slice(), t = tops.slice();
      l[steps[i]] = steps[i + 1];
      t[steps[i + 2]]--;
      t[steps[i + 3]]++;
      if (this.certEvent(b, l, t)) return true;
    }
    return false;
  }

  // Might some suit be completed: is a king's unit on top of its column,
  // with a copy of every lower card of the suit moved, or in a top unit
  // above its bottom card (which may have been split off)?
  certCompletable(b, left) {
    const M = this.M, starts = [];
    for (let c = 0; c < NC; c++) starts.push(this.certUnit(b, c, left[c]));
    for (let c = 0; c < NC; c++) {
      const king = M[b + c * MAXC + starts[c]];
      if (king % 13 !== 12) continue;
      const lowest = M[b + c * MAXC + left[c] - 1];
      let all = true;
      for (let card = king - 12; card < lowest && all; card++) {
        all = false;
        for (let j = 0; j < NC && !all; j++) {
          for (let i = starts[j] + 1, n = M[b + LEN + j]; i < n && !all; i++) all = M[b + j * MAXC + i] === card;
        }
      }
      if (all) return true;
    }
    return false;
  }

  // The columns at b as arrays, and their face-down counts.
  columnsAt(b) {
    const M = this.M, cols = [], down = [];
    for (let c = 0; c < NC; c++) {
      cols.push(Array.from(M.subarray(b + c * MAXC, b + c * MAXC + M[b + LEN + c])));
      down.push(M[b + DOWN + c]);
    }
    return [cols, down];
  }

  // Deal onto the position at b.
  dealAt(b) {
    const M = this.M, deal = this.deals[M[b + DEALT]];
    for (let c = 0; c < NC; c++) M[b + c * MAXC + M[b + LEN + c]++] = deal[c];
    M[b + DEALT]++;
    for (let c = 0; c < NC; c++) this.removeIfComplete(b, c);
  }

  // ---------------------------------------------------------------- classes

  // Enumerate the class of the position in slot 0 under reversible moves (at
  // most CLASS_CAP members; the rest become exits), with its irreversible
  // exits. Deals are not among the exits: MI[DEALSC..] says how each member
  // would evaluate after one, column by column.
  enumerate() {
    const M = this.M, MI = this.MI, found = this.found, moves = this.moves;
    const deal = this.deals[M[DEALT]];
    const h = M[DONE] * 8 + M[DEALT], hl = HL[h], hh = HH[h];
    this.exits.length = 0;
    this.nexits = 0;
    this.win = null;
    found.add(MI[SUML] ^ hl, MI[SUMH] ^ hh);
    if (deal) for (let c = 0; c < NC; c++) MI[DEALSC + c] = this.dealColScore(0, c, deal[c]);
    let n = 1;
    for (let i = 0; i < n; i++) {
      const b = i * MS, ib = i * IS;
      const nm = this.legalMoves(b);
      for (let k = 0; k < nm; k++) {
        const mv = moves[k], from = mv >> 16, to = (mv >> 8) & 255, count = mv & 255;
        const fl = M[b + LEN + from], tl = M[b + LEN + to];
        if (tl + count > MAXC) continue;
        const nb = n * MS, nib = n * IS; // the slot to build the result in
        const src = b + from * MAXC + fl - count;
        if (this.reversibleMove(b, from, to, count)) {
          // Most reversible moves lead back to a member already found, so
          // work out the result's key before building it.
          let rl = MI[ib + RAWL + from], rh = MI[ib + RAWH + from], sl = MI[ib + RAWL + to], sh = MI[ib + RAWH + to];
          for (let j = 0; j < count; j++) {
            const card = M[src + j], zf = (fl - count + j) * 52 + card, zt = (tl + j) * 52 + card;
            rl = (rl - ZL[zf]) | 0;
            rh = (rh - ZH[zf]) | 0;
            sl = (sl + ZL[zt]) | 0;
            sh = (sh + ZH[zt]) | 0;
          }
          part(rl, rh, M[b + DOWN + from]);
          const fpl = F0, fph = F1;
          part(sl, sh, M[b + DOWN + to]);
          const tpl = F0, tph = F1;
          const suml = (MI[ib + SUML] - MI[ib + PARL + from] - MI[ib + PARL + to] + fpl + tpl) | 0;
          const sumh = (MI[ib + SUMH] - MI[ib + PARH + from] - MI[ib + PARH + to] + fph + tph) | 0;
          const kl = suml ^ hl, kh = sumh ^ hh;
          if (found.has(kl, kh)) continue;
          M.copyWithin(nb, b, b + MS);
          MI.copyWithin(nib, ib, ib + IS);
          const dst = nb + to * MAXC + tl;
          for (let j = 0; j < count; j++) M[dst + j] = M[src + j];
          M[nb + LEN + from] = fl - count;
          M[nb + LEN + to] = tl + count;
          MI[nib + RAWL + from] = rl;
          MI[nib + RAWH + from] = rh;
          MI[nib + RAWL + to] = sl;
          MI[nib + RAWH + to] = sh;
          MI[nib + PARL + from] = fpl;
          MI[nib + PARH + from] = fph;
          MI[nib + PARL + to] = tpl;
          MI[nib + PARH + to] = tph;
          MI[nib + SUML] = suml;
          MI[nib + SUMH] = sumh;
          if (n >= CLASS_CAP) {
            // Class too big to enumerate: hand the rest of it to the search
            // as ordinary exits, so nothing is lost.
            this.addExit(n, i, mv, kl, kh);
            continue;
          }
          found.add(kl, kh);
          MI[nib + PARENT] = i;
          MI[nib + MOVE] = mv;
          if (deal) {
            MI[nib + DEALSC + from] = this.dealColScore(nb, from, deal[from]);
            MI[nib + DEALSC + to] = this.dealColScore(nb, to, deal[to]);
          }
          n++;
        } else {
          M.copyWithin(nb, b, b + MS);
          MI.copyWithin(nib, ib, ib + IS);
          const dst = nb + to * MAXC + tl;
          for (let j = 0; j < count; j++) M[dst + j] = M[src + j];
          M[nb + LEN + from] = fl - count;
          M[nb + LEN + to] = tl + count;
          this.flipIfNeeded(nb, from);
          this.removeIfComplete(nb, to);
          if (M[nb + DONE] === 8) {
            this.win = { member: i, move: mv };
            this.nmem = n;
            return;
          }
          let suml = MI[nib + SUML] - MI[nib + PARL + from] - MI[nib + PARL + to];
          let sumh = MI[nib + SUMH] - MI[nib + PARH + from] - MI[nib + PARH + to];
          this.rehashCol(nb, nib, from);
          this.rehashCol(nb, nib, to);
          suml = (suml + MI[nib + PARL + from] + MI[nib + PARL + to]) | 0;
          sumh = (sumh + MI[nib + PARH + from] + MI[nib + PARH + to]) | 0;
          const h2 = M[nb + DONE] * 8 + M[nb + DEALT];
          this.addExit(n, i, mv, suml ^ HL[h2], sumh ^ HH[h2]);
        }
      }
    }
    this.nmem = n;
  }

  // An exit: the position in `slot`, reached from `member` by `mv`. One that
  // leads into a class already expanded (most do) is only counted.
  addExit(slot, member, mv, kl, kh) {
    const index = this.nexits++;
    if (this.found.has(kl, kh)) return;
    const p = this.alloc();
    this.packInto(slot, this.PA, p * PACKED);
    this.pkey[p] = this.evalAt(slot * MS);
    this.exits.push(p, member, mv, index, kl, kh);
  }

  // ---------------------------------------------------------------- records, paths and nodes

  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.pn === this.pcap) {
      this.pcap *= 2;
      const grow = (old, n) => { const a = new old.constructor(n); a.set(old); return a; };
      this.PA = grow(this.PA, this.pcap * PACKED);
      for (const f of ['pkey', 'pseq', 'pparent', 'pdepth', 'poff', 'plen']) this[f] = grow(this[f], this.pcap);
    }
    return this.pn++;
  }

  // Write the moves through the class just enumerated from its entry to
  // `member`, then `mv`; returns where, the length going in this.pathLen.
  encodePath(member, mv) {
    const MI = this.MI, list = [mv];
    for (let m = member; m !== 0; m = MI[m * IS + PARENT]) list.push(MI[m * IS + MOVE]);
    if (this.pathN + 2 * list.length > this.paths.length) {
      const a = new Uint8Array(this.paths.length * 2);
      a.set(this.paths);
      this.paths = a;
    }
    const start = this.pathN, paths = this.paths;
    let at = start;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m === DEAL_MOVE) paths[at++] = 255;
      else {
        paths[at++] = (m >> 16) * NC + ((m >> 8) & 255);
        paths[at++] = m & 255;
      }
    }
    this.pathN = at;
    this.pathLen = at - start;
    return start;
  }

  pushNode(parent, off, len) {
    if (this.nn === this.nparent.length) {
      for (const f of ['nparent', 'noff', 'nlen']) {
        const a = new Int32Array(this.nn * 2);
        a.set(this[f]);
        this[f] = a;
      }
    }
    this.nparent[this.nn] = parent;
    this.noff[this.nn] = off;
    this.nlen[this.nn] = len;
    return this.nn++;
  }

  // The winning line: the recorded paths from the root to the won node.
  buildLine() {
    const chain = [], line = [];
    for (let n = this.winNode; n >= 0; n = this.nparent[n]) chain.push(n);
    for (const n of chain.reverse()) {
      for (let i = this.noff[n], end = i + this.nlen[n]; i < end; ) {
        const v = this.paths[i++];
        if (v === 255) line.push(DEAL);
        else line.push({ from: Math.floor(v / NC), to: v % NC, count: this.paths[i++] });
      }
    }
    return line;
  }

  // ---------------------------------------------------------------- search

  tick() {
    if (this.work >= this.budget) this.aborted = true;
    return this.aborted;
  }

  // Open a stage (the positions reachable without dealing) at node `entry`,
  // whose position is record `rec`.
  newStage(entry, rec, baseKey, origin) {
    this.pseq[rec] = 0; // marks the stage's entry
    this.pdepth[rec] = 0;
    this.stages.push({
      heap: [rec],
      pendingDeals: [], // deal points found but not yet released to the queue
      frozen: [], // candidates parked because this subtree is over its allowance
      entry,
      baseKey, // key of the candidate that opened this stage; resumptions are keyed from it
      origin,
      subtree: 0, // work spent in this stage and everything below it
      allowance: this.stages.length ? this.stageCap * SUB_ALLOC : Infinity,
      resumes: 0,
      failures: 0,
      resumeQueued: false,
      end: this.PA[rec * PACKED + 1] >= this.deals.length,
    });
    return this.stages.length - 1;
  }

  // Explore a stage, depth-first with siblings ordered by evaluation, for
  // one slice of work. Its deal points go onto the queue, the best few now.
  // Returns UNSOLVABLE if the stage is exhausted, NOT_FOUND if it was
  // suspended (its resumption is queued).
  exploreStage(sid) {
    const stage = this.stages[sid], heap = stage.heap, foundDeals = stage.pendingDeals;
    const allowance = stage.end ? this.endCap : this.stageCap;
    const startWork = this.work, gt = this.pendingGt, found = this.found, M = this.M, MI = this.MI;
    let suspended = false;
    while (heap.length) {
      const p = heapPop(heap, gt);
      if (this.tick()) return UNKNOWN;
      if (this.work - startWork > allowance) {
        heapPush(heap, p, gt);
        suspended = true;
        break;
      }
      this.unpackFrom(this.PA, p * PACKED, 0);
      const isEntry = this.pseq[p] === 0, parent = this.pparent[p], poff = this.poff[p], plen = this.plen[p];
      const depth = this.pdepth[p] + 1;
      this.free.push(p);
      const h = M[DONE] * 8 + M[DEALT], kl = MI[SUML] ^ HL[h], kh = MI[SUMH] ^ HH[h];
      if (found.has(kl, kh)) continue;
      if (stage.end) {
        // A position the top-rank certificate proves lost is not searched
        // (its work is the certificate's).
        // (The position after the last deal gets the certificate that
        // goes on past emptying a column, which costs more.)
        let dead;
        if (isEntry) {
          dead = lost(...this.columnsAt(0), [], CERTIFY_LIMIT);
          this.work += Math.min(lostNodes, CERTIFY_LIMIT);
        } else {
          dead = this.topRankDead(0);
          this.work += Math.min(this.certNodes, CERTIFY_LIMIT);
        }
        if (dead) {
          found.add(kl, kh);
          continue;
        }
      }
      this.enumerate();
      const n = this.nmem;
      this.work += n;
      this.classes++;
      const nid = isEntry ? stage.entry : this.pushNode(parent, poff, plen);
      if (this.win) {
        const off = this.encodePath(this.win.member, this.win.move);
        this.winNode = this.pushNode(nid, off, this.pathLen);
        return SOLVABLE;
      }
      const ex = this.exits;
      for (let e = 0; e < ex.length; e += 6) {
        const q = ex[e];
        if (found.has(ex[e + 4], ex[e + 5])) {
          this.free.push(q);
          continue;
        }
        this.pkey[q] += DEPTH_W * depth;
        this.pseq[q] = this.seq + ex[e + 3] + 1;
        this.pparent[q] = nid;
        this.pdepth[q] = depth;
        this.poff[q] = this.encodePath(ex[e + 1], ex[e + 2]);
        this.plen[q] = this.pathLen;
        heapPush(heap, q, gt);
      }
      this.seq += this.nexits;
      this.work += this.nexits;
      // The members that can deal, with their evaluation afterwards.
      if (!this.deals[M[DEALT]]) continue;
      let classDeals = [];
      for (let m = 0; m < n; m++) {
        const b = m * MS, ib = m * IS;
        let k = W_COMPLETED * M[b + DONE];
        for (let c = 0; c < NC; c++) {
          const len = M[b + LEN + c];
          if (len === 0 || len >= MAXC) { k = null; break; }
          k += MI[ib + DEALSC + c];
        }
        if (k !== null) classDeals.push([k, m]);
      }
      if (classDeals.length > DEALS_PER_CLASS) {
        classDeals.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
        // The deal points dropped make the search incomplete, unless this
        // is the last deal and the certificate proves the position after
        // each of them lost.
        const lastDeal = M[DEALT] + 1 === this.deals.length, scratch = n * MS;
        for (let i = DEALS_PER_CLASS; i < classDeals.length; i++) {
          if (!lastDeal) {
            this.incomplete = true;
            break;
          }
          const from = classDeals[i][1] * MS;
          M.copyWithin(scratch, from, from + MS);
          this.dealAt(scratch);
          const dead = lost(...this.columnsAt(scratch), [], CERTIFY_LIMIT);
          this.work += 1 + lostNodes;
          if (!dead) {
            this.incomplete = true;
            break;
          }
        }
        classDeals.length = DEALS_PER_CLASS;
      }
      for (const [key, m] of classDeals) {
        const rec = this.alloc(); // the member; the deal is made when the stage is opened
        this.packInto(m, this.PA, rec * PACKED);
        const off = this.encodePath(m, DEAL_MOVE);
        heapPush(foundDeals, { key, seq: ++this.seq, stage: -1, nid, off, len: this.pathLen, rec, origin: sid, charged: 0 }, candGt);
      }
    }
    const spent = this.work - startWork;
    // Release only the best few deal points now; the rest wait for a
    // resumption, so one stage cannot flood the queue with siblings.
    for (let i = 0; i < DEALS_PER_STAGE && foundDeals.length; i++) heapPush(this.queue, heapPop(foundDeals, candGt), candGt);
    // Charge the work to this stage and all its ancestors.
    for (let a = sid; ; a = this.stages[a].origin) {
      this.stages[a].subtree += spent;
      if (a === 0) break;
    }
    if (suspended && heap.length > SUSPEND_KEEP) {
      heap.sort((a, b) => (gt(a, b) ? -1 : 1));
      for (let i = SUSPEND_KEEP; i < heap.length; i++) this.free.push(heap[i]);
      heap.length = SUSPEND_KEEP; // sorted, so still a heap
      this.incomplete = true;
    }
    if (suspended || foundDeals.length) {
      this.queueResume(sid);
      return NOT_FOUND;
    }
    return UNSOLVABLE;
  }

  // Queue a resumption of a stage, keyed like a sibling of it.
  queueResume(sid) {
    const st = this.stages[sid];
    if (st.resumeQueued) return;
    st.resumeQueued = true;
    const key = st.baseKey - RESUME_TAX * (st.resumes + 1);
    heapPush(this.queue, { key, seq: ++this.seq, stage: sid, origin: st.origin, charged: this.stages[st.origin].failures }, candGt);
  }

  // The topmost ancestor (or the stage itself) whose subtree is over its allowance, or -1.
  overBudget(sid) {
    let top = -1;
    for (let a = sid; ; a = this.stages[a].origin) {
      if (this.stages[a].subtree >= this.stages[a].allowance) top = a;
      if (a === 0) return top;
    }
  }

  // Best-first over deal points and suspended stages: explore the root
  // stage, then keep taking the most promising candidate, opening the stage
  // after its deal or resuming one. Every stage's subtree has an allowance
  // of work, doubled when the stage is resumed; candidates under a spent
  // allowance wait for that.
  search() {
    this.unpackFrom(this.root, 0, 0);
    const rec = this.alloc();
    this.PA.set(this.root, rec * PACKED);
    const key = this.evalAt(0);
    this.pkey[rec] = key;
    let sid = this.newStage(this.pushNode(-1, 0, 0), rec, key, 0);
    let r = this.exploreStage(sid);
    if (r === SOLVABLE || r === UNKNOWN) return r;
    while (this.queue.length) {
      const c = heapPop(this.queue, candGt);
      if (this.tick()) return UNKNOWN;
      const owner = c.stage < 0 ? c.origin : c.stage;
      const over = this.overBudget(owner);
      if (over >= 0 && c.stage !== over) {
        this.stages[over].frozen.push(c);
        this.queueResume(over);
        continue;
      }
      if (c.stage < 0) {
        // Deal, and open the stage after it.
        this.unpackFrom(this.PA, c.rec * PACKED, 0);
        this.dealAt(0);
        this.packInto(0, this.PA, c.rec * PACKED);
        this.pkey[c.rec] = this.evalAt(0);
        sid = this.newStage(this.pushNode(c.nid, c.off, c.len), c.rec, c.key, c.origin);
      } else {
        sid = c.stage;
        const st = this.stages[sid];
        st.resumeQueued = false;
        st.resumes++;
        st.allowance *= SUB_GROWTH;
        for (const f of st.frozen) heapPush(this.queue, f, candGt);
        st.frozen = [];
        if (!st.heap.length && !st.pendingDeals.length) continue;
      }
      r = this.exploreStage(sid);
      if (r === SOLVABLE || r === UNKNOWN) return r;
      this.stages[c.origin].failures++;
    }
    return this.incomplete ? NOT_FOUND : UNSOLVABLE;
  }

  // Forget everything searched so far (between passes).
  reset() {
    this.found.clear();
    this.stages = [];
    this.queue = [];
    this.incomplete = false;
    this.pn = this.nn = this.pathN = 0;
    this.free = [];
  }

  solve() {
    if (this.root[0] === 8) return { verdict: SOLVABLE, work: 0, classes: 0, line: [] };
    // A certificate may prove the position lost outright: a quick try
    // first (not with two deals or more to come: it hardly ever does then),
    // a long one if no win is found.
    this.unpackFrom(this.root, 0, 0);
    const [cols, down] = this.columnsAt(0);
    const certify = limit => {
      const dead = lost(cols, down, this.deals, limit);
      this.work += Math.min(lostNodes, limit);
      return dead;
    };
    if (this.deals.length <= 1 && certify(CERTIFY_LIMIT)) return { verdict: UNSOLVABLE, work: this.work, classes: 0, line: [] };
    let outcome = this.search();
    if (outcome === UNSOLVABLE) {
      // No win without splitting same-suit runs. The second pass allows
      // splits as exits, which finds a win that needs one quickly, but is
      // capped because it makes exhausting a position much dearer; the
      // third has splits inside the classes, for the proof.
      this.splits = this.splitExits = true;
      this.reset();
      const full = this.budget;
      this.budget = Math.min(full, this.work + Math.floor(full / 8));
      outcome = this.search();
      this.budget = full;
      if (outcome !== SOLVABLE && outcome !== UNSOLVABLE) {
        this.splitExits = false;
        this.aborted = false;
        this.reset();
        outcome = this.search();
      }
    }
    if ((outcome === NOT_FOUND || outcome === UNKNOWN) && certify(ROOT_CERTIFY_LIMIT)) outcome = UNSOLVABLE;
    const verdict = outcome === NOT_FOUND ? UNKNOWN : outcome;
    return { verdict, work: this.work, classes: this.classes, line: verdict === SOLVABLE ? this.buildLine() : [] };
  }
}

// Whether the game can be won from here: {verdict, work, classes, line}.
// verdict is 'solvable' (line wins), 'unsolvable' (proven: no legal moves
// win) or 'unknown' (the budget ran out).
export function solve(game, budget) {
  return new Solver(game, budget).solve();
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data: { key, suits, seed, moves, budgets } }) => {
    const game = new Game(suits, seed);
    for (const mv of parseMoves(moves)) game.applyRaw(mv);
    for (const [i, budget] of budgets.entries()) {
      const { verdict, line } = solve(game, budget);
      postMessage({ key, verdict, line: encodeMoves(line), last: i === budgets.length - 1 });
      if (verdict !== 'unknown') break;
    }
  };
}
