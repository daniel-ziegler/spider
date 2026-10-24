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
import { Game, NUM_COLS } from './game.js';
import { encode } from './vnet.js';

const UNKNOWN = 255;

// The position as the board draws it (see render in app.js) and as it is valued.
function snapshot(g) {
  const faceDown = [...g.faceDown], stock = [...g.stock];
  return { columns: g.columns.map(c => [...c]), faceDown, seen: faceDown, completed: [...g.completed], stock, dealsRemaining: () => stock.length / NUM_COLS };
}

export const encodeSnap = s => encode(s.columns, s.faceDown, s.stock.length / NUM_COLS, s.completed.length);

// The network's encoding of the position a move that shows cards leads to,
// with what it shows not yet known: `before` and `after` are the positions
// on either side of the move. The cards a move turns are those face down
// before and not after (they do not move); a deal puts an unknown card on
// every column (a suit it completes is not known of either).
export function committed(before, after, deal) {
  if (deal) return encode(before.columns.map(col => [...col, UNKNOWN]), before.faceDown, before.stock.length / NUM_COLS - 1, before.completed.length);
  const columns = after.columns.map((col, c) => col.map((card, j) => (j >= after.faceDown[c] && j < before.faceDown[c] ? UNKNOWN : card)));
  return encode(columns, after.faceDown, after.stock.length / NUM_COLS, after.completed.length);
}

// Replays the moves ({from, to, count} or {deal: true}) of a deal. Returns
//   snaps     the position after 0, 1, ... moves;
//   shows     for each move, whether it shows cards ('deal', 'turn' or null);
//   stretches {from, to, shows}: the moves from..to-1, the last showing cards (but perhaps for the last stretch);
//   jobs      what the network is to value: {key, enc}, the key being
//             'p' + t for the position after t moves, and 'u' + t for it with
//             the cards move t showed (turned, or dealt) not yet known.
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
    if (show) jobs.push({ key: `u${t}`, enc: committed(before, s, !!mv.deal) });
    if (show || t === moves.length) {
      stretches.push({ from, to: t, shows: show });
      from = t;
    }
  });
  return { snaps, shows, stretches, jobs, won: g.isWon() };
}

// What the network gets wrong on average about cards not yet known, measured
// on the line player's own games (tools/analysis/calib.mjs), where the cards
// are fair: BIAS[suits] is how much higher it values a position with a
// turned card unknown than the position is on average with the card known,
// and the same for a deal's ten cards. Measured on 40 games for each number
// of suits they are 0.3, -0.6, -0.5 and -0.6 points for a turned card (about
// two standard errors) and 0.3, 0.2, 0.3 and 0.3 for a deal: nothing worth
// taking out. (The networks before, which had no deal not yet known and
// were not told what the player does next, were one to two points high on a
// turned card and fell five to eleven points at every deal.)
export const BIAS = { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0] };

// The network's three values of a stretch, once it has valued everything
// (`values`: key -> probability; a won game is worth 1 whatever it says):
// {start, commit, end, play: commit - start, luck: end - commit}. With
// `suits` given, the bias is taken out of commit.
export function stretchValues(st, values, won, last, suits = 0) {
  const p = t => (won && t === last ? 1 : values.get(`p${t}`));
  const start = p(st.from), end = p(st.to), [turned, dealt] = BIAS[suits] ?? [0, 0];
  const commit = st.shows ? Math.min(1, Math.max(0, values.get(`u${st.to}`) - (st.shows === 'deal' ? dealt : turned))) : end;
  return { start, commit, end, play: commit - start, luck: end - commit };
}

