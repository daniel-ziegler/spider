// A game with mistakes put in, for measuring the analysis on (order.mjs,
// short.mjs): a deal played as the analysis's player does, but at one stretch
// in eight something else is done (a deal before its time, or one to three
// legal moves at random) and half the others are the cheap player's line: many
// candidates that cost little, as a person's game has. Returns {moves, put,
// data, job, cuts}: the moves, how many stretches were put in, what prepare
// (analysis-core.js) makes of the game, job(at) the roll's position and moves
// for stretch `at` as the page has them, and each stretch's track.
import { Game } from '../../static/game.js';
import { fastConfig, makeState, playOut } from '../../static/lineplayer.js';
import { prepare } from '../../static/analysis-core.js';
import { random, track } from '../../static/analysis-worker.js';

export function plant(suits, seed) {
  const g = new Game(suits, seed), moves = [], below = random(seed ^ 0x51ED);
  const play = mv => { if (g.check(mv)) throw new Error('an illegal move'); g.applyRaw(mv); moves.push(mv); };
  let put = 0;
  while (!g.isWon() && moves.length < 700) {
    const line = track({ suits, columns: g.columns, faceDown: g.faceDown, completed: g.completed.length, stock: g.stock, moves: [] }, true)?.line;
    if (!line?.length) break;
    if (below(8) < 1) {
      put++;
      if (below(2) < 1 && g.stock.length && !line[0].deal && g.columns.every(c => c.length)) play({ deal: true });
      else {
        for (let k = 1 + below(3); k > 0; k--) {
          const legal = g.hintMoves().filter(mv => !mv.deal);
          if (!legal.length) break;
          const { from, to, count } = legal[below(legal.length)];
          play({ from, to, count });
        }
      }
      continue;
    }
    if (below(2) < 1) {
      const own = [];
      playOut(makeState(g.columns, g.faceDown, g.completed.length), Uint8Array.from(g.stock), fastConfig(suits), own, true);
      if (own.length) { for (const mv of own) play(mv); continue; }
    }
    for (const mv of line) play(mv);
  }
  const data = prepare(suits, seed, moves);
  const job = at => {
    const st = data.stretches[at], start = data.snaps[st.from];
    return { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to), seed: (Number(BigInt(seed) % 1000003n) * 131 + at) | 0 };
  };
  const cuts = data.stretches.map((_, at) => track(job(at)));
  return { moves, put, data, job, cuts };
}
