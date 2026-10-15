// What the analysis of a finished game (analysis.js) works out, apart from the
// drawing and the workers.
//
// The game analysed is one line of moves from the deal. A move that shows
// cards (turns one over, or deals) ends a *stretch*: between two such moves
// the player learns nothing, so whatever the moves of a stretch change is the
// player's doing, and what the cards shown change is luck. Every position gets
// a value from the network (vnet.js: the chance that the line player goes on
// to win, by the cards face up), and a stretch three: at its start, after its
// moves with the cards they show not yet known, and with them known: the
// curve. The mistakes are found by playing games out (below).
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

// Two things the networks get wrong on average, measured on the line
// player's own games (tools/analysis/calib.mjs, 24 games for each number of
// suits), where neither should be there. A position with a turned card
// unknown is valued higher than it is on average with the card known, by
// BIAS[suits][0]. And the value climbs between deals and falls at each: a
// position the player is about to deal from is too high by BIAS[suits][1],
// since the network cannot tell that nothing is left to do.
const BIAS = { 1: [0.010, 0.049], 2: [0.018, 0.103], 3: [0.016, 0.107], 4: [0.016, 0.069] };

// The network's three values of a stretch, once it has valued everything
// (`values`: key -> probability; a won game is worth 1 whatever it says):
// {start, commit, end, play: commit - start, luck: end - commit, bias}. With
// `suits` given, the first bias is taken out of commit; bias is what play is
// too low by on average (the second bias, for a stretch ending in a deal).
export function stretchValues(st, values, won, last, suits = 0) {
  const p = t => (won && t === last ? 1 : values.get(`p${t}`));
  const start = p(st.from), end = p(st.to), [turned, dealing] = BIAS[suits] ?? [0, 0];
  let commit = end;
  if (st.shows === 'turn') commit = Math.max(0, values.get(`u${st.to}`) - turned);
  else if (st.shows === 'deal') {
    commit = 0;
    for (let j = 0; j < DEAL_SAMPLES; j++) commit += values.get(`d${st.to}/${j}`) / DEAL_SAMPLES;
  }
  return { start, commit, end, play: commit - start, luck: end - commit, bias: st.shows === 'deal' ? dealing : 0 };
}

// ---------------------------------------------------------------- mistakes
//
// A mistake is a move after which the line player wins less often than it
// would have from the position before it, by games played out in shuffles of
// the cards the player had not seen (analysis-worker.js: the same shuffles
// for both, so that the difference is far less noisy than the two rates).
// The network is not asked: its error from one position to the next is as
// large as most mistakes. Every stretch whose moves are not, in effect, the
// line player's own (track, in the worker) is a candidate, and the games are
// shared out among them in rounds: a few worlds for each first, then more
// and more for those that still look most like mistakes, until the games run
// out. Only what is then surely a loss is called a mistake.
//
// The numbers are in games played out, since the time is theirs: `games` for
// finding the mistakes (and `extra` where some are nearly found), at most
// `most` * 2 * `pin` more for putting each to a move, and 2 * `luck` for the
// cards' biggest swing.
export const SEARCH = {
  games: 4400, // games played out to find the mistakes
  extra: 1600, // more of them, only for candidates that are then close to being surely mistakes
  round: 16, // worlds in a piece of work, and for each candidate at first
  group: 6, // candidates given more worlds in a round (as many again as each has)
  cap: 512, // worlds for a candidate at most
  least: 256, // worlds a mistake needs behind it
  cost: 0.05, // a mistake costs at least this much of the chance of winning
  z: 2.5, // and is this many standard errors from costing nothing
  most: 5, // mistakes shown
  pin: 256, // worlds for putting a mistake to one move of its stretch
  luck: 128, // worlds for the cards' biggest swing
};

// Games in the same worlds compared: `a` and `b` have for each world 1 (won),
// 0 or -1 (not played). {n, a, b, mean, se}: over the first `most` worlds
// that have both, the two rates, and b - a with its standard error (never
// taken for less than one game's difference would make it).
export function paired(a, b, most = Infinity) {
  let n = 0, sa = 0, sb = 0, sd = 0, sq = 0;
  for (let w = 0; w < a.length && w < most; w++) {
    if (a[w] < 0 || b[w] < 0) continue;
    const d = b[w] - a[w];
    n++; sa += a[w]; sb += b[w]; sd += d; sq += d * d;
  }
  if (!n) return { n: 0, a: NaN, b: NaN, mean: 0, se: Infinity };
  const mean = sd / n, se = n > 1 ? Math.sqrt(Math.max(0, sq - n * mean * mean) / (n - 1) / n) : 1;
  return { n, a: sa / n, b: sb / n, mean, se: Math.max(se, 1 / n) };
}

