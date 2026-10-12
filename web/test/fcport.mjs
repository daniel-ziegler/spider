// Plays FreeCell with static/freecell.js and prints, one line per game:
//   deal initial-position moves final-position
// Random games first (with undos and redos mixed in), then lines of the
// solver (static/fcwinnable.js), which win. The server's `cargo test` replays
// them with freecell.rs and compares.
import { encodeMoves } from '../static/game.js';
import { FreeCell, HOME } from '../static/freecell.js';
import { solve } from '../static/fcwinnable.js';

let state = 12345;
const rand = n => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state % n;
};

for (let i = 0; i < 40; i++) {
  const seed = i < 30 ? i : 2 ** 31 - 1 - i;
  const g = new FreeCell(seed);
  const start = g.positionText();
  for (let step = 0; step < 300 && !g.isWon(); step++) {
    const legal = [];
    for (let from = 0; from < HOME; from++)
      for (let to = 0; to <= HOME; to++)
        for (let count = 1; count <= g.runLen(from); count++)
          if (!g.checkMove(from, to, count)) legal.push({ from, to, count });
    const r = rand(10);
    if (r === 0 && g.canUndo()) g.undo();
    else if (r === 1 && g.canRedo()) g.redo();
    else if (legal.length) g.apply(legal[rand(legal.length)]);
    else if (g.canUndo()) g.undo();
  }
  console.log(`${seed} ${start} ${encodeMoves(g.moves())} ${g.positionText()}`);
}

for (const seed of [1, 617, 31465, 1000000]) {
  const g = new FreeCell(seed);
  const start = g.positionText();
  const r = solve(g.columns, g.cells, 2_000_000);
  if (r.verdict !== 'won') throw new Error(`deal ${seed} not won`);
  // Hints along the way are legal moves.
  for (const mv of r.line) {
    for (const h of g.hintMoves()) if (g.check(h)) throw new Error(`illegal hint in deal ${seed}`);
    if (g.apply(mv)) throw new Error(`illegal move in the line of deal ${seed}`);
  }
  if (!g.isWon()) throw new Error(`the line of deal ${seed} does not win`);
  console.log(`${seed} ${start} ${encodeMoves(g.moves())} ${g.positionText()}`);
}
