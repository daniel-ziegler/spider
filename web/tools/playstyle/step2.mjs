// The paired playouts: node step2.mjs DB DIR [--threads=N] [--worlds=24] [--scale=1]
// Each job is two moves' lines played on from one position in the same shuffles
// of what the player had not seen (analysis-worker.js's roll with `stop`: eight
// moves that show cards, then the network). Results in DIR/paired.jsonl, each
// with `d`, the mean over worlds of (a - b), its standard error `se`, `ma` and `mb`.
import { createWriteStream, readFileSync } from 'node:fs';
import os from 'node:os';
import { isMainThread, parentPort } from 'node:worker_threads';
import { Game } from '../../static/game.js';
import { MAXC, analysisConfig, playOut as jsPlayOut, makeState } from '../../static/lineplayer.js';
import { roll, useEngine, useNet, random } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';
import { loadGames, openGame } from './games.mjs';
import { runPool } from './pool.mjs';
import { planted } from './planted.mjs';

const STOP = 8;
const file = u => { const b = readFileSync(new URL(u, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const hash = s => { let h = 7; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h; };

if (!isMainThread) {
  const netBytes = file('../../static/nets/value.bin');
  const engine = await loadWasm(file('../../static/spider.wasm'));
  useEngine(engine);
  let netSuits = 0;
  parentPort.on('message', job => {
    if (job === null) return process.exit(0);
    let res = null, err = null;
    try {
      if (job.kind === 'strength') {
        const cfg = job.who === 'line' ? analysisConfig(4) : planted(4)[job.who];
        const g = new Game(4, job.seed), s = makeState(g.columns, g.faceDown, 0);
        const r = (job.who === 'line' ? engine.playOut : jsPlayOut)(s, Uint8Array.from(g.stock), cfg);
        res = { kind: job.kind, who: job.who, seed: job.seed, won: r.won ? 1 : 0 };
      } else {
        if (netSuits !== job.suits) { useNet(engine.net(netBytes, job.suits)); netSuits = job.suits; }
        const g = new Game(job.suits, job.seed);
        for (let i = 0; i < job.t; i++) g.applyRaw(job.line[i]);
        const pos = { suits: job.suits, columns: g.columns, faceDown: g.faceDown, completed: g.completed.length, stock: Uint8Array.from(g.stock), seed: hash(`${job.g}/${job.t}`), from: 0, to: job.worlds, stop: STOP };
        if (g.columns.some(c => c.length > MAXC)) throw new Error('column too long');
        const worth = moves => roll({ ...pos, moves, at: [moves.length] });
        const a = job.a === 'line' ? null : worth(job.a);
        let va, vb;
        if (job.a === 'line') { const both = roll({ ...pos, moves: job.b, at: [0, job.b.length] }); va = both.filter((_, i) => i % 2 === 0); vb = both.filter((_, i) => i % 2 === 1); }
        else { va = a; vb = worth(job.b); }
        let sd = 0, sq = 0, ma = 0, mb = 0, n = va.length;
        for (let i = 0; i < n; i++) { const d = va[i] - vb[i]; sd += d; sq += d * d; ma += va[i]; mb += vb[i]; }
        const d = sd / n;
        res = { ...job.meta, d, se: Math.sqrt(Math.max(0, sq / n - d * d) / Math.max(1, n - 1)), ma: ma / n, mb: mb / n, n };
      }
    } catch (e) { err = String(e.stack); }
    parentPort.postMessage({ res, err });
  });
  parentPort.postMessage({ ready: true });
} else {
  const args = process.argv.slice(2), opt = n => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
  const [db, dir] = args.filter(a => !a.startsWith('--'));
  const W = +(opt('worlds') ?? 24), scale = +(opt('scale') ?? 1);
  const jsonl = name => readFileSync(`${dir}/${name}.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const lines = new Map(loadGames(db, ['dmz', 'amanda'], [3, 4]).map(r => [`${r.user}/${r.suits}/${r.seed}`, openGame(r)?.moves]));
  const stretches = jsonl('stretches'), asked = jsonl('asked');
  const below = random(0xC0FFEE), sample = (xs, n) => { xs = xs.slice(); for (let i = xs.length - 1; i > 0; i--) { const j = below(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs.slice(0, Math.round(n * scale)); };
  const job = (r, a, b, meta, worlds = W) => ({ kind: 'pair', g: r.g, suits: r.suits, seed: +r.g.split('/')[2], t: r.t, line: lines.get(r.g).slice(0, r.t), a, b, worlds, meta: { g: r.g, user: r.user, suits: r.suits, t: r.t, ...meta } });
  const jobs = [];
  const clean = stretches.filter(r => !r.cont);
  // T3: every stretch where the player ended elsewhere than the line player: the line player's choice against it.
  for (const r of clean) if (!r.sameEnd && r.vL !== null) jobs.push(job(r, 'line', r.moves, { test: 't3', who: 'human' }));
  // T1: every missed goal: the shortest line to it against what was played.
  const missed = (out, goal) => (goal === 'flip' ? !(out.kind === 'turn' && out.empties >= 0) : goal === 'run' ? !(out.done > 0) : !(out.empties > 0));
  for (const r of clean) {
    for (const goal of ['flip', 'run', 'empty']) {
      const o = r.opp[goal];
      if (o && missed(r.out.human, goal)) jobs.push(job(r, o.path, r.moves, { test: 't1', who: 'human', goal, L: o.L, cat: o.cat, needs: o.needs, kind: r.out.human.kind }));
    }
  }
  // T4: the questions the player answered (at most so many of each).
  const byKey = new Map();
  for (const a of asked) if (a.who === 'human' && !a.open && !a.cont) { const k = `${a.suits}/${a.user}/${a.q}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(a); }
  for (const [, xs] of byKey) {
    for (const a of sample(xs, 300)) jobs.push(job({ g: a.g, user: a.user, suits: a.suits, t: a.t }, [...a.before, a.A], [...a.before, a.B], { test: 't4', who: 'human', q: a.q, pick: a.pick }));
  }
  // T5: the synthetic players' departures (T3) and the short player's misses (T1).
  for (const who of ['short', 'emptyLow', 'offHigh', 'runLow']) {
    const xs = stretches.filter(r => r.flawed[who] && !r.flawed[who].same && r.flawed[who].shows && r.vL !== null);
    for (const r of sample(xs, 400)) jobs.push(job(r, 'line', r.flawed[who].moves, { test: 't5', who, total: xs.length, all: stretches.filter(x => x.flawed[who]).length }));
    if (who === 'short') {
      const ms = [];
      for (const r of stretches) for (const goal of ['flip', 'run', 'empty']) { const o = r.opp[goal]; if (o && r.flawed.short && r.flawed.short.shows && missed(r.out.short, goal)) ms.push([r, goal, o]); }
      for (const [r, goal, o] of sample(ms, 300)) jobs.push(job(r, o.path, r.flawed.short.moves, { test: 't1', who: 'short', goal, L: o.L, cat: o.cat, total: ms.length }));
    }
  }
  // T5: what the flaws cost a whole game.
  const n = Math.round(800 * scale);
  for (let i = 0; i < n; i++) for (const who of ['line', 'short', 'emptyLow', 'offHigh', 'runLow']) jobs.push({ kind: 'strength', who, seed: 900001 + i });
  // (Shuffled so that the time left can be told.)
  const order = sample(jobs.filter(j => !opt('only') || j.meta?.test === opt('only')), jobs.length / scale);
  console.error(`${order.length} jobs:`, Object.entries(order.reduce((m, j) => { const k = j.meta?.test ?? j.kind; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(e => e.join(' ')).join(', '));
  const out = createWriteStream(`${dir}/${opt('only') ? `paired-${opt('only')}` : 'paired'}.jsonl`), t0 = Date.now();
  await runPool(new URL(import.meta.url), +(opt('threads') ?? os.cpus().length), order, (m, done, all) => {
    if (m.err) console.error(m.err);
    if (m.res) out.write(JSON.stringify(m.res) + '\n');
    if (done % 200 === 0) console.error(`${done}/${all} ${Math.round((Date.now() - t0) / 1000)} s`);
  });
  out.end();
}
