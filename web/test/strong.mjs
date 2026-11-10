// Checks the stronger player (static/strong.js over the WebAssembly engine's
// part, ../wasm/src/strong.rs): that `choose` picks as it should on worth made
// up for it, and that the games it plays are legal, the same each time, and
// the very games ../wasm's `strong` plays natively with the same settings
// (the hashes below are its: `S_MOST=3 S_PER_COL=1 S_FIRST=4 S_MAX=8
// S_ZKEEP=0 S_STOP=3 cargo run --release --bin strong -- 4 70001 1`, and
// `S_MOST=2 S_PER_COL=1 S_FIRST=2 S_MAX=4 S_ZKEEP=0 S_STOP=0` for `1 70002
// 1`). It fails by
// throwing. `cargo test` in web/ runs this.
import { readFileSync } from 'node:fs';
import { Game } from '../static/game.js';
import { strong, useEngine, useNet } from '../static/analysis-worker.js';
import { choose, strongGame, strongParams } from '../static/strong.js';
import { loadWasm } from '../static/wasm.js';

const check = (ok, what) => { if (!ok) throw new Error(what); };
const file = name => { const b = readFileSync(new URL(name, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// choose: worth[c](w) is choice c's worth in world w.
const pick = (worth, p) => {
  let played = 0;
  return choose(worth.length, { first: 4, max: 16, zDrop: 2, zKeep: 0, ...p }, async (c, from, to) => { played += to - from; return Array.from({ length: to - from }, (_, i) => worth[c](from + i)); }).then(at => [at, played]);
};
const noisy = w => ((w * 7919) % 13) / 100;
check((await pick([() => 0.5], {}))[0] === 0, 'one choice is the choice');
check((await pick([w => 0.4 + noisy(w), w => 0.6 + noisy(w), w => 0.2 + noisy(w)], {})).join() === '1,12', 'the best is picked, and the others dropped after the first worlds');
check((await pick([w => 0.5 + noisy(w), w => 0.5 + noisy(w)], {})).join() === '0,8', 'of two the same the first is kept');
const sway = w => (w % 2 ? -0.05 : 0.05);
check((await pick([w => 0.5 + noisy(w), w => 0.5 + noisy(w) + sway(w)], {})).join() === '0,32', 'two that cannot be told apart are played in every world, and the first kept');
check((await pick([w => 0.5 + noisy(w), w => 0.501 + noisy(w) + sway(w)], {}))[0] === 1, 'the best by ever so little is played');
check((await pick([w => 0.5 + noisy(w), w => 0.501 + noisy(w) + sway(w)], { zKeep: 2 }))[0] === 0, 'unless the line player\'s own is to be kept until another is surely better');

const wasm = await loadWasm(file('../static/spider.wasm'));
useEngine(wasm);
const hashOf = moves => moves.flatMap(mv => (mv.deal ? [255, 255, 255] : [mv.from, mv.to, mv.count])).reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811C9DC5).toString(16).padStart(8, '0');
const t0 = performance.now();
for (const [suits, seed, over, hash, changed] of [
  [4, 70001, { most: 3, perCol: 1, first: 4, max: 8, zKeep: 0, stop: 3 }, 'b39173ec', 8],
  [1, 70002, { most: 2, perCol: 1, first: 2, max: 4, zKeep: 0, stop: 0 }, '5fecfdfd', 0],
]) {
  useNet(wasm.net(file('../static/nets/value.bin'), suits));
  const params = { ...strongParams(suits), ...over };
  const game = await strongGame(suits, seed, async job => strong(job), { params });
  const g = new Game(suits, seed);
  for (const mv of game.moves) {
    check(!g.check(mv), `${suits}/${seed}: an illegal move`);
    g.applyRaw(mv);
  }
  check(g.isWon() === game.won, `${suits}/${seed}: won or not`);
  check(game.changed === changed, `${suits}/${seed}: ${game.changed} choices not the line player's, not ${changed}`);
  check(hashOf(game.moves) === hash, `${suits}/${seed}: not the game the native player plays (${hashOf(game.moves)})`);
}
console.log(`ok (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