// ---------------------------------------------------------------- mistakes
//
// A mistake is a move after which the line player wins less often than it
// would have from the position before it, by games played out in shuffles of
// the cards the player had not seen (analysis-worker.js: the same shuffles
// for both, so that the difference is far less noisy than the two rates).
// Every stretch whose moves are not, in effect, the line player's own
// (track, in the worker) is a candidate. There are too many of them (some
// forty in a game of fifty stretches) to play all out as far as it takes to
// be sure, so the network says where to look first: it values the position
// the player's moves came to and the one the line player's own line would
// have come to, both just before their cards show (screen), and the
// candidates are taken in the order of that difference. The first few get
// worlds at once, then round by round more and more go to those that still
// look most like mistakes, and as candidates are settled the next by the
// network's order come in, until the games run out. Only what is then surely
// a loss is called a mistake, and each of those is then played once more in
// worlds not used before: the loss shown is that of those games alone, since
// the games that found it are, taken by themselves, too bad on average (they
// are why it was picked).
//
// The numbers are in games played out, since the time is theirs: `games` for
// finding the mistakes, then for each found at most some 2 * `pin` for
// putting it to a move and 2 * `fresh` for its loss, and 2 * `luck` for the
// cards' biggest swing. Where few mistakes are found, those that may be are
// brought up to `enough` worlds (some two for each place to fill) and put to
// a move as well.
export const SEARCH = {
  games: 2400, // games played out to find the mistakes
  round: 16, // worlds a candidate is given more in at least
  piece: 4, // worlds in a piece of work (small, so that a round's last games are shared out over the workers)
  first: 32, // worlds for a candidate when it comes in
  start: 6, // candidates that come in at once: the worst by the network
  group: 3, // candidates given more worlds in a round (as many again as each has)
  cap: 512, // worlds for a candidate at most
  least: 128, // worlds a mistake needs behind it
  cost: 0.05, // a mistake costs at least this much of the chance of winning
  z: 2.5, // and is this many standard errors from costing nothing
  most: 4, // mistakes shown
  pin: 128, // worlds for putting a mistake to one move of its stretch
  fresh: 128, // worlds, not used before, for the loss shown
  spread: 0.1, // a loss not put to one move is shown only if it is this large
  luck: 128, // worlds for the cards' biggest swing
  shown: 3, // with fewer mistakes than this, the list is filled up with what may be mistakes
  maybe: 0.02, // which is what lost this much in its games, however unsurely,
  enough: 128, // in this many worlds at least
};

// What the network is to value besides the game's own positions, to say
// which candidates to look at first: for each stretch that leaves the line
// player's line (`cuts` are the worker's tracks), the position that line
// would have come to from the first departure, just before its cards show.
// Returns [{at, enc, shows}] (none for a stretch where the line player has
// nothing to play; shows: 'turn', 'deal' or null, what the line's last move
// does).
export function screenJobs(suits, seed, moves, stretches, cuts) {
  const out = [];
  stretches.forEach((st, at) => {
    const cut = cuts[at]?.[0];
    if (!cut?.line.length) return;
    const { snaps, shows } = branch(suits, seed, moves, st.from + cut.at - 1, cut.line), n = snaps.length - 1;
    if (n < 1) return;
    const show = shows[n - 1].show;
    out.push({ at, enc: show ? committed(snaps[n - 1], snaps[n], show === 'deal') : encodeSnap(snaps[n]), shows: show });
  });
  return out;
}

// What the network makes each stretch cost: the value of where the player's
// moves came to less that of where the line player's would have (`theirs`:
// stretch -> {value, shows}, of screenJobs' positions), both with the cards
// about to show not yet known, so that what the network gets wrong about
// such positions is on both sides (and where one line ends with a deal and
// the other with a card turned, what it gets wrong on average about each,
// BIAS, is taken out). 0 where there is nothing to compare; and the end of a
// game not won comes first whatever the network says (it is where the game
// was given up).
export function screen(stretches, values, theirs, won, last, suits = 0) {
  const off = shows => (shows ? (BIAS[suits] ?? [0, 0])[shows === 'deal' ? 1 : 0] : 0);
  return stretches.map((st, at) => {
    if (!won && !st.shows && st.to === last) return -1;
    const bot = theirs.get(at);
    if (!bot) return 0;
    const mine = st.shows ? values.get(`u${st.to}`) : won && st.to === last ? 1 : values.get(`p${st.to}`);
    return mine - off(st.shows) - (bot.value - off(bot.shows));
  });
}

