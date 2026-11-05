// Lining up two attempts at a deal (compare-core.js): reordered moves and moves
// taken back are no difference, a real split is found, and lines that part and
// meet again have parted nowhere.
import assert from 'node:assert/strict';
import { Game, encodeMoves } from '../static/game.js';
import { readLine, relate, align, positionKey, differing, computerGame, nextShow, rows, keyRows, parts, valueJobs } from '../static/compare-core.js';
import { nextMoves } from '../static/analysis-worker.js';

// Positions are made by hand: a Game whose columns are set, as prepare would read them.
const SUITS = 4, SEED = 20820;
const legal = g => g.hintMoves().map(m => m.mv ?? m).filter(m => !m.deal);

// Moves that do not touch each other, from the deal: legal moves between
// columns that no other of them uses and that show no cards.
function independent(n) {
  for (let seed = SEED; seed < SEED + 2000; seed++) {
    const g = new Game(SUITS, seed), used = new Set(), out = [];
    for (const mv of legal(g)) {
      if (used.has(mv.from) || used.has(mv.to)) continue;
      used.add(mv.from);
      used.add(mv.to);
      out.push(mv);
    }
    if (out.length >= n) return { seed, moves: out.slice(0, n) };
  }
  throw new Error('no such deal');
}

const read = (seed, moves) => readLine(SUITS, seed, moves);
const back = mv => ({ from: mv.to, to: mv.from, count: mv.count });

// The same moves: the same game.
const { seed, moves: [m1, m2] } = independent(2);
assert.ok(relate(read(seed, [m1, m2]), read(seed, [m1, m2])).same);

// Another order: the same game, one stretch in another order, no split.
{
  const r = relate(read(seed, [m1, m2]), read(seed, [m2, m1]));
  assert.ok(r.same);
  assert.equal(r.split, null);
  assert.equal(r.reordered, 1);
}

// A move taken back by hand is no difference. (A move that turned a card cannot
// be taken back by hand: independent()'s moves onto a card from a column of one
// face-up run would be needed, so the test is of the key's own loop.)
{
  const keys = ['p0', 'p1', 'p0', 'p2', 'p3'];
  assert.deepEqual(align(keys, ['p0', 'p2', 'p3']), [[0, 0], [2, 0], [3, 1], [4, 2]]);
  assert.deepEqual(align(['p0', 'p2', 'p3'], keys), [[0, 0], [0, 2], [1, 3], [2, 4]]);
}

// A real split: at the last position shared, by each side's own count of moves.
{
  const line = read(seed, [m1]);
  const r = relate(line, read(seed, [m2]));
  assert.equal(r.same, false);
  assert.deepEqual([r.split.a, r.split.b, r.split.kind], [0, 0, 'choice']);
  // Having reordered first, the split is after that.
  const g = new Game(SUITS, seed);
  g.applyRaw(m1);
  g.applyRaw(m2);
  const third = legal(g).filter(x => !x.deal);
  if (third.length >= 2) {
    const r2 = relate(read(seed, [m1, m2, third[0]]), read(seed, [m2, m1, third[1]]));
    assert.deepEqual([r2.split.a, r2.split.b, r2.reordered], [2, 2, 1]);
  }
}

// Lines that part and meet again have no split there (moves up to the meeting
// are only reordered), though with a different number of moves: 3 + 1 moves
// against 2 + 1, where the first takes one of them back.
{
  const keysA = ['s', 'x', 'y', 'm', 'e'], keysB = ['s', 'z', 'm', 'e'];
  assert.deepEqual(align(keysA, keysB), [[0, 0], [3, 2], [4, 3]]);
  const fake = (keys, n) => ({ keys, moves: Array(n).fill({}) });
  const r = relate(fake(keysA, 4), fake(keysB, 3));
  assert.ok(r.same);
  assert.equal(r.reordered, 1);
  // A rejoin, and then a split: the split is after the meeting.
  const r2 = relate(fake(['s', 'x', 'm', 'a'], 3), fake(['s', 'y', 'm', 'b'], 3));
  assert.deepEqual([r2.split.a, r2.split.b], [2, 2]);
  // One line stops where the other goes on.
  const r3 = relate(fake(['s', 'x'], 1), fake(['s', 'x', 'y'], 2));
  assert.deepEqual([r3.split.kind, r3.split.ended], ['end', 'a']);
}

