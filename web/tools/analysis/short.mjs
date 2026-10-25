// What the analysis's mistakes would be worth if their games were not played
// out to the end but for a while, and the network (vnet.js) then valued the
// position reached: an experiment, on games with mistakes put in
// (planted.mjs, as order.mjs has them). The page does not do this.
//
//   node short.mjs run NET.bin SUITS SEED OUT.json [WORLDS]   a game's candidates, every world played both ways
//   node short.mjs report [--times=FILE.json,...] FILE.json...  the tables (the times from other runs, made with the machine idle)
//
// `run` takes each candidate (a stretch that leaves the line player's line)
// through WORLDS shuffles (256) of the cards not seen at its start, the same
// as the page's (roll in analysis-worker.js), and in each plays the line
// player on from before the stretch's moves and from after them, twice:
// straight to the end, as the page does (`full`), and from one move that
// shows cards to the next, where the network values the position at each
// mark it comes to: after the 1st, 2nd, ... card shown or deal counted from
// the stretch's start (`r1`, `r2`, ...: a stretch's own last move is the
// first for the game from after it, so `r1` plays nothing there), and after
// the first deal (`d1`). The positions valued are all just
// after cards came up, every card face up known. A game that ends before a
// mark has its result there (1 won, 0 not), and `end` is the result of the
// game played from showing to showing (it need not be `full`'s: a step that
// goes on after its card turns is cut short there and thought out again).
// The time each takes is kept, with the network's.
//
// `report` gives, for each number of suits and each mark, over the
// candidates: the cost (the mean over worlds of after less before) against
// `full`'s (correlation, mean difference, root mean square difference, and
// that with the worlds' noise taken out: what would be left with worlds
// without end), the standard deviation of a world's difference and so the
// worlds needed for full's standard error, the time a world takes and so the
// time for the same standard error, and how the candidates called mistakes
// (analysis-core.js's isMistake: five points, 2.5 standard errors) compare
// with those full calls so in all the worlds.
import { readFileSync, writeFileSync } from 'node:fs';
import { NUM_COLS, MAXC, LEN, DOWN, DONE, analysisConfig } from '../../static/lineplayer.js';
import { encode } from '../../static/vnet.js';
import { isMistake, SEARCH } from '../../static/analysis-core.js';
import { random, shuffled, setup, useEngine } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';
import { plant } from './planted.mjs';

