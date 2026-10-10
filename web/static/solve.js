// Auto-complete's search, in a worker so the board never waits on it. Given
// a game whose cards are all dealt and face up, looks for a way to win: a
// depth-first search over the hint moves, best first, skipping positions
// already seen. Replies {key, line}: the moves, or null if none turned up
// within LIMIT positions.
import { Game, parseMoves, encodeMoves } from './game.js';

const LIMIT = 30000;

function winningLine(game) {
  const seen = new Set(), line = [];
  let nodes = 0;
  const search = () => {
    if (game.isWon()) return true;
    const key = game.positionText();
    if (seen.has(key) || ++nodes > LIMIT) return false;
    seen.add(key);
    for (const mv of game.hintMoves()) {
      if (mv.deal) continue;
      const rec = game.applyRaw(mv);
      line.push(mv);
      if (search()) return true;
      line.pop();
      game.unapply(rec);
    }
    return false;
  };
  return search() ? line : null;
}

onmessage = ({ data: { key, suits, seed, moves } }) => {
  const game = new Game(suits, seed);
  for (const mv of parseMoves(moves)) game.applyRaw(mv);
  const line = winningLine(game);
  postMessage({ key, line: line && encodeMoves(line) });
};
