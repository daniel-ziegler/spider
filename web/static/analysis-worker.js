// The analysis's worker (see analysis.js, which runs several): it values
// positions with the network (vnet.js) and plays games out from them with
// the line player (lineplayer.js), neither of which sees a face-down card.
//
// Messages to it:
//   {net: ArrayBuffer}               the network's file, first
//   {id, value: [enc, ...]}          positions, encoded (vnet.js); answers {id, values: [p, ...]}
//   {id, roll: {...}}                a key moment's games in some worlds; answers {id, rolls: [...]}
//   {id, same: [{suits, columns, faceDown, completed, stock, moves}, ...]}
//                                    for each position and the moves played from it up to the first that showed
//                                    cards: would the line player have played just those? answers {id, same: [bool, ...]}
//
// A roll is {suits, columns, faceDown, completed, stock, moves, seed, from, to}:
// the position before a stretch of moves with its real cards, the moves (the
// last of which may turn cards over or deal), and the worlds to play, numbered
// from..to. A world is a shuffle of every card that is face down or in the
// stock at the start, so it agrees with all the player had seen there. In
// each world three games are played out by the line player:
//   pre     from the start, the line player choosing the moves itself;
//   commit  after the stretch's moves, with the world's cards coming up;
//   reveal  after the moves, with the cards that really came up (the world's
//           other cards as they are, but for those swapped to make room).
// The same worlds for all three (common random numbers) make the differences
// far less noisy than the three rates: commit - pre is what the moves cost,
// reveal - commit what the cards did. The answer has a byte per world: bit 0
// pre won, bit 1 commit, bit 2 reveal.
import { Net } from './vnet.js';
import { NUM_COLS, MAXC, LEN, DOWN, fastConfig, makeState, applyMove, removeIfComplete, playOut } from './lineplayer.js';

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
// moves show, and game(cards, moved): the position with the hidden cards
// `cards`, after the moves if `moved`, as {s, stock} for the line player
// (null if a column gets too long for it).
export function setup({ columns, faceDown, completed, stock, moves }) {
  const start = makeState(columns, faceDown, completed);
  const places = [];
  for (let c = 0; c < NUM_COLS; c++) for (let i = 0; i < faceDown[c]; i++) places.push(c * MAXC + i);
  const nd = places.length;
  const real = new Uint8Array(nd + stock.length);
  for (let k = 0; k < nd; k++) real[k] = start[places[k]];
  real.set(stock, nd);
  const game = (cards, moved) => {
    const s = start.slice(), st = cards.slice(nd);
    for (let k = 0; k < nd; k++) s[places[k]] = cards[k];
    let left = st.length;
    if (moved) {
      for (const mv of moves) {
        if (mv.deal) {
          for (let c = 0; c < NUM_COLS; c++) {
            if (s[LEN + c] >= MAXC) return null;
            s[c * MAXC + s[LEN + c]++] = st[--left];
          }
          for (let c = 0; c < NUM_COLS; c++) removeIfComplete(s, 0, c, -1);
        } else {
          if (s[LEN + mv.to] + mv.count > MAXC) return null;
          applyMove(s, 0, mv.from, mv.to, mv.count, -1);
        }
      }
    }
    return { s, stock: st.subarray(0, left) };
  };
  // The places shown: those hidden at the start and not after the moves.
  const after = game(real, true), shown = [];
  if (after) {
    let k = 0;
    for (let c = 0; c < NUM_COLS; c++) for (let i = 0; i < faceDown[c]; i++, k++) if (i >= after.s[DOWN + c]) shown.push(k);
    for (let i = after.stock.length; i < stock.length; i++) shown.push(nd + i);
  }
  return { real, shown, game };
}

export function roll(job) {
  const { suits, moves, seed, from, to } = job, cfg = fastConfig(suits);
  const { real, shown, game } = setup(job);
  const won = g => (g && playOut(g.s, g.stock, cfg).won ? 1 : 0);
  const out = new Uint8Array(to - from);
  for (let w = from; w < to; w++) {
    const below = random(Math.imul(seed, 0x9E3779B1) ^ Math.imul(w + 1, 0x85EBCA6B));
    const cards = shuffled(real, below);
    let bits = won(game(cards, false));
    if (!moves.length) bits *= 7; // nothing played: all three are the one game
    else {
      const commit = won(game(cards, true));
      bits |= commit << 1;
      if (!shown.length) bits |= commit << 2; // nothing came up
      else {
        showReal(cards, real, shown, below);
        bits |= won(game(cards, true)) << 2;
      }
    }
    out[w - from] = bits;
  }
  return out;
}

// Whether the line player's own moves from a position, up to the first that
// shows cards, are these moves. (They do not depend on the hidden cards.)
export function plays({ suits, columns, faceDown, completed, stock, moves }) {
  if (columns.some(c => c.length > MAXC)) return false;
  const own = [];
  playOut(makeState(columns, faceDown, completed), Uint8Array.from(stock), fastConfig(suits), own, true);
  return own.length === moves.length && own.every((m, i) => (m.deal ? !!moves[i].deal : m.from === moves[i].from && m.to === moves[i].to && m.count === moves[i].count));
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data }) => {
    if (data.net) net = new Net(data.net);
    else if (data.value) postMessage({ id: data.id, values: data.value.map(enc => net.winProb(enc)) });
    else if (data.same) postMessage({ id: data.id, same: data.same.map(plays) });
    else if (data.roll) postMessage({ id: data.id, rolls: roll(data.roll) });
  };
}
