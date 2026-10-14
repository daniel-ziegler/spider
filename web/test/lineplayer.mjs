// Plays deals with the browser's port of the line player
// (static/lineplayer.js) and prints, one line per deal:
//   suits seed won completed work moves
// The repository root's `cargo test` plays the same deals with src/lines.rs
// (LineConfig::fast) and compares.
import { Game, encodeMoves } from '../static/game.js';
import { fastConfig, makeState, playOut } from '../static/lineplayer.js';

// (GAMES in the environment: more deals of each suit count than the test's twelve.)
const first = 70001, count = +(process.env.GAMES || 12);
for (let suits = 1; suits <= 4; suits++) {
  for (let seed = first; seed < first + count; seed++) {
    const g = new Game(suits, seed), moves = [];
    const r = playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), fastConfig(suits), moves);
    // The moves must be legal by the rules the game is played by, and end as the player says.
    for (const mv of moves) if (g.apply(mv)) throw new Error(`illegal move in ${suits}/${seed}`);
    if (g.isWon() !== r.won || g.completed.length !== r.completed) throw new Error(`${suits}/${seed} does not end as reported`);
    console.log([suits, seed, r.won, r.completed, r.work, encodeMoves(moves) || '-'].join(' '));
  }
}
