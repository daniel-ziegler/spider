// What comparing two attempts at a deal (compare.js) works out, apart from the
// drawing and the workers. See README ("Comparing attempts").
//
// Two lines of a deal have the same cards in the same places, so a position
// says all there is to say whichever way it was come to. Lines are lined up by
// the positions they share, not by their moves: a stretch of moves between two
// shared positions is moves in another order (or taken back by hand), and no
// difference. So the only choice that really parts two lines is at the last
// position they share; on real games that is mostly within the first few moves,
// and from the first deal on few columns are alike. After it there is nothing
// to line up move by move, and the lines are compared from deal to deal (the
// one thing they have in common), by the network's values.
import { Game, NUM_COLS } from './game.js';
import { prepare, stretchValues } from './analysis-core.js';

// A position, so that two come out the same exactly if they are the same but
// for columns the player cannot tell apart. A column with cards face down is
// its own (they are its cards, and do not move), and a column with none is
// known by its cards alone: which of two places they are in does not matter to
// any move. It does to where a deal's cards land: see the split's `cards`.
// Cards are compared by suit and rank, so the two of each are the same too.
// Null with nothing left hidden: every game won ends on the same empty board,
// and that two lines come to an end they could see says nothing of how.
export function positionKey(s) {
  if (!s.stock.length && s.faceDown.every(n => !n)) return null;
  const own = [], free = [];
  s.columns.forEach((col, c) => {
    if (s.faceDown[c]) own.push(`${c}:${s.faceDown[c]}:${col.join('.')}`);
    else free.push(col.join('.'));
  });
  free.sort();
  return `${own.join('|')}#${free.join('|')}#${s.stock.length}#${s.completed.length}`;
}

// A line of moves, read: analysis-core.js's prepare (positions, stretches, what
// to value), with each position's key and the moves that dealt.
export function readLine(suits, seed, moves, over = '') {
  const data = prepare(suits, seed, moves), deals = [];
  moves.forEach((mv, i) => { if (mv.deal) deals.push(i); });
  return { ...data, suits, seed, moves, deals, over: data.won ? 'won' : over, keys: data.snaps.map(positionKey) };
}

// The positions two lines share, in order, as pairs [i, j] of how many moves
// each had played, from [0, 0]: each time the next pair is the one that the
// fewest moves lead to. (A line that comes back to where it was has shared the
// position again, with no moves on the other side.)
export function align(keysA, keysB) {
  const where = new Map();
  keysB.forEach((k, j) => {
    if (k === null) return;
    if (!where.has(k)) where.set(k, []);
    where.get(k).push(j);
  });
  const pairs = [[0, 0]];
  let i = 0, j = 0;
  for (;;) {
    let best = null, least = Infinity;
    for (let a = i; a < keysA.length && a - i < least; a++) {
      for (const b of where.get(keysA[a]) ?? []) {
        if (b < j || (a === i && b === j)) continue;
        if (a - i + b - j < least) { best = [a, b]; least = a - i + b - j; }
        break;
      }
    }
    if (!best) return pairs;
    [i, j] = best;
    pairs.push(best);
  }
}

// How two lines (readLine's) stand to each other: {pairs, same, reordered,
// takenBack, split}. reordered: the stretches of moves between shared positions
// that differ, each coming to the same place; takenBack: those on one side only.
// split: the last position shared, {a, b} moves in, and `kind`:
//   choice  they play different moves from it and never meet again;
//   cards   both deal from it, but columns alike stood in different places, so
//           the same choice put different cards on them;
//   end     one line stops there and the other goes on (`ended`: 'a' or 'b').
// Null if the lines come to the same end, or from the last position shared to
// where nothing is hidden.
export function relate(A, B) {
  const pairs = align(A.keys, B.keys);
  let reordered = 0, takenBack = 0;
  for (let k = 1; k < pairs.length; k++) {
    const da = pairs[k][0] - pairs[k - 1][0], db = pairs[k][1] - pairs[k - 1][1];
    if (!da || !db) takenBack++;
    else if (da > 1 || db > 1) reordered++;
  }
  const [a, b] = pairs[pairs.length - 1], N = A.moves.length, M = B.moves.length;
  const open = (keys, t) => keys.slice(t + 1).every(k => k === null); // (nothing on it left to share)
  const out = { pairs, reordered, takenBack, same: open(A.keys, a) && open(B.keys, b), split: null };
  if (out.same) return out;
  const kind = a === N || b === M ? 'end' : A.moves[a].deal && B.moves[b].deal ? 'cards' : 'choice';
  out.split = { a, b, kind, ...(kind === 'end' && { ended: a === N ? 'a' : 'b' }) };
  return out;
}

// The moves of a line from a position up to and including the next that shows
// cards (or to its end): what its player chose there, knowing what they knew.
export function nextShow(line, t) {
  const st = line.stretches.find(x => t >= x.from && t < x.to);
  return st ? { from: t, to: st.to, shows: st.shows, moves: line.moves.slice(t, st.to) } : { from: t, to: t, shows: null, moves: [] };
}

const total = xs => xs.reduce((a, b) => a + b, 0);

// How a position stands: cards turned so far, suits done, empty columns.
export function standing(line, t) {
  const s = line.snaps[t];
  return { at: t, turned: total(line.snaps[0].faceDown) - total(s.faceDown), suits: s.completed.length, empty: s.columns.filter(c => !c.length).length };
}

