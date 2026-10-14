// How well the analysis's network does on games of the player it was trained
// on: node calib.mjs SUITS [FIRST_SEED] [GAMES]. For each game of the line
// player it values what the analysis would, and prints the means, over the
// stretches of all games, of the network's "moves" part (commit - start) and
// "cards" part (end - commit). The player is the one the network predicts,
// and luck is fair, so both should be near zero if the three kinds of
// position (ordinary, a turned card unknown, a sampled deal) are valued
// consistently. Also the value at the deal against the games won.
import { readFileSync } from 'node:fs';
import { Game } from '../../static/game.js';
import { fastConfig, makeState, playOut } from '../../static/lineplayer.js';
import { Net } from '../../static/vnet.js';
import { prepare, stretchValues } from '../../static/analysis-core.js';

const [suits = 4, first = 80001, games = 20] = process.argv.slice(2).map(Number);
const bytes = readFileSync(new URL(`../../static/nets/v${suits}.bin`, import.meta.url));
const net = new Net(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const sum = { turn: [0, 0, 0], deal: [0, 0, 0], end: [0, 0, 0] };
let won = 0, p0 = 0, brier = 0;
for (let seed = first; seed < first + games; seed++) {
  const g = new Game(suits, seed), moves = [];
  const r = playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), fastConfig(suits), moves);
  const data = prepare(suits, seed, moves), values = new Map(data.jobs.map(j => [j.key, net.winProb(j.enc)]));
  won += r.won;
  p0 += values.get('p0');
  for (const st of data.stretches) {
    const v = stretchValues(st, values, false, moves.length), s = sum[st.shows || 'end'];
    s[0]++;
    s[1] += v.play;
    s[2] += v.luck;
  }
  // The value where the player stopped (a lost game should be near 0, a won one is not valued).
  if (!r.won) brier += values.get(`p${moves.length}`);
}
console.log(`${suits} suits, ${games} games: won ${won}, mean value at the deal ${(p0 / games).toFixed(3)}, mean value where a lost game stopped ${(brier / Math.max(1, games - won)).toFixed(3)}`);
for (const [k, [n, play, luck]] of Object.entries(sum)) console.log(`  stretches ending with ${k}: ${n}, mean moves part ${(100 * play / n).toFixed(2)} points, mean cards part ${(100 * luck / n).toFixed(2)} points`);
