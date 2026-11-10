// Two attempts at a deal side by side: the player's and the computer's, or a
// friend's, or another of their own. compare-core.js has what is worked out;
// this file has the workers and the page. app.js loads it when it is asked for.
//
// What the page says of the choice that parted the lines is measured as the
// analysis measures a mistake: games played out from both, in the same shuffles
// of the cards not seen at that point, so nothing either line later turned up
// is used. What it says from deal to deal is the network's.
import { readLine, relate, nextShow, rows, keyRows, valueJobs, differing, computerGame, standing } from './compare-core.js';
import { Pool, fetchNet } from './analysis.js';
import { paired, searchFor } from './analysis-core.js';
import { parseMoves, encodeMoves, suitOf, rankOf } from './game.js';
import { strongGame } from './strong.js';

const VALUES = 6; // positions valued in one piece of work
const CACHE = 'spider:computer:2', KEEP = 30; // the computer's games kept here (a new number when it plays differently)
// The computer plays what the analysis rates best at every choice (strong.js),
// which takes a pool of workers the better part of a minute; where that
// would be minutes (few cores, or a phone) the line player's own game, there
// at once, is what is shown unless the other is asked for or kept from before.
const slow = () => (navigator.hardwareConcurrency || 4) < 8 || matchMedia('(pointer: coarse)').matches;

