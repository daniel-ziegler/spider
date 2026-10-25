// Checks the analysis's WebAssembly engine (static/spider.wasm, built from
// ../wasm; static/wasm.js) against the JavaScript it stands in for: the
// line player's games (lineplayer.js's playOut, from the deal and played to
// the first card shown), the analysis's games and tracks (roll and track in
// analysis-worker.js, the games also stopped and valued), and the network's values (vnet.js). They must be the
// same, the values to a millionth. It fails by throwing, and prints the
// time each engine took. The repository root's `cargo test` runs this.
import { readFileSync } from 'node:fs';
import { Game } from '../static/game.js';
import { fastConfig, rolloutConfig, analysisConfig, makeState, playOut, NUM_COLS, MAXC, LEN, DOWN, DONE } from '../static/lineplayer.js';
import { Net } from '../static/vnet.js';
import { prepare } from '../static/analysis-core.js';
import { roll, track, useEngine, useNet } from '../static/analysis-worker.js';
import { loadWasm } from '../static/wasm.js';

const check = (ok, what) => { if (!ok) throw new Error(what); };
const file = name => { const b = readFileSync(new URL(name, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const wasm = await loadWasm(file('../static/spider.wasm'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A position as far as it goes (what lies past a column's end is no part of it).
const cards = s => [Array.from({ length: NUM_COLS }, (_, c) => [...s.subarray(c * MAXC, c * MAXC + s[LEN + c])]), [...s.subarray(DOWN, DOWN + NUM_COLS)], s[DONE]];
const time = { js: 0, wasm: 0 };
const timed = (name, f) => { const t = performance.now(), r = f(); time[name] += performance.now() - t; return r; };

// Games from the deal, by both players, and their end positions.
const games = [];
for (const [name, config] of [['analysis', analysisConfig], ['rollout', rolloutConfig], ['fast', fastConfig]]) {
  for (let suits = 1; suits <= 4; suits++) {
    for (let seed = 70001; seed < 70004; seed++) {
      const g = new Game(suits, seed), out = {};
      for (const [e, play] of [['js', playOut], ['wasm', wasm.playOut]]) {
        const s = makeState(g.columns, g.faceDown, 0), moves = [];
        const r = timed(e, () => play(s, Uint8Array.from(g.stock), config(suits), moves));
        out[e] = { r, moves, s: cards(s) };
      }
      check(same(out.js, out.wasm), `${name} ${suits}/${seed}: the engines play differently`);
      if (name === 'analysis') games.push({ suits, seed, moves: out.js.moves });
    }
  }
}
// Played to the first card shown, from positions along those games.
for (const { suits, seed, moves } of games) {
  const data = prepare(suits, seed, moves);
  for (let t = 0; t < moves.length; t += 11) {
    const p = data.snaps[t], out = {};
    for (const [e, play] of [['js', playOut], ['wasm', wasm.playOut]]) {
      const s = makeState(p.columns, p.faceDown, p.completed.length), own = [];
      const r = play(s, Uint8Array.from(p.stock), analysisConfig(suits), own, true);
      out[e] = { r, own, s: cards(s) };
    }
    check(same(out.js, out.wasm), `${suits}/${seed} after ${t} moves: the engines play differently to the first card shown`);
  }
}
// The analysis's games and tracks, every third stretch of a game of each number of suits.
for (const { suits, seed, moves } of games.filter(g => g.seed === 70001)) {
  const data = prepare(suits, seed, moves);
  data.stretches.forEach((st, at) => {
    if (at % 3) return;
    const start = data.snaps[st.from];
    const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to), seed: at, from: 0, to: 4 };
    const out = {};
    for (const [e, engine] of [['js', null], ['wasm', wasm]]) {
      useEngine(engine);
      out[e] = timed(e, () => ({ roll: [...roll(job)], track: track(job, true) }));
    }
    useEngine(null);
    check(same(out.js, out.wasm), `${suits}/${seed} stretch ${at}: the engines' games or tracks differ`);
  });
}
// The network's values, of every other position of those games (and of those with cards not yet known).
const bytes = file('../static/nets/value.bin');
let worst = 0, n = 0;
for (const { suits, seed, moves } of games.filter(g => g.seed <= 70002)) {
  const js = new Net(bytes, suits), wa = wasm.net(bytes, suits);
  for (const { enc } of prepare(suits, seed, moves).jobs.filter((_, i) => i % 2 === 0)) {
    const a = timed('js', () => js.winProb(enc)), b = timed('wasm', () => wa.winProb(enc));
    worst = Math.max(worst, Math.abs(a - b));
    n++;
  }
}
check(worst < 1e-6, `the engines' values differ by ${worst}`);
// Games stopped after a few moves that show cards and valued there (a roll with `stop`).
let stopped = 0;
for (const { suits, seed, moves } of games.filter(g => g.seed === 70001 && g.suits > 1)) {
  const data = prepare(suits, seed, moves), nets = { js: new Net(bytes, suits), wasm: wasm.net(bytes, suits) };
  data.stretches.forEach((st, at) => {
    if (at % 7 !== 2) return;
    const start = data.snaps[st.from];
    const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to), seed: at, from: 0, to: 2, reveal: true, stop: 3 };
    const out = {};
    for (const [e, engine] of [['js', null], ['wasm', wasm]]) {
      useEngine(engine);
      useNet(nets[e]);
      out[e] = timed(e, () => roll(job));
    }
    useEngine(null);
    stopped++;
    check(out.js.length === 6 && out.js.every((x, k) => Math.abs(x - out.wasm[k]) < 1e-6), `${suits}/${seed} stretch ${at}: the engines' stopped games differ`);
  });
}
console.log(`${games.length * 3} games, ${stopped} rolls stopped and valued, ${n} values (largest difference ${worst.toExponential(1)}): JavaScript ${(time.js / 1000).toFixed(1)} s, WebAssembly ${(time.wasm / 1000).toFixed(1)} s`);
