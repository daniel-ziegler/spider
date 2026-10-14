// Checks of the analysis's parts that are not the page (static/analysis-core.js,
// static/analysis-worker.js); the repository root's `cargo test` runs this.
// It fails by throwing. It also prints lines "enc suits seed moves hex": the
// network's encoding of positions from play, which the test compares with
// what src/vnet.rs encodes.
import { Game, encodeMoves } from '../static/game.js';
import { fastConfig, makeState, playOut, LEN, DOWN, MAXC } from '../static/lineplayer.js';
import { prepare, stretchValues, keyStretches, rollStats, verdict, DEAL_SAMPLES } from '../static/analysis-core.js';
import { random, shuffled, showReal, setup, roll, plays } from '../static/analysis-worker.js';

const check = (ok, what) => { if (!ok) throw new Error(what); };

// A game of the line player's, analysed.
function played(suits, seed) {
  const g = new Game(suits, seed), moves = [];
  playOut(makeState(g.columns, g.faceDown, 0), Uint8Array.from(g.stock), fastConfig(suits), moves);
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
  check(data.jobs.length === moves.length + 1 + turns + deals * DEAL_SAMPLES, 'the wrong number of positions to value');
  check(new Set(data.jobs.map(j => j.key)).size === data.jobs.length, 'a position is valued twice');
  // A position with a turned card unknown has a 2 there and is otherwise the position.
  for (const job of data.jobs.filter(j => j.key[0] === 'u')) {
    const known = data.jobs.find(j => j.key === `p${job.key.slice(1)}`).enc;
    const diff = [...job.enc].flatMap((v, i) => (v !== known[i] ? [[v, known[i]]] : []));
    check(diff.length >= 1 && diff.every(([v, k]) => v === 2 && k >= 3), 'an unknown card is not what differs');
  }
  // The encodings, for the Rust to compare (every seventh position).
  const g = new Game(suits, seed);
  moves.forEach((mv, i) => {
    g.apply(mv);
    if (i % 7 === 0) console.log(`enc ${suits} ${seed} ${encodeMoves(moves.slice(0, i + 1))} ${Buffer.from(data.jobs.find(j => j.key === `p${i + 1}`).enc).toString('hex')}`);
  });

  // The line player's own moves are known for its own (and not when one is changed).
  data.stretches.slice(0, 12).forEach(st => {
    const start = data.snaps[st.from];
    const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to) };
    check(plays(job), 'the line player does not know its own moves');
    check(!plays({ ...job, moves: [...job.moves, { deal: true }] }) && !plays({ ...job, moves: job.moves.slice(1) }), 'other moves pass for the line player\'s own');
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
    const { s, stock } = game(cards, true);
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
// three games are one; from the deal the rate is about the line player's.
{
  const g = new Game(2, 70001);
  const job = { suits: 2, columns: g.columns, faceDown: g.faceDown, completed: 0, stock: g.stock, moves: [], seed: 7, from: 0, to: 48 };
  const a = roll(job), b = roll({ ...job, from: 16, to: 32 });
  check(a.slice(16, 32).join() === b.join(), 'the same worlds play out differently');
  check(a.every(x => x === 0 || x === 7), 'the three games differ with no moves played');
  const s = rollStats(a);
  check(s.pre.mean > 0.4 && s.pre.mean < 0.85 && s.play.mean === 0 && s.luck.mean === 0, `an odd rate from the deal: ${s.pre.mean}`);
  // A move that turns a card: the three games are played, and luck and play add up.
  const moves = played(2, 70001), data = prepare(2, 70001, moves), st = data.stretches[0];
  const r = rollStats(roll({ ...job, moves: moves.slice(st.from, st.to), to: 32 }));
  check(Math.abs(r.reveal.mean - r.pre.mean - r.play.mean - r.luck.mean) < 1e-12, 'play and luck do not add up');
}

// Statistics and names.
{
  const bytes = Uint8Array.from([...Array(60).fill(0b101), ...Array(30).fill(0b001), ...Array(10).fill(0)]);
  const s = rollStats(bytes);
  check(s.n === 100 && Math.abs(s.pre.mean - 0.9) < 1e-12 && Math.abs(s.commit.mean) < 1e-12 && Math.abs(s.reveal.mean - 0.6) < 1e-12, 'rates');
  check(Math.abs(s.play.mean + 0.9) < 1e-12 && Math.abs(s.luck.mean - 0.6) < 1e-12 && Math.abs(s.play.se - Math.sqrt(0.9 * 0.1 / 99)) < 1e-12, 'differences');
  check(verdict(s) === 'Mistake, good luck', verdict(s));
  check(verdict(rollStats(Uint8Array.from([7, 0, 7, 0, 1, 6]))) === 'Too close to call', 'a verdict from six games');
  const vals = [[0.5, 0.5, 0.45], [0.45, 0.2, 0.44], [0.44, 0.44, 0.1], [0.1, 0.12, 0.3]].map(([start, commit, end]) => ({ start, commit, end, play: commit - start, luck: end - commit }));
  check(keyStretches(vals).join() === '0,1,2', 'the key stretches');
  check(keyStretches(vals, 1).join() === '2', 'the biggest drop');
  check(keyStretches(vals.map((v, i) => ({ ...v, same: i === 1 }))).join() === '0,2', 'a stretch of the line player\'s own moves is no key stretch for them');
  check(keyStretches(vals.map((v, i) => ({ ...v, bias: i === 2 ? 0.31 : 0 }))).join() === '0,1', 'a deal\'s usual loss is not a key stretch');
  const v = stretchValues({ from: 3, to: 4, shows: 'turn' }, new Map([['p3', 0.5], ['u4', 0.4], ['p4', 0.7]]), true, 4);
  check(v.end === 1 && Math.abs(v.play + 0.1) < 1e-12 && Math.abs(v.luck - 0.6) < 1e-12, 'a won game is worth 1');
  const w = stretchValues({ from: 3, to: 4, shows: 'turn' }, new Map([['p3', 0.5], ['u4', 0.4], ['p4', 0.7]]), false, 4, 4);
  check(w.commit < 0.4 && w.commit > 0.37 && Math.abs(w.play + w.luck - 0.2) < 1e-12 && w.bias === 0, 'the bias of an unknown card');
}
console.log('ok');
