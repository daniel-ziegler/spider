// Spider rules for the browser: a port of src/game.rs, which the server uses
// to check wins. A given (suits, seed) deals the same cards in both; the
// server's test (`cargo test`) plays random games here and replays them there.
//
// A card is the number suit * 13 + rank, rank 0 = ace .. 12 = king,
// suits 0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs.
// A move is {from, to, count} (0-based columns) or DEAL.

export const NUM_COLS = 10;
export const suitOf = c => Math.floor(c / 13);
export const rankOf = c => c % 13;
export const DEAL = Object.freeze({ deal: true });

const MASK = (1n << 64n) - 1n;

// splitmix64, as in game.rs; returns below(n).
function rng(seed) {
  let s = (BigInt(seed) ^ 0xD1B54A32D192ED03n) & MASK;
  return n => {
    s = (s + 0x9E3779B97F4A7C15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    z ^= z >> 31n;
    return Number(z % BigInt(n));
  };
}

export const encodeMove = m => (m.deal ? 'd' : `${m.from}>${m.to}:${m.count}`);
export const encodeMoves = ms => ms.map(encodeMove).join(',');

export function parseMoves(s) {
  return s.split(',').filter(Boolean).map(t => {
    if (t === 'd') return DEAL;
    const m = /^(\d+)>(\d+):(\d+)$/.exec(t);
    if (!m) throw new Error(`bad move ${t}`);
    return { from: +m[1], to: +m[2], count: +m[3] };
  });
}

// Longest same-suit descending run at the top of col, above the face-down cards.
export function runLen(col, faceDown) {
  const n = col.length;
  if (n === faceDown) return 0;
  let k = 1;
  while (n - k > faceDown) {
    const upper = col[n - k - 1], lower = col[n - k];
    if (suitOf(upper) === suitOf(lower) && rankOf(upper) === rankOf(lower) + 1) k++;
    else break;
  }
  return k;
}

export class Game {
  constructor(suits, seed) {
    const deck = [];
    for (let set = 0; set < 8; set++) {
      const suit = suits === 1 ? 0 : suits === 2 ? set % 2 : set % 4;
      for (let rank = 0; rank < 13; rank++) deck.push(suit * 13 + rank);
    }
    const below = rng(seed);
    for (let i = deck.length - 1; i >= 1; i--) {
      const j = below(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    this.columns = Array.from({ length: NUM_COLS }, () => []);
    for (let i = 0; i < 54; i++) this.columns[i % NUM_COLS].push(deck.pop());
    this.faceDown = this.columns.map(c => c.length - 1);
    this.stock = deck; // dealt from the end
    this.completed = []; // suits of removed K..A runs
    this.suits = suits;
    this.seed = seed;
    this.history = []; // records: {mv, flips: [col], completed: [[col, suit]]}
    this.redoStack = [];
  }

  dealsRemaining() { return this.stock.length / NUM_COLS; }
  isWon() { return this.completed.length === 8; }
  canUndo() { return this.history.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  moves() { return this.history.map(r => r.mv); }
  redoMoves() { return this.redoStack.map(r => r.mv).reverse(); }
  runLen(col) { return runLen(this.columns[col], this.faceDown[col]); }

  // Would the next undo take back a card flip or a deal?
  undoRevealsInfo() {
    const r = this.history.at(-1);
    return !!r && (!!r.mv.deal || r.flips.length > 0);
  }

  // Why moving count cards from -> to is illegal, or null if it is legal.
  checkMove(from, to, count) {
    if (!(from >= 0 && from < NUM_COLS && to >= 0 && to < NUM_COLS)) return 'no such column';
    if (from === to) return 'source and destination are the same column';
    if (count <= 0) return 'nothing selected';
    if (count > this.runLen(from)) return 'those cards are not a same-suit descending run';
    const src = this.columns[from];
    const bottom = src[src.length - count];
    const top = this.columns[to].at(-1);
    if (top !== undefined && rankOf(top) !== rankOf(bottom) + 1) return 'the destination card must be one rank higher';
    return null;
  }

  // For a non-empty destination, the number of cards that would legally move there.
  requiredCount(from, to) {
    const top = this.columns[to].at(-1), srcTop = this.columns[from].at(-1);
    if (top === undefined || srcTop === undefined) return null;
    const k = rankOf(top) - rankOf(srcTop);
    return k >= 1 && k <= this.runLen(from) ? k : null;
  }

  checkDeal() {
    if (this.stock.length === 0) return 'the stock is empty';
    if (this.columns.some(c => c.length === 0)) return 'you cannot deal while a column is empty';
    return null;
  }

  // Apply a move; returns an error message, or null. Clears the redo stack.
  apply(mv) {
    const err = mv.deal ? this.checkDeal() : this.checkMove(mv.from, mv.to, mv.count);
    if (err) return err;
    this.history.push(this.applyRaw(mv));
    this.redoStack = [];
    return null;
  }

  applyRaw(mv) {
    const rec = { mv, flips: [], completed: [] };
    if (mv.deal) {
      for (const col of this.columns) col.push(this.stock.pop());
      for (let c = 0; c < NUM_COLS; c++) this.collectComplete(c, rec);
    } else {
      const src = this.columns[mv.from];
      this.columns[mv.to].push(...src.splice(src.length - mv.count));
      this.flipIfNeeded(mv.from, rec);
      this.collectComplete(mv.to, rec);
    }
    return rec;
  }

  flipIfNeeded(col, rec) {
    const len = this.columns[col].length;
    if (len > 0 && this.faceDown[col] === len) {
      this.faceDown[col]--;
      rec.flips.push(col);
    }
  }

  collectComplete(col, rec) {
    const c = this.columns[col];
    const top = c.at(-1);
    if (top !== undefined && rankOf(top) === 0 && this.runLen(col) >= 13) {
      c.length -= 13;
      this.completed.push(suitOf(top));
      rec.completed.push([col, suitOf(top)]);
      this.flipIfNeeded(col, rec);
    }
  }

  unapply(rec) {
    for (const [col, suit] of [...rec.completed].reverse()) {
      this.completed.pop();
      for (let rank = 12; rank >= 0; rank--) this.columns[col].push(suit * 13 + rank);
    }
    for (const col of [...rec.flips].reverse()) this.faceDown[col]++;
    if (rec.mv.deal) {
      for (let c = NUM_COLS - 1; c >= 0; c--) this.stock.push(this.columns[c].pop());
    } else {
      const dst = this.columns[rec.mv.to];
      this.columns[rec.mv.from].push(...dst.splice(dst.length - rec.mv.count));
    }
  }

  undo() {
    const rec = this.history.pop();
    if (!rec) return null;
    this.unapply(rec);
    this.redoStack.push(rec);
    return rec;
  }

  redo() {
    const rec = this.redoStack.pop();
    if (!rec) return null;
    const again = this.applyRaw(rec.mv);
    this.history.push(again);
    return again;
  }

  // Same text form as Game::to_position_text in game.rs (used by the port test).
  positionText() {
    return [this.completed.length, ...this.columns.map((c, i) => `${this.faceDown[i]}/${c.join(',')}`)].join(';');
  }
}
