// The analysis's worker (see analysis.js, which runs several): it values
// positions with the network (vnet.js) and plays games out from them with
// the line player (lineplayer.js), neither of which sees a face-down card.
//
// Messages to it:
//   {net: ArrayBuffer}               the network's file, first
//   {id, value: [enc, ...]}          positions, encoded (vnet.js); answers {id, values: [p, ...]}
//   {id, roll: {...}}                games played out in some worlds; answers         {id, rolls: [...]}
//   {id, track: [{suits, columns, faceDown, completed, stock, moves}, ...]}
//                                    for each position and the moves played from it up to the first that showed
//                                    cards: where they leave the line player's own (see track); answers {id, tracks: [...]}
//
// A roll is {suits, columns, faceDown, completed, stock, moves, seed, from, to, at, reveal}:
// a position with its real cards, moves played from it (the last of which
// may turn cards over or deal), and the worlds to play, numbered from..to. A
// world is a shuffle of every card that is face down or in the stock at the
// start, so it agrees with all the player had seen there. In each world the
// line player plays a game out from the position after the first at[i] of
// the moves, for each i (at: [0, moves.length] if not given: its own choice
// of moves against those played), and with `reveal` one more after all the
// moves with the cards that really came up (the world's other cards as they
// are, but for those swapped to make room). The same worlds for all the
// games (common random numbers) make the differences between them far less
// noisy than the rates. The answer has a byte per world, a bit for each game.
import { Net } from './vnet.js';
import { NUM_COLS, MAXC, LEN, DOWN, DONE, fastConfig, makeState, applyMove, removeIfComplete, playOut } from './lineplayer.js';

let net = null;

// A small seeded generator (mulberry32).
export function random(seed) {
  let a = seed | 0;
  return n => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * n);
  };
}

// A world: the hidden cards `real` shuffled.
export function shuffled(real, below) {
  const cards = real.slice();
  for (let i = cards.length - 1; i > 0; i--) {
    const j = below(i + 1), t = cards[i];
    cards[i] = cards[j];
    cards[j] = t;
  }
  return cards;
}

// Change a world so that the places `shown` have their real cards: each is
// swapped in from a place that has it, chosen at random among those not
// already put right. (At random, so that the other places stay a fair shuffle
// of the other cards: taking the first would not be one.)
export function showReal(cards, real, shown, below) {
  const fixed = new Uint8Array(cards.length);
  for (const k of shown) {
    if (cards[k] !== real[k]) {
      const have = [];
      for (let j = 0; j < cards.length; j++) if (!fixed[j] && cards[j] === real[k]) have.push(j);
      const j = have[below(have.length)];
      cards[j] = cards[k];
      cards[k] = real[k];
    }
    fixed[k] = 1;
  }
}

// What a roll's worlds are made of: the hidden cards in the order of their
// places (each column's face-down cards, then the stock), the places the
// moves show, and game(cards, upto): the position with the hidden cards
// `cards` after the first `upto` of the moves, as {s, stock} for the line
// player (null if a column gets too long for it).
export function setup({ columns, faceDown, completed, stock, moves }) {
  const start = makeState(columns, faceDown, completed);
  const places = [];
  for (let c = 0; c < NUM_COLS; c++) for (let i = 0; i < faceDown[c]; i++) places.push(c * MAXC + i);
  const nd = places.length;
  const real = new Uint8Array(nd + stock.length);
  for (let k = 0; k < nd; k++) real[k] = start[places[k]];
  real.set(stock, nd);
  const game = (cards, upto) => {
    const s = start.slice(), st = cards.slice(nd);
    for (let k = 0; k < nd; k++) s[places[k]] = cards[k];
    let left = st.length;
    for (let i = 0; i < upto; i++) {
      left = play(s, st, left, moves[i]);
      if (left < 0) return null;
    }
    return { s, stock: st.subarray(0, left) };
  };
  // The places shown: those hidden at the start and not after the moves.
  const after = game(real, moves.length), shown = [];
  if (after) {
    let k = 0;
    for (let c = 0; c < NUM_COLS; c++) for (let i = 0; i < faceDown[c]; i++, k++) if (i >= after.s[DOWN + c]) shown.push(k);
    for (let i = after.stock.length; i < stock.length; i++) shown.push(nd + i);
  }
  return { real, shown, game };
}