// Whether a difference is surely a loss, and whether it can no longer be found one.
export const isMistake = (d, opt = SEARCH, least = opt.least) => d.n >= least && d.mean <= -opt.cost && d.mean + opt.z * d.se <= 0;
// (The second: with all its worlds played its standard error would be some
// se * sqrt(n / cap), and its mean would have to move two standard errors of
// what is still to come to be a mistake then.)
export function hopeless(d, opt = SEARCH) {
  if (d.n < 2 * opt.round) return false;
  if (d.n >= opt.cap) return !isMistake(d, opt);
  const share = d.n / opt.cap;
  return d.mean - 2 * d.se * Math.sqrt(1 - share) > -Math.max(opt.cost, opt.z * d.se * Math.sqrt(share));
}

// The next round: `stats` are the candidates' differences so far (paired),
// `left` the games that may still be played. Returns [[candidate, worlds
// more], ...]: at first the first worlds for all, then as many again for the
// `group` candidates that look worst (by their mean less one standard error)
// among those not yet settled (surely a mistake, or surely not one to be
// found); nothing when all are settled or the games are spent. With `close`
// only those count that are nearly mistakes already: a loss of `cost`, one
// and a half standard errors from nothing, in 64 worlds or more.
export function nextRound(stats, left, opt = SEARCH, close = false) {
  const out = [];
  const give = (i, more) => {
    more = Math.min(more, Math.floor(left / 2 / opt.round) * opt.round);
    if (more > 0) { out.push([i, more]); left -= 2 * more; }
  };
  if (stats.some(d => !d.n)) stats.forEach((d, i) => { if (!d.n) give(i, opt.round); });
  else {
    stats.map((d, i) => [d.mean - d.se, i])
      .filter(([, i]) => !hopeless(stats[i], opt) && !isMistake(stats[i], opt) && stats[i].n < opt.cap)
      .filter(([, i]) => !close || (stats[i].n >= 64 && stats[i].mean <= -opt.cost && stats[i].mean + 1.5 * stats[i].se <= 0))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, opt.group)
      .forEach(([, i]) => give(i, Math.min(stats[i].n, opt.cap - stats[i].n)));
  }
  return out;
}

