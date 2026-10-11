// Runs the browser's solver (static/winnable.js) on positions from play and
// prints, one line per position:
//   suits seed moves budget verdict work classes line
// (- for no moves or no line). The repository root's `cargo test` solves
// the same positions with src/solver.rs and compares.
import { Game, NUM_COLS, DEAL, encodeMoves } from '../static/game.js';
import { solve } from '../static/winnable.js';

let state = 2024;
const rand = n => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state % n;
};

function report(g, budget) {
  const r = solve(g, budget);
  if (r.verdict === 'solvable') {
    const h = new Game(g.suits, g.seed);
    for (const mv of [...g.moves(), ...r.line]) if (h.apply(mv)) throw new Error('illegal move in a line');
    if (!h.isWon()) throw new Error('a line does not win');
  }
  console.log([g.suits, g.seed, encodeMoves(g.moves()) || '-', budget, r.verdict, r.work, r.classes, encodeMoves(r.line) || '-'].join(' '));
}

for (let i = 0; i < 24; i++) {
  const suits = 1 + i % 4, g = new Game(suits, 100 + i);
  report(g, i === 5 ? 3000 : 150_000);
  // Play on, mostly the top hint and sometimes any legal move (splits
  // included), solving on the way: such play soon loses, so this covers
  // unwinnable positions and the passes that prove them so.
  for (let step = 1; step <= 400 && !g.isWon(); step++) {
    let moves = g.hintMoves();
    if (rand(8) === 0) {
      moves = [];
      for (let from = 0; from < NUM_COLS; from++)
        for (let to = 0; to < NUM_COLS; to++)
          for (let count = 1; count <= g.runLen(from); count++)
            if (!g.checkMove(from, to, count)) moves.push({ from, to, count });
      if (!g.checkDeal()) moves.push(DEAL);
      moves = moves.length ? [moves[rand(moves.length)]] : [];
    }
    if (!moves.length) break;
    if (moves[0].deal) report(g, 60_000); // before a deal: the last one has its own rule
    g.apply(moves[0]);
    if (step % 60 === 0 || (g.stock.length === 0 && step % 15 === 0)) report(g, 60_000);
  }
  report(g, 60_000);
}