// Play a move in a position of the line player's, the stock having `left`
// cards: returns how many it then has, or -1 if a column gets too long.
function play(s, stock, left, mv) {
  if (mv.deal) {
    for (let c = 0; c < NUM_COLS; c++) if (s[LEN + c] >= MAXC) return -1;
    for (let c = 0; c < NUM_COLS; c++) s[c * MAXC + s[LEN + c]++] = stock[--left];
    for (let c = 0; c < NUM_COLS; c++) removeIfComplete(s, 0, c, -1);
  } else {
    if (s[LEN + mv.to] + mv.count > MAXC) return -1;
    applyMove(s, 0, mv.from, mv.to, mv.count, -1);
  }
  return left;
}

// The games of a roll: for each world a byte, bit i of which says whether the
// line player won from the position after the first at[i] of the moves (with
// the world's cards coming up), and, with `reveal`, the next bit whether it
// won after all the moves with the cards that really came up.
export function roll(job) {
  const { suits, moves, seed, from, to, at = [0, moves.length], reveal = false } = job, cfg = fastConfig(suits);
  const { real, shown, game } = setup(job);
  const won = g => (g && playOut(g.s, g.stock, cfg).won ? 1 : 0);
  const out = new Uint8Array(to - from);
  for (let w = from; w < to; w++) {
    const below = random(Math.imul(seed, 0x9E3779B1) ^ Math.imul(w + 1, 0x85EBCA6B));
    const cards = shuffled(real, below), games = new Map();
    let bits = 0;
    at.forEach((upto, i) => {
      if (!games.has(upto)) games.set(upto, won(game(cards, upto)));
      bits |= games.get(upto) << i;
    });
    if (reveal) {
      if (!shown.length) bits |= (games.get(moves.length) ?? won(game(cards, moves.length))) << at.length; // nothing came up
      else {
        showReal(cards, real, shown, below);
        bits |= won(game(cards, moves.length)) << at.length;
      }
    }
    out[w - from] = bits;
  }
  return out;
}

// Where the moves played from a position, up to the first that showed cards
// (or the game's last), leave what the line player would have played, and
// what it would have played there. The player's own line from the position
// goes up to its first move that shows cards; a move played that is its next
// is no departure. One that is not is a departure if the line player, asked
// anew after it, ends its line somewhere else than it would have before it
// (with the same cards coming up): the moves can often be played in another
// order, or taken back. Returns the departures in order, each {at, line}: the
// move moves[at - 1], and the line player's moves in its place, up to its
// first that shows cards. None: the moves cost nothing by the line player's
// measure. (Its lines do not depend on the hidden cards.) Null if a column is
// too long for it.
export function track({ suits, columns, faceDown, completed, stock, moves }) {
  if (columns.some(c => c.length > MAXC)) return null;
  const cfg = fastConfig(suits), cards = Uint8Array.from(stock), cur = makeState(columns, faceDown, completed);
  let left = cards.length;
  const hidden = s => { let n = 0; for (let c = 0; c < NUM_COLS; c++) n += s[DOWN + c]; return n; };
  const lineFrom = () => {
    const end = cur.slice(), own = [];
    playOut(end, cards.subarray(0, left), cfg, own, true);
    return { own, end, left: own.length && own[own.length - 1].deal ? left - NUM_COLS : left };
  };
  const equal = (a, b) => {
    if (a.left !== b.left || a.end[DONE] !== b.end[DONE]) return false;
    for (let c = 0; c < NUM_COLS; c++) {
      if (a.end[LEN + c] !== b.end[LEN + c] || a.end[DOWN + c] !== b.end[DOWN + c]) return false;
      for (let i = c * MAXC, n = i + a.end[LEN + c]; i < n; i++) if (a.end[i] !== b.end[i]) return false;
    }
    return true;
  };
  const cuts = [];
  let line = lineFrom(), used = 0;
  for (let j = 1; j <= moves.length; j++) {
    const mv = moves[j - 1], next = line.own[used], down = hidden(cur);
    left = play(cur, cards, left, mv);
    if (left < 0) return null;
    if (next && (mv.deal ? !!next.deal : !next.deal && mv.from === next.from && mv.to === next.to && mv.count === next.count)) { used++; continue; }
    const rest = line.own.slice(used);
    // After a move that showed cards the line played has ended where it stands.
    const now = mv.deal || hidden(cur) < down ? { own: [], end: cur.slice(), left } : lineFrom();
    if (!equal(now, line)) cuts.push({ at: j, line: rest });
    line = now;
    used = 0;
  }
  return cuts;
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data }) => {
    if (data.net) net = new Net(data.net);
    else if (data.value) postMessage({ id: data.id, values: data.value.map(enc => net.winProb(enc)) });
    else if (data.track) postMessage({ id: data.id, tracks: data.track.map(track) });
    else if (data.roll) postMessage({ id: data.id, rolls: roll(data.roll) });
  };
}
