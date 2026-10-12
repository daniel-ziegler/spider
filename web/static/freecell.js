// FreeCell rules for the browser. src/freecell.rs is the server's port, which
// checks wins; the server's test (`cargo test`) plays random games here and
// replays them there.
//
// Cards are numbered as in game.js (suit * 13 + rank; spades, hearts,
// diamonds, clubs). Deals are numbered as in Microsoft FreeCell, so deal 617
// here is deal 617 there.
//
// A place is a column (0-7), a free cell (8-11) or the foundations (HOME). A
// move is {from, to, count}: count cards from a column or a free cell to a
// place, written from>to:count like a Spider move. A run of several cards
// moves between columns in one move if it could be done one card at a time
// through the empty free cells and columns.
//
// After every move, cards that will never be wanted in a column go to the
// foundations by themselves (see safe); that is part of the move.
import { Played, suitOf, rankOf } from './game.js';

export const COLS = 8, CELLS = 4, HOME = COLS + CELLS;
export const MAX_DEAL = 2 ** 31 - 1;

const isRed = c => suitOf(c) === 1 || suitOf(c) === 2;
// May `card` lie on `parent` in a column?
export const follows = (parent, card) => rankOf(parent) === rankOf(card) + 1 && isRed(parent) !== isRed(card);

// The columns of a deal, by Microsoft's shuffle.
export function deal(seed) {
  // Its deck runs A♣ A♦ A♥ A♠ 2♣ ...
  const deck = Array.from({ length: 52 }, (_, i) => (3 - (i & 3)) * 13 + (i >> 2));
  const columns = Array.from({ length: COLS }, () => []);
  let state = seed;
  for (let i = 0, left = 52; i < 52; i++) {
    state = (Math.imul(state, 214013) + 2531011) & 0x7fffffff;
    const j = (state >> 16) % left;
    columns[i % COLS].push(deck[j]);
    deck[j] = deck[--left];
  }
  return columns;
}

export class FreeCell extends Played {
  constructor(seed) {
    super();
    this.game = 'freecell';
    this.freecell = true;
    this.suits = 4;
    this.seed = seed;
    this.columns = deal(seed);
    this.cells = new Array(CELLS).fill(null); // a card or null
    this.found = [0, 0, 0, 0]; // how many cards are on each suit's foundation
    this.autoplay([]);
  }

  isWon() { return this.found.every(n => n === 13); }

  // The cards at a place that can be taken from: a column, or a cell's card.
  pile(place) {
    if (place < COLS) return this.columns[place];
    const card = this.cells[place - COLS];
    return card == null ? [] : [card];
  }

  // How many cards at the top of a column follow one another (1 for a card in a cell).
  runLen(place) {
    const p = this.pile(place);
    let k = Math.min(p.length, 1);
    while (k < p.length && follows(p[p.length - k - 1], p[p.length - k])) k++;
    return k;
  }

  // The most cards that can move to column `to` at once: one more than the
  // empty cells, doubled for every empty column on the way.
  capacity(to) {
    const cells = this.cells.filter(c => c === null).length;
    const columns = this.columns.filter((c, i) => c.length === 0 && i !== to).length;
    return (cells + 1) << columns;
  }

  // Why moving count cards from -> to is illegal, or null if it is legal.
  checkMove(from, to, count) {
    if (!(from >= 0 && from < HOME && to >= 0 && to <= HOME)) return 'no such place';
    if (from === to) return 'source and destination are the same';
    if (!(count > 0)) return 'nothing selected';
    if (count > this.runLen(from)) return from < COLS ? 'those cards are not a run of alternating colours' : 'that free cell is empty';
    const src = this.pile(from), bottom = src[src.length - count];
    if (to === HOME) {
      if (count > 1) return 'cards go to the foundations one at a time';
      return rankOf(bottom) === this.found[suitOf(bottom)] ? null : 'that card cannot go to its foundation yet';
    }
    if (to >= COLS) {
      if (count > 1) return 'a free cell holds one card';
      return this.cells[to - COLS] === null ? null : 'that free cell is taken';
    }
    const top = this.columns[to].at(-1);
    if (top !== undefined && !follows(top, bottom)) return 'the destination card must be one rank higher and the other colour';
    if (count > this.capacity(to)) return `not enough free cells to move ${count} cards`;
    return null;
  }

  // For a non-empty column, the number of cards that would legally move there.
  requiredCount(from, to) {
    const top = this.columns[to]?.at(-1), src = this.pile(from);
    if (top === undefined || !src.length) return null;
    const k = rankOf(top) - rankOf(src.at(-1));
    return k >= 1 && k <= this.runLen(from) && follows(top, src[src.length - k]) ? k : null;
  }

  check(mv) { return this.checkMove(mv.from, mv.to, mv.count); }

  // Nothing is hidden, so an undo counts, unless it only does what a move
  // could: the cards can go straight back, and none went to the foundations
  // meanwhile. (Asked just after the move is made.)
  isReal(rec) {
    const { from, to, count } = rec.mv;
    return to === HOME || rec.auto.length > 0 || this.checkMove(to, from, count) !== null;
  }

