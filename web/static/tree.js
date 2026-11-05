// The undo tree (from the menu, or t): every move played from the deal, as a
// tree beside the board (under it on a phone), with the position on the board
// marked. Tapping a position goes there as the buttons would: undo back to
// where the two lines part, then the moves down to it (each undo counted as
// an undo is, the moves played again free). Loaded with it, not with the page.
//
// The drawing: one row per move from the deal down, the line of each node's
// longest branch going straight on and the others to its right, each in a
// lane of its own as long as it lasts. Long stretches where nothing happens
// (no branch starts or ends, no deal) are folded to one row, which a tap
// opens. Moves that turned a card over are white dots, deals purple squares
// (the cards' back), won ends a star and ends with no move left a cross.
import { COLS, HOME } from './freecell.js';

let styled = null;
function style() {
  styled ??= new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/tree.css';
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
  return styled;
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const FOLD = 6; // a stretch of this many quiet moves or more is folded
const MARGIN = 2; // moves kept on either side of what happens
const GUTTER = 40; // for the move numbers

// What a move does, said before and after it is played on `copy` (a game of
// the same deal, walked over the tree).
// When a move was first played (node.t, tenths of a second), as a person says it.
function ago(t) {
  const s = Date.now() / 1000 - t / 10, unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

function describe(copy, mv, cardName) {
  if (mv.deal) return 'Deal';
  if (copy.freecell) {
    const src = copy.pile(mv.from), card = src[src.length - mv.count];
    const where = p => (p === HOME ? 'to the foundation' : p >= COLS ? 'to a free cell' : copy.columns[p].length ? `on ${cardName(copy.columns[p].at(-1))}` : `to empty column ${p + 1}`);
    return `${cardName(card)}${mv.count > 1 ? ` (${mv.count} cards)` : ''} ${where(mv.to)}`;
  }
  const src = copy.columns[mv.from], top = copy.columns[mv.to].at(-1);
  return `${cardName(src[src.length - mv.count])}${mv.count > 1 ? ` (${mv.count} cards)` : ''} ${top === undefined ? `to empty column ${(mv.to + 1) % 10}` : `on ${cardName(top)}`}`;
}

function shown(copy, rec, cardName) {
  const out = [];
  if (copy.freecell) {
    if (rec.auto?.length) out.push(`${plural(rec.auto.length, 'card')} to the foundations`);
    return out;
  }
  for (const c of rec.flips) out.push(`turned ${cardName(copy.columns[c][copy.faceDown[c]])}`);
  if (rec.completed.length) out.push(rec.completed.length > 1 ? `completed ${rec.completed.length} suits` : 'completed a suit');
  return out;
}

// The tree laid out: for every node {parent, depth, lane, text, won, lost},
// the nodes at each depth, and the lanes used.
function layout(g, copy, cardName) {
  const info = new Map([[g.root, { parent: null, depth: 0, lane: 0, text: 'The deal', won: false, lost: false }]]);
  const walk = (n, depth) => {
    for (const kid of n.children) {
      const what = describe(copy, kid.mv, cardName);
      copy.enter(kid);
      const won = copy.isWon(), lost = !won && !kid.children.length && !copy.hintMoves().length;
      info.set(kid, { parent: n, depth: depth + 1, lane: 0, text: [what, ...shown(copy, copy.history.at(-1), cardName)].join(' · '), won, lost });
      walk(kid, depth + 1);
      copy.leave();
    }
  };
  walk(g.root, 0);
  // The longest branch first (ties by the move, so that the drawing does not
  // change when the order of the children does, as undoing changes it).
  const heights = new Map();
  const height = n => {
    if (!heights.has(n)) heights.set(n, n.children.reduce((m, c) => Math.max(m, height(c) + 1), 0));
    return heights.get(n);
  };
  const order = n => [...n.children].sort((a, b) => height(b) - height(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const lanes = [];
  const free = (l, s, e) => !(lanes[l] ??= []).some(([a, b]) => a <= e + 1 && s <= b + 1);
  const place = (start, lane) => {
    const chain = [];
    for (let n = start; n; n = order(n)[0]) chain.push(n);
    const s = info.get(start).depth;
    (lanes[lane] ??= []).push([s, s + chain.length - 1]);
    for (const n of chain) info.get(n).lane = lane;
    for (const n of chain) {
      for (const kid of order(n).slice(1)) {
        const d = info.get(kid).depth;
        let l = lane + 1;
        while (!free(l, d, d + height(kid))) l++;
        place(kid, l);
      }
    }
  };
  place(g.root, 0);
  const byDepth = [];
  for (const [n, i] of info) (byDepth[i.depth] ??= []).push(n);
  return { info, byDepth, lanes: lanes.length };
}

// Open the tree. ctx: {game() (the game on the board), copy() (a new game of
// its deal), busy() (whether the board may not be played on now), confirm(title,
// text, ok) (a promise of yes or no), moved() (after a jump: save and draw),
// relayout() (the board's size changed), cardName, closed()}. Returns
// {update() (to be called whenever the board is drawn), close()}.
export function open(ctx) {
  const el = document.createElement('aside');
  el.id = 'tree';
  el.innerHTML = `<div class="tr-head"><b>Undo tree</b><span class="tr-count"></span><button class="tr-close" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="tr-info"></div>
    <div class="tr-scroll"></div>
    <div class="tr-legend"><span><i class="k-turn"></i>turned a card</span><span><i class="k-deal"></i>deal</span><span class="k-won">★ won</span><span class="k-lost">✕ no moves</span></div>`;
  const scroll = el.querySelector('.tr-scroll'), infoLine = el.querySelector('.tr-info'), count = el.querySelector('.tr-count');
  let sig = null, forGame = null, laid = null, rows = [], rowOf = [], hover = null, closed = false, lastAt = null;
  const opened = new Set(); // folded stretches opened, by their first move

  const coarse = matchMedia('(pointer: coarse)').matches;
  const R = coarse ? 24 : 16, W = coarse ? 22 : 16, TOP = R / 2 + 4;
  const X = lane => GUTTER + lane * W + W / 2;
  const Y = depth => TOP + rowOf[depth] * R;

  // Which depths get a row: those where something happens, and a little round
  // them; the quiet stretches between are folded unless opened.
  function rowsFor(g) {
    const max = laid.byDepth.length - 1, busy = new Array(max + 1).fill(false);
    busy[0] = busy[max] = true;
    busy[g.line.length - 1] = true;
    for (const [n, i] of laid.info) {
      if (n.children.length !== 1 || n.mv?.deal) busy[i.depth] = true;
      if (i.parent && i.lane !== laid.info.get(i.parent).lane) busy[i.depth] = busy[i.depth - 1] = true;
    }
    const keep = busy.map((_, d) => busy.slice(Math.max(0, d - MARGIN), d + MARGIN + 1).some(Boolean));
    rows = [];
    rowOf = [];
    for (let d = 0; d <= max;) {
      if (keep[d]) { rowOf[d] = rows.length; rows.push({ d }); d++; continue; }
      let e = d;
      while (e + 1 <= max && !keep[e + 1]) e++;
      if (e - d + 1 >= FOLD && !opened.has(d)) {
        for (let k = d; k <= e; k++) rowOf[k] = rows.length;
        rows.push({ gap: [d, e] });
      } else for (let k = d; k <= e; k++) { rowOf[k] = rows.length; rows.push({ d: k }); }
      d = e + 1;
    }
  }

  function say(n) {
    const g = ctx.game(), i = laid?.info.get(n);
    if (!i) return void (infoLine.textContent = '');
    const here = n === g.line.at(-1), onLine = g.line.includes(n);
    const bits = [i.depth ? `<b>Move ${i.depth}</b>` : '<b>Start</b>', esc(i.text)];
    if (i.won) bits.push('<span class="k-won">won</span>');
    if (i.lost) bits.push('<span class="k-lost">no moves left</span>');
    if (n.children.length > 1) bits.push(`${n.children.length} lines from here`);
    bits.push(here ? 'on the board' : onLine ? 'played' : 'undone');
    if (n.t) bits.push(ago(n.t));
    infoLine.innerHTML = bits.join(' · ');
  }

  function draw(g) {
    const { info, byDepth, lanes } = laid;
    rowsFor(g);
    const onLine = new Set(g.line), at = g.line.at(-1);
    const hidden = d => rows[rowOf[d]].gap;
    let edges = '', lit = '', dots = '', labels = '';
    for (const [n, i] of info) {
      if (!i.parent) continue;
      const p = info.get(i.parent), y1 = Y(p.depth), y2 = Y(i.depth);
      if (y1 === y2) continue;
      const x1 = X(p.lane), x2 = X(i.lane);
      const path = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + R * 0.7} ${x2} ${y2 - R * 0.7} ${x2} ${y2}`;
      const line = `<path d="${path}"${hidden(p.depth) || hidden(i.depth) ? ' class="folded"' : ''}/>`;
      if (onLine.has(n)) lit += line; else edges += line;
    }
    for (const r of rows) {
      if (r.gap) {
        const y = TOP + rowOf[r.gap[0]] * R;
        labels += `<text class="gap" x="${GUTTER - 6}" y="${y + 4}">⋯${r.gap[1] - r.gap[0] + 1}</text>`;
        continue;
      }
      const y = Y(r.d);
      if (r.d % 10 === 0 || r.d === at && r.d) labels += `<text x="${GUTTER - 6}" y="${y + 4}">${r.d || 'start'}</text>`;
      for (const n of byDepth[r.d]) {
        const i = info.get(n), x = X(i.lane), cls = onLine.has(n) ? ' on' : '';
        if (n === at) dots += `<circle class="here" cx="${x}" cy="${y}" r="${R * 0.38}"/>`;
        if (n === hover && n !== at) dots += `<circle class="hover" cx="${x}" cy="${y}" r="${R * 0.38}"/>`;
        if (i.won) dots += `<text class="won" x="${x}" y="${y + 5}">★</text>`;
        else if (i.lost) dots += `<text class="lost" x="${x}" y="${y + 4.5}">✕</text>`;
        else if (!i.depth) dots += `<rect class="start${cls}" x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5"/>`;
        else if (n.mv.deal) dots += `<rect class="deal${cls}" x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2"/>`;
        else if (n.real) dots += `<circle class="turn${cls}" cx="${x}" cy="${y}" r="4"/>`;
        else dots += `<circle class="move${cls}" cx="${x}" cy="${y}" r="2.5"/>`;
      }
    }
    const w = GUTTER + lanes * W + 8, h = TOP + rows.length * R;
    scroll.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g class="edges">${edges}</g><g class="lit">${lit}</g>${labels}${dots}</svg>`;
    const moves = info.size - 1, ends = [...info.keys()].filter(n => !n.children.length).length;
    count.textContent = moves ? `${plural(moves, 'move')} · ${plural(Math.max(1, ends), 'line')}` : 'no moves yet';
    if (at !== lastAt) {
      lastAt = at;
      const y = Y(info.get(at).depth), x = X(info.get(at).lane);
      if (y < scroll.scrollTop + R || y > scroll.scrollTop + scroll.clientHeight - R) scroll.scrollTop = y - scroll.clientHeight / 2;
      if (x < scroll.scrollLeft + W || x > scroll.scrollLeft + scroll.clientWidth - W) scroll.scrollLeft = x - scroll.clientWidth / 2;
    }
    say(hover ?? at);
  }

  function update() {
    if (closed || !el.isConnected) return;
    const g = ctx.game();
    if (!g) return;
    const s = `${g.treeText()}#${g.line.map(n => n.key).join(',')}`;
    if (g !== forGame) { opened.clear(); hover = null; lastAt = null; forGame = g; }
    else if (s === sig) return;
    sig = s;
    laid = layout(g, ctx.copy(), ctx.cardName);
    draw(g);
  }

  // The node (or folded stretch) under a point of the drawing.
  function hit(e) {
    const box = scroll.querySelector('svg')?.getBoundingClientRect();
    if (!box || !laid) return null;
    const r = rows[Math.round((e.clientY - box.top - TOP) / R)];
    if (!r) return null;
    if (r.gap) return r;
    const x = e.clientX - box.left;
    let best = null, far = W;
    for (const n of laid.byDepth[r.d]) {
      const dx = Math.abs(X(laid.info.get(n).lane) - x);
      if (dx < far) { best = n; far = dx; }
    }
    return best;
  }

  // Go to node n: undo to where its line and the board's part, then play down to it.
  async function go(n) {
    const g = ctx.game();
    if (ctx.busy() || !laid?.info.has(n)) return;
    const path = [];
    for (let m = n; m; m = laid.info.get(m).parent) path.unshift(m);
    let k = 0;
    while (k < path.length && k < g.line.length && path[k] === g.line[k]) k++;
    const back = g.line.length - k;
    if (!back && k === path.length) return;
    const real = g.line.slice(k).filter(m => m.real && !m.undone).length;
    if (real) {
      const text = g.freecell ? `Going there counts as ${plural(real, 'undo')}.`
        : `Going there takes back ${real === 1 ? 'a deal or a card turned over' : `${real} deals or cards turned over`}: ${plural(real, 'undo')}, not free ones.`;
      const line = g.line.length;
      if (!await ctx.confirm(real === 1 ? 'Use an undo?' : 'Use undos?', text, 'Go there')) return;
      if (ctx.game() !== g || g.line.length !== line || ctx.busy()) return;
    }
    for (let i = 0; i < back; i++) g.undo();
    for (const m of path.slice(k)) if (g.apply(m.mv)) break;
    ctx.moved();
  }

  scroll.addEventListener('click', e => {
    const t = hit(e);
    if (!t) return;
    if (t.gap) {
      opened.add(t.gap[0]);
      draw(ctx.game());
    } else go(t);
  });
  scroll.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !laid) return;
    const t = hit(e), n = t && !t.gap ? t : null;
    if (n === hover) return;
    hover = n;
    draw(ctx.game());
  });
  scroll.addEventListener('pointerleave', () => {
    if (!hover) return;
    hover = null;
    draw(ctx.game());
  });

  function close() {
    if (closed) return;
    closed = true;
    el.remove();
    delete document.body.dataset.tree;
    ctx.closed();
    ctx.relayout();
  }
  el.querySelector('.tr-close').onclick = close;

  style().then(() => {
    if (closed) return;
    document.body.insertBefore(el, document.getElementById('tray'));
    document.body.dataset.tree = '';
    ctx.relayout(); // (which draws the board, and so the tree)
  });
  return { update, close };
}