// Games in the same worlds compared: `a` and `b` have for each world 1 (won),
// 0 or -1 (not played). {n, a, b, mean, se}: over the worlds from `from` up
// to `to` that have both, the two rates, and b - a with its standard error
// (never taken for less than one game's difference would make it).
export function paired(a, b, to = Infinity, from = 0) {
  let n = 0, sa = 0, sb = 0, sd = 0, sq = 0;
  for (let w = from; w < a.length && w < to; w++) {
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
  if (d.n < opt.first) return false;
  if (d.n >= opt.cap) return !isMistake(d, opt);
  const share = d.n / opt.cap;
  return d.mean - 2 * d.se * Math.sqrt(1 - share) > -Math.max(opt.cost, opt.z * d.se * Math.sqrt(share));
}

// The next round: `stats` are the candidates' differences so far (paired; no
// worlds yet for one that has not come in), `order` the candidates in the
// order they are to come in, `left` the games that may still be played.
// Returns [[candidate, worlds more], ...]: at first the first worlds for the
// `start` first candidates; then as many worlds again for the `group`
// candidates that look worst (by their mean less one standard error) among
// those in and not yet settled (surely a mistake, or surely not one to be
// found), and where there are fewer of those than `group`, the first worlds
// for the next to come in. Nothing when all are settled or the games are
// spent.
export function nextRound(stats, order, left, opt = SEARCH) {
  const out = [];
  const give = (i, more) => {
    more = Math.min(more, Math.floor(left / 2 / opt.round) * opt.round);
    if (more > 0) { out.push([i, more]); left -= 2 * more; }
  };
  const waiting = order.filter(i => !stats[i].n);
  if (waiting.length === order.length) waiting.slice(0, opt.start).forEach(i => give(i, opt.first));
  else {
    const open = order.filter(i => stats[i].n && stats[i].n < opt.cap && !hopeless(stats[i], opt) && !isMistake(stats[i], opt))
      .sort((a, b) => stats[a].mean - stats[a].se - stats[b].mean + stats[b].se || a - b)
      .slice(0, opt.group);
    open.forEach(i => give(i, Math.min(stats[i].n, opt.cap - stats[i].n)));
    waiting.slice(0, opt.group - open.length).forEach(i => give(i, opt.first));
  }
  return out;
}

// Find the mistakes of a game. `stretches` are those of prepare, `cuts[i]`
// what the worker's track says of stretch i (null: not to be played out),
// `prior[i]` what the network makes stretch i cost (screen; without it the
// candidates come in as they are in the game), `job(i)` the roll's position
// and moves for stretch i (see the worker), and roll(job) plays games out: a
// promise of the bytes. `update` is called as results come in, with the
// candidates so far.
//
// Returns the mistakes, the costliest first, each
//   {at, move, line, exact, unsure, n, better, yours, cost: {mean, se}}
// stretch `at`; the move numbered `move` in the game (1 is the first) was
// the mistake, `line` what the line player would have played in its place up
// to its first move that shows cards; `better` and `yours` are the line
// player's rates of winning from before the move and from after it (with
// `exact`), or, where no one move of the stretch is surely the loss, from
// before it and from the end of the stretch: in `n` worlds not played
// before, as is the cost. After them, where they are fewer than `shown`,
// come those that may be mistakes, `unsure` (see likeliest).
//
// A stretch's games: each world is played from the stretch's start (the line
// player choosing: bit 0) and from its end (bit 1). The moves between two
// departures from the line player's line are all worth what the first of
// them is, so a stretch with several is cut in two at a departure in its
// middle, games are played from there in the same worlds, and the half that
// lost more is cut again. A loss that cannot be put to one move so is shown
// only if it is large (`spread`): a small one over many moves says nothing
// the player can use.
export async function findMistakes({ stretches, cuts, prior = null, job, roll, update = () => {}, opt = SEARCH }) {
  const cands = stretches.flatMap((st, at) => (cuts[at]?.length ? [{ at, st, cuts: cuts[at], prior: prior?.[at] ?? 0, wins: new Map(), n: 0, stat: paired([], []), state: 'wait' }] : []));
  const order = cands.map((c, i) => i).sort((a, b) => cands[a].prior - cands[b].prior || a - b);
  let spent = 0;
  // Games from after `upto` moves of a candidate's stretch, in its worlds from `from` up to n.
  const play = async (c, uptos, n, from = 0) => {
    for (const u of uptos) if (!c.wins.has(u)) c.wins.set(u, new Int8Array(opt.cap + opt.fresh).fill(-1));
    from = Math.min(...uptos.map(u => { const w = c.wins.get(u); let k = from; while (k < n && w[k] >= 0) k++; return k; }));
    const work = [];
    for (let w = from; w < n; w += opt.piece) {
      const to = Math.min(n, w + opt.piece);
      work.push(roll({ ...job(c.at), from: w, to, at: uptos }).then(bytes => {
        uptos.forEach((u, i) => { const wins = c.wins.get(u); bytes.forEach((b, k) => { wins[w + k] = (b >> i) & 1; }); });
        spent += uptos.length * (to - w);
        c.stat = paired(c.wins.get(0), c.wins.get(c.st.to - c.st.from) ?? [], opt.cap);
        update(cands, spent);
      }));
    }
    await Promise.all(work);
  };
  for (;;) {
    const round = nextRound(cands.map(c => c.stat), order, opt.games - spent, opt);
    if (!round.length) break;
    await Promise.all(round.map(([i, more]) => {
      const c = cands[i];
      c.n += more;
      return play(c, [0, c.st.to - c.st.from], c.n);
    }));
    for (const c of cands) c.state = !c.n ? 'wait' : isMistake(c.stat, opt) ? 'mistake' : hopeless(c.stat, opt) ? 'out' : 'open';
    update(cands, spent);
  }
  const found = cands.filter(c => isMistake(c.stat, opt)).sort((a, b) => a.stat.mean - b.stat.mean).slice(0, opt.most);
  for (const c of cands) if (!found.includes(c)) c.state = 'out';
  update(cands, spent);
  // The departure of a candidate's stretch that lost most, by cutting in two:
  // {ends, lo, hi}, the games from after ends[lo] and ends[hi] moves being those before and after it.
  const cut = async (c, n) => {
    const len = c.st.to - c.st.from;
    const ends = [0, ...c.cuts.slice(0, -1).map(x => x.at), len]; // games from after ends[i] moves: what the stretch is worth after its first i departures
    let lo = 0, hi = c.cuts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      await play(c, [ends[mid]], n);
      const w = k => c.wins.get(ends[k]);
      if (paired(w(lo), w(mid), n).mean <= paired(w(mid), w(hi), n).mean) hi = mid;
      else lo = mid;
    }
    return { ends, lo, hi };
  };
  const record = (c, lo, exact, d, unsure) => ({ at: c.at, move: c.st.from + c.cuts[lo].at, line: c.cuts[lo].line, exact, unsure, n: d.n, better: d.a, yours: d.b, cost: { mean: d.mean, se: d.se } });
  const sure = (await Promise.all(found.map(async c => {
    const n = Math.min(c.n, opt.pin), at = await cut(c, n), { ends } = at;
    let { lo, hi } = at;
    const one = c.cuts.length === 1;
    const exact = one || isMistake(paired(c.wins.get(ends[lo]), c.wins.get(ends[hi]), n), opt, Math.min(n, opt.least));
    if (!exact) { lo = 0; hi = c.cuts.length; }
    // The loss to show: in worlds the search has not seen.
    await play(c, [ends[lo], ends[hi]], opt.cap + opt.fresh, opt.cap);
    const d = paired(c.wins.get(ends[lo]), c.wins.get(ends[hi]), Infinity, opt.cap);
    if (d.mean > -(exact ? opt.cost / 2 : opt.spread)) {
      c.state = 'out';
      update(cands, spent);
      return null;
    }
    c.found = record(c, lo, exact, d, false);
    update(cands, spent);
    return c.found;
  }))).filter(m => m?.line.length).sort((a, b) => a.cost.mean - b.cost.mean);
  return [...sure, ...await likeliest(opt.shown - sure.length)];

  // What may be mistakes, to fill `slots` places: the candidates not found
  // to be that lost most in all their games (those of a mistake that its
  // fresh games did not bear out among them), each brought up to `enough`
  // worlds first, since a few worlds say little; then put to a move as a
  // mistake is, the move being taken for the loss if most of it is there.
  // Their losses are too bad on average, being picked for them, and are
  // marked `unsure`.
  async function likeliest(slots) {
    if (slots <= 0) return [];
    const whole = c => paired(c.wins.get(0), c.wins.get(c.st.to - c.st.from), Infinity);
    const worst = () => cands.filter(c => c.n && !c.found && c.cuts[0].line.length).map(c => [whole(c), c])
      .filter(([d]) => d.mean <= -opt.maybe).sort((a, b) => a[0].mean - b[0].mean || a[1].at - b[1].at);
    for (let pass = 0; pass < 3; pass++) {
      const few = worst().slice(0, slots + 1).map(([, c]) => c).filter(c => c.n < opt.enough);
      if (!few.length) break;
      await Promise.all(few.map(c => { c.n = opt.enough; return play(c, [0, c.st.to - c.st.from], c.n); }));
    }
    const out = await Promise.all(worst().filter(([d]) => d.n >= opt.enough).slice(0, slots).map(async ([all, c]) => {
      const n = Math.min(c.n, opt.pin), { ends, lo, hi } = await cut(c, n);
      const d = paired(c.wins.get(ends[lo]), c.wins.get(ends[hi]), Infinity);
      const exact = c.cuts.length === 1 || (d.mean <= -opt.maybe && d.mean <= 0.6 * all.mean);
      c.state = 'maybe';
      c.found = exact ? record(c, lo, true, d, true) : record(c, 0, false, all, true);
      update(cands, spent);
      return c.found;
    }));
    return out.sort((a, b) => a.cost.mean - b.cost.mean);
  }
}

// What the cards shown by a stretch did, by games played out after its moves
// with the world's cards coming up and with the real ones: the difference (paired).
export async function measureLuck({ st, job, roll, opt = SEARCH }) {
  const len = st.to - st.from, a = new Int8Array(opt.luck), b = new Int8Array(opt.luck);
  const work = [];
  for (let w = 0; w < opt.luck; w += opt.piece) {
    work.push(roll({ ...job, from: w, to: w + opt.piece, at: [len], reveal: true }).then(bytes => bytes.forEach((x, k) => { a[w + k] = x & 1; b[w + k] = (x >> 1) & 1; })));
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
