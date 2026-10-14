// The analysis of a game of Spider, somewhat like a Go server's review: a
// plot of the chance of winning over the moves, the moments it fell most
// broken down into what the moves cost and what the cards did, and the board
// to step through. app.js loads this only when an analysis is asked for, and
// it then fetches the network; nothing here is part of an ordinary page load.
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
//   2. For the stretches of moves where it falls most, games are played out
//      from WORLDS shuffles of the cards the player had not seen: before the
//      moves, after them, and with the cards that really came up. These give
//      win rates with an honest error, and the split into moves and cards.
// analysis-core.js has what is computed; this file the workers and the page.
import { prepare, stretchValues, keyStretches, rollStats, verdict, DEAL_SAMPLES } from './analysis-core.js';

const NET_VERSION = 1; // in the networks' address, which is cached for good: change it with them
const WORLDS = 256; // shuffles played out for each key stretch
const ROUND = 16; // of them in one piece of work
const VALUES = 6; // positions valued in one piece of work
const MAX_KEYS = 6;
const ROLL_WEIGHT = 8; // a world's three games against a position's valuing, for the progress bar

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
  let keys = []; // the key stretches: {at: index of the stretch, st, rolls: bytes so far, stats}
  let step = N, selected = -1, hover = -1;
  let pool = null, closed = false, failed = '', phase = 'net', done = 0, total = data.jobs.length + MAX_KEYS * WORLDS * ROLL_WEIGHT;
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
      <div class="rv-side"><div class="rv-keys"></div><p class="rv-note"></p></div>
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
  const stretchOf = t => data.stretches.findIndex(st => t > st.from && t <= st.to);

  function describe(t) {
    if (t === 0) return 'The deal';
    const mv = moves[t - 1], before = data.snaps[t - 1], after = data.snaps[t];
    let text = 'deals a row';
    if (!mv.deal) {
      const src = before.columns[mv.from];
      text = `${ctx.cardName(src[src.length - mv.count])}${mv.count > 1 ? ` and ${mv.count - 1} more` : ''} to column ${mv.to + 1}`;
      if (data.shows[t - 1]) text += ', turning a card';
    }
    if (after.completed.length > before.completed.length) text += ', finishing a suit';
    return `Move ${t} of ${N}: ${text}`;
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
    // The stretch picked out.
    const sel = keys[selected];
    if (sel) s += `<rect class="band" x="${f(X(sel.st.from))}" width="${f(Math.max(2, X(sel.st.to) - X(sel.st.from)))}" y="${mt}" height="${h}"/>`;
    // The curve: what the moves did slopes, what the cards did is upright.
    let area = '', play = '', luck = '', last = -1;
    for (let t = 0; t <= N; t++) {
      const p = value(t);
      if (p === undefined) continue;
      const c = t > 0 && data.shows[t - 1] && last === t - 1 ? commitAt(t) : undefined;
      if (last < 0) play += `M${f(X(t))},${f(Y(p))}`;
      else if (c !== undefined) {
        play += `L${f(X(t))},${f(Y(c))}M${f(X(t))},${f(Y(p))}`;
        luck += `M${f(X(t))},${f(Y(c))}L${f(X(t))},${f(Y(p))}`;
      } else play += `L${f(X(t))},${f(Y(p))}`;
      area += `${area ? 'L' : 'M'}${f(X(t))},${f(Y(p))}`;
      last = t;
    }
    if (last > 0) s += `<path class="area" d="${area}L${f(X(last))},${f(Y(0))}L${f(X(0))},${f(Y(0))}Z"/>`;
    s += `<path class="play" d="${play}"/><path class="luck" d="${luck}"/>`;
    // The key stretches: a numbered mark above, and the games played out as dots with their 95% intervals.
    let marked = -99;
    keys.forEach((k, i) => {
      const x0 = X(k.st.from), x1 = X(k.st.to), bx = marked = Math.max(x1, marked + 21); // marks side by side where stretches are close
      s += `<line class="lead" x1="${f(bx)}" x2="${f(x1)}" y1="18" y2="${mt}"/>`;
      if (k.stats) {
        const dot = (x, st, cls) => {
          const lo = Math.max(0, st.mean - 1.96 * st.se), hi = Math.min(1, st.mean + 1.96 * st.se);
          return `<line class="whisker" x1="${f(x)}" x2="${f(x)}" y1="${f(Y(lo))}" y2="${f(Y(hi))}"/><circle class="roll ${cls}" cx="${f(x)}" cy="${f(Y(st.mean))}" r="4.5"/>`;
        };
        s += dot(x0, k.stats.pre, '') + dot(x1, k.stats.reveal, '');
      }
      s += `<g class="badge${i === selected ? ' sel' : ''}" data-key="${i}"><circle cx="${f(bx)}" cy="11" r="9"/><text x="${f(bx)}" y="15" text-anchor="middle">${i + 1}</text></g>`;
    });
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
    $('.rv-move').textContent = describe(step) + (p === undefined ? '' : ` · ${pct(p)}`);
    const frac = Math.min(1, done / total);
    $('.rv-bar').hidden = phase === 'done' || !!failed;
    $('.rv-bar i').style.width = `${(frac * 100).toFixed(1)}%`;
    $('.rv-text').textContent = failed || (phase === 'net' ? 'Fetching the network…'
      : phase === 'value' ? `Valuing ${N + 1} positions…`
      : phase === 'roll' ? `Playing out games: ${keys.reduce((n, k) => n + k.rolls.length, 0).toLocaleString()} of ${(keys.length * WORLDS).toLocaleString()}`
      : `Done in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`);
    $('.rv-keys').innerHTML = keys.map((k, i) => {
      const st = k.st, v = vals[k.at], r = k.stats;
      const what = `${st.to - st.from > 1 ? `Moves ${st.from + 1}–${st.to}` : `Move ${st.to}`}${st.shows === 'deal' ? ', a deal' : st.shows === 'turn' ? ', a card turned' : ', to the end'}`;
      const pm = x => `<span class="pm">±${Math.round(196 * x.se)}</span>`;
      const nums = r ? `<b>${pct(r.pre.mean)} → ${pct(r.reveal.mean)}</b><span class="part"><i class="k-play"></i>moves <b>${points(r.play.mean)}</b>${pm(r.play)}</span>${st.shows ? `<span class="part"><i class="k-luck"></i>cards <b>${points(r.luck.mean)}</b>${pm(r.luck)}</span>` : ''}`
        : `<b>${pct(v.same ? v.commit : v.start)} → ${pct(v.end)}</b><span class="part"><i class="k-play"></i>moves ${points(v.same ? 0 : v.play)}</span>${st.shows ? `<span class="part"><i class="k-luck"></i>cards ${points(v.luck)}</span>` : ''}`;
      const said = !r ? 'the network\'s guess; playing it out…' : k.rolls.length < WORLDS ? `${k.rolls.length} of ${WORLDS} games…` : verdict(r);
      const cls = r && k.rolls.length === WORLDS ? ` v-${said.split(/[ ,]/)[0].toLowerCase()}` : ' pending';
      return `<button type="button" class="rv-key${i === selected ? ' sel' : ''}" data-key="${i}"><span class="num">${i + 1}</span><span class="what">${what}</span><span class="said${cls}">${esc(said)}</span><span class="nums">${nums}</span></button>`;
    }).join('') || (vals ? '<p class="rv-none">No stretch of moves lost four points or more.</p>' : '');
    $('.rv-note').innerHTML = note();
  }

  function note() {
    // (The end as the games played out have it, once they are there.)
    const ended = keys.find(k => k.st.to === N && k.stats)?.stats.reveal.mean ?? value(N);
    let text = value(0) === undefined || ended === undefined ? '' : `From ${pct(value(0))} at the deal to ${data.won ? 'the win' : `${pct(ended)} at the end`}. `;
    text += `<span class="legend"><i class="l-play"></i>your moves <i class="l-luck"></i>cards turned or dealt <i class="l-roll"></i>games played out (95% interval)</span> `
      + 'The chance is that of a computer player that sees only what is face up and takes nothing back, so it runs low for a player who thinks longer. '
      + `At the marked moments it is measured by playing ${WORLDS} games out with the unseen cards reshuffled: before the moves, after them, and with the cards that really came up. The first step is the moves' doing, the second the cards'.`;
    if (ctx.undos) text += ' Moves that were taken back are left out: the game is read as if it had been played straight through.';
    return text;
  }

  // ---- stepping

  function setStep(t) {
    t = Math.max(0, Math.min(N, t));
    // The stretch picked out stays so while the board is within it.
    const within = k => k && t >= k.st.from && t <= k.st.to;
    if (!within(keys[selected])) selected = keys.findIndex(k => t > k.st.from && t <= k.st.to);
    step = t;
    ctx.render();
    redraw();
  }

  function pick(i) {
    const k = keys[i];
    if (!k) return;
    const at = selected === i && step === k.st.from ? k.st.to : k.st.from; // again: its end
    selected = i;
    step = at;
    ctx.render();
    redraw();
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
    else if (b.dataset.go) setStep(b.dataset.go === 'start' ? 0 : b.dataset.go === 'end' ? N : step + +b.dataset.go);
  });
  for (const b of el.querySelectorAll('button')) b.addEventListener('mousedown', e => e.preventDefault()); // keep the keys with the page

  // The next key stretch in a direction (or, with none, the next move that showed cards).
  function jump(d) {
    if (keys.length) {
      const i = d > 0 ? keys.findIndex(k => k.st.from > step) : keys.findLastIndex(k => k.st.from < step);
      if (i >= 0) { selected = i; step = keys[i].st.from; ctx.render(); redraw(); }
      return;
    }
    let t = step + d;
    while (t > 0 && t < N && !data.shows[t - 1]) t += d;
    setStep(t);
  }

  function key(e) {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'h') setStep(step - (e.shiftKey ? 10 : 1));
    else if (k === 'ArrowRight' || k === 'l') setStep(step + (e.shiftKey ? 10 : 1));
    else if (k === 'ArrowUp' || k === '[') jump(-1);
    else if (k === 'ArrowDown' || k === ']') jump(1);
    else if (k === 'Home') setStep(0);
    else if (k === 'End') setStep(N);
    else if (k === 'Escape') ctx.close();
    else if (/^[1-9]$/.test(k) && keys[+k - 1]) pick(+k - 1);
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
    const all = data.stretches.map(st => stretchValues(st, values, data.won, N, suits));
    // Where the moves are the line player's own, they are no mistake by its measure.
    const asked = data.stretches.map(st => {
      const start = data.snaps[st.from];
      return { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: moves.slice(st.from, st.to) };
    });
    const answers = await Promise.all(Array.from({ length: Math.ceil(asked.length / 16) }, (_, i) => pool.run({ same: asked.slice(16 * i, 16 * i + 16) })));
    if (closed) return;
    answers.flatMap(a => a.same).forEach((same, i) => { all[i].same = same; });
    vals = all;
    // Stretches with a column too long for the player are left to the network.
    const playable = st => data.snaps.slice(st.from, st.to + 1).every(s => s.columns.every(c => c.length <= 48));
    const picked = keyStretches(vals.map((v, i) => (playable(data.stretches[i]) ? v : { start: 0, end: 0, play: 0, luck: 0 })), MAX_KEYS);
    // The end of a game not won is always measured: the network does not see well that nothing is left to do.
    const end = data.stretches.length - 1;
    if (!data.won && end >= 0 && !picked.includes(end) && playable(data.stretches[end])) picked.push(end);
    keys = picked.map(at => ({ at, st: data.stretches[at], rolls: new Uint8Array(0), stats: null }));
    total = data.jobs.length + keys.length * WORLDS * ROLL_WEIGHT;
    phase = keys.length ? 'roll' : 'done';
    seconds = (performance.now() - t0) / 1000;
    redraw();
    const work = [];
    for (let from = 0; from < WORLDS; from += ROUND) {
      for (const k of keys) {
        const start = data.snaps[k.st.from];
        const roll = {
          suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock,
          moves: moves.slice(k.st.from, k.st.to), seed: (Number(BigInt(seed) % 1000003n) * 131 + k.at) | 0, from, to: from + ROUND,
        };
        work.push(pool.run({ roll }).then(({ rolls }) => {
          const all = new Uint8Array(k.rolls.length + rolls.length);
          all.set(k.rolls);
          all.set(rolls, k.rolls.length);
          k.rolls = all;
          k.stats = rollStats(all);
          done += rolls.length * ROLL_WEIGHT;
          redraw();
        }));
      }
    }
    await Promise.all(work);
    if (closed) return;
    phase = 'done';
    seconds = (performance.now() - t0) / 1000;
    pool.close();
    pool = null;
    redraw();
  }
  const review = {
    get shown() { return data.snaps[step]; },
    get mark() {
      const mv = step > 0 && moves[step - 1];
      if (!mv || mv.deal || data.snaps[step].completed.length > data.snaps[step - 1].completed.length) return null;
      return { col: mv.to, count: mv.count };
    },
    get info() {
      const p = value(step);
      return `Analysis · ${suits === 1 ? '1 suit' : `${suits} suits`} · move <b>${step}</b> of ${N}${p === undefined ? '' : ` · chance of winning <b>${pct(p)}</b>`}`;
    },
    key,
    // For tests and the curious: where the work stands.
    get state() { return { phase, failed, seconds, done, total, step, selected, values: values.size, keys: keys.map(k => ({ from: k.st.from, to: k.st.to, shows: k.st.shows, n: k.rolls.length, stats: k.stats, net: vals[k.at] })) }; },
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
