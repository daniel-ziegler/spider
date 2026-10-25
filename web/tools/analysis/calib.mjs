// How well the analysis's network does on games of the player it was trained
// on: node calib.mjs SUITS [FIRST_SEED] [GAMES]. For each game of the line
// player (analysisConfig) it values what the analysis would, and prints the
// means, over the stretches of all games, of the network's "moves" part
// (commit - start) and "cards" part (end - commit), with no bias taken out.
// The player is the one the network predicts, and luck is fair, so both
// should be near zero if the kinds of position (ordinary, a turned card not
// yet known, a deal's ten cards not yet known) are valued consistently.
// What is left of the cards part is BIAS in analysis-core.js, with its sign
// changed; for the deals it is also measured with less noise, as the value
// with the cards unknown less the mean value over sixteen deals of the
// unseen cards. Also the value at the deal against the games won, the value
// where a lost game stopped (which should be 0), and the dips: how far the
// value falls inside a stretch below both its start and its end before the
// cards show (the player's own line, so it should not), as a mean over the
// stretches of two moves or more and as the share of them where it is more
// than three points.
import { readFileSync } from 'node:fs';
import { Game, NUM_COLS, runLen, rankOf } from '../../static/game.js';
import { analysisConfig, makeState, playOut } from '../../static/lineplayer.js';
import { Net, encode } from '../../static/vnet.js';
import { prepare, stretchValues } from '../../static/analysis-core.js';

const [suits = 4, first = 80001, games = 20] = process.argv.slice(2).map(Number);
const bytes = readFileSync(new URL('../../static/nets/value.bin', import.meta.url));
const net = new Net(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), suits);
const config = analysisConfig(suits);
const sum = { turn: [0, 0, 0], deal: [0, 0, 0], end: [0, 0, 0] };
let won = 0, p0 = 0, stopped = 0, dips = 0, deep = 0, long = 0, positions = 0, ms = 0, dealt = 0, deals = 0;
const SAMPLES = 16, UNKNOWN = 255;

// The mean value over deals of ten of the unseen cards from the position `before`.
function sampled(before, below) {
  const unseen = [...before.stock, ...before.columns.flatMap((col, c) => col.slice(0, before.faceDown[c]))];
  let sum = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let k = 0; k < NUM_COLS; k++) {
      const r = k + Math.floor(below() * (unseen.length - k));
      [unseen[k], unseen[r]] = [unseen[r], unseen[k]];
    }
    const faceDown = [...before.faceDown];
    let completed = before.completed.length;
    const columns = before.columns.map((col, c) => {
      const out = [...col, unseen[c]];
      if (rankOf(unseen[c]) === 0 && runLen(out, faceDown[c]) >= 13) {
        out.length -= 13;
        completed++;
        if (out.length && faceDown[c] === out.length) out[--faceDown[c]] = UNKNOWN;
      }
      return out;
    });
    sum += net.winProb(encode(columns, faceDown, before.stock.length / NUM_COLS - 1, completed));
  }
  return sum / SAMPLES;
}
let rs = 12345;
const below = () => { rs = (Math.imul(rs, 1103515245) + 12345) | 0; return (rs >>> 8) / 16777216; };
for (let seed = first; seed < first + games; seed++) {
  const g = new Game(suits, seed), moves = [];
  const r = playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), config, moves);
  const data = prepare(suits, seed, moves), t0 = performance.now();
  const values = new Map(data.jobs.map(j => [j.key, net.winProb(j.enc)]));
  ms += performance.now() - t0;
  positions += data.jobs.length;
  won += r.won;
  p0 += values.get('p0');
  for (const st of data.stretches) {
    const v = stretchValues(st, values, false, moves.length), s = sum[st.shows || 'end'];
    s[0]++;
    s[1] += v.play;
    s[2] += v.luck;
    if (st.shows === 'deal') {
      deals++;
      dealt += v.commit - sampled(data.snaps[st.to - 1], below);
    }
    if (st.to - st.from < 2) continue;
    let low = 1;
    for (let t = st.from + 1; t < st.to; t++) low = Math.min(low, values.get(`p${t}`));
    const dip = Math.max(0, Math.min(v.start, v.commit) - low);
    long++;
    dips += dip;
    if (dip > 0.03) deep++;
  }
  // The value where the player stopped (a lost game should be near 0, a won one is not valued).
  if (!r.won) stopped += values.get(`p${moves.length}`);
}
console.log(`${suits} suits, ${games} games: won ${won}, mean value at the deal ${(p0 / games).toFixed(3)}, mean value where a lost game stopped ${(stopped / Math.max(1, games - won)).toFixed(3)}, ${(ms / positions).toFixed(1)} ms a position (${Math.round(positions / games)} a game)`);
for (const [k, [n, play, luck]] of Object.entries(sum)) console.log(`  stretches ending with ${k}: ${n}, mean moves part ${(100 * play / n).toFixed(2)} points, mean cards part ${(100 * luck / n).toFixed(2)} points`);
console.log(`  a deal not yet known less the mean of ${SAMPLES} deals: ${(100 * dealt / deals).toFixed(2)} points`);
console.log(`  dips inside ${long} stretches: mean ${(100 * dips / long).toFixed(2)} points, over three points in ${(100 * deep / long).toFixed(1)}%`);
