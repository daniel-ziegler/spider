// That board.mjs's moves are the game's: node check.mjs DB. Each saved line is
// replayed in both; every move played must be offered by movesOf (or be one that
// it leaves out on purpose), and each position must come out the same.
import { Game } from '../../static/game.js';
import { fromGame, play, movesOf, keyOf, UNKNOWN, canDeal } from './board.mjs';
import { loadGames, openGame } from './games.mjs';
let plies = 0, off = 0, bad = 0;
for (const row of loadGames(process.argv[2], ['dmz', 'amanda'], [1, 2, 3, 4])) {
  const o = openGame(row), g = new Game(row.suits, row.seed);
  for (const mv of o.moves) {
    const p = fromGame(g);
    plies++;
    if (mv.deal ? !canDeal(p) : !movesOf(p).some(m => m.from === mv.from && m.count === mv.count && (m.to === mv.to || (m.toEmpty && !p.cols[mv.to].length)))) off++;
    const q = play(p, mv);
    g.applyRaw(mv);
    const r = fromGame(g);
    const same = q.done === r.done || mv.deal; // (a deal's completion is not known beforehand)
    const cols = q.cols.every((c, i) => c.length === r.cols[i].length && c.every((x, j) => x === UNKNOWN || x === r.cols[i][j]) || mv.deal);
    if (!same || !cols || q.left !== r.left || (!q.shows && keyOf(q) !== keyOf(r))) { bad++; console.log('differs', row.user, row.seed, mv); }
  }
}
console.log({ plies, notOffered: off, bad });
