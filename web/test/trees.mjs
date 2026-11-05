// The times of the tree of moves (game.js): round trip, a save without them,
// merging, and that nothing else about a game depends on them.
import assert from 'node:assert/strict';
import { Game, encodeMoves, parseTree, treeText, timesText, mergeTree, addTimes } from '../static/game.js';

const legal = g => g.hintMoves().map(m => m.mv ?? m);

// A game with a branch, as played.
const g = new Game(4, 20820);
for (let i = 0; i < 6; i++) assert.equal(g.apply(legal(g)[0]), null);
const played = g.moves().map(m => encodeMoves([m]));
for (let i = 0; i < 3; i++) g.undo();
const alt = legal(g).find(m => encodeMoves([m]) !== played[g.history.length]);
assert.equal(g.apply(alt), null);
const stamp = (n, t) => { for (const c of n.children) { c.t = t; stamp(c, t + 7); } };
stamp(g.root, 17000000000);

// Round trip, and the tree's own text does not change.
const tree = g.treeText();
assert.ok(!tree.includes('@'));
const times = timesText(g.root);
assert.match(times, /^[^@]+@17000000000,/);
const back = addTimes(parseTree(tree), times);
assert.equal(timesText(back), times);
assert.equal(treeText(back), tree);

// A save without times: no times, and the same game.
const old = parseTree(tree);
assert.equal(timesText(old), '');
assert.equal(timesText(addTimes(parseTree(tree), undefined)), '');
assert.equal(timesText(addTimes(parseTree(tree), 'not times')), '');
const a = new Game(4, 20820), b = new Game(4, 20820);
a.adopt(old);
b.adopt(addTimes(parseTree(tree), times));
assert.deepEqual([a.undos, a.realUndos], [b.undos, b.realUndos]);
assert.equal(a.treeText(), b.treeText());

// Only moves new to the tree get a time, and replaying a save gives none.
const c = new Game(4, 20820);
c.adopt(parseTree(tree));
for (const m of g.moves()) assert.equal(c.apply(m, 0), null);
assert.equal(timesText(c.root), '');
const before = Math.round(Date.now() / 100);
assert.equal(c.apply(legal(c).find(m => !c.line.at(-1).children.some(n => n.key === encodeMoves([m])))), null);
const t = c.line.at(-1).t;
assert.ok(t >= before);
c.undo();
c.redo();
assert.equal(c.line.at(-1).t, t, 'going back into a move keeps its time');

// A partly timed tree: moves on the way to a timed one are named, without a time.
assert.equal(timesText(c.root).split('@').length, 2);
assert.equal(timesText(addTimes(parseTree(c.treeText()), timesText(c.root))), timesText(c.root));

// Merging keeps the earlier time, takes one where only one has it, either way round.
const one = parseTree('d@100,1>2:3@5');
const two = parseTree('d@90,1>2:3@50|1>3:1@1');
const find = (r, ...keys) => keys.reduce((p, k) => p.children.find(x => x.key === k), r);
for (const merged of [mergeTree(mergeTree({ children: [] }, one), two), mergeTree(mergeTree({ children: [] }, two), one)]) {
  assert.equal(find(merged, 'd').t, 90);
  assert.equal(find(merged, 'd', '1>2:3').t, 105); // 100 + 5 against 90 + 50... the earlier of the two
  assert.equal(find(merged, '1>3:1').t, 1);
}
assert.equal(find(mergeTree(parseTree('d'), parseTree('d@9')), 'd').t, 9);

// A clock that went back: a move before the one above it still round-trips.
const skew = parseTree('d@100,d@-30');
assert.equal(find(skew, 'd', 'd').t, 70);
assert.equal(timesText(skew), 'd@100,d@-30');

// Times of moves the tree has not got are left out, and the tree gets no moves.
assert.equal(treeText(addTimes(parseTree('d'), 'd@1,1>2:3@4')), 'd');
console.log('ok');
