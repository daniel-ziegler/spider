// Checks of the analysis's parts that are not the page (static/analysis-core.js,
// static/analysis-worker.js); the repository root's `cargo test` runs this.
// It fails by throwing. It also prints lines "enc suits seed moves hex": the
// network's encoding of positions from play, and "dealt ...": that of the
// position after the moves and a deal with the cards dealt not yet known,
// which the test compares with what src/vnet.rs encodes.
import { Game, encodeMoves } from '../static/game.js';
import { rolloutConfig, makeState, playOut, LEN, DOWN, MAXC } from '../static/lineplayer.js';
import { prepare, stretchValues, committed, screenJobs, screen, paired, isMistake, hopeless, nextRound, findMistakes, measureLuck, branch, SEARCH, BIAS } from '../static/analysis-core.js';
import { random, shuffled, showReal, setup, roll, track } from '../static/analysis-worker.js';

const check = (ok, what) => { if (!ok) throw new Error(what); };

// A game of the line player's, analysed.
function played(suits, seed) {
  const g = new Game(suits, seed), moves = [];
  playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), rolloutConfig(suits), moves);
  return moves;
}

for (const [suits, seed] of [[1, 70002], [2, 70001], [3, 70002], [4, 70018]]) {
  const moves = played(suits, seed), data = prepare(suits, seed, moves);
  // The stretches are the moves in order, each ending with the first move that shows cards.
  let at = 0;
  for (const st of data.stretches) {
    check(st.from === at && st.to > st.from, 'stretches do not follow one another');
    for (let t = st.from + 1; t < st.to; t++) check(!data.shows[t - 1], 'cards shown inside a stretch');
    check(st.shows === data.shows[st.to - 1], 'a stretch does not end with its showing move');
    at = st.to;
  }
  check(at === moves.length && data.snaps.length === moves.length + 1, 'stretches do not cover the game');
  const turns = data.shows.filter(s => s === 'turn').length, deals = data.shows.filter(s => s === 'deal').length;
  check(data.jobs.length === moves.length + 1 + turns + deals, 'the wrong number of positions to value');
  check(new Set(data.jobs.map(j => j.key)).size === data.jobs.length, 'a position is valued twice');
  // A position with a turned card unknown has a 2 there and is otherwise the position.
  // After a deal the ten cards dealt are 2s (but for one that completed a suit), and nothing else differs.
  for (const job of data.jobs.filter(j => j.key[0] === 'u')) {
    const t = +job.key.slice(1), known = data.jobs.find(j => j.key === `p${t}`).enc;
    const diff = [...job.enc].flatMap((v, i) => (v !== known[i] ? [[v, known[i]]] : []));
    if (data.shows[t - 1] === 'turn') check(diff.length >= 1 && diff.every(([v, k]) => v === 2 && k >= 3), 'an unknown card is not what differs');
    else if (data.snaps[t].completed.length === data.snaps[t - 1].completed.length) check(diff.length === 10 && diff.every(([v, k]) => v === 2 && k >= 3), 'the cards dealt are not what differs');
  }
  // The encodings, for the Rust to compare (every seventh position).
  const g = new Game(suits, seed);
  moves.forEach((mv, i) => {
    g.apply(mv);
    if (i % 7 === 0) console.log(`enc ${suits} ${seed} ${encodeMoves(moves.slice(0, i + 1))} ${Buffer.from(data.jobs.find(j => j.key === `p${i + 1}`).enc).toString('hex')}`);
    if (moves[i + 1]?.deal) console.log(`dealt ${suits} ${seed} ${encodeMoves(moves.slice(0, i + 1))} ${Buffer.from(data.jobs.find(j => j.key === `u${i + 2}`).enc).toString('hex')}`);
  });

  // The line player's own moves leave its line nowhere. A deal in place of a
  // stretch of several moves that ends with a card turned leaves it at the
  // deal, for those moves; and a first move played out of turn that changes
  // nothing leaves it nowhere (the moves then go on as the line player's would).
  data.stretches.slice(0, 12).forEach(st => {
    const start = data.snaps[st.from], own = moves.slice(st.from, st.to);
    const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: own };
    check(track(job).length === 0, 'the line player leaves its own line');
    if (st.shows === 'turn' && start.stock.length && start.columns.every(c => c.length)) {
      const cuts = track({ ...job, moves: [{ deal: true }] });
      check(cuts.length === 1 && cuts[0].at === 1 && encodeMoves(cuts[0].line) === encodeMoves(own), 'a deal too early is not seen, or not with what was better');
      const alt = branch(suits, seed, moves, st.from, cuts[0].line), last = alt.shows[alt.shows.length - 1];
      check(alt.snaps.length === own.length + 1 && last.show === 'turn' && alt.snaps[own.length].faceDown[last.col] === start.faceDown[last.col] - 1, 'the better line does not end with its card turned');
      // What the network is asked of the line player's line then is the game's own position there, its card not yet known.
      const asks = screenJobs(suits, seed, [...moves.slice(0, st.from), { deal: true }], [{ from: st.from, to: st.from + 1, shows: 'deal' }], [cuts]);
      check(asks.length === 1 && asks[0].at === 0 && asks[0].shows === 'turn' && asks[0].enc.join() === data.jobs.find(j => j.key === `u${st.to}`).enc.join(), 'the position to compare a departure with');
    }
  });
  // Worlds: in every stretch that shows cards, a world made to show the real
  // ones gives the real position after the moves, face-up card for card, and
  // is a rearrangement of the hidden cards.
  for (const st of data.stretches.filter((s, i) => s.shows && i % 3 === 0)) {
    const start = data.snaps[st.from], end = data.snaps[st.to];
    const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to) };
    const { real, shown, game } = setup(job);
    check(shown.length === (st.shows === 'deal' ? 10 : 0) + start.faceDown.reduce((n, d, c) => n + d - end.faceDown[c], 0), 'the wrong places shown');
    const below = random(seed + st.to), cards = shuffled(real, below);
    check([...cards].sort().join() === [...real].sort().join(), 'a world is not a shuffle');
    showReal(cards, real, shown, below);
    check([...cards].sort().join() === [...real].sort().join(), 'a world shown is not a shuffle');
    const { s, stock } = game(cards, job.moves.length);
    check(stock.length === end.stock.length, 'the stock is wrong after the moves');
    for (let c = 0; c < 10; c++) {
      check(s[LEN + c] === end.columns[c].length && s[DOWN + c] === end.faceDown[c], 'a column is wrong after the moves');
      for (let i = end.faceDown[c]; i < end.columns[c].length; i++) check(s[c * MAXC + i] === end.columns[c][i], 'a face-up card is wrong after the moves');
    }
  }
}

