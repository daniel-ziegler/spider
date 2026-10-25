// How often a configuration of the line player (lineplayer.js: analysis,
// rollout or fast) wins, and what a game costs, in the WebAssembly engine:
//   node strength.mjs config suits first count [over]
// plays the deals first..first+count-1 and prints
//   config suits won games ms-a-game positions-a-game
// (`over`: JSON to put over the configuration, which is then played in
// JavaScript: e.g. '{"beam":150}'.)
import { readFileSync } from 'node:fs';
import { Game } from '../../static/game.js';
import * as lp from '../../static/lineplayer.js';
import { loadWasm } from '../../static/wasm.js';

const [name, suits, first, count, over] = process.argv.slice(2);
const b = readFileSync(new URL('../../static/spider.wasm', import.meta.url));
const wasm = await loadWasm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let cfg = lp[`${name}Config`](+suits);
if (over) {
  cfg = { ...cfg, ...JSON.parse(over) };
  if (cfg.staged) cfg.staged = cfg.staged.map(c => ({ ...c, ...JSON.parse(over) }));
}
let won = 0, work = 0;
const t = performance.now();
for (let seed = +first; seed < +first + +count; seed++) {
  const g = new Game(+suits, seed);
  const r = wasm.playOut(lp.makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), cfg);
  won += r.won;
  work += r.work;
}
console.log([name + (over ?? ''), suits, won, count, ((performance.now() - t) / count).toFixed(1), Math.round(work / count)].join(' '));
