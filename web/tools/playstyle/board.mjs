// The board as the player sees it, for playstyle's searches: only the cards
// face up (a card that has just come up and is not to be known yet is UNKNOWN);
// what is face down is a count. So nothing here can use a hidden card.
//
// A position is {cols, down, done, left, hs}: per column its face-up cards from
// the bottom and how many are face down under them, the suits completed, the
// cards in the stock, and per column a hash (a position's key is their sum, so
// that the order of the columns does not matter). Positions are not changed:
// a move makes a new one, sharing the columns it leaves alone.
export const UNKNOWN = 255;
export const rankOf = c => c % 13;
export const suitOf = c => Math.floor(c / 13);
const NC = 10;

function colHash(col, d) {
  let a = Math.imul(d + 7, 0x01000193), b = Math.imul(col.length + 0x51, 0x2C1B3C6D) + d;
  for (let i = 0; i < col.length; i++) {
    const x = col[i] + 1;
    a = Math.imul(a ^ x, 0x01000193);
    b = Math.imul(b + x, 0xCC9E2D51);
    b = (b << 15) | (b >>> 17);
  }
  a ^= a >>> 16; a = Math.imul(a, 0x85EBCA6B); a ^= a >>> 13;
  b ^= b >>> 15; b = Math.imul(b, 0x2C1B3C6D); b ^= b >>> 12;
  return (a >>> 0) + (b & 0x1FFFF) * 4294967296;
}

export function fromGame(g) {
  const cols = g.columns.map((c, i) => c.slice(g.faceDown[i])), down = [...g.faceDown];
  return { cols, down, done: g.completed.length, left: g.stock.length, hs: cols.map((c, i) => colHash(c, down[i])) };
}

export const keyOf = p => {
  let k = p.left * 1e12 + p.done * 1e14;
  for (let c = 0; c < NC; c++) k += p.hs[c];
  return k;
};
export const empties = p => { let n = 0; for (let c = 0; c < NC; c++) if (!p.cols[c].length) n++; return n; };
export const hiddenOf = p => { let n = 0; for (let c = 0; c < NC; c++) n += p.down[c]; return n; };

// How many cards from the top of col are a same-suit descending run.
export function runOf(col) {
  const n = col.length;
  if (!n || col[n - 1] === UNKNOWN) return 0;
  let k = 1;
  while (n - k > 0) {
    const up = col[n - k - 1], lo = col[n - k];
    if (up === UNKNOWN || suitOf(up) !== suitOf(lo) || rankOf(up) !== rankOf(lo) + 1) break;
    k++;
  }
  return k;
}

// The moves of a position with what they are:
// {from, to, count, card, reveal, toEmpty, sameTarget, offTarget, parent, split, tail}
// card: the moved run's head; parent: the card it leaves (undefined: none);
// split: it leaves a card of its own suit that it was linked to; tail: it
// leaves a card one rank above it, of any suit, and goes to another.
// `reveal`: the move turns a card over (leaving nothing on a face-down card).
// Of the empty columns only the first is offered, and a whole column with
// nothing under it is not moved to one.
export function movesOf(p) {
  const out = [], { cols, down } = p;
  let firstEmpty = -1;
  for (let c = 0; c < NC; c++) if (!cols[c].length) { firstEmpty = c; break; }
  for (let from = 0; from < NC; from++) {
    const col = cols[from], n = col.length, r = runOf(col);
    for (let count = 1; count <= r; count++) {
      const card = col[n - count], rank = rankOf(card), parent = count < n ? col[n - count - 1] : undefined;
      const reveal = count === n && down[from] > 0;
      const linked = parent !== undefined && parent !== UNKNOWN && rankOf(parent) === rank + 1;
      const split = linked && suitOf(parent) === suitOf(card);
      for (let to = 0; to < NC; to++) {
        if (to === from) continue;
        const tc = cols[to];
        if (!tc.length) {
          if (to !== firstEmpty) continue;
          if (count === n && !down[from]) continue;
          out.push({ from, to, count, card, reveal, toEmpty: true, sameTarget: false, offTarget: false, parent, split, tail: linked });
        } else {
          const top = tc[tc.length - 1];
          if (top === UNKNOWN || rankOf(top) !== rank + 1) continue;
          const same = suitOf(top) === suitOf(card);
          out.push({ from, to, count, card, reveal, toEmpty: false, sameTarget: same, offTarget: !same, parent, split, tail: linked });
        }
      }
    }
  }
  return out;
}

