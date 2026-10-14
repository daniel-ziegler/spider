// What the analysis of a finished game (analysis.js) works out, apart from the
// drawing and the workers.
//
// The game analysed is one line of moves from the deal. A move that shows
// cards (turns one over, or deals) ends a *stretch*: between two such moves
// the player learns nothing, so whatever the moves of a stretch change is the
// player's doing, and what the cards shown change is luck. Every position gets
// a value from the network (vnet.js: the chance that the line player goes on
// to win, by the cards face up), and a stretch three: at its start, after its
// moves with the cards they show not yet known, and with them known. The
// stretches where the value falls most are then measured by playing games out
// (analysis-worker.js).
import { Game, NUM_COLS, runLen, rankOf } from './game.js';
import { encode } from './vnet.js';

export const DEAL_SAMPLES = 16; // deals sampled to value a deal before its cards are known
const UNKNOWN = 255;

function random(seed) {
  let a = seed | 0;
  return n => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * n);
  };
}

// The position as the board draws it (see render in app.js) and as it is valued.
function snapshot(g) {
  const faceDown = [...g.faceDown], stock = [...g.stock];
  return { columns: g.columns.map(c => [...c]), faceDown, seen: faceDown, completed: [...g.completed], stock, dealsRemaining: () => stock.length / NUM_COLS };
}

const encodeSnap = s => encode(s.columns, s.faceDown, s.stock.length / NUM_COLS, s.completed.length);

// Replays the moves ({from, to, count} or {deal: true}) of a deal. Returns
//   snaps     the position after 0, 1, ... moves;
//   shows     for each move, whether it shows cards ('deal', 'turn' or null);
//   stretches {from, to, shows}: the moves from..to-1, the last showing cards (but perhaps for the last stretch);
//   jobs      what the network is to value: {key, enc}, the key being
//             'p' + t for the position after t moves, 'u' + t for it with the
//             cards move t turned unknown, 'd' + t + '/' + j for the jth sampled deal at move t.
export function prepare(suits, seed, moves) {
  const g = new Game(suits, seed);
  const snaps = [snapshot(g)], shows = [], stretches = [], jobs = [{ key: 'p0', enc: encodeSnap(snaps[0]) }];
  let from = 0;
  moves.forEach((mv, i) => {
    if (g.check(mv)) throw new Error('an illegal move');
    const before = snaps[i], rec = g.applyRaw(mv), s = snapshot(g), t = i + 1;
    snaps.push(s);
    const show = mv.deal ? 'deal' : rec.flips.length ? 'turn' : null;
    shows.push(show);
    jobs.push({ key: `p${t}`, enc: encodeSnap(s) });
    if (show === 'turn') {
      // The cards turned are those face down before and not now; they do not move.
      const columns = s.columns.map((col, c) => col.map((card, j) => (j >= s.faceDown[c] && j < before.faceDown[c] ? UNKNOWN : card)));
      jobs.push({ key: `u${t}`, enc: encode(columns, s.faceDown, s.stock.length / NUM_COLS, s.completed.length) });
    } else if (show === 'deal') {
      // Deals of ten of the cards not yet seen.
      const unseen = [...before.stock, ...before.columns.flatMap((col, c) => col.slice(0, before.faceDown[c]))];
      const below = random(Math.imul(t, 0x9E3779B1) ^ Number(BigInt(seed) & 0xFFFFFFFFn));
      for (let j = 0; j < DEAL_SAMPLES; j++) {
        for (let k = 0; k < NUM_COLS; k++) {
          const r = k + below(unseen.length - k);
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
        jobs.push({ key: `d${t}/${j}`, enc: encode(columns, faceDown, before.stock.length / NUM_COLS - 1, completed) });
      }
    }
    if (show || t === moves.length) {
      stretches.push({ from, to: t, shows: show });
      from = t;
    }
  });
  return { snaps, shows, stretches, jobs, won: g.isWon() };
}

// The network's three values of a stretch, once it has valued everything
// (`values`: key -> probability; a won game is worth 1 whatever it says):
// {start, commit, end, play: commit - start, luck: end - commit}.
export function stretchValues(st, values, won, last) {
  const p = t => (won && t === last ? 1 : values.get(`p${t}`));
  const start = p(st.from), end = p(st.to);
  let commit = end;
  if (st.shows === 'turn') commit = values.get(`u${st.to}`);
  else if (st.shows === 'deal') {
    commit = 0;
    for (let j = 0; j < DEAL_SAMPLES; j++) commit += values.get(`d${st.to}/${j}`) / DEAL_SAMPLES;
  }
  return { start, commit, end, play: commit - start, luck: end - commit };
}

// The stretches to play games out for: those where the value falls most,
// or where the network puts the most down to the moves; at most `most`, each
// by at least `least`. Returns indices, in the order of the game. A stretch
// marked `same` (its moves are the line player's own, so they cost nothing by
// the measure used: the network's difference there is its error) counts only
// by what its cards did.
export function keyStretches(vals, most = 6, least = 0.04) {
  return vals.map((v, i) => [v.same ? -v.luck : Math.max(v.start - v.end, -v.play), i])
    .filter(([drop]) => drop >= least)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, most)
    .map(([, i]) => i)
    .sort((a, b) => a - b);
}

// What the games played out say (a byte a world, see analysis-worker.js):
// the three win rates, what the moves cost (play = commit - pre) and what the
// cards did (luck = reveal - commit), each with its standard error. The
// differences are of games in the same worlds, so their errors are those of
// paired samples.
export function rollStats(bytes) {
  const n = bytes.length, bit = (b, k) => (b >> k) & 1;
  const mean = f => { let s = 0; for (const b of bytes) s += f(b); return s / n; };
  const se = (f, m) => { let s = 0; for (const b of bytes) s += (f(b) - m) ** 2; return n > 1 ? Math.sqrt(s / (n - 1) / n) : NaN; };
  const stat = f => { const m = mean(f); return { mean: m, se: se(f, m) }; };
  return {
    n, pre: stat(b => bit(b, 0)), commit: stat(b => bit(b, 1)), reveal: stat(b => bit(b, 2)),
    play: stat(b => bit(b, 1) - bit(b, 0)), luck: stat(b => bit(b, 2) - bit(b, 1)),
  };
}

// What to call a key stretch, from its games: a part counts if it is at
// least two points and twice its standard error.
export function verdict(stats) {
  const sure = s => Math.abs(s.mean) >= 0.02 && Math.abs(s.mean) > 2 * s.se;
  const play = sure(stats.play) ? Math.sign(stats.play.mean) : 0, luck = sure(stats.luck) ? Math.sign(stats.luck.mean) : 0;
  if (play < 0 && luck < 0) return 'Mistake and bad luck';
  if (play < 0) return luck > 0 ? 'Mistake, good luck' : 'Mistake';
  if (luck < 0) return play > 0 ? 'Good play, bad luck' : 'Bad luck';
  if (play > 0 && luck > 0) return 'Good play and good luck';
  if (play > 0) return 'Good play';
  if (luck > 0) return 'Good luck';
  return 'Too close to call';
}
