// The game the computer plays of each deal, as compare mode shows it
// (compare-core.js's computerGame: the analysis's line player, from one move
// that shows cards to the next, in the WebAssembly engine as in the browser):
//   node computer.mjs suits first count     the deals first..first+count-1
//   node computer.mjs suits FILE            the deals whose seeds start FILE's lines (`#` comments aside; `seed N ...` too)
// prints `seed S won 0|1 moves N` for each. With SPIDER_JS=1 it plays in
// JavaScript instead, which gives the same games; with SPIDER_PART=i/n only
// every n-th deal, from the i-th (to play them in n processes).
import { readFileSync } from 'node:fs';
import { computerGame } from '../../static/compare-core.js';
import { nextMoves, useEngine } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';

const [suits, first, count] = process.argv.slice(2);
if (!process.env.SPIDER_JS) {
  const b = readFileSync(new URL('../../static/spider.wasm', import.meta.url));
  useEngine(await loadWasm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}
const seeds = count === undefined
  ? readFileSync(first, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => +l.replace(/^seed /, '').split(/\s+/)[0])
  : Array.from({ length: +count }, (_, i) => +first + i);
const [part, parts] = (process.env.SPIDER_PART ?? '0/1').split('/').map(Number);
for (const seed of seeds.filter((_, i) => i % parts === part)) {
  const { moves, won } = await computerGame(+suits, seed, async position => nextMoves(position));
  console.log(`seed ${seed} won ${+won} moves ${moves.length}`);
}
