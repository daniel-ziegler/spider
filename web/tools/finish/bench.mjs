// Compares auto-complete's rules (static/solve.js) with search.mjs on endgames that can
// be won: winning play run backwards from the cleared board for a number of
// moves. For each suit count and depth prints how many each solves, the time
// each takes, and the lengths of their lines where both solve. Then the same
// for the cards of the last 8, 6 or 4 runs shuffled over the columns (depth
// r8, r6, r4), which is far messier than play gets and often cannot be won.
//   node bench.mjs [positions per row, default 50]
import { Game, rankOf, runLen } from '../../static/game.js';
import { greedyLine } from '../../static/solve.js';
import { search } from './search.mjs';

let state = 4242;
const rand = n => {
  state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};

function scrambleOnce(suits, depth) {
  const cols = Array.from({ length: 10 }, () => []);
  let runs = 8, fails = 0;
  for (let d = 0; d < depth || runs; ) {
    if (runs && (d >= depth || rand(depth) < 24)) {
      // Undo a completion: the run comes back, in the two parts that met.
      const suit = --runs % suits, c = cols[rand(10)];
      for (let r = 12; r >= 0; r--) c.push(suit * 13 + r);
      let o;
      do o = cols[rand(10)]; while (o === c);
      o.push(...c.splice(c.length - 1 - rand(12)));
      continue;
    }
    // Undo a move: part of a run goes anywhere, if it could have come back.
    const to = rand(10), from = rand(10), t = cols[to];
    if (to === from || !t.length) { if (!cols.some(c => c.length)) d++; continue; }
    const count = 1 + rand(runLen(t, 0));
    if (count < t.length && rankOf(t[t.length - count - 1]) !== rankOf(t[t.length - count]) + 1) {
      if (++fails % 200 === 0) d++;
      continue;
    }
    cols[from].push(...t.splice(t.length - count));
    d++;
  }
  return cols;
}

// A scramble in which no whole run is left standing (play would have cleared it).
function scramble(suits, depth) {
  for (;;) {
    const cols = scrambleOnce(suits, depth);
    if (!cols.some(c => c.some((_, i) => i >= 12 && runLen(c.slice(0, i + 1), 0) >= 13))) return cols;
  }
}

function check(cols, line) {
  const g = Object.create(Game.prototype);
  Object.assign(g, { columns: cols.map(c => [...c]), faceDown: cols.map(() => 0), stock: [], history: [], redoStack: [] });
  g.completed = Array(8 - cols.flat().length / 13).fill(0);
  for (const mv of line) if (g.apply(mv)) throw new Error('illegal move');
  if (!g.isWon()) throw new Error('line does not win');
}

function shuffled(suits, runs) {
  const deck = [];
  for (let s = 0; s < runs; s++) for (let r = 0; r < 13; r++) deck.push((s % suits) * 13 + r);
  for (let j = deck.length - 1; j > 0; j--) {
    const k = rand(j + 1);
    [deck[j], deck[k]] = [deck[k], deck[j]];
  }
  const cols = Array.from({ length: 10 }, () => []);
  deck.forEach((c, j) => cols[runs === 8 ? j % 10 : rand(10)].push(c));
  return cols;
}

const per = +process.argv[2] || 50;
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? NaN;
const fmt = ms => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)).padStart(5);
const all = { scrambled: { n: 0, greedy: 0, search: 0, onlyGreedy: 0 }, shuffled: { n: 0, greedy: 0, search: 0, onlyGreedy: 0 } };
console.log('suits depth |  greedy solved  median    max ms |  search solved  first: median  max ms |  moves where both solve: greedy  search first  search final');
for (const suits of [1, 2, 3, 4]) for (const depth of [20, 40, 80, 150, 300, 1000, 'r8', 'r6', 'r4']) {
  const r = { greedy: 0, search: 0, onlyGreedy: 0, gMs: [], sMs: [], both: 0, gLen: 0, sFirst: 0, sLen: 0 };
  for (let i = 0; i < per; i++) {
    const cols = typeof depth === 'number' ? scramble(suits, depth) : shuffled(suits, +depth[1]);
    let t = performance.now();
    const greedy = greedyLine(cols);
    r.gMs.push(performance.now() - t);
    t = performance.now();
    let first = null, best = null, firstMs = 0;
    search({ columns: cols }, line => {
      if (!first) { first = line; firstMs = performance.now() - t; }
      best = line;
    });
    if (greedy) check(cols, greedy);
    if (best) { check(cols, best); r.sMs.push(firstMs); }
    r.greedy += !!greedy;
    r.search += !!best;
    r.onlyGreedy += !!greedy && !best;
    if (greedy && best) { r.both++; r.gLen += greedy.length; r.sFirst += first.length; r.sLen += best.length; }
  }
  const a = typeof depth === 'number' ? all.scrambled : all.shuffled;
  a.n += per; a.greedy += r.greedy; a.search += r.search; a.onlyGreedy += r.onlyGreedy;
  const pct = n => `${String(n).padStart(3)}/${per} ${(100 * n / per).toFixed(0).padStart(3)}%`;
  const avg = x => (x / r.both).toFixed(1).padStart(6);
  console.log(`${String(suits).padStart(5)} ${String(depth).padStart(5)} |  ${pct(r.greedy)}   ${fmt(median(r.gMs))}  ${fmt(Math.max(...r.gMs))}    |  ${pct(r.search)}        ${fmt(median(r.sMs))}   ${fmt(Math.max(...r.sMs))}  |  ${avg(r.gLen)}  ${avg(r.sFirst)}  ${avg(r.sLen)}`);
}
for (const [name, a] of Object.entries(all)) console.log(`${name}: greedy ${a.greedy}/${a.n}, search ${a.search}/${a.n}, greedy alone ${a.onlyGreedy}`);
