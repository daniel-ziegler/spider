// What the games the analysis plays out say of the chance of winning, put
// together with the network's values (blend in analysis-core.js), against the
// network's values alone, on games with mistakes put in (order.mjs make:
// every candidate played to the end in 256 worlds from before and after its
// moves, which is the truth here):
//
//   node blend.mjs run NET.bin GAME.json OUT.json [short|full|page] [key:value,...]   the search on a game, and what its games say
//   node blend.mjs report ['key:value,...;...'] OUT.json...                         how good the curve is with them
//
// `run` searches as the page does (findMistakes, then fillCurve), with the
// page's numbers for the game's suits, or SHORT's or SEARCH's, some changed,
// but in other worlds than those of the truth (the seeds changed), and keeps
// the network's values, what the games came to at each position (evidence)
// and the truth; also what found.mjs report counts, which it reads as well.
// `report` gives, for each number of suits, the network's error against the
// truth (its root mean square, the truth's own noise taken out) and that of
// the curve with the games: each position by its own games alone (`point`),
// with BLEND, and with BLEND with some numbers changed (key:value,... and
// ';' between ways), over the positions with a truth that have games of
// their own, those that do not, and all.
import { readFileSync, writeFileSync } from 'node:fs';
import { screen, findMistakes, fillCurve, evidence, blend, BLEND, searchFor, SEARCH, SHORT } from '../../static/analysis-core.js';
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
  const { moves, data, job: theirJob, cuts } = plant(suits, seed);
  if (moves.length !== game.moves) throw new Error('not the game of the file');
  const job = at => { const j = theirJob(at); return { ...j, seed: (j.seed ^ 0x5BD1E995) | 0 }; }; // (worlds other than the truth's)
  const value = enc => net.winProb(Buffer.from(enc, 'base64'));
  const values = new Map(game.jobs.map(j => [j.key, value(j.enc)]));
  const theirs = new Map(game.asks.map(j => [j.at, { value: value(j.enc), shows: j.shows }]));
  let cands = [], spent = 0;
  const t0 = performance.now();
  const found = await findMistakes({
    stretches: data.stretches, cuts, job, roll: async r => roll(r), opt,
    prior: screen(data.stretches, values, theirs, data.won, moves.length, suits), update: (c, n) => { cands = c; spent = n; },
  });
  const filled = await fillCurve({ stretches: data.stretches, cuts, cands, job, roll: async r => roll(r), opt, update: (_, n) => { spent += n; } });
  const ms = performance.now() - t0;
  const ev = evidence(data.stretches, [...cands, ...filled]);
  const N = moves.length, fixed = data.won ? [`p${N}`] : [];
  writeFileSync(args[2], JSON.stringify({
    suits, seed, spent, ms, won: data.won, moves: N, stretches: data.stretches, fixed, full: !opt.stop,
    values: [...values], evidence: [...ev], cands: game.cands,
    found: found.map(m => ({ at: m.at, move: m.move, exact: m.exact, unsure: m.unsure, n: m.n, mean: m.cost.mean, se: m.cost.se })), truth: game.cands.map(c => ({ at: c.at, before: c.before, after: c.before + c.mean })),
  }));
  console.log(`${suits} suits, seed ${seed}: ${spent} games, ${(ms / 1000).toFixed(1)} s`);
} else if (cmd === 'report') {
  // Each way: BLEND with some numbers changed; `point` is each position by its own games alone.
  const ways = [['the network', null], ['point', { moves: 1e9, cards: 1e9 }], ['BLEND', {}]];
  if (!args[0].endsWith('.json')) {
    for (const way of args.shift().split(';')) ways.push([way, Object.fromEntries(way.split(',').map(kv => { const [k, v] = kv.split(':'); return [k, +v]; }))]);
  }
  const runs = args.map(name => JSON.parse(readFileSync(name)));
  const noise = t => t * (1 - t) / 256; // (of the truth: games played to the end)
  for (const suits of [1, 2, 3, 4, 0]) {
    const mine = runs.filter(r => !suits || r.suits === suits);
    if (!mine.length) continue;
    // Every position with a truth, with or without games: [run, key, truth].
    const pos = mine.flatMap(r => r.truth.flatMap(c => {
      const st = r.stretches[c.at], end = st.shows ? `u${st.to}` : `p${st.to}`;
      return [[r, `p${st.from}`, c.before], ...(r.fixed.includes(end) ? [] : [[r, end, c.after]])];
    }));
    const has = ([r, key]) => new Map(r.evidence).get(key)?.n > 0;
    let e2 = 0, vv = 0, sw = 0, nw = 0, games = 0;
    for (const [r, key, t] of pos) {
      const v = new Map(r.values).get(key), e = new Map(r.evidence).get(key);
      e2 += (v - t) ** 2 - noise(t); vv += v * (1 - v);
      if (e?.n > 1) { const m = e.sum / e.n; sw += (e.sq - e.n * m * m) / (e.n - 1) / (v * (1 - v) || 1); nw++; games += e.n; }
    }
    console.log(`${suits || 'all'} suits, ${mine.length} games, ${pos.length} positions with a truth, ${pos.filter(has).length} with games (${Math.round(games / nw)} each), ${Math.round(mine.reduce((a, r) => a + r.spent, 0) / mine.length)} games and ${(mine.reduce((a, r) => a + r.ms, 0) / mine.length / 1000).toFixed(1)} s a game:`
      + ` the network's error ${(100 * Math.sqrt(e2 / pos.length)).toFixed(1)} points rms (${(e2 / vv).toFixed(3)} of v(1-v)), a game's variance ${(sw / nw).toFixed(3)} of v(1-v)`);
    for (const [name, change] of ways) {
      const sums = [0, 0, 0], counts = [0, 0, 0];
      for (const r of mine) {
        const values = new Map(r.values);
        const curve = change ? blend(r.stretches, values, new Map(r.evidence), new Set(r.fixed), r.full, { ...BLEND, ...change }) : values;
        for (const p of pos.filter(x => x[0] === r)) {
          const [, key, t] = p, d = (curve.get(key) - t) ** 2 - noise(t), w = has(p) ? 0 : 1;
          sums[w] += d; counts[w]++; sums[2] += d; counts[2]++;
        }
      }
      const rms = i => (100 * Math.sqrt(Math.max(0, sums[i] / counts[i]))).toFixed(2);
      console.log(`  ${name.padEnd(28)} error (rms, points): with games ${rms(0)}, without ${rms(1)}, all ${rms(2)}`);
    }
  }
} else throw new Error('run or report');
