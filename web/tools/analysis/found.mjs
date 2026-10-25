// What the analysis's whole search for mistakes (findMistakes in
// analysis-core.js) finds on games with mistakes put in, against what each
// candidate really costs (order.mjs make: games played to the end in 256
// worlds):
//
//   node found.mjs run NET.bin GAME.json OUT.json [short|full] [key:value,...]   the search on a game of order.mjs make's
//   node found.mjs report OUT.json...                                            the counts
//
// `run` searches as the page does, with the page's numbers for the game's
// suits, or SHORT's or SEARCH's if asked for, some changed (cost:0.06,z:3),
// one roll after another. `report` counts for each number of suits, of the
// candidates that really are mistakes (five points and 2.5 standard errors,
// as isMistake has it), those the search called mistakes and those it did
// not, and of what it called mistakes besides those that really cost three
// points or more (near ones) and the others (false ones); the same of what
// it listed as perhaps mistakes; and the games played and the time.
import { readFileSync, writeFileSync } from 'node:fs';
import { screen, findMistakes, isMistake, searchFor, SEARCH, SHORT } from '../../static/analysis-core.js';
import { roll, useEngine, useNet } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';
import { plant } from './planted.mjs';

const file = name => { const b = readFileSync(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'run') {
  const game = JSON.parse(readFileSync(args[1])), { suits, seed } = game;
  const engine = await loadWasm(file(new URL('../../static/spider.wasm', import.meta.url)));
  useEngine(engine);
  const net = engine.net(file(args[0]), suits);
  useNet(net);
  const opt = { ...(args[3] === 'short' ? SHORT : args[3] === 'full' ? SEARCH : searchFor(suits)) };
  for (const kv of (args[4] ?? '').split(',').filter(x => x)) { const [k, v] = kv.split(':'); opt[k] = +v; }
  const { moves, data, job, cuts } = plant(suits, seed);
  if (moves.length !== game.moves) throw new Error('not the game of the file');
  const value = enc => net.winProb(Buffer.from(enc, 'base64'));
  const values = new Map(game.jobs.map(j => [j.key, value(j.enc)]));
  const theirs = new Map(game.asks.map(j => [j.at, { value: value(j.enc), shows: j.shows }]));
  let spent = 0;
  const t0 = performance.now();
  const found = await findMistakes({
    stretches: data.stretches, cuts, job, roll: async r => roll(r), opt,
    prior: screen(data.stretches, values, theirs, data.won, moves.length, suits), update: (c, n) => { spent = n; },
  });
  const ms = performance.now() - t0;
  writeFileSync(args[2], JSON.stringify({ suits, seed, cands: game.cands, spent, ms, found: found.map(m => ({ at: m.at, move: m.move, exact: m.exact, unsure: m.unsure, n: m.n, mean: m.cost.mean, se: m.cost.se, better: m.better, yours: m.yours })) }));
  console.log(`${suits} suits, seed ${seed}: ${spent} games, ${(ms / 1000).toFixed(1)} s, ${found.filter(m => !m.unsure).length} mistakes and ${found.filter(m => m.unsure).length} perhaps`);
} else if (cmd === 'report') {
  const runs = args.map(name => JSON.parse(readFileSync(name)));
  for (const suits of [1, 2, 3, 4, 0]) {
    const mine = runs.filter(r => !suits || r.suits === suits);
    if (!mine.length) continue;
    let real = 0, hit = 0, near = 0, wrong = 0, perhaps = [0, 0, 0], spent = 0, ms = 0, shown = 0, over = 0, pairs = 0;
    for (const r of mine) {
      const truth = new Map(r.cands.map(c => [c.at, c])), is = c => isMistake({ n: 256, mean: c.mean, se: c.se });
      real += r.cands.filter(is).length;
      spent += r.spent; ms += r.ms;
      for (const m of r.found) {
        const c = truth.get(m.at);
        if (m.unsure) perhaps[is(c) ? 0 : c.mean <= -0.03 ? 1 : 2]++;
        else if (is(c)) { hit++; shown += m.mean; over += c.mean; pairs++; } else if (c.mean <= -0.03) near++;
        else wrong++;
      }
    }
    console.log(`${suits || 'all'} suits, ${mine.length} games: ${real} real mistakes, ${hit} found, ${real - hit} not; called mistakes besides: ${near} near, ${wrong} false; perhaps: ${perhaps[0]} real, ${perhaps[1]} near, ${perhaps[2]} not; the found ones' cost shown ${(-100 * shown / pairs).toFixed(1)} against ${(-100 * over / pairs).toFixed(1)}; ${Math.round(spent / mine.length)} games and ${(ms / mine.length / 1000).toFixed(1)} s a game`);
  }
} else throw new Error('run or report');