// The position after a move ({from, to, count}, or {deal: true}). The result's
// `shows` says if it turned a card or dealt; what came is UNKNOWN.
export function play(p, mv) {
  const cols = p.cols.slice(), down = p.down.slice(), hs = p.hs.slice();
  let done = p.done, left = p.left, shows = false;
  if (mv.deal) {
    for (let c = 0; c < NC; c++) { cols[c] = [...cols[c], UNKNOWN]; hs[c] = colHash(cols[c], down[c]); }
    left -= NC;
    shows = true;
  } else {
    const { from, to, count } = mv, src = cols[from];
    const moved = src.slice(src.length - count);
    cols[from] = src.slice(0, src.length - count);
    cols[to] = [...cols[to], ...moved];
    if (!cols[from].length && down[from] > 0) { down[from]--; cols[from] = [UNKNOWN]; shows = true; }
    const t = cols[to];
    if (t.length >= 13 && rankOf(t[t.length - 13]) === 12) {
      let whole = true;
      for (let i = t.length - 13; i < t.length - 1; i++) {
        if (t[i] === UNKNOWN || t[i + 1] === UNKNOWN || suitOf(t[i]) !== suitOf(t[i + 1]) || rankOf(t[i]) !== rankOf(t[i + 1]) + 1) { whole = false; break; }
      }
      if (whole) {
        cols[to] = t.slice(0, t.length - 13);
        done++;
        if (!cols[to].length && down[to] > 0) { down[to]--; cols[to] = [UNKNOWN]; shows = true; }
      }
    }
    hs[from] = colHash(cols[from], down[from]);
    hs[to] = colHash(cols[to], down[to]);
  }
  return { cols, down, done, left, hs, shows };
}

export const canDeal = p => p.left > 0 && p.cols.every(c => c.length > 0);

// Everything to be reached from a position by moves that show nothing, at most
// maxDepth of them and maxNodes positions, breadth first (so each is had by a
// shortest line). `moves` may be restricted. Returns
//   commits: Map key -> {p, node, mv, depth, kind}: the positions a move that
//            shows cards leads to (kind 'turn' or 'deal'), cards not yet known
//   run, empty: the first node with a suit more completed / a column more empty
//   nodes: how many positions were looked at; capped: whether it stopped short
export function reach(start, { maxDepth = 12, maxNodes = 30000, filter = null } = {}) {
  const seen = new Set([keyOf(start)]), e0 = empties(start), d0 = start.done;
  const queue = [{ p: start, parent: null, mv: null, depth: 0 }], commits = new Map();
  let run = null, empty = null, capped = false, i = 0;
  const addCommit = (p, node, mv, kind) => {
    const k = keyOf(p);
    if (!commits.has(k)) commits.set(k, { p, node, mv, depth: node.depth + 1, kind });
  };
  for (; i < queue.length; i++) {
    const node = queue[i];
    if (canDeal(node.p)) addCommit(play(node.p, { deal: true }), node, { deal: true }, 'deal');
    if (node.depth >= maxDepth) continue;
    for (const m of movesOf(node.p)) {
      if (filter && !filter(m, node.p)) continue;
      const mv = { from: m.from, to: m.to, count: m.count }, q = play(node.p, mv);
      if (q.done > d0 && !run) run = { node, mv, depth: node.depth + 1 };
      if (q.shows) { addCommit(q, node, mv, 'turn'); continue; }
      const k = keyOf(q);
      if (seen.has(k)) continue;
      seen.add(k);
      const child = { p: q, parent: node, mv, depth: node.depth + 1 };
      if (!empty && empties(q) > e0) empty = child;
      if (queue.length < maxNodes) queue.push(child); else capped = true;
    }
  }
  return { commits, run, empty, nodes: queue.length, capped, depthReached: queue[queue.length - 1].depth };
}

// The moves of a commit, or of a node (with a last move `last`), from the start.
export function pathOf(node, last = null) {
  const out = last ? [last] : [];
  for (let n = node; n && n.mv; n = n.parent) out.push(n.mv);
  return out.reverse();
}

// What kind of line the moves are: whether any move goes to an empty column,
// leaves a link (tail), splits a same-suit run, or goes on a card of another suit.
export function tagsOf(start, path) {
  const tags = { toEmpty: false, tail: false, split: false, off: false };
  let p = start;
  for (const mv of path) {
    if (!mv.deal) {
      const m = movesOf(p).find(x => x.from === mv.from && x.count === mv.count && (x.to === mv.to || (x.toEmpty && !p.cols[mv.to].length)));
      if (m) {
        tags.toEmpty ||= m.toEmpty;
        tags.tail ||= m.tail && !m.toEmpty && !m.reveal;
        tags.split ||= m.split;
        tags.off ||= m.offTarget;
      }
    }
    p = play(p, mv);
  }
  return tags;
}
export const categoryOf = (tags, len) => (len === 1 ? 'direct' : tags.toEmpty ? 'via-empty' : tags.split ? 'split-run' : tags.tail ? 'tail-swap' : tags.off ? 'off-suit' : 'chain');

