// How well the analysis's network orders the candidates for mistakes (screen
// in analysis-core.js), on games with mistakes put in:
//
//   node order.mjs make SUITS SEED OUT.json [WORLDS]   a game, its candidates and what each really costs
//   node order.mjs score NET.bin FILE.json...          where a network puts the real mistakes
//
// `make` plays a deal with mistakes put in (planted.mjs: something else than
// the analysis's player's line at one stretch in eight, the cheap player's
// at half the others), finds the candidates as the page does (track) and plays
// each out in WORLDS shuffles (256) from before and after its moves: its
// cost, with the standard error. `score` has a network value what the page
// would and counts, of the candidates that cost eight points or more and
// surely something (2.5 standard errors), how many are among the first
// three, five and eight of their game by the network's difference (and how
// many would be at random), and gives the correlation of the difference
// with the cost over all candidates.
import { readFileSync, writeFileSync } from 'node:fs';
import { Net } from '../../static/vnet.js';
import { screenJobs, screen, paired } from '../../static/analysis-core.js';
import { roll, useEngine } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';
import { plant } from './planted.mjs';

const file = name => { const b = readFileSync(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'make') {
  const [suits, seed, out, worlds = 256] = [+args[0], +args[1], args[2], +(args[3] ?? 256)];
  useEngine(await loadWasm(file(new URL('../../static/spider.wasm', import.meta.url))));
  const { moves, put, data, job, cuts } = plant(suits, seed);
  const b64 = enc => Buffer.from(enc).toString('base64');
  const cands = [];
  data.stretches.forEach((st, at) => {
    if (!cuts[at]?.length) return;
    const worth = roll({ ...job(at), from: 0, to: worlds, at: [0, st.to - st.from] });
    const d = paired(worth.filter((_, k) => !(k & 1)), worth.filter((_, k) => k & 1));
    cands.push({ at, mean: d.mean, se: d.se, before: d.a });
  });
  writeFileSync(out, JSON.stringify({
    suits, seed, won: data.won, moves: moves.length, put, stretches: data.stretches, cands,
    jobs: data.jobs.map(j => ({ key: j.key, enc: b64(j.enc) })),
    asks: screenJobs(suits, seed, moves, data.stretches, cuts).map(j => ({ at: j.at, enc: b64(j.enc), shows: j.shows })),
  }));
  console.log(`${suits} suits, seed ${seed}: ${moves.length} moves, ${data.won ? 'won' : 'lost'}, ${put} put in, ${cands.length} candidates, ${cands.filter(c => c.mean <= -0.08 && c.mean + 2.5 * c.se <= 0).length} real mistakes`);
} else if (cmd === 'score') {
  const bytes = file(args[0]), nets = {};
  const tops = [3, 5, 8], found = tops.map(() => 0), chance = tops.map(() => 0);
  let real = 0, n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, small = 0, smallSq = 0, smalls = 0;
  for (const name of args.slice(1)) {
    const game = JSON.parse(readFileSync(name)), net = nets[game.suits] ??= new Net(bytes, game.suits);
    const value = enc => net.winProb(Buffer.from(enc, 'base64'));
    const values = new Map(game.jobs.map(j => [j.key, value(j.enc)]));
    const theirs = new Map(game.asks.map(j => [j.at, { value: value(j.enc), shows: j.shows }]));
    const prior = screen(game.stretches, values, theirs, game.won, game.moves, game.suits);
    const order = game.cands.map(c => c.at).sort((a, b) => prior[a] - prior[b] || a - b);
    for (const c of game.cands) {
      const last = !game.won && !game.stretches[c.at].shows && game.stretches[c.at].to === game.moves; // (the end of a game not won comes first whatever the network says)
      if (!last) {
        const x = prior[c.at], y = c.mean;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (y > -0.03) { smalls++; small += x; smallSq += x * x; }
      }
      if (!(c.mean <= -0.08 && c.mean + 2.5 * c.se <= 0)) continue;
      real++;
      const rank = order.indexOf(c.at);
      tops.forEach((k, i) => { found[i] += rank < k; chance[i] += Math.min(k, order.length) / order.length; });
    }
  }
  const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  console.log(`${args.length - 1} games, ${n} candidates, ${real} real mistakes; among the first ${tops.join(', ')}: ${found.join(', ')} (at random ${chance.map(x => x.toFixed(1)).join(', ')}); correlation of the difference with the cost ${corr.toFixed(3)}; the difference where the cost is under three points: sd ${(100 * Math.sqrt(smallSq / smalls - (small / smalls) ** 2)).toFixed(1)} points`);
} else throw new Error('make or score');
