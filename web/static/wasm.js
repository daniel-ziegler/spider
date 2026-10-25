// The analysis's line player and network in WebAssembly (spider.wasm, built
// from ../wasm): what analysis-worker.js plays games out and values
// positions with where it loads, in place of lineplayer.js's playOut and
// vnet.js's Net, which give the same (test/wasm.mjs compares them): the
// games in less than half the time, the network in some two thirds of it,
// and where JavaScript runs interpreted (Chrome with its optimizer off, as
// under Android's Advanced Protection) both in a small fraction.
import { playOut as jsPlayOut, fastConfig, rolloutConfig, analysisConfig, SIZE } from './lineplayer.js';
import { ENC } from './vnet.js';

// The engine from spider.wasm's bytes (fetched if not given): {playOut, net(bytes, suits)}.
export async function loadWasm(bytes) {
  bytes ??= await fetch('/spider.wasm').then(res => {
    if (!res.ok) throw new Error(res.statusText);
    return res.arrayBuffer();
  });
  const { instance } = await WebAssembly.instantiate(bytes);
  const ex = instance.exports;
  // (Views are made afresh each time: the memory's buffer changes when it grows.)
  const view = (ptr, n) => new Uint8Array(ex.memory.buffer, ptr, n);

  // Which of lineplayer.js's configurations cfg is: 0 rollout, 1 fast, 2
  // the analysis's, -1 none (one changed: played in JavaScript).
  const KINDS = { rollout: [rolloutConfig, 0], fast: [fastConfig, 1], analysis: [analysisConfig, 2] }, known = new Map();
  const which = cfg => {
    const [config, kind] = KINDS[cfg.name] ?? [];
    if (!config) return -1;
    const key = `${cfg.name}${cfg.suits}`;
    if (!known.has(key)) known.set(key, JSON.stringify(config(cfg.suits)));
    return JSON.stringify(cfg) === known.get(key) ? kind : -1;
  };

  // As lineplayer.js's playOut, for its configurations (others are played there).
  function playOut(s, stock, cfg, moves = null, toShow = false) {
    const kind = which(cfg);
    if (kind < 0) return jsPlayOut(s, stock, cfg, moves, toShow);
    view(ex.state_ptr(), SIZE).set(s);
    view(ex.stock_ptr(), stock.length).set(stock);
    const r = ex.play_out(cfg.suits, stock.length, kind, moves ? 1 : 0, toShow ? 1 : 0);
    s.set(view(ex.state_ptr(), SIZE));
    if (moves) {
      const n = r >>> 8, m = view(ex.moves_ptr(), 3 * n);
      for (let i = 0; i < 3 * n; i += 3) moves.push(m[i] === 255 ? { deal: true } : { from: m[i], to: m[i + 1], count: m[i + 2] });
    }
    if (r & 32) return null;
    return { won: !!(r & 1), completed: (r >> 1) & 15, work: ex.work() };
  }

  // The network of the file `bytes` (export.py's), for games of this many suits: {winProb(enc)}.
  function net(file, suits) {
    view(ex.file_ptr(file.byteLength), file.byteLength).set(new Uint8Array(file));
    if (!ex.net_load(suits)) throw new Error('not a network');
    return {
      winProb(enc) {
        view(ex.enc_ptr(), ENC).set(enc);
        return ex.win_prob();
      },
    };
  }

  return { playOut, net };
}
