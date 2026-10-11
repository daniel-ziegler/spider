// Auto-complete's player, in a worker so the board never waits on it. Given a
// game whose cards are all dealt and face up, tries to win it and replies
// {key, line}: the moves, or null if it got stuck. It does not search: it
// plays one move at a time by fixed rules and never takes one back, so it
// finishes what is plainly won and little else (tools/finish compares it with
// a search).
//   1. Join a run to the next card up of its suit, a completing join first.
//   2. Otherwise dig: of the joins that are blocked, by runs lying on the run or
//      on the card it wants, take the one with the fewest runs in the way and
//      move one of them: onto another suit's card (best one no run is waiting
//      for), else to an empty column, the last one only for the last blocker.
//   3. Otherwise any move of a column's top run.
// It never returns to a position it has been in, and gives up when stuck or
// after PATIENCE moves without a new low in unsettled cards.
import { Game, parseMoves, encodeMoves, rankOf, runLen } from './game.js';

const MAX_MOVES = 500;
const PATIENCE = 80;

// The winning line from these columns (all cards face up, stock empty), or null.
export function greedyLine(columns) {
  const cols = columns.map(c => [...c]);
  const line = [];
  const key = () => cols.map(c => c.join(',')).sort().join('|');
  const seen = new Set([key()]);
  const run = c => runLen(cols[c], 0);

  // Plays the move unless it leads somewhere already seen.
  const attempt = (from, to, count) => {
    const src = cols[from], dst = cols[to];
    const moved = dst.concat(src.slice(src.length - count));
    if (rankOf(moved.at(-1)) === 0 && runLen(moved, 0) >= 13) moved.length -= 13;
    cols[from] = src.slice(0, src.length - count);
    cols[to] = moved;
    const k = key();
    if (seen.has(k)) {
      cols[from] = src;
      cols[to] = dst;
      return false;
    }
    seen.add(k);
    line.push({ from, to, count });
    return true;
  };
  const first = moves => moves.sort((a, b) => b.score - a.score).some(m => attempt(m.from, m.to, m.count));

  // A column's maximal runs, bottom to top, as [start, end).
  const runsOf = col => {
    const out = [];
    for (let end = col.length; end > 0; ) {
      const start = end - runLen(col.slice(0, end), 0);
      out.unshift([start, end]);
      end = start;
    }
    return out;
  };
  const unsettled = () => cols.reduce((n, col) => n + runsOf(col).filter(([s]) => rankOf(col[s]) !== 12).length, 0);

  const join = () => {
    const moves = [];
    cols.forEach((src, from) => {
      const count = run(from);
      const bottom = src[src.length - count];
      if (!count || rankOf(bottom) === 12) return;
      cols.forEach((dst, to) => {
        if (to === from || dst.at(-1) !== bottom + 1) return;
        const score = (run(to) + count === 13 ? 1000 : 0) + (count === src.length ? 50 : 0) + run(to);
        moves.push({ from, to, count, score });
      });
    });
    return first(moves);
  };

  // Is some run waiting to land on this card?
  const wanted = card => rankOf(card) > 0 && cols.some(col => col.some((c, i) => c === card - 1 && col[i - 1] !== card));

  // Places for column from's top run other than the columns in `avoid`.
  const parkings = (from, avoid, lastBlocker) => {
    const src = cols[from], count = run(from), bottom = src[src.length - count];
    const moves = [];
    const empties = cols.filter(c => !c.length).length;
    cols.forEach((dst, to) => {
      if (to === from || avoid.includes(to)) return;
      if (!dst.length) {
        if (count < src.length && (empties > 1 || lastBlocker) && !moves.some(m => m.score === -10)) moves.push({ from, to, count, score: -10 });
      } else if (rankOf(dst.at(-1)) === rankOf(bottom) + 1) {
        moves.push({ from, to, count, score: wanted(dst.at(-1)) ? 0 : 10 });
      }
    });
    return moves;
  };

  const dig = () => {
    const digs = [];
    cols.forEach((col, c) => {
      const runs = runsOf(col);
      runs.forEach(([start], i) => {
        const bottom = col[start];
        if (rankOf(bottom) === 12) return;
        const above = runs.length - 1 - i;
        cols.forEach((col2, c2) => {
          const runs2 = runsOf(col2);
          runs2.forEach(([, end2], i2) => {
            if (col2[end2 - 1] !== bottom + 1) return;
            const above2 = runs2.length - 1 - i2;
            digs.push({ cost: above + above2, blocked: [...(above ? [c] : []), ...(above2 ? [c2] : [])], avoid: [c, c2] });
          });
        });
      });
    });
    digs.sort((a, b) => a.cost - b.cost);
    for (const d of digs) {
      for (const from of new Set(d.blocked)) {
        if (first(parkings(from, d.avoid, d.cost === 1))) return true;
      }
    }
    return false;
  };

  const any = () => {
    const moves = [];
    cols.forEach((_, from) => { if (run(from)) moves.push(...parkings(from, [], true)); });
    return first(moves);
  };

  let low = unsettled(), since = 0;
  while (low > 0) {
    if (line.length >= MAX_MOVES || since > PATIENCE) return null;
    if (!(join() || dig() || any())) return null;
    const n = unsettled();
    if (n < low) { low = n; since = 0; } else since++;
  }
  return line;
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data: { key, suits, seed, moves } }) => {
    const game = new Game(suits, seed);
    for (const mv of parseMoves(moves)) game.applyRaw(mv);
    const line = greedyLine(game.columns);
    postMessage({ key, line: line && encodeMoves(line) });
  };
}