// Columns: those with no cards face down are told apart by their cards alone,
// the others by their place as well.
{
  const pos = (cols, down) => ({ columns: cols, faceDown: down, stock: [1], completed: [] });
  const e = [[], [5], [7], [], [], [], [], [], [], []], z = new Array(10).fill(0);
  const swapped = [[5], [], [7], [], [], [], [], [], [], []];
  assert.equal(positionKey(pos(e, z)), positionKey(pos(swapped, z)));
  assert.deepEqual(differing(pos(e, z), pos(swapped, z)).map(s => s.size), [0, 0]);
  // With face-down cards the place matters: those are that column's own cards.
  const d1 = [...z]; d1[1] = 1;
  const a = [[], [9, 5], [7], [], [], [], [], [], [], []], b = [[9, 5], [], [7], [], [], [], [], [], [], []], d2 = [...z]; d2[0] = 1;
  assert.notEqual(positionKey(pos(a, d1)), positionKey(pos(b, d2)));
  // Two of the same card in the same place: one position.
  assert.equal(positionKey(pos(e, z)), positionKey(pos(e.map(c => [...c]), z)));
  // What differs is what is unlike.
  const c = [[], [5], [8], [], [], [], [], [], [], []];
  const [p, q] = differing(pos(e, z), pos(c, z));
  assert.deepEqual([[...p], [...q]], [[2], [2]]);
}

// Two wins end on the same empty board, and with nothing hidden on the way
// there may share more: that is no meeting.
{
  const fake = (keys, n) => ({ keys, moves: Array(n).fill({}) });
  assert.equal(positionKey({ columns: Array(10).fill([]), faceDown: new Array(10).fill(0), stock: [], completed: [] }), null);
  const r = relate(fake(['s', 'x', null, null], 3), fake(['s', 'y', null], 2));
  assert.deepEqual([r.same, r.split.a, r.split.b, r.split.kind], [false, 0, 0, 'choice']);
  assert.ok(relate(fake(['s', 'm', null], 2), fake(['s', 'm', null, null], 3)).same);
}

// Both deal from one position, with columns alike in different places: no choice.
{
  const fake = (keys, moves) => ({ keys, moves });
  const r = relate(fake(['s', 'a'], [{ deal: true }]), fake(['s', 'b'], [{ deal: true }]));
  assert.equal(r.split.kind, 'cards');
}

// The computer's game is legal, won or not, the same each time, and ends where
// it should; its moves read as a line, and it has a move everywhere it stands.
{
  const ask = async p => nextMoves(p);
  const first = await computerGame(4, 20820, ask), again = await computerGame(4, 20820, ask);
  assert.equal(encodeMoves(first.moves), encodeMoves(again.moves));
  const g = new Game(4, 20820);
  for (const mv of first.moves) assert.equal(g.check(mv), null), g.applyRaw(mv);
  assert.equal(g.isWon(), first.won);
  const line = readLine(4, 20820, first.moves, 'lost');
  assert.equal(line.over, first.won ? 'won' : 'lost');
  // Compared with a line that shares its first move: the split is after it.
  const other = read(20820, first.moves.slice(0, 1));
  const r = relate(line, other);
  assert.deepEqual([r.split.a, r.split.b, r.split.kind, r.split.ended], [1, 1, 'end', 'b']);
  // A piece of a line up to what it shows.
  const seg = nextShow(line, 0);
  assert.ok(seg.to >= 1 && seg.moves.length === seg.to);
  assert.ok(seg.shows === null || seg.to === line.stretches[0].to);
  // Parts: one more than there are deals, joined, and valued from the jobs.
  const values = new Map(valueJobs(line).map(j => [j.key, 0.5]));
  const ps = parts(line, values);
  assert.equal(ps.length, line.deals.length + 1);
  for (let k = 1; k < ps.length; k++) assert.equal(ps[k].start, ps[k - 1].to);
  assert.equal(ps[ps.length - 1].end, line.moves.length);
  // Rows: a line with no deals against one with more, diff only where both are.
  const short = readLine(4, 20820, first.moves.slice(0, 3));
  const shortValues = new Map(valueJobs(short).map(j => [j.key, 0.4]));
  const all = rows(line, short, values, shortValues);
  assert.equal(all.length, Math.max(line.deals.length, short.deals.length) + 1);
  assert.ok(all.slice(short.deals.length + 1).every(x => x.b === null && x.diff === null));
  assert.ok(keyRows([{ r: 0, diff: 0.01 }, { r: 1, diff: -0.2 }, { r: 2, diff: 0.1 }, { r: 3, diff: null }]).map(x => x.r).join() === '1,2');
  // The gap is of the chances, a game over counting as what it came to, and adds up.
  const both = rows(short, short, shortValues, shortValues);
  assert.ok(both.every(x => x.gap === 0 && x.diff === 0));
  const ends = all.filter(x => x.gap !== null);
  assert.ok(Math.abs(ends.reduce((sum, x) => sum + x.diff, 0) - ends[ends.length - 1].gap) < 1e-9);
  assert.equal(ps[ps.length - 1].value, first.won ? 1 : 0);
}

console.log('ok');
