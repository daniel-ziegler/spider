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

// A node of the tree of moves played from a deal: its move, whether it has
// ever been undone, whether it turned a card over or dealt (known once it has
// been played), and the moves played after it. The root has only children.
const newNode = (mv, undone = false) => ({ mv, key: encodeMove(mv), undone, real: false, children: [] });

// A tree as text. A move is followed by "!" if it has been undone, then by
// what was played after it: ",move" if one thing, "(a|b)" if several.
export function treeText(root) {
  const branch = n => n.key + (n.undone ? '!' : '')
    + (n.children.length > 1 ? `(${siblings(n)})` : n.children.length ? `,${branch(n.children[0])}` : '');
  const siblings = n => n.children.map(branch).join('|');
  return siblings(root);
}

export function parseTree(text) {
  let i = 0;
  const siblings = () => {
    const out = [branch()];
    while (text[i] === '|') { i++; out.push(branch()); }
    return out;
  };
  const branch = () => {
    const re = /(d|\d+>\d+:\d+)(!?)/y;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new Error(`bad tree at ${i}`);
    i = re.lastIndex;
    const node = newNode(parseMoves(m[1])[0], !!m[2]);
    if (text[i] === ',') { i++; node.children = [branch()]; }
    else if (text[i] === '(') {
      i++;
      node.children = siblings();
      if (text[i++] !== ')') throw new Error(`bad tree at ${i - 1}`);
    }
    return node;
  };
  const children = text ? siblings() : [];
  if (i !== text.length) throw new Error(`bad tree at ${i}`);
  return mergeTree({ children: [] }, { children }); // merges any repeated moves
}

// Add the moves of the tree `from` to the tree `into`.
export function mergeTree(into, from) {
  for (const n of from.children) {
    let mine = into.children.find(m => m.key === n.key);
    if (!mine) into.children.push(mine = newNode(n.mv));
    mine.undone ||= n.undone;
    mergeTree(mine, n);
  }
  return into;
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
      const suit = set % suits; // three suits: 3 sets of spades, 3 of hearts, 2 of diamonds
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
    // Every move ever played from this deal, as a tree; undone lines stay in
    // it. line is the nodes from the root to the current position. The last
    // child of a node is the one most recently undone: the one redo plays.
    this.root = { children: [] };
    this.line = [this.root];
    this.undos = 0; // moves in the tree that have been undone, however often
    this.realUndos = 0; // those of them that took back a card flip or a deal
    // Per column, the fewest face-down cards anywhere in the tree: the cards
    // from there up have been seen.
    this.seen = [...this.faceDown];
  }

  dealsRemaining() { return this.stock.length / NUM_COLS; }
  isWon() { return this.completed.length === 8; }
  canUndo() { return this.history.length > 0; }
  canRedo() { return this.line.at(-1).children.length > 0; }
  moves() { return this.history.map(r => r.mv); }
  treeText() { return treeText(this.root); }
  runLen(col) { return runLen(this.columns[col], this.faceDown[col]); }

  // Would the next undo take back a card flip or a deal for the first time?
  undoCosts() {
    const node = this.line.at(-1);
    return this.history.length > 0 && node.real && !node.undone;
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

  check(mv) { return mv.deal ? this.checkDeal() : this.checkMove(mv.from, mv.to, mv.count); }

  // Apply a move; returns an error message, or null. A move already in the
  // tree here goes down that branch, so what followed it can be redone.
  apply(mv) {
    const err = this.check(mv);
    if (err) return err;
    const here = this.line.at(-1), key = encodeMove(mv);
    let node = here.children.find(n => n.key === key);
    if (!node) here.children.push(node = newNode(mv));
    this.enter(node);
    return null;
  }

  enter(node) {
    const rec = this.applyRaw(node.mv);
    node.real = !!node.mv.deal || rec.flips.length > 0;
    this.history.push(rec);
    this.line.push(node);
    this.faceDown.forEach((n, c) => { if (n < this.seen[c]) this.seen[c] = n; });
    return rec;
  }

  leave() {
    this.unapply(this.history.pop());
    return this.line.pop();
  }

  // Take on a tree of moves (from parseTree), dropping any that are not
  // legal. The game must be at the start.
  adopt(root) {
    const walk = node => {
      node.children = node.children.filter(n => {
        if (this.check(n.mv)) return false;
        this.enter(n);
        walk(n);
        this.leave();
        if (n.undone) {
          this.undos++;
          if (n.real) this.realUndos++;
        }
        return true;
      });
    };
    this.root = root;
    this.line = [root];
    this.undos = this.realUndos = 0;
    walk(root);
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

  // Undoing a move counts only the first time.
  undo() {
    const rec = this.history.at(-1);
    if (!rec) return null;
    const node = this.leave(), siblings = this.line.at(-1).children;
    siblings.push(...siblings.splice(siblings.indexOf(node), 1));
    if (!node.undone) {
      node.undone = true;
      this.undos++;
      if (node.real) this.realUndos++;
    }
    return rec;
  }

  redo() {
    const node = this.line.at(-1).children.at(-1);
    return node ? this.enter(node) : null;
  }

  // Every legal move, best first, for hints: a port of Game::hint_moves.
  // Scored by the destination plus what the move frees at the source; among
  // equal scores the longer run first; the deal last. Only whole runs are
  // offered for an empty column, and only for the first empty one.
  hintMoves() {
    const out = [];
    const firstEmpty = this.columns.findIndex(c => c.length === 0);
    for (let from = 0; from < NUM_COLS; from++) {
      const run = this.runLen(from);
      if (run === 0) continue;
      const src = this.columns[from];
      for (let to = 0; to < NUM_COLS; to++) {
        if (to === from) continue;
        let count;
        if (this.columns[to].length === 0) {
          if (firstEmpty !== to || run === src.length) continue;
          count = run;
        } else {
          count = this.requiredCount(from, to);
          if (count === null) continue;
        }
        out.push({ score: this.hintScore(from, to, count), mv: { from, to, count } });
      }
    }
    out.sort((a, b) => b.score - a.score || b.mv.count - a.mv.count);
    const moves = out.map(h => h.mv);
    if (!this.checkDeal()) moves.push(DEAL);
    return moves;
  }

  // Destination: completes a suit +100, same-suit linkage +15, cross-suit 0,
  // empty column -15. Source: flips a card +12, empties the column +10, leaves
  // a non-linkage +8, a cross-suit linkage 0, breaks a same-suit run -20.
  hintScore(from, to, count) {
    const src = this.columns[from], bottom = src[src.length - count];
    const dest = this.columns[to], top = dest.at(-1);
    let dst;
    if (top === undefined) dst = -15;
    else if (suitOf(top) === suitOf(bottom)) {
      dst = rankOf(bottom) === 0 && runLen(dest, this.faceDown[to]) + count === 13 ? 100 : 15;
    } else dst = 0;
    let srcScore;
    if (count === src.length) srcScore = 10;
    else if (count === src.length - this.faceDown[from]) srcScore = 12;
    else {
      const parent = src[src.length - count - 1];
      if (rankOf(parent) !== rankOf(bottom) + 1) srcScore = 8;
      else if (suitOf(parent) === suitOf(bottom)) srcScore = -20;
      else srcScore = 0;
    }
    return dst + srcScore;
  }

  // Same text form as Game::to_position_text in game.rs (used by the port test).
  positionText() {
    return [this.completed.length, ...this.columns.map((c, i) => `${this.faceDown[i]}/${c.join(',')}`)].join(';');
  }
}