let styled = null;
function style() {
  styled ??= new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/compare.css';
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
  return styled;
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pct = p => `${Math.round(p * 100)}%`;
const points = x => `${x < -0.005 ? '−' : '+'}${Math.abs(Math.round(x * 100))}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Open the comparison: ctx is {suits, seed, mine: {moves, undos, over} (the game
// on the board), attempts() (a promise of {attempts} from the server, or {why}:
// why there are none to see), cardName, close(), analyze() (of the game on the
// board), store}.
// Returns {key(event), destroy(), state}.
export function open(ctx) {
  const { suits, seed, cardName, store } = ctx;
  const choices = [{ id: 'mine', name: 'You', label: `This game (${plural(ctx.mine.moves.length, 'move')})`, ...ctx.mine }, { id: 'computer', name: 'Computer', label: slow() ? 'Strong computer (takes minutes here)' : 'The computer' }, { id: 'quick', name: 'Quick computer', label: 'Quick computer (weaker)' }];
  let aId = 'mine', bId = slow() && !store.get(CACHE, {})[`${suits}/${seed}`] ? 'quick' : 'computer';
  let why = '', closed = false, failed = '', busy = '', token = 0;
  let pool = null, A = null, B = null, rel = null, all = [], keys = [], measured = null;
  let quickWins = false; // the computer lost a deal that the quick computer wins
  let at = [0, 0], pick = null; // the two boards' positions, and what is picked out ('split', or a row's number)
  const lines = new Map(), valued = new Map(); // read lines and their values, by attempt

  const el = document.createElement('section');
  el.id = 'compare';
  el.innerHTML = `<div class="cp-head">
      <b class="cp-title">Compare</b>
      <span class="cp-pick"><select data-side="a" aria-label="First attempt"></select><span class="cp-vs">vs</span><select data-side="b" aria-label="Second attempt"></select></span>
      <button data-analyze title="The analysis of this game: its mistakes, move by move">Analyze</button>
      <button class="primary" data-close title="Back to the game (Esc)">Back</button>
    </div>
    <p class="cp-status" aria-live="polite"><span class="cp-bar"><i></i></span><span class="cp-text"></span></p>
    <p class="cp-sum"></p>
    <div class="cp-keys"></div>
    <div class="cp-boards"><div class="cp-side a"></div><div class="cp-side b"></div></div>
    <div class="cp-table"></div>
    <p class="cp-note"></p>`;
  const $ = s => el.querySelector(s);
  document.querySelector('#tray').before(el);

  // ---- words

  const nameOf = id => choices.find(c => c.id === id)?.name ?? '';
  const whose = id => (id === 'mine' ? 'your' : `${nameOf(id)}'s`);
  const forWhom = id => (id === 'mine' ? 'you' : nameOf(id));
  const moveText = (mv, before) => {
    if (mv.deal) return 'a deal';
    const src = before.columns[mv.from];
    return `${cardName(src[src.length - mv.count])}${mv.count > 1 ? ` and ${mv.count - 1} more` : ''} to column ${mv.to + 1}`;
  };
  // What a line chose at t, up to the next move that shows cards. (The card that
  // came up is left out on purpose: no one knew it. The board has it.)
  function chose(line, t) {
    const seg = nextShow(line, t);
    if (!seg.moves.length) return { seg, text: 'stopped here' };
    const shown = seg.moves.map((mv, i) => moveText(mv, line.snaps[t + i]));
    const list = shown.length > 3 ? `${shown.slice(0, 2).join(', ')}, ${shown.length - 3} more, ${shown[shown.length - 1]}` : shown.join(', ');
    const last = seg.moves[seg.moves.length - 1];
    return { seg, text: list + (seg.shows === 'turn' ? `, turning the card in column ${last.from + 1}` : '') };
  }
  const result = line => (line.over === 'won' ? `won in ${plural(line.moves.length, 'move')}` : line.over === 'lost' ? `lost after ${plural(line.moves.length, 'move')}` : `at move ${line.moves.length}, not over`);
  const undosOf = c => (c.undos === undefined ? '' : ` · ${plural(c.undos, 'undo')}`);
  const stand = p => `${p.turned} turned · ${plural(p.suits, 'suit')} · ${p.empty} empty`;
  const rowName = (r, last) => (r === 0 ? 'Up to the first deal' : r < last ? `Deal ${r} to deal ${r + 1}` : `After deal ${r}`);

  // ---- the board of one attempt

  function card(c) {
    const s = suitOf(c);
    return `<i class="cp-card s${s}">${['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][rankOf(c)]}${['♠', '♥', '♦', '♣'][s]}&#xFE0E;</i>`;
  }

  function side(which, line, t, other) {
    const snap = line.snaps[t], mv = t > 0 ? line.moves[t - 1] : null, unlike = other ?? new Set();
    const cols = snap.columns.map((col, c) => {
      const down = snap.faceDown[c], up = col.slice(down);
      return `<div class="cp-col${unlike.has(c) ? ' differs' : ''}${mv && !mv.deal && mv.to === c ? ' moved' : ''}">${down ? `<i class="cp-down" title="${plural(down, 'card')} face down">${down}</i>` : ''}${up.map(card).join('')}</div>`;
    }).join('');
    const now = standing(line, t), shows = t > 0 && line.shows[t - 1];
    return `<div class="cp-side-head"><b>${esc(nameOf(which === 'a' ? aId : bId))}</b>
        <span class="cp-nav"><button data-step="${which},-1" title="Back a move"${t ? '' : ' disabled'}>‹</button><span class="cp-at">${t}/${line.moves.length}</span><button data-step="${which},1" title="On a move"${t < line.moves.length ? '' : ' disabled'}>›</button><button data-show="${which}" title="On to the next move that shows cards"${t < line.moves.length ? '' : ' disabled'}>»</button></span>
      </div>
      <div class="cp-line">${t ? `${esc(moveText(line.moves[t - 1], line.snaps[t - 1]))}${shows === 'turn' ? ', turning a card' : ''}` : 'The deal'}</div>
      <div class="cp-line dim">${stand(now)} · ${snap.stock.length / 10} deals left</div>
      <div class="cp-grid">${cols}</div>`;
  }

  // ---- drawing

  function splitHtml() {
    const sp = rel?.split;
    if (!sp) return '';
    const on = pick === 'split' ? ' sel' : '', title = sp.a === sp.b ? `Move ${sp.a + 1}` : `Moves ${sp.a + 1} and ${sp.b + 1}`;
    const a = chose(A, sp.a), b = chose(B, sp.b);
    let verdict = '';
    if (sp.kind === 'cards') verdict = '<div class="cp-odds">No choice here: both dealt, but columns alike stood in different places, so the cards landed differently.</div>';
    else if (sp.kind === 'choice') {
      const m = measured;
      const close = m && Math.abs(m.mean) < 1.96 * m.se;
      verdict = !m ? '<div class="cp-odds"><i class="spin"></i>Playing it out both ways…</div>'
        : `<div class="cp-odds">Chance of winning from here: ${esc(nameOf(aId))} <b>${pct(m.a)}</b>, ${esc(nameOf(bId))} <b>${pct(m.b)}</b>${close ? ': too close to call' : ''} <span class="dim">(±${Math.max(1, Math.round(196 * m.se))} on the difference, ${m.n} games each with the unseen cards reshuffled)</span></div>`;
    }
    return `<button type="button" class="cp-key${on}" data-pick="split">
      <span class="cp-key-head"><span class="num">★</span><span class="what">Where they part: ${title}</span></span>
      <span class="cp-who a"><b>${esc(nameOf(aId))}:</b> ${esc(a.text)}</span>
      <span class="cp-who b"><b>${esc(nameOf(bId))}:</b> ${esc(b.text)}</span>
      ${verdict}</button>`;
  }

  function rowHtml(x) {
    const last = Math.max(A.deals.length, B.deals.length), on = pick === x.r ? ' sel' : '';
    const who = (name, p, cls) => (p ? `<span class="cp-who ${cls}"><b>${esc(name)}:</b> ${p.from === null ? '' : `${pct(p.from)} → ${pct(p.value)}`}${p.worst && p.worst.play <= -0.02 ? ` · <span class="jump" data-jump="${cls},${p.worst.from}" role="button">look at ${p.worst.to - p.worst.from > 1 ? `moves ${p.worst.from + 1}–${p.worst.to}` : `move ${p.worst.to}`}</span>` : ''}</span>` : '');
    return `<div class="cp-key${on}" data-pick="${x.r}" role="button" tabindex="0">
      <span class="cp-key-head"><span class="num">${x.diff === null ? '·' : points(x.diff)}</span><span class="what">${rowName(x.r, last)}${x.diff === null ? '' : `: ${Math.abs(Math.round(x.diff * 100))} points towards ${esc(forWhom(x.diff > 0 ? aId : bId))}, by the network`}</span></span>
      ${who(nameOf(aId), x.a, 'a')}${who(nameOf(bId), x.b, 'b')}</div>`;
  }

  function draw() {
    if (closed) return;
    const fill = (select, value) => {
      if (select.options.length === choices.length) return; // (left alone, so that one open stays open)
      select.innerHTML = choices.map(c => `<option value="${esc(c.id)}"${c.id === value ? ' selected' : ''}${c.disabled ? ' disabled' : ''}>${esc(c.label)}</option>`).join('');
    };
    fill($('[data-side=a]'), aId);
    fill($('[data-side=b]'), bId);
    $('.cp-status').hidden = !busy && !failed;
    $('.cp-bar').hidden = !busy || !!failed;
    $('.cp-text').textContent = failed || busy;
    if (!A || !B) return;
    const sp = rel.split;
    let sum;
    if (aId === bId) sum = 'Pick two different attempts.';
    else if (!sp) sum = 'The same game: these two reach the same position in the end.';
    else {
      const where = sp.a === 0 && sp.b === 0 ? 'They part from the deal.' : `The same position up to move ${sp.a}${sp.a === sp.b ? '' : ` of ${esc(whose(aId))} and move ${sp.b} of ${esc(whose(bId))}`}.`;
      const never = sp.kind === 'end' ? ` ${esc(whose(sp.ended === 'a' ? aId : bId)).replace(/^y/, 'Y')} line stops there.` : ' After that they never reach the same position again, so they are compared deal by deal.';
      sum = `${where}${never}`;
    }
    const ignored = [rel.reordered && plural(rel.reordered, 'stretch of moves').replace('stretchs', 'stretches') + ' in another order', rel.takenBack && plural(rel.takenBack, 'move back to a position')].filter(Boolean);
    $('.cp-sum').innerHTML = `<b>${esc(nameOf(aId))}</b> ${result(A)}${undosOf(choices.find(c => c.id === aId))}; <b>${esc(nameOf(bId))}</b> ${result(B)}${undosOf(choices.find(c => c.id === bId))}. ${sum}${quickWins ? ' <b>The quick computer wins this deal</b>: pick it above to see how.' : ''}${ignored.length ? ` <span class="dim">(Left out, as coming to the same: ${ignored.join(', ')}.)</span>` : ''}`;
    const shownKeys = keys.slice();
    if (typeof pick === 'number' && !shownKeys.some(x => x.r === pick) && all[pick]) shownKeys.push(all[pick]);
    const html = splitHtml() + (shownKeys.length ? shownKeys.map(rowHtml).join('') : '');
    if ($('.cp-keys').dataset.html !== html) { // (left alone when nothing changed, so that a click on it is not lost)
      $('.cp-keys').dataset.html = html;
      $('.cp-keys').innerHTML = html;
    }
    const [ua, ub] = differing(A.snaps[at[0]], B.snaps[at[1]]);
    $('.cp-side.a').innerHTML = side('a', A, at[0], ua);
    $('.cp-side.b').innerHTML = side('b', B, at[1], ub);
    const last = Math.max(A.deals.length, B.deals.length);
    const cell = (line, p) => {
      if (!p) return '<td class="dim">—</td>';
      return `<td>${p.ended && line.over ? `<b>${line.over}</b>` : p.value === null ? '' : `<b>${pct(p.value)}</b>`}<span class="cp-stand">${stand(p)}</span></td>`;
    };
    $('.cp-table').innerHTML = `<table><tr><th>By the end of</th><th class="a">${esc(nameOf(aId))}</th><th class="b">${esc(nameOf(bId))}</th><th class="num" title="The first's chance of winning less the second's, by the network">Gap</th></tr>
      ${all.map(x => `<tr data-pick="${x.r}"${pick === x.r ? ' class="sel"' : ''}><th>${rowName(x.r, last).replace('Up to the first deal', 'First deal').replace(/^Deal \d+ to deal /, 'Deal ')}</th>${cell(A, x.a)}${cell(B, x.b)}<td class="num">${x.gap === null ? '' : points(x.gap)}</td></tr>`).join('')}</table>`;
    $('.cp-note').innerHTML = `${[aId, bId].includes('computer') ? 'The computer sees only what is face up and takes nothing back. At every choice it plays what the analysis rates best: its own lines played on in shuffles of the cards not seen, so the analysis finds next to no mistakes in its game; this is the one game it plays on these cards. ' : [aId, bId].includes('quick') ? 'The computer sees only what is face up and takes nothing back; at a glance it plays the line the analysis measures everything against, without weighing others. ' : ''}Both lines are read as played straight through; moves taken back are left out, though the cards they showed may have helped (hence the undos above). What came up later in one line is not something the other player could have known. From deal to deal the numbers are the network\'s, a rough judge of any one position, and part of what moves them is the cards, which do not come up alike: they point at where to look, and only the choice where the lines part is played out. <span class="keys">Keys: ← → both boards a move · ↑ ↓ the moments · Esc back</span>`;
  }

  const redraw = () => { if (!closed) draw(); };

  // ---- the work

  // The computer's game of the deal: `quick`, the line player's own (thought
  // out anew at each card, as the analysis's games are), else the stronger
  // player's (strong.js), which is kept here once played, since it takes a
  // while. Without the WebAssembly engine there is only the first.
  let playing = null;
  function computer(quick) {
    const key = `${suits}/${seed}`, saved = store.get(CACHE, {})[key];
    const said = text => { if (!A) { busy = text; redraw(); } }; // (while the lines are waited for)
    if (quick) {
      return computerGame(suits, seed, position => pool.run({ next: position }, true).then(a => a.next), moves => {
        said(`The computer is playing: move ${moves.length}…`);
        return !closed;
      });
    }
    if (saved) return Promise.resolve({ moves: parseMoves(saved.moves), won: saved.won });
    // (One game at a time, played on while the computer is still one of the two picked.)
    if (playing) return playing;
    let over = false; // given up, or done
    const game = playing = pool.run({ engine: true }).then(({ engine }) => {
      if (engine !== 'wasm') return computer(true);
      return strongGame(suits, seed, job => pool.run({ strong: job }).then(a => a.cands ?? a.worth), {
        step(moves, turns, g) {
          said(`The computer is playing, weighing each choice: ${turns} made, ${g.faceDown.reduce((a, b) => a + b, 0) + g.stock.length} cards still to come…`);
          if (!closed && [aId, bId].includes('computer')) return true;
          over = true;
          if (playing === game) playing = null;
          return false;
        },
      }).then(played => {
        if (over) return null;
        if (playing === game) playing = null;
        const now = store.get(CACHE, {});
        now[key] = { moves: encodeMoves(played.moves), won: played.won, t: Date.now() };
        for (const k of Object.keys(now).sort((a, b) => now[b].t - now[a].t).slice(KEEP)) delete now[k];
        store.set(CACHE, now);
        return played;
      });
    });
    return playing;
  }

  async function lineOf(id) {
    if (lines.has(id)) return lines.get(id);
    const c = choices.find(x => x.id === id);
    let line;
    if (id === 'computer' || id === 'quick') {
      const game = await computer(id === 'quick');
      if (!game) return null;
      line = readLine(suits, seed, game.moves, 'lost');
    } else line = readLine(suits, seed, c.moves, c.over);
    lines.set(id, line);
    return line;
  }

  async function values(id, line) {
    if (valued.has(id)) return valued.get(id);
    const jobs = valueJobs(line), out = new Map();
    await Promise.all(Array.from({ length: Math.ceil(jobs.length / VALUES) }, async (_, i) => {
      const batch = jobs.slice(VALUES * i, VALUES * i + VALUES), { values: got } = await pool.run({ value: batch.map(j => j.enc) });
      batch.forEach((j, k) => out.set(j.key, got[k]));
    }));
    valued.set(id, out);
    return out;
  }

  // The two choices at the split played out, in the same shuffles of what was
  // not to be seen there.
  async function measure(sp, mine) {
    const opt = searchFor(suits), n = opt.fresh;
    const worlds = async (line, t) => {
      const seg = nextShow(line, t), start = line.snaps[t], out = new Float32Array(n), base = (Number(BigInt(seed) % 1000003n) * 131 + t) | 0;
      const job = { suits, columns: start.columns, faceDown: start.faceDown, completed: start.completed.length, stock: start.stock, moves: seg.moves, at: [seg.moves.length], seed: base, stop: opt.stop };
      return { job, out, seg };
    };
    const a = await worlds(A, sp.a), b = await worlds(B, sp.b);
    b.job.seed = a.job.seed;
    const all = [];
    for (const side of [a, b]) {
      for (let w = 0; w < n; w += opt.piece) {
        const to = Math.min(n, w + opt.piece);
        all.push(pool.run({ roll: { ...side.job, from: w, to } }).then(({ rolls }) => { side.out.set(rolls, w); }));
      }
    }
    await Promise.all(all);
    if (mine !== token) return;
    measured = paired(a.out, b.out);
    busy = '';
    redraw();
  }

  async function compare() {
    const mine = ++token;
    A = B = null;
    measured = null;
    all = keys = [];
    $('.cp-keys').innerHTML = $('.cp-side.a').innerHTML = $('.cp-side.b').innerHTML = $('.cp-table').innerHTML = $('.cp-sum').innerHTML = '';
    delete $('.cp-keys').dataset.html;
    busy = 'Fetching the network…';
    redraw();
    const net = await fetchNet();
    if (closed || mine !== token) return;
    if (!pool) {
      const cores = navigator.hardwareConcurrency || 4;
      pool = new Pool(Math.max(1, Math.min(12, cores - 1)), net, suits, e => { failed = `The comparison failed: ${e.message || 'a worker stopped'}`; redraw(); });
    }
    busy = 'Reading the games…';
    redraw();
    const la = await lineOf(aId), lb = await lineOf(bId);
    if (closed || mine !== token || !la || !lb) return;
    A = la;
    B = lb;
    // (The two computers' games of a deal are different games: one may win where the other loses.)
    quickWins = false;
    if ([aId, bId].includes('computer') && !lines.get('computer').won && ![aId, bId].includes('quick')) {
      lineOf('quick').then(q => { if (q?.won && mine === token) { quickWins = true; redraw(); } });
    }
    rel = relate(A, B);
    all = rows(A, B);
    const sp = rel.split;
    pick = sp ? 'split' : null;
    at = sp ? [sp.a, sp.b] : [A.moves.length, B.moves.length];
    busy = 'Valuing the positions…';
    redraw();
    const va = await values(aId, A), vb = await values(bId, B);
    if (closed || mine !== token) return;
    all = rows(A, B, va, vb);
    keys = keyRows(all);
    if (!sp) pick = keys[0]?.r ?? null;
    if (sp?.kind === 'choice') {
      busy = 'Playing out the choice where they part…';
      redraw();
      await measure(sp, mine);
    } else {
      busy = '';
      redraw();
    }
  }

  function start() {
    compare().catch(e => {
      failed = `The comparison failed: ${e.message}`;
      redraw();
    });
  }

  // ---- what the player does

  function pickOut(p) {
    pick = p;
    if (p === 'split' && rel.split) at = [rel.split.a, rel.split.b];
    else if (typeof p === 'number' && all[p]) at = [all[p].a?.start ?? A.moves.length, all[p].b?.start ?? B.moves.length];
    redraw();
  }

  el.addEventListener('click', e => {
    if (!A) { if (e.target.closest('[data-close]')) ctx.close(); return; } // (still working)
    const b = e.target.closest('button, [data-jump], [data-pick]');
    if (!b) return;
    const d = b.dataset;
    if ('close' in d) ctx.close();
    else if ('analyze' in d) ctx.analyze();
    else if (d.jump) {
      const [which, t] = d.jump.split(',');
      at[which === 'a' ? 0 : 1] = +t;
      redraw();
      $('.cp-boards').scrollIntoView({ block: 'nearest' });
    } else if (d.step) {
      const [which, n] = d.step.split(','), i = which === 'a' ? 0 : 1, line = i ? B : A;
      at[i] = Math.max(0, Math.min(line.moves.length, at[i] + +n));
      redraw();
    } else if (d.show) {
      const i = d.show === 'a' ? 0 : 1, line = i ? B : A;
      at[i] = nextShow(line, at[i]).to || at[i];
      redraw();
    } else if (d.pick !== undefined) {
      pickOut(d.pick === 'split' ? 'split' : +d.pick);
      $('.cp-boards').scrollIntoView({ block: 'nearest' });
    }
  });
  el.addEventListener('change', e => {
    const s = e.target.closest('select');
    if (!s) return;
    if (s.dataset.side === 'a') aId = s.value;
    else bId = s.value;
    start();
  });

  function key(e) {
    const k = e.key;
    if (e.target.closest?.('select')) { if (k !== 'Escape') return; }
    if (k === 'Escape') ctx.close();
    else if (!A) return;
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const d = k === 'ArrowLeft' ? -1 : 1;
      at = [Math.max(0, Math.min(A.moves.length, at[0] + d)), Math.max(0, Math.min(B.moves.length, at[1] + d))];
      redraw();
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      const list = [...(rel.split ? ['split'] : []), ...keys.map(x => x.r)], i = list.indexOf(pick) + (k === 'ArrowUp' ? -1 : 1);
      if (list[i] !== undefined) pickOut(list[i]);
    } else return;
    e.preventDefault();
  }

  (async () => {
    await style();
    redraw();
    start();
    const got = await ctx.attempts();
    if (closed) return;
    why = got.why ?? '';
    (got.attempts ?? []).forEach((a, i) => {
      const text = encodeMoves(ctx.mine.moves);
      if (a.moves === text) return;
      const name = a.mine ? 'Your other' : a.username;
      choices.push({
        id: `s${i}`, name: a.mine ? 'You, before' : a.username, moves: parseMoves(a.moves), over: a.won ? 'won' : 'lost',
        ...(a.real_undos !== null && a.real_undos !== undefined && { undos: a.real_undos }),
        label: `${a.mine ? `${name} win` : a.won ? `${name}'s win` : `${name}'s lost game`} (${plural(a.moves.split(',').filter(Boolean).length, 'move')}${a.real_undos == null ? '' : `, ${plural(a.real_undos, 'undo')}`})`,
      });
    });
    if (why) choices.push({ id: 'why', name: '', label: why, disabled: true });
    redraw();
  })().catch(e => {
    failed = `The comparison failed: ${e.message}`;
    redraw();
  });

  return {
    key,
    get state() { return { aId, bId, busy, failed, at, pick, choices: choices.map(c => c.label), rel: rel && { split: rel.split, reordered: rel.reordered, takenBack: rel.takenBack, same: rel.same }, measured, keys: keys.map(x => ({ r: x.r, diff: x.diff })), rows: all.map(x => ({ r: x.r, gap: x.gap })) }; },
    destroy() {
      closed = true;
      token++;
      pool?.close();
      el.remove();
    },
  };
}
