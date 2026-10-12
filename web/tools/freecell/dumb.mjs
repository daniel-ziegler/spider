// A dumb FreeCell player, to tell easy deals from hard ones: a deal it wins
// most of the time is easy. It does not search and never takes a move back.
// Every move it looks at each legal move (whole runs onto cards and into an
// empty column, a card to a free cell or a foundation), scores the position
// the move leads to, adds a little noise, and plays the best that does not
// lead to a position it has been in:
//   +10 a card on the foundations
//   +6  an empty column, -3 a free cell in use
//   +1  a card lying on one it follows (the next rank up, the other colour)
//   -2  a card lying anywhere above a lower card of its own suit in its
//       column (it has to move before that one can go to the foundations),
//       and -2 more above the very card its foundation is waiting for
// It gives up when nothing is left to play or after PATIENCE moves without a
// new card on the foundations. The noise makes games differ, so a deal's
// easiness is the share of some games that it wins (winRate).
import { FreeCell, COLS, HOME, follows } from '../../static/freecell.js';
import { suitOf, rankOf } from '../../static/game.js';

const PATIENCE = 40, NOISE = 4;

function score(g) {
  let s = 0;
  for (const n of g.found) s += 10 * n;
  for (const c of g.cells) if (c !== null) s -= 3;
  for (const col of g.columns) {
    if (!col.length) { s += 6; continue; }
    const low = [13, 13, 13, 13]; // the lowest rank of each suit so far, from the bottom of the column
    for (let i = 0; i < col.length; i++) {
      const card = col[i], suit = suitOf(card), rank = rankOf(card);
      if (i && follows(col[i - 1], card)) s += 1;
      if (rank > low[suit]) s -= low[suit] === g.found[suit] ? 4 : 2;
      else low[suit] = rank;
    }
  }
  return s;
}

function legalMoves(g) {
  const out = [];
  const emptyCol = g.columns.findIndex(c => c.length === 0), emptyCell = g.cells.indexOf(null);
  for (let from = 0; from < HOME; from++) {
    const run = g.runLen(from);
    if (!run) continue;
    if (!g.checkMove(from, HOME, 1)) out.push({ from, to: HOME, count: 1 });
    for (let to = 0; to < COLS; to++) {
      const count = g.requiredCount(from, to);
      if (to !== from && count !== null && !g.checkMove(from, to, count)) out.push({ from, to, count });
    }
    if (emptyCol >= 0) {
      const count = Math.min(run, g.capacity(emptyCol));
      if (from >= COLS || count < g.columns[from].length) out.push({ from, to: emptyCol, count });
    }
    if (emptyCell >= 0 && from < COLS) out.push({ from, to: COLS + emptyCell, count: 1 });
  }
  return out;
}

// One game from the start of a deal; rand() is uniform in [0, 1). Returns the winning moves, or null.
export function dumbGame(seed, rand) {
  const g = new FreeCell(seed), seen = new Set([g.key()]), line = [];
  let home = 0, since = 0;
  while (!g.isWon()) {
    let best = null, bestScore = -Infinity;
    for (const mv of legalMoves(g)) {
      const rec = g.applyRaw(mv);
      const s = seen.has(g.key()) ? -Infinity : score(g) + NOISE * rand();
      g.unapply(rec);
      if (s > bestScore) [best, bestScore] = [mv, s];
    }
    if (!best) return null;
    g.applyRaw(best);
    line.push(best);
    seen.add(g.key());
    const n = g.found[0] + g.found[1] + g.found[2] + g.found[3];
    if (n > home) { home = n; since = 0; } else if (++since > PATIENCE) return null;
  }
  return line;
}

// The same games for the same deal every time.
export function rng(seed) {
  let x = (seed * 2654435761 + 12345) >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

// The share of `games` games of a deal that the dumb player wins.
export function winRate(seed, games = 20) {
  const rand = rng(seed);
  let won = 0;
  for (let i = 0; i < games; i++) if (dumbGame(seed, rand)) won++;
  return won / games;
}