// Showing a real card leaves the rest a fair shuffle: with the hidden cards
// X X Y Z and the first place shown to be X, the other three are each of
// their six orders equally often.
{
  const real = Uint8Array.from([5, 5, 6, 7]), below = random(12345), seen = new Map(), n = 60000;
  for (let i = 0; i < n; i++) {
    const cards = shuffled(real, below);
    showReal(cards, real, [0], below);
    check(cards[0] === 5, 'the card shown is not the real one');
    const k = cards.slice(1).join();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  check(seen.size === 6, 'not every order comes up');
  for (const [k, c] of seen) check(Math.abs(c / n - 1 / 6) < 0.01, `order ${k} comes up ${c} times of ${n}`);
}

// Games played out: the same worlds give the same answer; with no moves the
// games are one; from the deal the rate is about the line player's.
{
  const g = new Game(2, 70001);
  const job = { suits: 2, columns: g.columns, faceDown: g.faceDown, completed: 0, stock: g.stock, moves: [], seed: 7, from: 0, to: 48, reveal: true };
  const a = roll(job), b = roll({ ...job, from: 16, to: 32 });
  check(a.slice(16, 32).join() === b.join(), 'the same worlds play out differently');
  check(a.every(x => x === 0 || x === 7), 'the three games differ with no moves played');
  const rate = a.reduce((n, x) => n + (x & 1), 0) / a.length;
  check(rate > 0.4 && rate < 0.85, `an odd rate from the deal: ${rate}`);
  // A move that turns a card: games from before it, after it, and both with the real card; a game is the same whatever else is asked for.
  const moves = played(2, 70001), data = prepare(2, 70001, moves), st = data.stretches[0];
  const own = moves.slice(st.from, st.to), r = roll({ ...job, moves: own, to: 16, at: [0, own.length] });
  const r2 = roll({ ...job, moves: own, to: 16, at: [own.length], reveal: false });
  check(r.every((x, w) => (x & 1) === (a[w] & 1) && ((x >> 1) & 1) === (r2[w] & 1)) && r.every(x => x < 8) && r2.every(x => x < 2), 'the games of a roll');
}

// Differences of games in the same worlds, and what is called a mistake.
{
  const a = Int8Array.from([...Array(60).fill(1), ...Array(40).fill(0), -1, 1]), b = Int8Array.from([...Array(30).fill(1), ...Array(70).fill(0), 1, -1]);
  const d = paired(a, b);
  check(d.n === 100 && Math.abs(d.a - 0.6) < 1e-12 && Math.abs(d.b - 0.3) < 1e-12 && Math.abs(d.mean + 0.3) < 1e-12 && Math.abs(d.se - Math.sqrt(0.3 * 0.7 / 99)) < 1e-12, 'a paired difference');
  check(paired(a, b, 30).mean === 0 && paired(a, b, 30).se === 1 / 30 && paired([], []).n === 0, 'a paired difference of few worlds');
  const s = (mean, se, n) => ({ n, mean, se });
  check(paired(a, b, Infinity, 60).mean === 0 && paired(a, b, Infinity, 60).n === 40 && paired(a, b, 60, 20).n === 40, 'a paired difference of some worlds');
  check(isMistake(s(-0.1, 0.03, 128)) && !isMistake(s(-0.1, 0.03, 64)) && !isMistake(s(-0.1, 0.05, 512)) && !isMistake(s(-0.02, 0.001, 512)), 'what a mistake is');
  check(!hopeless(s(0, 0.0625, 16)) && !hopeless(s(-0.05, 0.04, 128)) && hopeless(s(0.01, 0.02, 256)) && hopeless(s(-0.04, 0.02, 512)) && !hopeless(s(-0.06, 0.02, 512)), 'what is given up');
  // Rounds: the first candidates in their order first; then the worst-looking that are not settled, doubled, and the next to come in where those are few; within the games left.
  const none = s(0, Infinity, 0);
  check(nextRound([none, none, none], [0, 1, 2], 1000).join() === '0,32,1,32,2,32' && nextRound([none, none, none], [0, 1, 2], 70).join() === '0,32', 'the first round');
  check(nextRound([none, none, none], [2, 0, 1], 1000, { ...SEARCH, start: 2 }).join() === '2,32,0,32', 'the first round is not in the order given');
  const stats = [s(0, 0.06, 32), s(-0.2, 0.1, 32), s(-0.1, 0.03, 256), s(0.02, 0.02, 256), s(-0.06, 0.04, 128), none];
  const order = [0, 1, 2, 3, 4, 5];
  check(nextRound(stats, order, 10000, { ...SEARCH, group: 2 }).join() === '1,32,4,128' && nextRound(stats, order, 100, { ...SEARCH, group: 2 }).join() === '1,32,4,16', 'a later round');
  check(nextRound([s(-0.1, 0.03, 256), s(0.02, 0.02, 256), s(-0.2, 0.1, 32), none, none], [4, 0, 1, 2, 3], 10000, { ...SEARCH, group: 2 }).join() === '2,32,4,32', 'the next does not come in');
  check(nextRound([s(-0.1, 0.03, 256), s(0.02, 0.02, 256)], [0, 1], 10000).length === 0, 'rounds do not end');
}

// The search for mistakes, with games that are won by chance: stretch i is
// won with a chance that falls after some of its moves, in every world
// alike (a world's game is won if the world's number is under the chance).
{
  // [the chance after 0, 1, ... moves, the departures from the line player's line]
  const made = [
    [[0.5, 0.5, 0.5], [1]], // a departure that costs nothing
    [[0.7, 0.7, 0.7, 0.35, 0.35], [1, 3, 4]], // the second of three is a mistake
    [[0.4, 0.4], []], // the line player's own moves
    [[0.6, 0.05], [1]], // one move, a mistake
    [[0.5, 0.49, 0.48, 0.47], [1, 2, 3]], // too little to be one
    [[0.7, 0.68, 0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.54, 0.52, 0.5], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], // a large loss of ten moves, none surely one by itself
    [[0.6, 0.58, 0.56, 0.53], [1, 2, 3]], // a small loss of three moves: nothing to show
    ...Array.from({ length: 30 }, () => [[0.3, 0.31, 0.3], [1, 2]]),
  ];
  let at = 0, games = 0;
  const stretches = made.map(([p]) => ({ from: at, to: at += p.length - 1, shows: 'turn' }));
  const cuts = made.map(([, c]) => c.map(k => ({ at: k, line: [{ from: 0, to: 1, count: k }] })));
  const world = (i, w) => { const below = random(Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(w + 1, 0x85EBCA6B)); below(2); return below(1 << 20) / (1 << 20); };
  const fake = job => {
    games += job.at.length * (job.to - job.from);
    return Promise.resolve(Uint8Array.from({ length: job.to - job.from }, (_, k) => job.at.reduce((bits, u, j) => bits | ((world(job.i, job.from + k) < made[job.i][0][u] ? 1 : 0) << j), 0)));
  };
  let seen = 0;
  const found = await findMistakes({ stretches, cuts, job: i => ({ i }), roll: fake, update: (c, n) => { check(n >= seen && c.length === made.length - 1, 'the search goes backwards'); seen = n; } });
  check(seen === games && games <= SEARCH.games + SEARCH.most * (8 * SEARCH.pin + 2 * SEARCH.fresh), `the search plays ${games} games`);
  check(found.length === 3 && found.map(m => m.at).join() === '3,1,5', `the mistakes found: ${found.map(m => m.at)}`);
  const [one, two, three] = found;
  check(one.exact && one.move === stretches[3].from + 1 && Math.abs(one.cost.mean + 0.55) < 0.1 && Math.abs(one.better - 0.6) < 0.1 && Math.abs(one.yours - 0.05) < 0.1, 'a mistake of one move');
  check(two.exact && two.move === stretches[1].from + 3 && two.line[0].count === 3 && Math.abs(two.cost.mean + 0.35) < 0.1, 'a mistake is not put to its move');
  check(!three.exact && three.move === stretches[5].from + 1 && Math.abs(three.cost.mean + 0.2) < 0.1, 'a loss of several moves');
  for (const m of found) check(m.n === SEARCH.fresh && m.cost.mean < 0, 'a loss not measured in fresh worlds');
  // The order the network gives says where the games go: with few of them, the one mistake it puts first is found, and without it none.
  const few = { ...SEARCH, games: 300, start: 1, group: 1 };
  const led = await findMistakes({ stretches, cuts, prior: made.map((_, i) => (i === 3 ? -0.3 : 0)), job: i => ({ i }), roll: fake, opt: few });
  const blind = await findMistakes({ stretches, cuts, job: i => ({ i }), roll: fake, opt: few });
  const surely = ms => ms.filter(m => !m.unsure);
  check(surely(led).length === 1 && led[0].at === 3 && surely(blind).length === 0, `the network's order is not followed: ${led.map(m => m.at)}, ${blind.map(m => m.at)}`);
  // Where fewer than three mistakes are found the list is filled with what may be mistakes: the worst of the
  // rest by their games, in enough worlds, after the sure ones, each put to a move if most of its loss is there.
  for (const ms of [led, blind]) {
    const maybe = ms.filter(m => m.unsure);
    check(ms.length <= SEARCH.shown && ms.slice(surely(ms).length).every(m => m.unsure), 'what may be mistakes is not after the mistakes');
    check(maybe.every((m, i) => m.cost.mean <= -SEARCH.maybe && m.n >= SEARCH.enough && m.line.length && (!i || m.cost.mean >= maybe[i - 1].cost.mean)), 'what may be a mistake lost nothing, or has too few games');
    check(new Set(ms.map(m => m.at)).size === ms.length, 'a mistake is listed twice');
  }
  const none = await findMistakes({ stretches, cuts, prior: made.map((_, i) => (i === 1 || i === 5 ? -0.3 : 0)), job: i => ({ i }), roll: fake, opt: { ...SEARCH, games: 200, start: 2 } });
  check(none.length === 2 && none.every(m => m.unsure) && none[0].at === 1 && none[0].exact && none[0].move === stretches[1].from + 3 && none[1].at === 5 && !none[1].exact && none[1].move === stretches[5].from + 1,
    `what may be mistakes: ${JSON.stringify(none.map(m => [m.at, m.move, m.exact, m.n, m.cost.mean]))}`);
  // With every game the same there are none, and the games are not all played.
  games = 0;
  const same = job => { games += job.at.length * (job.to - job.from); return Promise.resolve(Uint8Array.from({ length: job.to - job.from }, (_, k) => ((job.from + k) % 5 < 2 ? (1 << job.at.length) - 1 : 0))); };
  const flat = await findMistakes({ stretches, cuts, job: i => ({ i }), roll: same });
  check(flat.length === 0 && games <= SEARCH.games, `no mistakes to find: ${flat.length} found in ${games} games`);
  // The cards' part: the real cards against the world's.
  const luck = await measureLuck({ st: stretches[0], job: {}, roll: job => Promise.resolve(Uint8Array.from({ length: job.to - job.from }, (_, k) => ((job.from + k) % 4 ? 1 : 3))) });
  check(luck.n === SEARCH.luck && Math.abs(luck.mean + 0.75) < 1e-12 && luck.a === 1 && luck.b === 0.25, 'the cards\' part');
}

// The network's values of a stretch.
{
  const v = stretchValues({ from: 3, to: 4, shows: 'turn' }, new Map([['p3', 0.5], ['u4', 0.4], ['p4', 0.7]]), true, 4);
  check(v.end === 1 && Math.abs(v.play + 0.1) < 1e-12 && Math.abs(v.luck - 0.6) < 1e-12, 'a won game is worth 1');
  const w = stretchValues({ from: 3, to: 4, shows: 'turn' }, new Map([['p3', 0.5], ['u4', 0.4], ['p4', 0.7]]), false, 4, 4);
  check(Math.abs(w.commit - 0.4 + BIAS[4][0]) < 1e-12 && Math.abs(w.play + w.luck - 0.2) < 1e-12, 'the bias of an unknown card');
  const d = stretchValues({ from: 3, to: 4, shows: 'deal' }, new Map([['p3', 0.5], ['u4', 0.4], ['p4', 0.7]]), false, 4, 4);
  check(Math.abs(d.commit - 0.4 + BIAS[4][1]) < 1e-12, 'the bias of a deal not yet known');
}
// What the network makes a stretch cost: its end against the line player's, cards unknown on both sides.
{
  const sts = [{ from: 0, to: 2, shows: 'turn' }, { from: 2, to: 3, shows: 'deal' }, { from: 3, to: 5, shows: null }];
  const vals = new Map([['u2', 0.5], ['u3', 0.4], ['p5', 0.3]]), theirs = new Map([[0, { value: 0.6, shows: 'turn' }], [1, { value: 0.45, shows: 'turn' }]]);
  const lost = screen(sts, vals, theirs, false, 5, 4), won = screen(sts, vals, theirs, true, 5, 4);
  check(Math.abs(lost[0] + 0.1) < 1e-12 && Math.abs(lost[1] - (0.4 - BIAS[4][1] - 0.45 + BIAS[4][0])) < 1e-12 && lost[2] === -1 && won[2] === 0, 'the network\'s order');
}
console.log('ok');