  take(place, count) {
    if (place < COLS) return this.columns[place].splice(this.columns[place].length - count);
    const card = this.cells[place - COLS];
    this.cells[place - COLS] = null;
    return [card];
  }

  put(place, cards) {
    if (place === HOME) this.found[suitOf(cards[0])]++;
    else if (place >= COLS) this.cells[place - COLS] = cards[0];
    else this.columns[place].push(...cards);
  }

  // A card that can go to its foundation is safe there once nothing could
  // want to lie on it: the cards one rank lower of the other colour are on
  // theirs. (Nothing needs to lie on a two.)
  safe(card) {
    const r = rankOf(card), s = suitOf(card);
    if (r !== this.found[s]) return false;
    return r <= 1 || (isRed(card) ? [0, 3] : [1, 2]).every(o => this.found[o] >= r);
  }

  // Send safe cards to the foundations; auto gets [place, card] for each.
  autoplay(auto) {
    for (let place = 0; place < HOME; place++) {
      const card = this.pile(place).at(-1);
      if (card === undefined || !this.safe(card)) continue;
      this.put(HOME, this.take(place, 1));
      auto.push([place, card]);
      place = -1;
    }
  }

  // Records are {mv, cards: those moved, auto: [[place, card]] sent to the foundations after}.
  applyRaw(mv) {
    const rec = { mv, cards: this.take(mv.from, mv.count), auto: [] };
    this.put(mv.to, rec.cards);
    this.autoplay(rec.auto);
    return rec;
  }

  unapply(rec) {
    for (const [place, card] of [...rec.auto].reverse()) {
      this.found[suitOf(card)]--;
      this.put(place, [card]);
    }
    if (rec.mv.to === HOME) this.found[suitOf(rec.cards[0])]--;
    else this.take(rec.mv.to, rec.mv.count);
    this.put(rec.mv.from, rec.cards);
  }

  // The moves that win by only sending cards to the foundations, lowest
  // first, or null if that does not win (or the game is won).
  finishLine() {
    const recs = [], line = [];
    while (!this.isWon()) {
      let best = null;
      for (let place = 0; place < HOME; place++) {
        const card = this.pile(place).at(-1);
        if (card !== undefined && rankOf(card) === this.found[suitOf(card)] && (best === null || rankOf(card) < best.rank)) best = { place, rank: rankOf(card) };
      }
      if (!best) break;
      line.push({ from: best.place, to: HOME, count: 1 });
      recs.push(this.applyRaw(line.at(-1)));
    }
    const won = this.isWon();
    while (recs.length) this.unapply(recs.pop());
    return won && line.length ? line : null;
  }

  // Legal moves, best first, for hints. To a foundation first; then onto a
  // card (better from a free cell, or if it empties a column or frees a card
  // for its foundation; worse if it only moves a run from one card to another
  // like it); then into an empty column; a free cell last.
  hintMoves() {
    const out = [];
    const emptyCol = this.columns.findIndex(c => c.length === 0), emptyCell = this.cells.indexOf(null);
    for (let from = 0; from < HOME; from++) {
      const src = this.pile(from), run = this.runLen(from);
      if (!run) continue;
      // What moving count cards away leaves behind.
      const leaves = count => {
        if (from >= COLS) return 10;
        if (count === src.length) return 10;
        const bottom = src[src.length - count], under = src[src.length - count - 1];
        return (rankOf(under) === this.found[suitOf(under)] ? 20 : 0) + (follows(under, bottom) ? -25 : 5);
      };
      if (!this.checkMove(from, HOME, 1)) out.push({ score: 100, mv: { from, to: HOME, count: 1 } });
      for (let to = 0; to < COLS; to++) {
        const count = this.requiredCount(from, to);
        if (to !== from && count !== null && !this.checkMove(from, to, count)) out.push({ score: 15 + leaves(count), mv: { from, to, count } });
      }
      if (emptyCol >= 0) {
        const count = Math.min(run, this.capacity(emptyCol));
        if (count < src.length || from >= COLS) out.push({ score: -15 + leaves(count), mv: { from, to: emptyCol, count } });
      }
      if (emptyCell >= 0 && from < COLS) out.push({ score: -30 + leaves(1), mv: { from, to: COLS + emptyCell, count: 1 } });
    }
    out.sort((a, b) => b.score - a.score || b.mv.count - a.mv.count);
    return out.map(h => h.mv);
  }

  // The same text as Game::to_position_text in freecell.rs (used by the port test).
  positionText() {
    return [this.found.join(','), this.cells.map(c => c ?? '-').join(','), ...this.columns.map(c => c.join(','))].join(';');
  }

  // The position whatever the order of its columns and cells, which is all that winning depends on.
  key() {
    return [this.cells.filter(c => c !== null).sort((a, b) => a - b).join(','), ...this.columns.map(c => c.join(',')).sort()].join(';');
  }
}
