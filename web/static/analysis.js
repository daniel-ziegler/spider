// The analysis of a game of Spider, somewhat like a Go server's review: the
// player's biggest mistakes, each with the move that would have been better
// and what it was for, a plot of the chance of winning over the moves, and
// the board to step through. app.js loads this only when an analysis is asked
// for, and it then fetches the network; nothing here is part of an ordinary
// page load.
//
// "The chance of winning" is that of a computer player that sees only the
// cards face up and takes nothing back (the line player, lineplayer.js); the
// game analysed is the line of moves on the board, as if it had been played
// straight through (moves taken back are not looked at: the saved tree does
// not say when in the game they were played, so what the player had seen of
// the face-down cards by then is not known).
//
// It comes in two passes, both in workers (analysis-worker.js) and both shown
// as they arrive:
//   1. A network values every position (and each position where cards came
//      up, also before they were known): the curve.
//   2. The mistakes are found by playing games out in shuffles of the cards
//      the player had not seen, from before the player's moves (the line
//      player choosing its own) and from after them: see findMistakes in
//      analysis-core.js, which has what is computed; this file has the
//      workers and the page.
import { prepare, stretchValues, findMistakes, measureLuck, branch, SEARCH, DEAL_SAMPLES } from './analysis-core.js';

const NET_VERSION = 1; // in the networks' address, which is cached for good: change it with them
const VALUES = 6; // positions valued in one piece of work
const ROLL_WEIGHT = 3; // a game played out against a position's valuing, for the progress bar

const nets = new Map(); // suits -> the promise of the network's bytes
function fetchNet(suits) {
  if (!nets.has(suits)) {
    const p = fetch(`/nets/v${suits}.bin?${NET_VERSION}`).then(res => {
      if (!res.ok) throw new Error(res.statusText);
      return res.arrayBuffer();
    });
    p.catch(() => nets.delete(suits));
    nets.set(suits, p);
  }
  return nets.get(suits);
}

