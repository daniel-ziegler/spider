// Picks FreeCell deals that are not easy, for daily challenges: prints
// "deal rate" for each deal FROM..TO that can be won (static/fcwinnable.js
// finds a line) and that the dumb player (dumb.mjs) wins in at most MAX of
// its GAMES games, rate being the share it wins. On stderr, how many deals
// were dropped as easy or as not known to be winnable.
//   node tools/freecell/pick.mjs FROM TO [MAX=0.2] [GAMES=20]
import { FreeCell } from '../../static/freecell.js';
import { solve } from '../../static/fcwinnable.js';
import { winRate } from './dumb.mjs';

const [from, to, max = 0.2, games = 20] = process.argv.slice(2).map(Number);
if (!(from <= to)) {
  console.error('usage: node tools/freecell/pick.mjs FROM TO [MAX=0.2] [GAMES=20]');
  process.exit(1);
}
let easy = 0, unwon = 0, kept = 0;
for (let deal = from; deal <= to; deal++) {
  const rate = winRate(deal, games);
  if (rate > max) { easy++; continue; }
  const g = new FreeCell(deal);
  if (rate === 0 && solve(g.columns, g.cells, 2_000_000).verdict !== 'won') { unwon++; continue; }
  kept++;
  console.log(deal, rate);
}
console.error(`${kept} kept, ${easy} easy, ${unwon} not known to be winnable`);
