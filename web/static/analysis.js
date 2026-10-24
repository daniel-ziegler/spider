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
//      player choosing its own) and from after them, in the order the
//      network gives the stretches (screen): see findMistakes in
//      analysis-core.js, which has what is computed; this file has the
//      workers and the page.
import { prepare, stretchValues, screenJobs, screen, findMistakes, measureLuck, branch, SEARCH } from './analysis-core.js';

const NET_VERSION = 2; // in the network's address, which is cached for good: change it with the network
const VALUES = 6; // positions valued in one piece of work
const ROLL_WEIGHT = 3; // a game played out against a position's valuing, for the progress bar

let fetched = null; // the promise of the network's bytes (one network for every number of suits)
function fetchNet() {
  if (!fetched) {
    fetched = fetch(`/nets/value.bin?${NET_VERSION}`).then(res => {
      if (!res.ok) throw new Error(res.statusText);
      return res.arrayBuffer();
    });
    fetched.catch(() => { fetched = null; });
  }
  return fetched;
}

// Workers that take one piece of work at a time, in the order given.
class Pool {
  constructor(n, net, suits, onError) {
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
    this.idle = [];
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker('/analysis-worker.js', { type: 'module' });
      const copy = net.slice(0);
      w.postMessage({ net: copy, suits }, [copy]);
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

  // (`first`: before the work that is waiting.)
  run(msg, first = false) {
    return new Promise(resolve => {
      this.queue[first ? 'unshift' : 'push']({ msg, resolve });
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
// undos, lost, cardName, render, close} (lost: the game is over and not won:
// it can no longer be won, or nothing is left to play). Returns what app.js draws and asks of it:
// shown (the position on the board), mark (cards to outline), info (the
// header's line), key(event), destroy().
export function open(ctx) {
  const { suits, seed, moves } = ctx, N = moves.length;
  const data = prepare(suits, seed, moves);
  const values = new Map(); // what the network has said: key -> chance
  // How the game ended, if it has: its last position is then worth that (1
  // or 0) and not what the network makes of it, so the curve ends there, and
  // the last stretch's cards and moves are what brought it there.
  const over = data.won ? 'won' : ctx.lost ? 'lost' : '';
  if (over) values.set(`p${N}`, data.won ? 1 : 0);
  let vals = null; // its three values of each stretch, once it has said everything
  let cands = []; // the stretches games are being played out for (see findMistakes)
  let found = null; // the mistakes, once they are known: see mistake() for what each has
  let luck = null; // the cards' biggest swing: {t, show, mean}
  let step = N, selected = -1, hover = -1;
  let alt = -1; // the board is on the selected mistake's better line, after this many of its moves (-1: on the game's)
  let adv = null; // what the line player would play at the position on the board, while that is asked for (see settle): {from, wait} or as a mistake is, with `advice`
  let asking = false; // whether it is asked for: at every position the board comes to
  try { asking = localStorage.getItem('spider:analysis:ask') === '1'; } catch { /* no storage */ }
  const advice = new Map(), advised = new Map(); // those worked out: move -> promise, and -> what it gave
  let pooled; // (called when the workers are there)
  const workers = new Promise(resolve => { pooled = resolve; });
  let pool = null, closed = false, failed = '', phase = 'net', done = 0, spent = 0;
  const total = data.jobs.length + SEARCH.games * ROLL_WEIGHT;
  const t0 = performance.now();
  let seconds = 0;

  const el = document.createElement('section');
  el.id = 'review';
  el.innerHTML = `<div class="rv-head">
      <b class="rv-title">Analysis</b>
      <span class="rv-nav"><button data-go="start" title="The deal (Home)">⏮&#xFE0E;</button><button data-go="-1" title="Back a move (←)">◀&#xFE0E;</button><button data-go="1" title="On a move (→)">▶&#xFE0E;</button><button data-go="end" title="The end (End)">⏭&#xFE0E;</button><button data-ask title="Show at every position what the computer would play there (? or C)">?<span class="long"> Computer's move</span></button></span>
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

  const value = t => values.get(`p${t}`);
  // The value after move t before the cards it showed were known.
  const commitAt = t => {
    const st = { from: t - 1, to: t, shows: data.shows[t - 1] };
    if (!values.has(`u${t}`)) return undefined;
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

  // Another line from the position after t moves, with what the page says of
  // it: its positions (alt.snaps[i] after i of its moves; the last of them
  // shows cards: its goal), and its first move and what that is for, in words.
  function lineInfo(t, moved) {
    const alt = branch(suits, seed, moves, t, moved), len = alt.snaps.length - 1, line = moved.slice(0, len);
    const goal = alt.shows[len - 1] ?? { show: null }, first = line[0];
    const n = len - 2, between = n > 0 ? `${n} more move${n > 1 ? 's' : ''}` : '';
    let goes = '';
    if (goal.show === 'turn') goes = len === 1 ? `, turning the card in column ${goal.col + 1}` : `, then ${between ? `${between} to ` : ''}turn the card in column ${goal.col + 1}`;
    else if (goal.show === 'deal' && len > 1) goes = between ? ` and ${between}, then deal` : ', then deal';
    else if (len > 1) goes = `, then ${len - 1} more move${len > 2 ? 's' : ''}`;
    return { alt, len, line, goal, betterText: len ? [first.deal ? 'deal' : moveText(first, data.snaps[t]), goes] : ['', ''] };
  }

  // The move played and another from the same position in words: [mine, the
  // other], saying where from if they would otherwise read the same (there
  // are two of each card).
  function twoMoves(mine, other, before) {
    const a = mine.deal ? 'dealt' : moveText(mine, before), b = other.deal ? 'deal' : moveText(other, before);
    return a === b && mine.from !== other.from ? [`${a}, from column ${mine.from + 1}`, `${b}, from column ${other.from + 1}`] : [a, b];
  }

  // A mistake found, with its better line and the words for it.
  function mistake(m) {
    const st = data.stretches[m.at], mine = moves[m.move - 1], before = data.snaps[m.move - 1];
    const info = lineInfo(m.move - 1, m.line), { len, goal } = info;
    const early = !!mine.deal && !info.line[0].deal;
    // (The line player would have turned the same card, after other moves.)
    const hasty = m.exact && len > 1 && data.shows[m.move - 1] === 'turn' && goal.show === 'turn' && data.snaps[m.move].faceDown[goal.col] < before.faceDown[goal.col];
    const end = m.exact ? m.move : st.to, after = end - m.move;
    const [played, better] = twoMoves(mine, info.line[0], before);
    return {
      ...m, st, ...info, end, betterText: [better, info.betterText[1]],
      title: early ? `Move ${m.move}: dealt too early` : hasty ? `Move ${m.move}: a card turned too early` : after ? `Moves ${m.move}–${end}` : `Move ${m.move}`,
      mine: played + (after ? ` and the ${after > 1 ? `${after} moves` : 'move'} after` : ''),
    };
  }

  // What the line player would play at the position on the board (after t
  // moves of the game), asked for: shown as a mistake is, but that nothing is
  // said of what it costs. It is worked out in a worker, ahead of the games
  // being played out, and kept. `same`: the move played there is its move;
  // `level`: another, but one that does not leave its line (see track).
  function advise(t) {
    if (!advice.has(t)) {
      const st = data.stretches.find(x => t >= x.from && t < x.to), start = data.snaps[t];
      const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: st ? moves.slice(t, st.to) : [] };
      advice.set(t, workers.then(() => pool.run({ ask: job }, true)).then(({ asked }) => {
        const info = lineInfo(t, asked?.line ?? []), mine = moves[t], first = info.line[0];
        const same = !!mine && !!first && (mine.deal ? !!first.deal : !first.deal && mine.from === first.from && mine.to === first.to && mine.count === first.count);
        const [played, its] = mine && first ? twoMoves(mine, first, start) : ['', info.betterText[0]];
        return {
          ...info, betterText: [its, info.betterText[1]], advice: true, from: t, move: t + 1, end: Math.min(N, t + 1), same, level: !same && !!mine && !!asked && asked.cuts[0]?.at !== 1,
          none: !asked ? 'A column is too long for the computer player here.' : !info.len ? (start.completed.length === 8 ? 'The game is won.' : 'The computer would give up here.') : '',
          mine: mine ? played || (mine.deal ? 'dealt' : moveText(mine, start)) : '',
        };
      }));
    }
    return advice.get(t);
  }

  function ask() {
    asking = !asking;
    try { localStorage.setItem('spider:analysis:ask', asking ? '1' : '0'); } catch { /* no storage */ }
    if (alt >= 0 && cur()?.advice) { step = cur().from; alt = -1; }
    show();
  }

  // What the line player would play is shown for the position the board is
  // at, while it is asked for: but not where a mistake picked out begins,
  // since the mistake says it there. (Called whenever the board has moved.)
  function settle() {
    if (alt >= 0) return;
    const t = step, m = found?.[selected];
    if (!asking || (m && t === m.from)) adv = null;
    else if (adv?.from !== t) {
      adv = advised.get(t) ?? { from: t, wait: true };
      if (adv.wait) {
        advise(t).then(a => {
          advised.set(t, a);
          if (closed || adv?.from !== t || !adv.wait) return; // (the board has gone elsewhere)
          adv = a;
          ctx.render();
          redraw();
        });
      }
    }
  }

  // The mistake picked out, or what was asked for in its place: what the views and the other line are of.
  const cur = () => (adv ? (adv.wait || adv.none ? null : adv) : found?.[selected]);

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
    if (over) s += `<text class="axis ${over}" x="${f(X(N) + 8)}" y="${H - 5}" text-anchor="end">${over}</text>`;
    data.shows.forEach((show, i) => {
      if (show !== 'deal') return;
      const x = X(i + 1);
      s += `<line class="deal" x1="${f(x)}" x2="${f(x)}" y1="${mt}" y2="${mt + h + 4}"/>`;
      if (x - labelled < 30 || (over && X(N) - x < 36)) return; // no room for the word
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
      s += `<g class="badge${i === selected ? ' sel' : ''}${m.sure && !m.maybe ? '' : ' unsure'}" data-key="${i}"><circle cx="${f(bx)}" cy="11" r="9"/><text x="${f(bx)}" y="15" text-anchor="middle">${i + 1}</text></g>`;
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
      tip.innerHTML = `<b>${hover ? `Move ${hover}` : 'The deal'}</b>${v === undefined ? '' : ` · ${pct(v)}`}${over && hover === N ? ` · ${over}` : ''}`
        + (c !== undefined && b !== undefined && v !== undefined ? `<br>${data.shows[hover - 1] === 'deal' ? 'the deal' : 'the card'} ${points(v - c)}` : '');
      tip.style.left = `${Math.max(60, Math.min(W - 60, X(hover)))}px`;
    }

    // The header's line (its chance may have come since the board was drawn),
    // the line about the move, the progress, the key stretches and the note.
    document.querySelector('#info').innerHTML = review.info;
    const m = alt >= 0 && cur();
    $('.rv-move').textContent = m ? `${m.advice ? 'The computer\'s' : 'The better'} line, move ${alt} of ${m.len}: ${moveText(m.line[alt - 1], m.alt.snaps[alt - 1])}${alt === m.len && m.goal.show === 'turn' ? ', turning a card' : ''}`
      : describe(step) + (p === undefined ? '' : ` · ${pct(p)}`) + (over && step === N ? ` · ${over}` : '');
    const frac = Math.min(1, done / total);
    $('.rv-bar').hidden = phase === 'done' || !!failed;
    $('.rv-bar i').style.width = `${(frac * 100).toFixed(1)}%`;
    $('.rv-text').textContent = failed || (phase === 'net' ? 'Fetching the network…'
      : phase === 'value' ? `Valuing ${N + 1} positions…`
      : phase === 'roll' ? `Playing out games: ${spent.toLocaleString()}`
      : `Done in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`);
    $('.rv-text').title = spent ? `${spent.toLocaleString()} games played out` : '';
    const items = shownItems(), sure = found?.filter(m => !m.maybe).length ?? 0;
    $('.rv-sum').textContent = failed || phase === 'net' || phase === 'value' ? '' : !found ? 'Looking for your biggest mistakes…'
      : !found.length ? `No clear mistakes: no move of yours surely cost ${Math.round(SEARCH.cost * 100)} points or more.`
      : !sure ? 'No clear mistakes. The likeliest, none of them sure:'
      : `Your ${sure > 1 ? `${sure} biggest mistakes` : 'one clear mistake'}, and what would have been better:`;
    // The views of a mistake, or of what was asked for, and the steps along its other line.
    const views = m => {
      const view = alt < 0 ? (step === m.move && !m.advice ? 'mine' : step === m.move - 1 ? 'before' : '') : alt === m.len - 1 && m.len > 1 ? 'setup' : alt === 1 ? 'better' : '';
      const b = (name, text, title) => `<button type="button" data-view="${name}" title="${title}"${view === name ? ' class="on"' : ''}>${text}</button>`;
      const its = m.advice ? 'the computer\'s' : 'the better';
      return `<div class="views">${b('before', m.advice ? 'Here' : 'Before', m.advice ? 'The position in the game (A)' : 'The position before the mistake, with both moves (A)')}${m.advice ? '' : b('mine', 'Your move', 'The position after your move (Y)')}${b('better', m.advice ? 'Its move' : 'Better move', `The position after ${its} move (B)`)}${m.len > 1 ? b('setup', 'What it sets up', `What ${its} move sets up: the position it reaches before the next card is shown (S)`) : ''}`
        + `<span class="along"><button type="button" data-along="-1" title="Back a move along ${its} line (,)"${alt < 1 ? ' disabled' : ''}>‹</button><span class="at" title="How far along ${its} line the board is">${Math.max(alt, 0)} of ${m.len}</span><button type="button" data-along="1" title="On a move along ${its} line (.)"${alt >= m.len ? ' disabled' : ''}>›</button></span></div>`;
    };
    // What the computer would play here comes first.
    let asked = '';
    if (adv) {
      const head = `<div class="rv-head1"><span class="num">?</span><span class="what">${adv.from < N ? `At move ${adv.from + 1}` : 'At the end'}: the computer's choice</span><button type="button" class="shut" data-ask title="No more of this (? or C)">×</button></div>`;
      asked = `<div class="rv-key sel asked">${head}<div class="rv-more">${adv.wait ? '<div class="odds"><i class="spin"></i>Thinking…</div>' : adv.none ? `<div class="odds">${adv.none}</div>`
        : `${adv.same ? `<div class="better"><i></i><span>The same as you played: <b>${esc(adv.betterText[0])}</b>${esc(adv.betterText[1])}</span></div>`
          : `${adv.mine ? `<div class="you"><i></i><span>You: <b>${esc(adv.mine)}</b>${adv.level ? ' (as good: it comes to the same)' : ''}</span></div>` : ''}<div class="better"><i></i><span>Computer: <b>${esc(adv.betterText[0])}</b>${esc(adv.betterText[1])}</span></div>`}${views(adv)}`}</div></div>`;
    }
    const html = asked + items.map((m, i) => {
      const section = m.maybe && sure && i === sure ? '<p class="rv-sub">And these may be mistakes:</p>' : '';
      const pm = `<span class="pm">±${Math.max(1, Math.round(196 * m.cost.se))}</span>`;
      const head = `<button type="button" class="rv-head1" data-key="${i}"><span class="num">${i + 1}</span><span class="what">${esc(m.title)}</span><span class="cost${m.sure ? '' : ' pending'}">${m.sure ? '' : 'checking… '}<b>${points(m.cost.mean)}</b>${pm}${m.maybe ? ', unsure' : ''}</span></button>`;
      const cls = `${m.sure ? '' : ' unsure'}${m.maybe ? ' maybe' : ''}`;
      if (!m.sure || i !== selected || adv) return `${section}<div class="rv-key${i === selected && !adv ? ' sel' : ''}${cls}">${head}</div>`;
      return `${section}<div class="rv-key sel${cls}">${head}<div class="rv-more">
          <div class="you"><i></i><span>You: <b>${esc(m.mine)}</b></span></div>
          <div class="better"><i></i><span>Better: <b>${esc(m.betterText[0])}</b>${esc(m.betterText[1])}</span></div>
          <div class="odds">Chance of winning: yours <b>${pct(m.yours)}</b> → better <b>${pct(m.better)}</b>${m.maybe ? ` (in ${m.n} games each: unsure)` : ''}</div>
          ${views(m)}
        </div></div>`;
    }).join('');
    $('[data-ask]').classList.toggle('on', asking);
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
    text += '<span class="keys">Keys: ← → the game\'s moves · ↑ ↓ or 1–9 the mistakes · A Y B S their views · , . along the other line · ? the computer\'s move everywhere</span> ';
    if (ctx.undos) text += 'Moves that were taken back are left out: the game is read as if it had been played straight through.';
    return text;
  }

  // ---- stepping

  function show() {
    settle();
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

  // Along the game by d moves: always the game's own moves, from the
  // position in it that another line on the board began at.
  function go(d) {
    setStep((alt >= 0 ? cur().from : step) + d);
  }

  // Along the other line (the better line of the mistake picked out, or the
  // computer's from the position on the board); back from its start is the game again.
  function along(d) {
    const m = cur();
    if (!m) return;
    if (alt < 0 && (step !== m.from || d < 0)) return;
    alt = Math.min(m.len, Math.max(alt, 0) + d);
    if (alt <= 0) { alt = -1; step = m.from; }
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

  // One of the views of the mistake picked out, or of what the computer would play here.
  function view(name) {
    const m = cur();
    if (!m) return;
    step = m.from;
    alt = -1;
    if (name === 'mine') step = Math.min(N, m.move);
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
    else if (b.dataset.along) along(+b.dataset.along);
    else if ('ask' in b.dataset) ask();
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

  // The keys: the arrows are the game's moves, always; the other line has its own.
  function key(e) {
    const k = e.key, m = cur();
    if (k === 'ArrowLeft' || k === 'h') go(e.shiftKey ? -10 : -1);
    else if (k === 'ArrowRight' || k === 'l') go(e.shiftKey ? 10 : 1);
    else if (k === 'ArrowUp' || k === '[') jump(-1);
    else if (k === 'ArrowDown' || k === ']') jump(1);
    else if (k === 'Home') setStep(0);
    else if (k === 'End') setStep(N);
    else if (k === 'Escape') ctx.close();
    else if (k === ',' || k === '<') along(-1);
    else if (k === '.' || k === '>') along(1);
    else if (k === 'a' && m) view('before');
    else if (k === 'y' && m && !m.advice) view('mine');
    else if (k === 'b' && m) view(alt === 1 ? 'before' : 'better');
    else if (k === 's' && m) view(alt >= 0 && alt === m.len - 1 ? 'before' : 'setup');
    else if (k === '?' || k === 'c') ask();
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
    const net = await fetchNet();
    if (closed) return;
    const cores = navigator.hardwareConcurrency || 4;
    pool = new Pool(Math.max(1, Math.min(12, cores - 1)), net, suits, e => { failed = `The analysis failed: ${e.message || 'a worker stopped'}`; redraw(); });
    pooled();
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
      batch.forEach((j, i) => { if (!values.has(j.key)) values.set(j.key, out[i]); }); // (the end of a game that is over is known)
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
    // Where to look first: what the network makes each candidate cost (see screen).
    const theirs = new Map(), asks = screenJobs(suits, seed, moves, data.stretches, cuts);
    await Promise.all(Array.from({ length: Math.ceil(asks.length / VALUES) }, async (_, i) => {
      const batch = asks.slice(VALUES * i, VALUES * i + VALUES);
      const { values: out } = await pool.run({ value: batch.map(j => j.enc) });
      batch.forEach((j, k) => theirs.set(j.at, { value: out[k], shows: j.shows }));
    }));
    if (closed) return;
    const mistakes = await findMistakes({
      stretches: data.stretches, cuts, job, roll, prior: screen(data.stretches, values, theirs, data.won, N, suits),
      update: (c, n) => { cands = c; spent = n; done = data.jobs.length + n * ROLL_WEIGHT; if (!closed) redraw(); },
    });
    await lucky;
    if (closed) return;
    found = mistakes.map(m => { const x = mistake(m); return { ...x, sure: true, maybe: !!m.unsure, at: x.move, from: x.move - 1 }; });
    selected = found.findIndex(m => step >= m.from && step <= m.end);
    phase = 'done';
    seconds = (performance.now() - t0) / 1000; // (the workers stay, for what is asked for)
    show();
  }
  // The move of the better line that the board is about to see played, and
  // at the position before a mistake the move that was played.
  const pending = () => {
    const m = cur();
    if (!m) return {};
    if (alt >= 0) return { better: m.line[alt] };
    return step === m.move - 1 ? { you: m.same ? undefined : moves[m.move - 1], better: m.line[0] } : {};
  };
  const review = {
    get shown() { return alt >= 0 ? cur().alt.snaps[alt] : data.snaps[step]; },
    // The cards the last move put down: {col, count}.
    get mark() {
      const snaps = alt >= 0 ? cur().alt.snaps : data.snaps, i = alt >= 0 ? alt : step;
      const mv = i > 0 && (alt >= 0 ? cur().line[i - 1] : moves[i - 1]);
      if (!mv || mv.deal || snaps[i].completed.length > snaps[i - 1].completed.length) return null;
      return { col: mv.to, count: mv.count };
    },
    // Moves to draw on the board as arrows: [{from, to, count, kind: 'you' or 'better'}], and whose deal it is to mark the stock for.
    get arrows() { return Object.entries(pending()).filter(([, mv]) => mv && !mv.deal).map(([kind, mv]) => ({ ...mv, kind })); },
    get dealing() { const p = pending(); return p.better?.deal ? 'better' : p.you?.deal ? 'you' : null; },
    get info() {
      const p = value(step);
      if (alt >= 0) return `Analysis · the ${cur().advice ? 'computer\'s' : 'better'} line at move <b>${cur().move}</b>, ${alt} of ${cur().len} played`;
      return `Analysis · ${suits === 1 ? '1 suit' : `${suits} suits`} · move <b>${step}</b> of ${N}${p === undefined ? '' : ` · chance of winning <b>${pct(p)}</b>`}${over && step === N ? ` · ${over}` : ''}`;
    },
    key,
    // For tests and the curious: where the work stands.
    get state() {
      return {
        phase, failed, seconds, done, total, step, alt, selected, spent, over, values: values.size, luck,
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