// Workers that take one piece of work at a time, in the order given.
class Pool {
  constructor(n, net, onError) {
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
    this.idle = [];
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker('/analysis-worker.js', { type: 'module' });
      const copy = net.slice(0);
      w.postMessage({ net: copy }, [copy]);
      w.onmessage = ({ data }) => {
        const resolve = this.jobs.get(data.id);
        this.jobs.delete(data.id);
        this.idle.push(w);
        resolve(data);
        this.pump();
      };
      w.onerror = onError;
      this.idle.push(w);
      return w;
    });
  }

  run(msg) {
    return new Promise(resolve => {
      this.queue.push({ msg, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const { msg, resolve } = this.queue.shift(), id = this.nextId++;
      this.jobs.set(id, resolve);
      this.idle.pop().postMessage({ id, ...msg });
    }
  }

  close() {
    for (const w of this.workers) w.terminate();
    this.queue = [];
  }
}

let styled = null;
function style() {
  styled ??= new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/analysis.css';
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
  return styled;
}

const pct = p => `${Math.round(p * 100)}%`;
const points = x => `${x < -0.005 ? '−' : x > 0.005 ? '+' : ''}${Math.abs(Math.round(x * 100))}`;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Open the analysis of the moves of a deal: ctx is {suits, seed, moves,
// undos, cardName, render, close}. Returns what app.js draws and asks of it:
// shown (the position on the board), mark (cards to outline), info (the
// header's line), key(event), destroy().
export function open(ctx) {
  const { suits, seed, moves } = ctx, N = moves.length;
  const data = prepare(suits, seed, moves);
  const values = new Map(); // what the network has said: key -> chance
  let vals = null; // its three values of each stretch, once it has said everything
  let cands = []; // the stretches games are being played out for (see findMistakes)
  let found = null; // the mistakes, once they are known: see mistake() for what each has
  let luck = null; // the cards' biggest swing: {t, show, mean}
  let step = N, selected = -1, hover = -1;
  let alt = -1; // the board is on the selected mistake's better line, after this many of its moves (-1: on the game's)
  let pool = null, closed = false, failed = '', phase = 'net', done = 0, spent = 0;
  const total = data.jobs.length + (SEARCH.games + SEARCH.extra) * ROLL_WEIGHT;
  const t0 = performance.now();
  let seconds = 0;

  const el = document.createElement('section');
  el.id = 'review';
  el.innerHTML = `<div class="rv-head">
      <b class="rv-title">Analysis</b>
      <span class="rv-nav"><button data-go="start" title="The deal (Home)">⏮&#xFE0E;</button><button data-go="-1" title="Back a move (←)">◀&#xFE0E;</button><button data-go="1" title="On a move (→)">▶&#xFE0E;</button><button data-go="end" title="The end (End)">⏭&#xFE0E;</button></span>
      <span class="rv-move"></span>
      <span class="rv-status"><span class="rv-bar"><i></i></span><span class="rv-text"></span></span>
      <button class="primary" data-close title="Close the analysis (Esc)">Back<span class="long"> to the game</span></button>
    </div>
    <div class="rv-body">
      <div class="rv-plot"><svg role="img" aria-label="The chance of winning over the moves of the game"></svg><div class="rv-tip" hidden></div></div>
      <div class="rv-side"><p class="rv-sum"></p><div class="rv-keys"></div><p class="rv-luck"></p><p class="rv-note"></p></div>
    </div>`;
  const $ = s => el.querySelector(s);
  const plot = $('.rv-plot'), svg = $('svg'), tip = $('.rv-tip');
  document.querySelector('#tray').before(el);

  // ---- what is known so far

  const value = t => (data.won && t === N ? 1 : values.get(`p${t}`));
  // The value after move t before the cards it showed were known.
  const commitAt = t => {
    const st = { from: t - 1, to: t, shows: data.shows[t - 1] };
    if (st.shows === 'turn' ? !values.has(`u${t}`) : !Array.from({ length: DEAL_SAMPLES }, (_, j) => values.has(`d${t}/${j}`)).every(Boolean)) return undefined;
    const v = stretchValues(st, values, data.won, N, suits);
    return Number.isFinite(v.commit) ? v.commit : undefined;
  };

  // A move in words, from the position it is played in.
  function moveText(mv, before) {
    if (mv.deal) return 'a deal';
    const src = before.columns[mv.from];
    return `${ctx.cardName(src[src.length - mv.count])}${mv.count > 1 ? ` and ${mv.count - 1} more` : ''} to column ${mv.to + 1}`;
  }

  function describe(t) {
    if (t === 0) return 'The deal';
    const before = data.snaps[t - 1], after = data.snaps[t];
    let text = moveText(moves[t - 1], before);
    if (data.shows[t - 1] === 'turn') text += ', turning a card';
    if (after.completed.length > before.completed.length) text += ', finishing a suit';
    return `Move ${t} of ${N}: ${text}`;
  }

  // A mistake found, with what the page says of it: the positions of the
  // better line (alt.snaps[i] after i of its moves; the last of them shows
  // cards: its goal), and the words.
  function mistake(m) {
    const st = data.stretches[m.at], mine = moves[m.move - 1], before = data.snaps[m.move - 1];
    const alt = branch(suits, seed, moves, m.move - 1, m.line), len = alt.snaps.length - 1, line = m.line.slice(0, len);
    const goal = alt.shows[len - 1] ?? { show: null }, first = line[0];
    const early = !!mine.deal && !first.deal;
    // (The line player would have turned the same card, after other moves.)
    const hasty = m.exact && len > 1 && data.shows[m.move - 1] === 'turn' && goal.show === 'turn' && data.snaps[m.move].faceDown[goal.col] < before.faceDown[goal.col];
    const n = len - 2, between = n > 0 ? `${n} more move${n > 1 ? 's' : ''}` : '';
    let goes = '';
    if (goal.show === 'turn') goes = len === 1 ? `, turning the card in column ${goal.col + 1}` : `, then ${between ? `${between} to ` : ''}turn the card in column ${goal.col + 1}`;
    else if (goal.show === 'deal' && len > 1) goes = between ? ` and ${between}, then deal` : ', then deal';
    else if (len > 1) goes = `, then ${len - 1} more move${len > 2 ? 's' : ''}`;
    const end = m.exact ? m.move : st.to, after = end - m.move;
    return {
      ...m, st, alt, len, line, goal, end,
      title: early ? `Move ${m.move}: dealt too early` : hasty ? `Move ${m.move}: a card turned too early` : after ? `Moves ${m.move}–${end}` : `Move ${m.move}`,
      mine: (mine.deal ? 'dealt' : moveText(mine, before)) + (after ? ` and the ${after > 1 ? `${after} moves` : 'move'} after` : ''),
      betterText: [first.deal ? 'deal' : moveText(first, before), goes],
    };
  }

  // ---- drawing

  let frame = 0;
  const redraw = () => { frame ||= requestAnimationFrame(() => { frame = 0; if (!closed) draw(); }); };

  function geometry() {
    const W = plot.clientWidth, H = plot.clientHeight, ml = 40, mr = 14, mt = 24, mb = 20;
    const w = Math.max(10, W - ml - mr), h = Math.max(10, H - mt - mb);
    return { W, H, ml, mt, w, h, X: t => ml + (N ? t / N : 0) * w, Y: p => mt + (1 - p) * h };
  }

  function draw() {
    const { W, H, ml, mt, w, h, X, Y } = geometry();
    if (!W) return;
    const f = x => x.toFixed(1);
    let s = '';
    // The grid: recessive, with the scale on the left and the deals below.
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      s += `<line class="grid${p === 0.5 ? ' mid' : ''}" x1="${ml}" x2="${ml + w}" y1="${f(Y(p))}" y2="${f(Y(p))}"/>`;
      if (p !== 0.25 && p !== 0.75) s += `<text class="axis" x="${ml - 6}" y="${f(Y(p) + 4)}" text-anchor="end">${pct(p)}</text>`;
    }
    let labelled = -99;
    data.shows.forEach((show, i) => {
      if (show !== 'deal') return;
      const x = X(i + 1);
      s += `<line class="deal" x1="${f(x)}" x2="${f(x)}" y1="${mt}" y2="${mt + h + 4}"/>`;
      if (x - labelled < 30) return; // no room for the word
      s += `<text class="axis" x="${f(x)}" y="${H - 5}" text-anchor="middle">deal</text>`;
      labelled = x;
    });
    // The mistake picked out.
    const sel = shownItems()[selected];
    if (sel) s += `<rect class="band" x="${f(X(sel.from))}" width="${f(Math.max(2, X(sel.end) - X(sel.from)))}" y="${mt}" height="${h}"/>`;
    // The curve: what the moves did slopes, what the cards did is upright.
    let area = '', play = '', jumps = '', last = -1;
    for (let t = 0; t <= N; t++) {
      const p = value(t);
      if (p === undefined) continue;
      const c = t > 0 && data.shows[t - 1] && last === t - 1 ? commitAt(t) : undefined;
      if (last < 0) play += `M${f(X(t))},${f(Y(p))}`;
      else if (c !== undefined) {
        play += `L${f(X(t))},${f(Y(c))}M${f(X(t))},${f(Y(p))}`;
        jumps += `M${f(X(t))},${f(Y(c))}L${f(X(t))},${f(Y(p))}`;
      } else play += `L${f(X(t))},${f(Y(p))}`;
      area += `${area ? 'L' : 'M'}${f(X(t))},${f(Y(p))}`;
      last = t;
    }
    if (last > 0) s += `<path class="area" d="${area}L${f(X(last))},${f(Y(0))}L${f(X(0))},${f(Y(0))}Z"/>`;
    s += `<path class="play" d="${play}"/><path class="luck" d="${jumps}"/>`;
    // The mistakes: a numbered mark above each (side by side where they are close), and the cards' biggest swing.
    let marked = -99;
    shownItems().map((m, i) => [m, i]).sort((a, b) => a[0].at - b[0].at).forEach(([m, i]) => {
      const x = X(m.at), bx = marked = Math.max(x, marked + 21);
      s += `<line class="lead" x1="${f(bx)}" x2="${f(x)}" y1="18" y2="${mt}"/>`;
      s += `<g class="badge${i === selected ? ' sel' : ''}${m.sure ? '' : ' unsure'}" data-key="${i}"><circle cx="${f(bx)}" cy="11" r="9"/><text x="${f(bx)}" y="15" text-anchor="middle">${i + 1}</text></g>`;
    });
    if (luck && value(luck.t) !== undefined) s += `<circle class="swing" data-luck cx="${f(X(luck.t))}" cy="${f(Y(value(luck.t)))}" r="4.5"/>`;
    // Where the board is, and where the pointer is.
    const p = value(step);
    s += `<line class="cursor" x1="${f(X(step))}" x2="${f(X(step))}" y1="${mt - 4}" y2="${mt + h + 4}"/>`;
    if (p !== undefined) s += `<circle class="here" cx="${f(X(step))}" cy="${f(Y(p))}" r="5"/>`;
    if (hover >= 0 && hover !== step) s += `<line class="cross" x1="${f(X(hover))}" x2="${f(X(hover))}" y1="${mt}" y2="${mt + h}"/>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;

    // The tooltip.
    tip.hidden = hover < 0;
    if (hover >= 0) {
      const v = value(hover), c = hover > 0 && data.shows[hover - 1] ? commitAt(hover) : undefined, b = value(hover - 1);
      tip.innerHTML = `<b>${hover ? `Move ${hover}` : 'The deal'}</b>${v === undefined ? '' : ` · ${pct(v)}`}`
        + (c !== undefined && b !== undefined && v !== undefined ? `<br>${data.shows[hover - 1] === 'deal' ? 'the deal' : 'the card'} ${points(v - c)}` : '');
      tip.style.left = `${Math.max(60, Math.min(W - 60, X(hover)))}px`;
    }

    // The header's line (its chance may have come since the board was drawn),
    // the line about the move, the progress, the key stretches and the note.
    document.querySelector('#info').innerHTML = review.info;
    const m = alt >= 0 && found[selected];
    $('.rv-move').textContent = m ? `The better line, move ${alt} of ${m.len}: ${moveText(m.line[alt - 1], m.alt.snaps[alt - 1])}${alt === m.len && m.goal.show === 'turn' ? ', turning a card' : ''}`
      : describe(step) + (p === undefined ? '' : ` · ${pct(p)}`);
    const frac = Math.min(1, done / total);
    $('.rv-bar').hidden = phase === 'done' || !!failed;
    $('.rv-bar i').style.width = `${(frac * 100).toFixed(1)}%`;
    $('.rv-text').textContent = failed || (phase === 'net' ? 'Fetching the network…'
      : phase === 'value' ? `Valuing ${N + 1} positions…`
      : phase === 'roll' ? `Playing out games: ${spent.toLocaleString()}`
      : `Done in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`);
    const items = shownItems();
    $('.rv-sum').textContent = failed || phase === 'net' || phase === 'value' ? '' : !found ? 'Looking for your biggest mistakes…'
      : !found.length ? `No clear mistakes: no move of yours surely cost ${Math.round(SEARCH.cost * 100)} points or more.`
      : `Your ${found.length > 1 ? `${found.length} biggest mistakes` : 'one clear mistake'}, and what would have been better:`;
    const html = items.map((m, i) => {
      const pm = `<span class="pm">±${Math.max(1, Math.round(196 * m.cost.se))}</span>`;
      const head = `<button type="button" class="rv-head1" data-key="${i}"><span class="num">${i + 1}</span><span class="what">${esc(m.title)}</span><span class="cost${m.sure ? '' : ' pending'}">${m.sure ? '' : 'checking… '}<b>${points(m.cost.mean)}</b>${pm}</span></button>`;
      if (!m.sure || i !== selected) return `<div class="rv-key${i === selected ? ' sel' : ''}${m.sure ? '' : ' unsure'}">${head}</div>`;
      const view = alt < 0 ? (step === m.move ? 'mine' : step === m.move - 1 ? 'before' : '') : alt === m.len - 1 && m.len > 1 ? 'setup' : alt === 1 ? 'better' : '';
      const b = (name, text, title) => `<button type="button" data-view="${name}" title="${title}"${view === name ? ' class="on"' : ''}>${text}</button>`;
      return `<div class="rv-key sel">${head}<div class="rv-more">
          <div class="you"><i></i><span>You: <b>${esc(m.mine)}</b></span></div>
          <div class="better"><i></i><span>Better: <b>${esc(m.betterText[0])}</b>${esc(m.betterText[1])}</span></div>
          <div class="odds">Chance of winning: yours <b>${pct(m.yours)}</b> → better <b>${pct(m.better)}</b></div>
          <div class="views">${b('before', 'Before', 'The position before the mistake, with both moves (click the mistake)')}${b('mine', 'Your move', 'The position after your move')}${b('better', 'Better move', 'The position after the better move (B)')}${m.len > 1 ? b('setup', 'What it sets up', 'What the better move sets up: the position it reaches before the next card is shown (S)') : ''}</div>
        </div></div>`;
    }).join('');
    if ($('.rv-keys').dataset.html !== html) { // (left alone when nothing changed, so that a click on it is not lost)
      $('.rv-keys').dataset.html = html;
      $('.rv-keys').innerHTML = html;
    }
    $('.rv-luck').innerHTML = luck ? `<button type="button" data-luck><i class="l-luck"></i>The biggest swing of luck: the ${luck.show === 'deal' ? 'deal' : 'card turned'} at move ${luck.t} ${luck.mean < 0 ? 'cost' : 'was worth'} about ${Math.abs(Math.round(luck.mean * 100))} points.</button>` : '';
    $('.rv-note').innerHTML = note();
  }

  // What is listed: the mistakes found, or while they are looked for the
  // stretches that look like mistakes so far. Each {at: the move the mark is
  // at, from..end: the moves picked out, sure, title, cost, ...}.
  function shownItems() {
    if (found) return found;
    return cands.filter(c => c.stat.n >= 64 && c.stat.mean <= -SEARCH.cost && c.state !== 'out')
      .sort((a, b) => a.stat.mean - b.stat.mean).slice(0, SEARCH.most)
      .map(c => ({ sure: false, at: c.st.to, from: c.st.from, end: c.st.to, move: c.st.from + 1, cost: c.stat, title: c.st.to - c.st.from > 1 ? `Moves ${c.st.from + 1}–${c.st.to}` : `Move ${c.st.to}` }));
  }

  function note() {
    let text = '<span class="legend"><i class="l-play"></i>your moves <i class="l-luck"></i>cards turned or dealt</span> ';
    if (found?.length) text += 'Each mistake is measured by playing some hundreds of games out both ways, with the cards you had not seen reshuffled. ';
    if (ctx.undos) text += 'Moves that were taken back are left out: the game is read as if it had been played straight through.';
    return text;
  }

  // ---- stepping

  function show() {
    ctx.render();
    redraw();
    requestAnimationFrame(() => el.querySelector('.rv-key.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  function setStep(t) {
    t = Math.max(0, Math.min(N, t));
    // The mistake picked out stays so while the board is within it.
    const items = shownItems(), within = m => m && t >= m.from && t <= m.end;
    if (!within(items[selected])) selected = items.findIndex(within);
    step = t;
    alt = -1;
    show();
  }

  // Along the line the board is on: the game's, or the better line of the
  // mistake picked out (back from its start is the game again).
  function go(d) {
    const m = found?.[selected];
    if (alt < 0 || !m) return setStep(step + d);
    alt = Math.min(m.len, alt + d);
    if (alt <= 0) alt = -1;
    show();
  }

  function pick(i) {
    const m = shownItems()[i];
    if (!m) return;
    step = selected === i && alt < 0 && step === m.from && m.sure ? m.move : m.from; // again: the move
    selected = i;
    alt = -1;
    show();
  }

  // One of the views of the mistake picked out.
  function view(name) {
    const m = found?.[selected];
    if (!m) return;
    step = m.from;
    alt = -1;
    if (name === 'mine') step = m.move;
    else if (name === 'better') alt = 1;
    else if (name === 'setup') alt = Math.max(1, m.len - 1);
    show();
  }

  const stepAt = e => {
    const { ml, w } = geometry();
    return Math.max(0, Math.min(N, Math.round((e.clientX - plot.getBoundingClientRect().left - ml) / w * N)));
  };
  let dragging = false;
  plot.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const badge = e.target.closest?.('[data-key]');
    if (badge) return pick(+badge.dataset.key);
    if (e.target.closest?.('[data-luck]')) return setStep(luck.t);
    dragging = true;
    plot.setPointerCapture(e.pointerId);
    setStep(stepAt(e));
  });
  plot.addEventListener('pointermove', e => {
    if (dragging) setStep(stepAt(e));
    const h = e.pointerType === 'mouse' || dragging ? stepAt(e) : -1;
    if (h !== hover) { hover = h; redraw(); }
  });
  const release = () => { dragging = false; };
  plot.addEventListener('pointerup', release);
  plot.addEventListener('pointercancel', release);
  plot.addEventListener('pointerleave', () => { if (hover >= 0) { hover = -1; redraw(); } });
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('close' in b.dataset) ctx.close();
    else if (b.dataset.key) pick(+b.dataset.key);
    else if (b.dataset.view) view(b.dataset.view);
    else if ('luck' in b.dataset) setStep(luck.t);
    else if (b.dataset.go === 'start') setStep(0);
    else if (b.dataset.go === 'end') setStep(N);
    else if (b.dataset.go) go(+b.dataset.go);
  });
  el.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }); // keep the keys with the page

  // The next mistake of the list in a direction (or, with none, the next move that showed cards).
  function jump(d) {
    const items = shownItems();
    if (items.length) {
      const i = selected < 0 ? (d > 0 ? 0 : items.length - 1) : selected + d;
      if (items[i]) { selected = -1; pick(i); }
      return;
    }
    let t = step + d;
    while (t > 0 && t < N && !data.shows[t - 1]) t += d;
    setStep(t);
  }

  function key(e) {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'h') e.shiftKey ? setStep(step - 10) : go(-1);
    else if (k === 'ArrowRight' || k === 'l') e.shiftKey ? setStep(step + 10) : go(1);
    else if (k === 'ArrowUp' || k === '[') jump(-1);
    else if (k === 'ArrowDown' || k === ']') jump(1);
    else if (k === 'Home') setStep(0);
    else if (k === 'End') setStep(N);
    else if (k === 'Escape') ctx.close();
    else if (k === 'b' && found?.[selected]) view(alt === 1 ? 'before' : 'better');
    else if (k === 's' && found?.[selected]) view(alt >= 0 && alt === found[selected].len - 1 ? 'before' : 'setup');
    else if (/^[1-9]$/.test(k) && shownItems()[+k - 1]) pick(+k - 1);
    else return;
    e.preventDefault();
  }

  const resize = new ResizeObserver(() => { ctx.render(); redraw(); });
  resize.observe(plot);

  // ---- the work

  async function run() {
    await style();
    ctx.render(); // the board has less room now
    redraw();
    const net = await fetchNet(suits);
    if (closed) return;
    const cores = navigator.hardwareConcurrency || 4;
    pool = new Pool(Math.max(1, Math.min(12, cores - 1)), net, e => { failed = `The analysis failed: ${e.message || 'a worker stopped'}`; redraw(); });
    phase = 'value';
    redraw();
    // The positions where cards came up first, so that the curve is there roughly at once.
    const ends = new Set(data.stretches.flatMap(st => [st.from, st.to]));
    const first = [], rest = [];
    for (const job of data.jobs) (job.key[0] !== 'p' || ends.has(+job.key.slice(1)) ? first : rest).push(job);
    const ordered = [...first, ...rest], batches = [];
    for (let i = 0; i < ordered.length; i += VALUES) batches.push(ordered.slice(i, i + VALUES));
    await Promise.all(batches.map(async batch => {
      const { values: out } = await pool.run({ value: batch.map(j => j.enc) });
      batch.forEach((j, i) => values.set(j.key, out[i]));
      done += batch.length;
      redraw();
    }));
    if (closed) return;
    vals = data.stretches.map(st => stretchValues(st, values, data.won, N, suits));
    phase = 'roll';
    redraw();
    // A stretch's position and moves, for the worker (stretches with a column too long for the player are left out).
    const job = at => {
      const st = data.stretches[at], start = data.snaps[st.from];
      return {
        suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock,
        moves: moves.slice(st.from, st.to), seed: (Number(BigInt(seed) % 1000003n) * 131 + at) | 0,
      };
    };
    const asked = data.stretches.map((_, at) => job(at));
    const answers = await Promise.all(Array.from({ length: Math.ceil(asked.length / 4) }, (_, i) => pool.run({ track: asked.slice(4 * i, 4 * i + 4) })));
    if (closed) return;
    const cuts = answers.flatMap(a => a.tracks);
    const roll = r => pool.run({ roll: r }).then(a => a.rolls);
    // The cards' biggest swing by the network, measured alongside.
    const swing = vals.map((v, at) => [cuts[at] && data.stretches[at].shows ? Math.abs(v.luck) : 0, at]).sort((a, b) => b[0] - a[0])[0];
    const lucky = swing && swing[0] >= 0.05 ? measureLuck({ st: data.stretches[swing[1]], job: job(swing[1]), roll }).then(d => {
      const st = data.stretches[swing[1]];
      if (Math.abs(d.mean) >= 0.05 && Math.abs(d.mean) >= 2 * d.se) luck = { t: st.to, show: st.shows, mean: d.mean, se: d.se };
    }) : null;
    const mistakes = await findMistakes({
      stretches: data.stretches, cuts, job, roll,
      update: (c, n) => { cands = c; spent = n; done = data.jobs.length + n * ROLL_WEIGHT; if (!closed) redraw(); },
    });
    await lucky;
    if (closed) return;
    found = mistakes.map(m => { const x = mistake(m); return { ...x, sure: true, at: x.move, from: x.move - 1 }; });
    selected = found.findIndex(m => step >= m.from && step <= m.end);
    phase = 'done';
    seconds = (performance.now() - t0) / 1000;
    pool.close();
    pool = null;
    ctx.render();
    redraw();
  }
  // The move of the better line that the board is about to see played, and
  // at the position before a mistake the move that was played.
  const pending = () => {
    const m = found?.[selected];
    if (!m) return {};
    if (alt >= 0) return { better: m.line[alt] };
    return step === m.move - 1 ? { you: moves[m.move - 1], better: m.line[0] } : {};
  };
  const review = {
    get shown() { return alt >= 0 ? found[selected].alt.snaps[alt] : data.snaps[step]; },
    // The cards the last move put down: {col, count}.
    get mark() {
      const snaps = alt >= 0 ? found[selected].alt.snaps : data.snaps, i = alt >= 0 ? alt : step;
      const mv = i > 0 && (alt >= 0 ? found[selected].line[i - 1] : moves[i - 1]);
      if (!mv || mv.deal || snaps[i].completed.length > snaps[i - 1].completed.length) return null;
      return { col: mv.to, count: mv.count };
    },
    // Moves to draw on the board as arrows: [{from, to, count, kind: 'you' or 'better'}], and whose deal it is to mark the stock for.
    get arrows() { return Object.entries(pending()).filter(([, mv]) => mv && !mv.deal).map(([kind, mv]) => ({ ...mv, kind })); },
    get dealing() { const p = pending(); return p.better?.deal ? 'better' : p.you?.deal ? 'you' : null; },
    get info() {
      const p = value(step);
      if (alt >= 0) return `Analysis · the better line at move <b>${found[selected].move}</b>, ${alt} of ${found[selected].len} played`;
      return `Analysis · ${suits === 1 ? '1 suit' : `${suits} suits`} · move <b>${step}</b> of ${N}${p === undefined ? '' : ` · chance of winning <b>${pct(p)}</b>`}`;
    },
    key,
    // For tests and the curious: where the work stands.
    get state() {
      return {
        phase, failed, seconds, done, total, step, alt, selected, spent, values: values.size, luck,
        cands: cands.map(c => ({ from: c.st.from, to: c.st.to, n: c.stat.n, mean: c.stat.mean, se: c.stat.se, state: c.state })),
        found: found?.map(m => ({ move: m.move, end: m.end, exact: m.exact, n: m.n, yours: m.yours, better: m.better, cost: m.cost, line: m.line, title: m.title, mine: m.mine, betterText: m.betterText })),
      };
    },
    destroy() {
      closed = true;
      pool?.close();
      resize.disconnect();
      cancelAnimationFrame(frame);
      el.remove();
    },
  };
  run().catch(e => {
    failed = `The analysis failed: ${e.message}`;
    if (!closed) redraw();
  });
  return review;
}
