// Plays random games with static/game.js and prints, one line per game:
//   suits seed initial-position stock moves final-position hints
// The server's `cargo test` replays these with game.rs and compares.
import { readFileSync } from 'node:fs';
import { Game, NUM_COLS, DEAL, encodeMoves, parseMoves } from '../static/game.js';

let state = 12345;
const rand = n => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state % n;
};

for (let i = 0; i < 60; i++) {
  const suits = 1 + i % 4;
  const seed = i < 50 ? i : 2 ** 53 - 1 - i; // include seeds above 2^32
  const g = new Game(suits, seed);
  const start = g.positionText(), stock = g.stock.join(',');
  // Random legal moves (preferring longer games), with undos and redos mixed in.
  for (let step = 0; step < 400 && !g.isWon(); step++) {
    const legal = [];
    for (let from = 0; from < NUM_COLS; from++)
      for (let to = 0; to < NUM_COLS; to++)
        for (let count = 1; count <= g.runLen(from); count++)
          if (!g.checkMove(from, to, count)) legal.push({ from, to, count });
    if (!g.checkDeal()) legal.push(DEAL);
    const r = rand(10);
    if (r === 0 && g.canUndo()) g.undo();
    else if (r === 1 && g.canRedo()) g.redo();
    else if (legal.length) g.apply(legal[rand(legal.length)]);
    else if (g.canUndo()) g.undo();
  }
  console.log(`${suits} ${seed} ${start} ${stock} ${encodeMoves(g.moves()) || ''} ${g.positionText()} ${encodeMoves(g.hintMoves())}`);
}

// A solver's winning line for 1 suit, deal 3, to cover completing runs.
const win = readFileSync(new URL('win-1-3.txt', import.meta.url), 'utf8').trim();
const g = new Game(1, 3);
const start = g.positionText(), stock = g.stock.join(',');
for (const mv of parseMoves(win)) if (g.apply(mv)) throw new Error(`illegal ${mv}`);
if (!g.isWon()) throw new Error('win-1-3.txt does not win');
console.log(`1 3 ${start} ${stock} ${win} ${g.positionText()} ${encodeMoves(g.hintMoves())}`);