// Find the mistakes of a game. `stretches` are those of prepare, `cuts[i]`
// what the worker's track says of stretch i (null: not to be played out),
// `job(i)` the roll's position and moves for stretch i (see the worker), and
// roll(job) plays games out: a promise of the bytes. `update` is called as
// results come in, with the candidates so far.
//
// Returns the mistakes, the costliest first, each
//   {at, move, line, exact, n, better, yours, cost: {mean, se}}
// stretch `at`; the move numbered `move` in the game (1 is the first) was
// the mistake, `line` what the line player would have played in its place up
// to its first move that shows cards; `better` and `yours` are the line
// player's rates of winning from before the move and from after it (with
// `exact`), or, where no one move of the stretch is surely the loss, from
// before it and from the end of the stretch.
//
// A stretch's games: each world is played from the stretch's start (the line
// player choosing: bit 0) and from its end (bit 1). The moves between two
// departures from the line player's line are all worth what the first of
// them is, so a stretch with several is cut in two at a departure in its
// middle, games are played from there in the same worlds, and the half that
// lost more is cut again.
export async function findMistakes({ stretches, cuts, job, roll, update = () => {}, opt = SEARCH }) {
  const cands = stretches.flatMap((st, at) => (cuts[at]?.length ? [{ at, st, cuts: cuts[at], wins: new Map(), n: 0, stat: paired([], []), state: 'open' }] : []));
  let spent = 0;
  // Games from after `upto` moves of a candidate's stretch, in its first n worlds.
  const play = async (c, uptos, n) => {
    for (const u of uptos) if (!c.wins.has(u)) c.wins.set(u, new Int8Array(opt.cap).fill(-1));
    const from = Math.min(...uptos.map(u => { const w = c.wins.get(u); let k = 0; while (k < n && w[k] >= 0) k++; return k; }));
    const work = [];
    for (let w = from; w < n; w += opt.round) {
      const to = Math.min(n, w + opt.round);
      work.push(roll({ ...job(c.at), from: w, to, at: uptos }).then(bytes => {
        uptos.forEach((u, i) => { const wins = c.wins.get(u); bytes.forEach((b, k) => { wins[w + k] = (b >> i) & 1; }); });
        spent += uptos.length * (to - w);
        c.stat = paired(c.wins.get(0), c.wins.get(c.st.to - c.st.from) ?? []);
        update(cands, spent);
      }));
    }
    await Promise.all(work);
  };
  for (;;) {
    const stats = cands.map(c => c.stat);
    let round = nextRound(stats, opt.games - spent, opt);
    if (!round.length) round = nextRound(stats, opt.games + opt.extra - spent, opt, true);
    if (!round.length) break;
    await Promise.all(round.map(([i, more]) => {
      const c = cands[i];
      c.n += more;
      return play(c, [0, c.st.to - c.st.from], c.n);
    }));
    for (const c of cands) c.state = isMistake(c.stat, opt) ? 'mistake' : hopeless(c.stat, opt) ? 'out' : 'open';
    update(cands, spent);
  }
  const found = cands.filter(c => isMistake(c.stat, opt)).sort((a, b) => a.stat.mean - b.stat.mean).slice(0, opt.most);
  for (const c of cands) if (!found.includes(c)) c.state = 'out';
  update(cands, spent);
  return (await Promise.all(found.map(async c => {
    const len = c.st.to - c.st.from, n = Math.min(c.n, opt.pin);
    const ends = [0, ...c.cuts.slice(0, -1).map(cut => cut.at), len]; // games from after ends[i] moves: what the stretch is worth after its first i departures
    let lo = 0, hi = c.cuts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      await play(c, [ends[mid]], n);
      const w = k => c.wins.get(ends[k]);
      if (paired(w(lo), w(mid), n).mean <= paired(w(mid), w(hi), n).mean) hi = mid;
      else lo = mid;
    }
    let cut = c.cuts[lo], d = paired(c.wins.get(ends[lo]), c.wins.get(ends[hi]), c.cuts.length > 1 ? n : Infinity);
    const exact = isMistake(d, opt, Math.min(n, opt.least));
    if (!exact) { cut = c.cuts[0]; d = c.stat; }
    c.found = { at: c.at, move: c.st.from + cut.at, line: cut.line, exact, n: d.n, better: d.a, yours: d.b, cost: { mean: d.mean, se: d.se } };
    update(cands, spent);
    return c.found;
  }))).filter(m => m.line.length).sort((a, b) => a.cost.mean - b.cost.mean);
}

// What the cards shown by a stretch did, by games played out after its moves
// with the world's cards coming up and with the real ones: the difference (paired).
export async function measureLuck({ st, job, roll, opt = SEARCH }) {
  const len = st.to - st.from, a = new Int8Array(opt.luck), b = new Int8Array(opt.luck);
  const work = [];
  for (let w = 0; w < opt.luck; w += opt.round) {
    work.push(roll({ ...job, from: w, to: w + opt.round, at: [len], reveal: true }).then(bytes => bytes.forEach((x, k) => { a[w + k] = x & 1; b[w + k] = (x >> 1) & 1; })));
  }
  await Promise.all(work);
  return paired(a, b);
}

// The positions of another line from the position after `t` of the game's
// moves: snaps[i] after i of the moves `line`, and shows[i] what move i showed
// ('deal', 'turn' or null) and in which column a card turned.
export function branch(suits, seed, moves, t, line) {
  const g = new Game(suits, seed);
  for (let i = 0; i < t; i++) g.applyRaw(moves[i]);
  const snaps = [snapshot(g)], shows = [];
  for (const mv of line) {
    if (g.check(mv)) break;
    const rec = g.applyRaw(mv);
    snaps.push(snapshot(g));
    shows.push(mv.deal ? { show: 'deal' } : rec.flips.length ? { show: 'turn', col: rec.flips[0] } : { show: null });
  }
  return { snaps, shows };
}
