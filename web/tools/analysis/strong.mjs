// The stronger player (static/strong.js) as the page plays it, one piece of
// work after another in the WebAssembly engine:
//
//   node strong.mjs play suits first count [params]     its games of the deals first..first+count-1
//   node strong.mjs analyze suits first count [params]  the same, and the analysis's search for mistakes in each
//
// `play` prints for each deal `seed won choices changed hash`, the hash being
// that of ../wasm's `strong` (cargo run --release --bin strong) for the same
// moves: the two must play the same games. `analyze` prints what
// findMistakes (analysis-core.js) makes of the game, searched as the page
// searches a person's: the mistakes it is sure of and those it lists as
// perhaps, each with its cost. `params` is JSON to put over strong.js's
// strongParams (e.g. '{"max":32}').
import { readFileSync } from 'node:fs';
import { prepare, screen, screenJobs, findMistakes, searchFor } from '../../static/analysis-core.js';
import { roll, track, strong, useEngine, useNet } from '../../static/analysis-worker.js';
import { strongGame, strongParams } from '../../static/strong.js';
import { loadWasm } from '../../static/wasm.js';

const file = name => { const b = readFileSync(new URL(name, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const [cmd, suitsArg, first, count, over] = process.argv.slice(2), suits = +suitsArg;
const engine = await loadWasm(file('../../static/spider.wasm'));
useEngine(engine);
const net = engine.net(file('../../static/nets/value.bin'), suits);
useNet(net);
const params = { ...strongParams(suits), ...JSON.parse(over ?? '{}') };

let sure = 0, perhaps = 0, cost = 0, games = 0, won = 0;
for (let seed = +first; seed < +first + +count; seed++) {
  const t0 = performance.now();
  const game = await strongGame(suits, seed, async job => strong(job), { params });
  const hash = game.moves.flatMap(mv => (mv.deal ? [255, 255, 255] : [mv.from, mv.to, mv.count])).reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811C9DC5);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  games++;
  won += game.won;
  if (cmd === 'play') { console.log(`${seed} ${+game.won} ${game.turns} ${game.changed} ${hash.toString(16).padStart(8, '0')} ${secs}s`); continue; }
  // The analysis of the game, as analysis.js runs it.
  const moves = game.moves, data = prepare(suits, seed, moves);
  const job = at => {
    const st = data.stretches[at], start = data.snaps[st.from];
    return { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to), seed: (Number(BigInt(seed) % 1000003n) * 131 + at) | 0 };
  };
  const cuts = data.stretches.map((_, at) => track(job(at)));
  const values = new Map(data.jobs.map(j => [j.key, net.winProb(j.enc)]));
  const theirs = new Map(screenJobs(suits, seed, moves, data.stretches, cuts).map(j => [j.at, { value: net.winProb(j.enc), shows: j.shows }]));
  let spent = 0;
  const found = await findMistakes({
    stretches: data.stretches, cuts, job, roll: async r => roll(r), opt: searchFor(suits),
    prior: screen(data.stretches, values, theirs, data.won, moves.length, suits), update: (c, n) => { spent = n; },
  });
  const list = found.map(m => `${m.unsure ? 'perhaps ' : ''}move ${m.move}: ${(100 * m.cost.mean).toFixed(1)} ± ${(100 * m.cost.se).toFixed(1)}`);
  sure += found.filter(m => !m.unsure).length;
  perhaps += found.filter(m => m.unsure).length;
  cost += found.filter(m => !m.unsure).reduce((a, m) => a + m.cost.mean, 0);
  console.log(`${seed} ${game.won ? 'won' : 'lost'}, ${game.turns} choices (${game.changed} not the line player's), ${cuts.filter(c => c?.length).length} stretches off its line, ${spent} games: ${list.join('; ') || 'no mistakes'} (${secs}s to play)`);
}
if (cmd !== 'play') console.log(`${games} games, ${won} won: ${sure} mistakes (${(100 * cost / games).toFixed(2)} points a game), ${perhaps} perhaps`);
