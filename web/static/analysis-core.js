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
// With one suit the games are played to the end. With more they are played
// until `stop` moves have shown cards and the network values where they
// stand (SHORT, below), so that a game is worth a chance and not a win or a
// loss: the chance of the network's player, as the curve is, and a few
// points more than the games' own player would make of it with four suits.
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
// cards' biggest swing (each times `noisy` at most). Where few mistakes are found, those that may be are
// brought up to `enough` worlds (some two for each place to fill) and put to
// a move as well. Then `curve` worlds are played from the start of every
// stretch for the curve (fillCurve).
export const SEARCH = {
  games: 6000, // games played out to find the mistakes
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
  pin: 256, // worlds for putting a mistake to one move of its stretch
  fresh: 256, // worlds, not used before, for the loss shown
  spread: 0.1, // a loss not put to one move is shown only if it is this large
  luck: 256, // worlds for the cards' biggest swing
  shown: 3, // with fewer mistakes than this, the list is filled up with what may be mistakes
  maybe: 0.02, // which is what lost this much in its games, however unsurely,
  enough: 128, // in this many worlds at least
  stop: 0, // moves showing cards a game is played on for before the network values it (0: to the end)
  sd: 0.2, // with `stop`: the standard deviation of a world's difference that pin, fresh and luck are meant for,
  noisy: 1, // and how many times as many worlds a candidate may get for them whose worlds differ more
  curve: 64, // worlds played from the start of every stretch for the curve alone, less those the search played there (fillCurve)
};

// With two suits or more a game stops after eight moves that show cards,
// counted from the start of its stretch. Measured against games played to
// the end on games with mistakes put in (tools/analysis/short.mjs), a
// world's difference then has a quarter of the variance with four suits (the
// standard deviation 20 points for 39), so a quarter of the worlds do, and
// what the network adds of its own to a candidate's cost is about a point
// (1.1 with four suits; stopped after four it is 1.8, after sixteen 0.7). A
// world costs about what it did (a value takes the time of a game or more),
// so the search takes about a quarter of the time. With one suit a game is
// over in less time than a value takes, and nothing is gained. Towards the
// end of a game there are not eight such moves left, the games are played
// out after all and a world's difference is as noisy as it was (up to 70
// points): a mistake found there gets up to four times the worlds for its
// move and its loss, as many as it had (`noisy`; so does the cards' swing).
// Both were then given more (the network got faster, and the games make
// the curve too: blend), and SHORT keeps a quarter of each of SEARCH's but
// for the worlds a candidate gets at first, a half
// (tools/analysis/blend.mjs: the search's games find no more mistakes with
// more of them, but put the curve some three points from the truth where
// the network is nine).
export const SHORT = {
  ...SEARCH, stop: 8, games: 1500, round: 8, piece: 2, first: 16, cap: 128, least: 32, pin: 64, fresh: 64, luck: 64, enough: 32, noisy: 4, curve: 16,
};

// The search's numbers for a game of this many suits.
export const searchFor = suits => (suits > 1 ? SHORT : SEARCH);

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