// ---------------------------------------------------------------- features

export const FEATURES = ['deal', 'flipLeft', 'empties', 'same', 'off', 'offHigh', 'breaks', 'runSq', 'done', 'dig', 'minDown', 'spread', 'buriedKings', 'kingBase', 'ranksOpen', 'mobility', 'turnable', 'steps'];
export const FEATURE_TEXT = {
  deal: 'dealing rather than turning a card',
  flipLeft: 'face-down cards left under the card turned',
  empties: 'an empty column',
  same: 'a same-suit link',
  off: 'an off-suit link',
  offHigh: 'an off-suit link being high (K-Q against 2-A)',
  breaks: 'a break in a column (face-up neighbours that do not link)',
  runSq: 'long runs (the squares of same-suit run lengths)',
  done: 'a completed suit',
  dig: 'cards on the nearest face-down card',
  minDown: 'face-down cards in the shallowest column still hiding any',
  spread: 'uneven column heights (their standard deviation)',
  buriedKings: 'a king not at the bottom of its column',
  kingBase: 'a clean column on a king',
  ranksOpen: 'different ranks on top of columns',
  mobility: 'legal moves',
  turnable: 'columns that could be cleared onto something at once',
  steps: 'moves in the line to get there',
};

// Features of a position a move that shows cards led to (the `from` the
// position the stretch began in). Ranks: 0 ace .. 12 king.
export function features(p, kind, start, depth) {
  const { cols, down } = p;
  let same = 0, off = 0, offHigh = 0, breaks = 0, runSq = 0, dig = 30, minDown = 30, buried = 0, kingBase = 0, turnable = 0;
  let sum = 0, sq = 0, flipLeft = 0;
  const ranks = new Set();
  for (let c = 0; c < NC; c++) {
    const col = cols[c], n = col.length, len = n + down[c];
    sum += len; sq += len * len;
    if (n) {
      const top = col[n - 1];
      if (top !== UNKNOWN) ranks.add(rankOf(top));
      else if (kind === 'turn' && start.down[c] > down[c]) flipLeft = down[c];
    }
    if (down[c]) { dig = Math.min(dig, n); minDown = Math.min(minDown, down[c]); }
    let cur = 1;
    for (let i = 0; i < n; i++) {
      const x = col[i];
      if (x !== UNKNOWN && rankOf(x) === 12) { if (i === 0 && !down[c]) kingBase++; else buried++; }
      if (i + 1 < n) {
        const y = col[i + 1];
        if (x === UNKNOWN || y === UNKNOWN) { runSq += cur * cur; cur = 1; continue; }
        if (rankOf(x) === rankOf(y) + 1) {
          if (suitOf(x) === suitOf(y)) { same++; cur++; continue; }
          off++; offHigh += rankOf(y) / 11;
        } else breaks++;
        runSq += cur * cur; cur = 1;
      }
    }
    if (n) runSq += cur * cur;
  }
  if (dig === 30) { dig = 0; minDown = 0; }
  const ms = movesOf(p);
  for (const m of ms) if (m.reveal && !m.toEmpty) turnable++;
  const mean = sum / NC, spread = Math.sqrt(Math.max(0, sq / NC - mean * mean));
  return [kind === 'deal' ? 1 : 0, flipLeft, empties(p), same, off, offHigh, breaks, runSq / 10, p.done, dig, minDown, spread, buried, kingBase, ranks.size, ms.length, turnable, depth];
}

// ---------------------------------------------------------------- the named questions (T4)

