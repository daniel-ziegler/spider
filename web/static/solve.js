// Auto-complete's search, in a worker so the board never waits on it. Given
// a game whose cards are all dealt and face up, looks for a short way to win.
// Replies {key, line, done} each time it has a shorter line, and at the end
// (line null if there is no way to win, or none turned up).
//
// With nothing hidden this is a shortest-path problem, searched with anytime
// weighted A*. A card is settled if it is a king or lies on the next card up
// of its suit; a move resettles only the card at the bottom of what it moves,
// so the unsettled cards count the moves still needed at least. The search
// expands the position least in moves so far + WEIGHT * unsettled cards, which
// reaches a first win quickly, then carries on with that win as a bound; if
// it runs dry before its limits, the line it has is a shortest one.
import { Game, parseMoves, encodeMoves } from './game.js';

const WEIGHT = 3;
const MAX_POSITIONS = 400000;
const MAX_MS = 500;

// A column is a string, one char per card; a position is its ten columns.

function runLen(col) {
  let k = col.length && 1;
  while (k < col.length) {
    const lower = col.charCodeAt(col.length - k);
    if (lower % 13 === 12 || col.charCodeAt(col.length - k - 1) !== lower + 1) break;
    k++;
  }
  return k;
}

function unsettled(cols) {
  let n = 0;
  for (const col of cols) {
    for (let i = 0; i < col.length; i++) {
      const c = col.charCodeAt(i);
      if (c % 13 !== 12 && (i === 0 || col.charCodeAt(i - 1) !== c + 1)) n++;
    }
  }
  return n;
}

// Columns can swap places without changing what is possible.
const keyOf = cols => [...cols].sort().join('|');

// Every position one move away, as [columns, move]. Any part of a run may go
// to an empty column, but only to the first one, and not a whole column.
function successors(cols) {
  const out = [];
  const firstEmpty = cols.indexOf('');
  for (let from = 0; from < cols.length; from++) {
    const src = cols[from];
    if (!src) continue;
    const run = runLen(src), rank = src.charCodeAt(src.length - 1) % 13;
    const move = (to, count) => {
      const next = cols.slice();
      next[from] = src.slice(0, src.length - count);
      let dst = cols[to] + src.slice(src.length - count);
      if (dst.charCodeAt(dst.length - 1) % 13 === 0 && runLen(dst) >= 13) dst = dst.slice(0, -13);
      next[to] = dst;
      out.push([next, { from, to, count }]);
    };
    for (let to = 0; to < cols.length; to++) {
      if (to === from) continue;
      const dst = cols[to];
      if (!dst) {
        if (to === firstEmpty) for (let count = Math.min(run, src.length - 1); count >= 1; count--) move(to, count);
      } else {
        const count = dst.charCodeAt(dst.length - 1) % 13 - rank;
        if (count >= 1 && count <= run) move(to, count);
      }
    }
  }
  return out;
}

// A binary heap of nodes, least f first, then least h.
const before = (a, b) => a.f < b.f || (a.f === b.f && a.h < b.h);

function push(heap, node) {
  let i = heap.length;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(node, heap[p])) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = node;
}

function pop(heap) {
  const top = heap[0], last = heap.pop();
  const n = heap.length;
  if (n) {
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && before(heap[c + 1], heap[c])) c++;
      if (!before(heap[c], last)) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = last;
  }
  return top;
}

// Calls found(line) with each shorter winning line; returns whether the last
// one is known to be a shortest (or, if there was none, that none exists).
export function search(game, found, { weight = WEIGHT, maxPositions = MAX_POSITIONS, maxMs = MAX_MS } = {}) {
  const cols = game.columns.map(c => String.fromCharCode(...c));
  const start = { cols, g: 0, h: unsettled(cols), f: 0, parent: null, mv: null };
  if (start.h === 0) return true;
  const reached = new Map([[keyOf(cols), 0]]); // position -> fewest moves to it so far
  const heap = [start];
  const deadline = Date.now() + maxMs;
  let bound = Infinity;
  for (let n = 0; heap.length; n++) {
    if (reached.size > maxPositions || (n % 256 === 0 && Date.now() > deadline)) return false;
    const node = pop(heap);
    if (node.g + node.h >= bound || node.g > reached.get(node.key ?? keyOf(node.cols))) continue;
    const g = node.g + 1;
    for (const [next, mv] of successors(node.cols)) {
      const h = unsettled(next);
      if (g + h >= bound) continue;
      const child = { cols: next, g, h, f: g + weight * h, parent: node, mv, key: null };
      if (h === 0) {
        bound = g;
        const line = [];
        for (let p = child; p.parent; p = p.parent) line.push(p.mv);
        found(line.reverse());
        continue;
      }
      child.key = keyOf(next);
      if (reached.get(child.key) <= g) continue;
      reached.set(child.key, g);
      push(heap, child);
    }
  }
  return true;
}

if (typeof WorkerGlobalScope !== 'undefined') {
  onmessage = ({ data: { key, suits, seed, moves } }) => {
    const game = new Game(suits, seed);
    for (const mv of parseMoves(moves)) game.applyRaw(mv);
    let best = null;
    search(game, line => {
      best = encodeMoves(line);
      postMessage({ key, line: best, done: false });
    });
    postMessage({ key, line: best, done: true });
  };
}
