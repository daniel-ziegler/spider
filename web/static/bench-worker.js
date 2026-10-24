// The benchmark of the analysis's work (bench.html): the same pieces of work
// the analysis's workers do (analysis-worker.js), each timed, run on the page
// and in workers, to see where a device is slow. Also the analysis's own
// worker messages, so that bench.html can run the whole analysis with it.
//
// Messages to it: {net: ArrayBuffer} first, then {id, suite: {suits, seed, reps}};
// answers {id, times: {name: ms}}. Anything else goes to analysis-worker.js.
import { Net } from './vnet.js';
import { Game } from './game.js';
import { makeState, playOut, rolloutConfig } from './lineplayer.js';
import { prepare } from './analysis-core.js';
import { roll, track } from './analysis-worker.js';

// A game of the line player's from a deal.
export function played(suits, seed) {
  const g = new Game(suits, seed), moves = [];
  playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), rolloutConfig(suits), moves);
  return moves;
}

// A stretch's job, as analysis.js makes it.
export function stretchJob(suits, seed, moves, data, at) {
  const st = data.stretches[at], start = data.snaps[st.from];
  return { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to), seed: at };
}

const time = f => { const t = performance.now(); const r = f(); return [performance.now() - t, r]; };

// The pieces of work, each timed (ms). `bytes`: the network's file.
export function suite(bytes, { suits = 4, seed = 70018, reps = 1 } = {}) {
  const out = {};
  const keep = (name, ms) => { out[name] = Math.min(out[name] ?? Infinity, ms); };
  let sink = 0;
  for (let r = 0; r < reps; r++) {
    // Plain JavaScript: integers, and floats with Math.exp.
    keep('int loop', time(() => { let a = 1; for (let i = 0; i < 2e7; i++) a = (Math.imul(a, 1103515245) + 12345) | 0; sink += a; })[0]);
    keep('float loop', time(() => { let s = 0; for (let i = 0; i < 2e6; i++) s += Math.exp(-(i % 50) * 0.1) * 1.0001; sink += s; })[0]);
    keep('typed alloc', time(() => { for (let i = 0; i < 2000; i++) sink += new Uint8Array(4096)[i % 4096]; })[0]);
    const [netLoad, net] = time(() => new Net(bytes.slice(0), suits));
    keep('net load', netLoad);
    const [gameMs, moves] = time(() => played(suits, seed));
    keep('play a game', gameMs);
    const data = prepare(suits, seed, moves), encs = data.jobs.slice(0, 24).map(j => j.enc);
    keep('net 24 positions', time(() => { for (const e of encs) sink += net.winProb(e); })[0]);
    keep('track all stretches', time(() => { for (let at = 0; at < data.stretches.length; at++) track(stretchJob(suits, seed, moves, data, at)); })[0]);
    const mid = Math.floor(data.stretches.length / 3);
    keep('roll 4 worlds', time(() => roll({ ...stretchJob(suits, seed, moves, data, mid), from: 0, to: 4 }))[0]);
  }
  out.sink = sink === 12345.678 ? 1 : 0; // (so that nothing is optimised away)
  return out;
}

if (typeof WorkerGlobalScope !== 'undefined') {
  const theirs = onmessage; // analysis-worker.js's
  let bytes = null;
  onmessage = e => {
    const { data } = e;
    if (data.net) bytes = data.net.slice(0);
    if (data.suite) postMessage({ id: data.id, times: suite(bytes, data.suite) });
    else theirs(e);
  };
}