const file = name => { const b = readFileSync(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const [cmd, ...args] = process.argv.slice(2);
const MARKS = [...[1, 2, 4, 8, 16].map(k => ['r', k]), ['d', 1]];
const NAMES = [...MARKS.map(([kind, k]) => kind + k), 'end', 'full'], NM = MARKS.length, END = NM, FULL = NM + 1;

if (cmd === 'run') {
  const [suits, seed, out, worlds] = [+args[1], +args[2], args[3], +(args[4] ?? 256)];
  const engine = await loadWasm(file(new URL('../../static/spider.wasm', import.meta.url)));
  useEngine(engine);
  const net = engine.net(file(args[0]), suits), cfg = analysisConfig(suits);
  const { moves, data, job, cuts } = plant(suits, seed);
  let evals = 0, evalTime = 0;
  const value = (s, left) => {
    const columns = [], t = performance.now();
    for (let c = 0; c < NUM_COLS; c++) columns.push(s.subarray(c * MAXC, c * MAXC + s[LEN + c]));
    const p = net.winProb(encode(columns, s.subarray(DOWN, DOWN + NUM_COLS), left / NUM_COLS, s[DONE]));
    evals++; evalTime += performance.now() - t;
    return p;
  };
  // (down, left) of a position: it changes when cards are shown and only then.
  const shown = (s, left) => { let down = 0; for (let c = 0; c < NUM_COLS; c++) down += s[DOWN + c]; return down * 1000 + left; };
  const stockLeft = s => { let n = 104 - 13 * s[DONE]; for (let c = 0; c < NUM_COLS; c++) n -= s[LEN + c]; return n; };
  // A game from showing to showing: vals[i] and times[i] (ms of play so far) at each mark and at the end.
  const follow = (g, reveals, deals, vals, times) => {
    if (!g) { vals.fill(0); times.fill(0); return; }
    const s = g.s, got = new Uint8Array(NM);
    let left = g.stock.length, t = 0, ngot = 0, result = -1;
    const mark = () => {
      let p = -1;
      MARKS.forEach(([kind, k], i) => {
        if (got[i] || (kind === 'r' ? reveals : deals) < k) return;
        if (p < 0) p = s[DONE] === 8 ? 1 : value(s, left);
        got[i] = 1; ngot++; vals[i] = p; times[i] = t;
      });
    };
    mark();
    while (result < 0) {
      if (s[DONE] === 8) { result = 1; break; }
      const before = shown(s, left), t0 = performance.now();
      engine.playOut(s, g.stock.subarray(0, left), cfg, null, true);
      t += performance.now() - t0;
      const now = stockLeft(s);
      if (shown(s, now) === before) { result = s[DONE] === 8 ? 1 : 0; break; }
      reveals++;
      if (now !== left) deals++;
      left = now;
      mark();
    }
    for (let i = 0; i < NM; i++) if (!got[i]) { vals[i] = result; times[i] = t; }
    vals[END] = result; times[END] = t;
  };
  const cands = [];
  let differ = 0, games = 0;
  data.stretches.forEach((st, at) => {
    if (!cuts[at]?.length) return;
    const j = job(at), { real, game } = setup(j), len = st.to - st.from;
    const a = NAMES.map(() => []), b = NAMES.map(() => []), time = new Float64Array(NAMES.length);
    const va = new Float64Array(NAMES.length), vb = new Float64Array(NAMES.length), ta = new Float64Array(NAMES.length), tb = new Float64Array(NAMES.length);
    for (let w = 0; w < worlds; w++) {
      const cards = shuffled(real, random(Math.imul(j.seed, 0x9E3779B1) ^ Math.imul(w + 1, 0x85EBCA6B)));
      follow(game(cards, 0), 0, 0, va, ta);
      follow(game(cards, len), st.shows ? 1 : 0, st.shows === 'deal' ? 1 : 0, vb, tb);
      [[0, va, ta], [len, vb, tb]].forEach(([upto, v, t]) => {
        const g = game(cards, upto), t0 = performance.now();
        v[FULL] = g && engine.playOut(g.s, g.stock, cfg).won ? 1 : 0;
        t[FULL] = performance.now() - t0;
        games++; differ += v[FULL] !== v[END];
      });
      NAMES.forEach((_, i) => { a[i].push(+va[i].toFixed(4)); b[i].push(+vb[i].toFixed(4)); time[i] += ta[i] + tb[i]; });
    }
    cands.push({ at, shows: st.shows, a, b, time: [...time].map(t => t / worlds) });
  });
  writeFileSync(out, JSON.stringify({ suits, seed, won: data.won, moves: moves.length, worlds, evalMs: evalTime / evals, cands }));
  console.log(`${suits} suits, seed ${seed}: ${moves.length} moves, ${cands.length} candidates, ${differ} of ${games} games end otherwise from showing to showing, a value ${(evalTime / evals).toFixed(2)} ms`);
} else if (cmd === 'report') {
  const read = name => JSON.parse(readFileSync(name));
  const games = args.filter(a => !a.startsWith('--')).map(read);
  // The times of each number of suits, from the runs given for them: the mean over their candidates.
  const timed = {};
  for (const g of (args.find(a => a.startsWith('--times='))?.slice(8).split(',') ?? []).map(read)) {
    const t = timed[g.suits] ??= { n: 0, time: NAMES.map(() => 0), evalMs: 0 };
    for (const c of g.cands) { t.n++; t.evalMs += g.evalMs; c.time.forEach((x, i) => { t.time[i] += x; }); }
  }
  const times = g => { const t = timed[g.suits]; return t ? { time: t.time.map(x => x / t.n), evalMs: t.evalMs / t.n } : { evalMs: g.evalMs }; };
  // Of xs[w]: n, mean, the standard error of the mean, the standard deviation.
  const stat = (xs, to = xs.length) => {
    let s = 0, q = 0;
    for (let w = 0; w < to; w++) { s += xs[w]; q += xs[w] * xs[w]; }
    const mean = s / to, v = Math.max(0, q - to * mean * mean) / (to - 1);
    return { n: to, mean, se: Math.max(Math.sqrt(v / to), 1 / to), sd: Math.sqrt(v) };
  };
  const pct = x => (100 * x).toFixed(1).padStart(6);
  for (const suits of [1, 2, 3, 4, 0]) {
    const cands = games.filter(g => !suits || g.suits === suits).flatMap(g => g.cands.map(c => ({ ...c, ...times(g) })));
    if (!cands.length) continue;
    const diff = (c, i) => c.b[i].map((x, w) => x - c.a[i][w]);
    const full = cands.map(c => stat(diff(c, FULL))), truth = full.map(d => isMistake(d));
    const N = cands.length, worlds = cands[0].a[0].length;
    console.log(`\n${suits || 'all'} suits: ${games.filter(g => !suits || g.suits === suits).length} games, ${N} candidates, ${truth.filter(x => x).length} mistakes by full games in ${worlds} worlds (their mean cost ${pct(-full.filter((_, k) => truth[k]).reduce((s, d) => s + d.mean, 0) / truth.filter(x => x).length)})`);
    console.log('mark    corr   bias    rms  rms-noise |  sd/world  worlds x |  ms/world  time x | mistakes: both full-only mark-only (64 worlds) (128) (all) | second half, of first half\'s mistakes: full  mark');
    NAMES.forEach((name, i) => {
      const mine = cands.map(c => stat(diff(c, i)));
      // Against full: the candidates' means, and world by world the difference of the two differences.
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sq = 0, noise = 0, varMine = 0, varFull = 0, ms = 0;
      cands.forEach((c, k) => {
        const x = full[k].mean, y = mine[k].mean, df = diff(c, FULL), dm = diff(c, i);
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sq += (y - x) ** 2;
        const e = stat(dm.map((v, w) => v - df[w]));
        noise += e.sd * e.sd / e.n;
        varMine += mine[k].sd ** 2; varFull += full[k].sd ** 2;
        ms += c.time[i] + (i < NM ? 2 * c.evalMs : 0);
      });
      const corr = (N * sxy - sx * sy) / Math.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy));
      const sdRatio = varMine / varFull, msFull = cands.reduce((s, c) => s + c.time[FULL], 0) / N;
      const table = n => {
        let both = 0, onlyFull = 0, onlyMine = 0;
        cands.forEach((c, k) => {
          const m = isMistake(stat(diff(c, i), n), SEARCH, Math.min(n, SEARCH.least));
          both += m && truth[k]; onlyFull += !m && truth[k]; onlyMine += m && !truth[k];
        });
        return `${both}/${onlyFull}/${onlyMine}`.padStart(9);
      };
      // The mistakes by full's games in the first half of the worlds, in the second half.
      const half = worlds >> 1;
      let picked = 0, f2 = 0, m2 = 0;
      cands.forEach(c => {
        const df = diff(c, FULL), dm = diff(c, i);
        if (!isMistake(stat(df, half), SEARCH, Math.min(half, SEARCH.least))) return;
        picked++; f2 += stat(df.slice(half)).mean; m2 += stat(dm.slice(half)).mean;
      });
      console.log(`${name.padEnd(5)} ${corr.toFixed(3).padStart(6)} ${pct((sy - sx) / N)} ${pct(Math.sqrt(sq / N))}  ${pct(Math.sqrt(Math.max(0, sq / N - noise / N)))} |   ${pct(Math.sqrt(varMine / N))}   ${sdRatio.toFixed(3).padStart(6)} |  ${(ms / N).toFixed(2).padStart(7)}  ${(msFull * 1 / (ms / N * sdRatio)).toFixed(1).padStart(6)} | ${table(64)} ${table(128)} ${table(worlds)} | ${picked} ${pct(f2 / picked)} ${pct(m2 / picked)} | value ${(cands.reduce((s, c) => s + c.evalMs, 0) / N).toFixed(1)} ms`);
    });
  }
} else throw new Error('run or report');