export const QUESTIONS = {
  sameVsOff: ['The same cards can go on a card of their suit or of another', 'of their suit', 'of another suit'],
  fewerHidden: ['Two equally good targets: on a column with fewer face-down cards or more', 'fewer face-down', 'more face-down'],
  flipShort: ['Two cards can be turned: in the column with fewer face-down cards left or more (by 2+)', 'fewer left', 'more left'],
  cleanVsBurn: ['Two cards can be turned: one by a move onto a card, the other by spending an empty column', 'onto a card', 'spend the empty'],
  flipVsJoin: ['Turn a card now, or first join a same-suit link elsewhere', 'turn now', 'join first'],
  dealVsTidy: ['With a deal available and a same-suit link to be made: deal now or join first', 'deal now', 'join first'],
  freeVsSplit: ['Two cards of a rank can go to the same target: one free, one splitting a same-suit run', 'the free one', 'split the run'],
  kingVsLow: ['Filling an empty column: a run headed by a king, or one headed by a 6 or lower', 'the king', 'the low run'],
  highVsLowOff: ['Two off-suit moves that do not turn a card: the higher card (by 3+) or the lower', 'higher', 'lower'],
  cardVsEmpty: ['The same cards can go on a card or to an empty column', 'on a card', 'to the empty column'],
};

const sameMove = (m, mv, p) => !mv.deal && m.from === mv.from && m.count === mv.count && (m.to === mv.to || (m.toEmpty && !p.cols[mv.to].length));

// Which questions the move `mv` of position p answers: [{q, pick: 'A' | 'B', A, B}]
// (A and B the two moves, the other picked by `below`), and in `open` (a set,
// if given) each question the position asks at all.
export function questions(p, mv, below, open = null) {
  const ms = movesOf(p), out = [];
  const plain = m => ({ from: m.from, to: m.to, count: m.count });
  const q = (name, isA, isB) => {
    let A = null, B = null;
    if (open) for (const a of ms) { if (isA(a) && ms.some(b => b !== a && isB(b, a))) { open.add(name); break; } }
    const mine = mv.deal ? null : ms.find(m => sameMove(m, mv, p));
    if (!mine) return;
    // (A move may be either side of a question: then at random, of those that have another side.)
    const asA = isA(mine) ? ms.filter(b => b !== mine && isB(b, mine)) : [];
    const asB = isB(mine, null) ? ms.filter(a => a !== mine && isA(a) && isB(mine, a)) : [];
    if (!asA.length && !asB.length) return;
    if (asA.length && (!asB.length || below(2))) { A = mine; B = asA[below(asA.length)]; out.push({ q: name, pick: 'A', A: plain(A), B: plain(B) }); }
    else { B = mine; A = asB[below(asB.length)]; out.push({ q: name, pick: 'B', A: plain(A), B: plain(B) }); }
  };
  const sameRun = (a, b) => a.from === b.from && a.count === b.count;
  q('sameVsOff', a => a.sameTarget, (b, a) => b.offTarget && (!a || sameRun(a, b)));
  q('fewerHidden', a => !a.toEmpty, (b, a) => !b.toEmpty && (!a || (sameRun(a, b) && a.sameTarget === b.sameTarget && p.down[a.to] < p.down[b.to])));
  q('flipShort', a => a.reveal && !a.toEmpty, (b, a) => b.reveal && !b.toEmpty && (!a || (a.from !== b.from && p.down[a.from] + 2 <= p.down[b.from])));
  q('cleanVsBurn', a => a.reveal && !a.toEmpty, (b, a) => b.reveal && b.toEmpty && (!a || a.from !== b.from));
  q('flipVsJoin', a => a.reveal && !a.toEmpty, (b, a) => !b.reveal && b.sameTarget && (!a || (a.from !== b.from && a.to !== b.to && a.from !== b.to && a.to !== b.from)));
  q('freeVsSplit', a => !a.toEmpty && !a.split, (b, a) => !b.toEmpty && b.split && (!a || (a.to === b.to && a.from !== b.from)));
  q('kingVsLow', a => a.toEmpty && rankOf(a.card) === 12, (b, a) => b.toEmpty && rankOf(b.card) <= 5 && (!a || a.from !== b.from));
  q('highVsLowOff', a => a.offTarget && !a.reveal, (b, a) => b.offTarget && !b.reveal && (!a || (a.from !== b.from && rankOf(a.card) >= rankOf(b.card) + 3)));
  q('cardVsEmpty', a => !a.toEmpty, (b, a) => b.toEmpty && (!a || sameRun(a, b)));
  // A deal against a join.
  if (canDeal(p)) {
    const joins = ms.filter(m => !m.reveal && m.sameTarget && !m.split);
    if (joins.length) {
      open?.add('dealVsTidy');
      // (Asked of deals alone: a join is made before a deal that may come much later, so it says nothing against one.)
      if (mv.deal) out.push({ q: 'dealVsTidy', pick: 'A', A: { deal: true }, B: plain(joins[below(joins.length)]) });
    }
  }
  return out;
}