// The positions to have values for, of a line's job list: where its stretches
// start and end, those ends with the cards not yet known, and where it dealt from.
export function valueJobs(line) {
  const want = new Set(line.deals.map(d => `p${d}`));
  for (const st of line.stretches) {
    want.add(`p${st.from}`);
    want.add(`p${st.to}`);
    if (st.shows) want.add(`u${st.to}`);
  }
  return line.jobs.filter(j => want.has(j.key));
}

// A line cut at its deals: for each part (r = 0: before the first deal; r: after
// deal r, up to the next or the end) {r, start, end, to, ended, from, value,
// worst, ...}: from position `start` to `end`, the position before the next deal
// (`to`: after it, where the next part starts). from and value are the chance of
// winning at its start and end by the network (`values`; 1 or 0 at the end of a
// game that is over), and worst the stretch ending in it that the moves did the
// most harm in, by what the moves did to that chance. (Taken stretch by stretch
// that is rough, and added up over a part it can come to moves −102 and cards
// +63, which is why the part is given by its values.)
export function parts(line, values) {
  const N = line.moves.length, out = [];
  const valueAt = t => (t === N && line.over === 'won' ? 1 : t === N && line.over === 'lost' ? 0 : values.get(`p${t}`));
  for (let r = 0; r <= line.deals.length; r++) {
    const start = r ? line.deals[r - 1] + 1 : 0, dealt = r < line.deals.length, to = dealt ? line.deals[r] + 1 : N;
    const part = { r, start, end: dealt ? line.deals[r] : N, to, ended: !dealt, from: null, value: null, worst: null };
    if (values) {
      part.from = valueAt(start);
      part.value = valueAt(part.end);
      for (const st of line.stretches) {
        if (st.to <= start || st.to > to) continue;
        const v = stretchValues(st, values, line.over === 'won', N, line.suits);
        if (!part.worst || v.play < part.worst.play) part.worst = { from: st.from, to: st.to, play: v.play };
      }
    }
    out.push({ ...part, ...standing(line, part.end) });
  }
  return out;
}

// The rows of a comparison from deal to deal, one for each part either line
// has: {r, a, b, gap, diff} (a or b null where that line never got there; gap:
// A's chance of winning less B's at the end of the part, by the network; diff:
// how far the part moved it, from nothing at the deal; outcome: a line's game is
// over in it, so what moved it was how the game came out). Part of that is the
// cards: the lines do not see the same ones when.
export function rows(A, B, valuesA, valuesB) {
  const pa = parts(A, valuesA), pb = parts(B, valuesB);
  let last = 0;
  return Array.from({ length: Math.max(pa.length, pb.length) }, (_, r) => {
    const a = pa[r] ?? null, b = pb[r] ?? null, gap = a && b && valuesA && valuesB ? a.value - b.value : null;
    const diff = gap === null ? null : gap - last;
    if (gap !== null) last = gap;
    return { r, a, b, gap, diff, outcome: !!((a?.ended && A.over) || (b?.ended && B.over)) };
  });
}

// The rows that say most: those before a game is over where the gap moved by
// `least` or more, largest first, `most` at most.
export function keyRows(all, least = 0.1, most = 3) {
  return all.filter(x => x.diff !== null && !x.outcome && Math.abs(x.diff) >= least).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, most);
}

// The columns of two positions that are not alike: [of the first, of the
// second] as Sets of columns, matched as positionKey does.
export function differing(p, q) {
  const inP = new Set(), inQ = new Set(), freeP = [], freeQ = [], same = (x, y) => x.length === y.length && x.every((c, i) => c === y[i]);
  for (let c = 0; c < NUM_COLS; c++) {
    if (p.faceDown[c] || q.faceDown[c]) {
      if (p.faceDown[c] !== q.faceDown[c] || !same(p.columns[c], q.columns[c])) { inP.add(c); inQ.add(c); }
    } else {
      freeP.push(c);
      freeQ.push(c);
    }
  }
  for (const c of freeP) {
    const k = freeQ.findIndex(d => same(p.columns[c], q.columns[d]));
    if (k < 0) inP.add(c);
    else freeQ.splice(k, 1);
  }
  for (const d of freeQ) inQ.add(d);
  return [inP, inQ];
}

// The line player's game of a deal, played as the analysis's games are: from
// one move that shows cards to the next, thought out anew each time, seeing what
// is face up. It has no chance in it: the same deal gives the same game.
// `ask(position)`: its moves from there (the worker's `next`), `step(moves)`
// after each piece of them. Returns the moves, and whether it won.
export async function computerGame(suits, seed, ask, step = () => true) {
  const g = new Game(suits, seed), moves = [];
  for (let pieces = 0; pieces < 2000 && !g.isWon(); pieces++) {
    const next = await ask({ suits, columns: g.columns.map(c => [...c]), faceDown: [...g.faceDown], completed: g.completed.length, stock: [...g.stock] });
    let shown = false;
    for (const mv of next) {
      if (g.check(mv)) return { moves, won: g.isWon() }; // (a deal it cannot make: a column too long for it, or empty)
      const rec = g.applyRaw(mv);
      moves.push(mv);
      if (mv.deal || rec.flips.length) shown = true;
    }
    if (!shown || step(moves, g) === false) break;
  }
  return { moves, won: g.isWon() };
}