// Games in the same worlds compared: `a` and `b` have for each world what
// the game was worth (1 won, 0 lost, or the network's value where it
// stopped), NaN where it was not played. {n, a, b, mean, se}: over the worlds from `from` up
// to `to` that have both, the two rates, and b - a with its standard error
// (never taken for less than one game's difference would make it).
export function paired(a, b, to = Infinity, from = 0) {
  let n = 0, sa = 0, sb = 0, sd = 0, sq = 0;
  for (let w = from; w < a.length && w < to; w++) {
    if (!(a[w] >= 0 && b[w] >= 0)) continue;
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
// promise of what they were worth (the worker's roll). `update` is called as results come in, with the
// candidates so far.
//
// Returns the mistakes, the costliest first, each
//   {at, move, line, exact, unsure, n, better, yours, cost: {mean, se}}
// stretch `at`; the move numbered `move` in the game (1 is the first) was
// the mistake, `line` what the line player would have played in its place up
// to its first move that shows cards; `better` and `yours` are the line
// player's chances of winning (the games' mean worth) from before the move and from after it (with
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
    for (const u of uptos) if (!c.wins.has(u)) c.wins.set(u, new Float32Array(opt.cap + opt.noisy * opt.fresh).fill(NaN));
    from = Math.min(...uptos.map(u => { const w = c.wins.get(u); let k = from; while (k < n && w[k] >= 0) k++; return k; }));
    const work = [];
    for (let w = from; w < n; w += opt.piece) {
      const to = Math.min(n, w + opt.piece);
      work.push(roll({ ...job(c.at), from: w, to, at: uptos, stop: opt.stop }).then(worth => {
        uptos.forEach((u, i) => { const wins = c.wins.get(u); for (let k = 0; k < to - w; k++) wins[w + k] = worth[k * uptos.length + i]; });
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
  // `base` worlds, or up to `noisy` times as many for a candidate whose worlds differ by more than `sd`.
  const worlds = (c, base) => base * Math.min(opt.noisy, Math.max(1, Math.ceil((c.stat.se * Math.sqrt(c.stat.n) / opt.sd) ** 2)));
  const sure = (await Promise.all(found.map(async c => {
    const fresh = worlds(c, opt.fresh), n = Math.min(opt.cap, Math.max(Math.min(c.n, opt.pin), worlds(c, opt.pin)));
    if (n > c.n) { c.n = n; await play(c, [0, c.st.to - c.st.from], n); }
    const at = await cut(c, n), { ends } = at;
    let { lo, hi } = at;
    const one = c.cuts.length === 1;
    const exact = one || isMistake(paired(c.wins.get(ends[lo]), c.wins.get(ends[hi]), n), opt, Math.min(n, opt.least));
    if (!exact) { lo = 0; hi = c.cuts.length; }
    // The loss to show: in worlds the search has not seen.
    await play(c, [ends[lo], ends[hi]], opt.cap + fresh, opt.cap);
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

// Games for the curve alone (see blend): from the start of every stretch in
// `opt.curve` worlds, and from the end of the last, less those the search
// has played there (`cands`, findMistakes'; and none where `cuts` has null,
// a column too long for the line player). Returns what it played as
// findMistakes has its candidates' games ([{at, st, wins}]), for evidence;
// update(those, games) is called as each piece comes in.
export async function fillCurve({ stretches, cuts, cands, job, roll, opt = SEARCH, update = () => {} }) {
  if (!opt.curve) return [];
  const had = new Map(cands.map(c => [c.at, c]));
  const out = [], work = [];
  stretches.forEach((st, at) => {
    const len = st.to - st.from, last = at === stretches.length - 1, c = had.get(at);
    if (!cuts[at]) return;
    const uptos = last && !st.shows ? [0, len] : [0];
    for (const upto of uptos) {
      const own = c?.wins.get(upto);
      let from = 0;
      while (own && from < opt.curve && own[from] >= 0) from++;
      if (from >= opt.curve) continue;
      const wins = new Float32Array(opt.curve).fill(NaN);
      out.push({ at, st, wins: new Map([[upto, wins]]) });
      for (let w = from; w < opt.curve; w += opt.piece) {
        const to = Math.min(opt.curve, w + opt.piece);
        work.push(roll({ ...job(at), from: w, to, at: [upto], stop: opt.stop }).then(worth => { wins.set(worth, w); update(out, to - w); }));
      }
    }
  });
  await Promise.all(work);
  return out;
}

// What the cards shown by a stretch did, by games played out after its moves
// with the world's cards coming up and with the real ones: the difference
// (paired), and the games themselves (`games`: the two, by world).
// (In more worlds where they differ much, as a mistake's loss is: see SHORT.)
export async function measureLuck({ st, job, roll, opt = SEARCH }) {
  const len = st.to - st.from, most = opt.noisy * opt.luck, a = new Float32Array(most).fill(NaN), b = new Float32Array(most).fill(NaN);
  const play = async (from, to) => {
    const work = [];
    for (let w = from; w < to; w += opt.piece) {
      work.push(roll({ ...job, from: w, to: w + opt.piece, at: [len], reveal: true, stop: opt.stop }).then(worth => { for (let k = 0; k < opt.piece; k++) { a[w + k] = worth[2 * k]; b[w + k] = worth[2 * k + 1]; } }));
    }
    await Promise.all(work);
  };
  await play(0, opt.luck);
  const d = paired(a, b);
  await play(opt.luck, opt.luck * Math.min(opt.noisy, Math.max(1, Math.ceil((d.se * Math.sqrt(d.n) / opt.sd) ** 2))));
  return { ...paired(a, b), games: [a, b] };
}

// ---------------------------------------------------------------- the curve, with the games
//
// The games played out to find the mistakes (and the luck) are each a sample
// of the very chance the curve is of: a game from a stretch's start, the line
// player choosing, of the position there; one from after some of its moves,
// of the position they come to; one from its end with the world's cards
// coming up, of that position with its cards not yet known (`u`); and the
// luck's with the real cards, of the position after them. What they say of a
// position: key -> {n, sum, sq}, the number of games, the sum of what they
// were worth and of its squares. `cands` are findMistakes' (each {at, st,
// wins}: wins maps a number of the stretch's moves to the games from after
// them, by world), `lucks` [{at, games}] measureLuck's of stretch `at`.
// The games of one stretch from one position are in the same worlds wherever
// they come from (the luck's `a` are the candidate's own from its end), so
// those are counted once each.
export function evidence(stretches, cands, lucks = []) {
  const groups = new Map(); // `${key} ${at}` -> [key, world -> worth]
  const add = (key, at, worths) => {
    if (!worths) return;
    const id = `${key} ${at}`;
    if (!groups.has(id)) groups.set(id, [key, new Map()]);
    const seen = groups.get(id)[1];
    worths.forEach((x, w) => { if (x >= 0 && !seen.has(w)) seen.set(w, x); });
  };
  const keyOf = (st, upto) => (upto === st.to - st.from && st.shows ? `u${st.to}` : `p${st.from + upto}`);
  for (const c of cands) for (const [upto, worths] of c.wins ?? []) add(keyOf(c.st, upto), c.at, worths);
  for (const { at, games: [a, b] } of lucks) {
    const st = stretches[at];
    add(keyOf(st, st.to - st.from), at, a);
    add(`p${st.to}`, at, b);
  }
  const out = new Map();
  for (const [key, seen] of groups.values()) {
    const e = out.get(key) ?? { n: 0, sum: 0, sq: 0 };
    for (const x of seen.values()) { e.n++; e.sum += x; e.sq += x * x; }
    out.set(key, e);
  }
  return out;
}

// How the network's values and the games are put together (blend, below),
// measured on the 48 games with mistakes put in that the search was measured
// on (tools/analysis/blend.mjs), against every candidate's two positions
// played to the end in 256 worlds. In units of v(1 - v), v being the
// network's value (so that a position near certain counts its errors as
// such): `error` is the variance of the network's error, `world` that of a
// game's worth about its position's chance with the games stopped as SHORT
// has it (with them played to the end it is 1: a win or a loss), `moves` and
// `cards` how much less alike the network's errors are across a stretch's
// moves and across the cards that end it (-ln of the correlation), `bias`
// what the games' own error adds (stopped, they are worth the network's
// value eight showings on), and `prior` how many games' worth of `world` a
// position's own games' spread is taken with.
export const BLEND = { error: 0.05, world: 0.31, moves: 0.6, cards: 0.6, bias: 0, prior: 30, least: 0.01 };

// The curve with the games put in: key -> value, for every key of `values`
// (the network's). The network's error is taken to be a random walk that
// drifts back to nothing, along the curve: over a stretch's moves it keeps
// exp(-moves) of what it was, a position inside the stretch so much of the
// way along as it is, and over the cards shown exp(-cards); the games are
// noisy measurements of the chance at their positions (with a variance of
// their spread over their number, and `bias`). The value at each position
// is then the network's plus what the error is most likely to be, given all
// the games (a Kalman smoother along the curve): at a position with games of
// its own and none near, the network's value counted as error / world games
// against the games' own; between positions with games, in between. A
// position whose value is known (the end of a game over) is left as it is.
// `full`: the games are played to the end (world is then 1).
export function blend(stretches, values, ev, fixed = new Set(), full = false, opt = BLEND) {
  // The curve's positions in order, with where each is along it.
  const pts = [], world = full ? 1 : opt.world;
  let at = 0;
  const point = (key, time) => { if (values.has(key) && !fixed.has(key)) pts.push({ key, time }); };
  stretches.forEach((st, i) => {
    if (i === 0) point(`p${st.from}`, at);
    const len = st.to - st.from;
    for (let t = st.from + 1; t < st.to; t++) point(`p${t}`, at + opt.moves * (t - st.from) / len);
    at += opt.moves;
    if (st.shows) { point(`u${st.to}`, at); at += opt.cards; }
    point(`p${st.to}`, at);
  });
  const out = new Map(values);
  if (!pts.length) return out;
  // Each position's games, in units of the error: (mean - value) / sqrt(v(1 - v)), and their variance.
  for (const p of pts) {
    const v = values.get(p.key), e = ev.get(p.key);
    p.scale = Math.sqrt(Math.max(opt.least, v * (1 - v)));
    if (!e?.n) continue;
    const mean = e.sum / e.n, spread = (Math.max(0, e.sq - e.n * mean * mean) + opt.prior * world * p.scale ** 2) / (e.n - 1 + opt.prior);
    p.y = (mean - v) / p.scale;
    p.r = spread / p.scale ** 2 / e.n + opt.bias;
  }
  // Forward (the filter), then back (the smoother).
  const q = opt.error;
  let m = 0, P = q;
  pts.forEach((p, i) => {
    const f = i ? Math.exp(-(p.time - pts[i - 1].time)) : 0;
    p.f = f;
    p.m0 = f * m;
    p.P0 = f * f * P + q * (1 - f * f);
    m = p.m0; P = p.P0;
    if (p.y !== undefined) {
      const k = P / (P + p.r);
      m += k * (p.y - m);
      P *= 1 - k;
    }
    p.m = m; p.P = P;
  });
  let ms = pts[pts.length - 1].m;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    if (i < pts.length - 1) {
      const nx = pts[i + 1], g = nx.P0 > 0 ? p.P * nx.f / nx.P0 : 0;
      ms = p.m + g * (ms - nx.m0);
    }
    const v = values.get(p.key);
    out.set(p.key, Math.min(1, Math.max(0, v + ms * p.scale)));
  }
  return out;
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
