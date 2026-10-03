// The Spider client: board, mouse/touch and keyboard play, saves in-progress
// games in this browser, and records wins on the server.
import { Game, NUM_COLS, DEAL, suitOf, rankOf, encodeMoves, parseMoves } from './game.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// U+FE0E keeps phones from drawing the suits as emoji.
const SUITS = ['♠', '♥', '♦', '♣'].map(s => s + '︎');
const MAX_SEED = 2 ** 53 - 1;
const MAX_SAVES = 30;

const $ = s => document.querySelector(s);
const board = $('#board'), dialog = $('#dialog');
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// ---------------------------------------------------------------- state

let me = null; // {username, settings} when logged in
let settings = { colors: 'mine', ...store.get('spider:settings', {}) };

let g; // the Game
let undos = 0, realUndos = 0; // real undos take back a card flip or a deal
let recorded = ''; // move list of the last win of this deal sent to the server
let sel = null; // selected run: {col, count}
let cursor = 0, showCursor = false; // keyboard column cursor
let keyboardUsed = store.get('spider:keyboard', false); // then columns show their number keys
let L; // layout, see computeLayout

// ---------------------------------------------------------------- saving and loading

const keyOf = (suits, seed) => `${suits}/${seed}`;

function save() {
  const saves = store.get('spider:saves', {});
  saves[keyOf(g.suits, g.seed)] = {
    moves: encodeMoves(g.moves()), redo: encodeMoves(g.redoMoves()), undos, realUndos, recorded, t: Date.now(),
  };
  for (const k of Object.keys(saves).sort((a, b) => saves[b].t - saves[a].t).slice(MAX_SAVES)) delete saves[k];
  store.set('spider:saves', saves);
  store.set('spider:last', keyOf(g.suits, g.seed));
}

function load(suits, seed, push = false) {
  g = new Game(suits, seed);
  undos = realUndos = 0;
  recorded = '';
  sel = null;
  const s = store.get('spider:saves', {})[keyOf(suits, seed)];
  if (s) {
    try {
      const redo = parseMoves(s.redo);
      for (const mv of [...parseMoves(s.moves), ...redo]) if (g.apply(mv)) throw new Error('bad save');
      for (const _ of redo) g.undo();
      [undos, realUndos, recorded] = [s.undos, s.realUndos, s.recorded ?? ''];
    } catch {
      g = new Game(suits, seed);
    }
  }
  const url = `/play/${suits}/${seed}`;
  if (location.pathname !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
  $('#dangler').hidden = true;
  save();
  render();
  if (g.isWon()) onWin();
}

const randomSeed = () => 1 + Math.floor(Math.random() * 999_999_999);

function loadFromUrl() {
  const m = /^\/play\/([124])\/(\d{1,16})\/?$/.exec(location.pathname);
  if (m && +m[2] <= MAX_SEED) return load(+m[1], +m[2]);
  const last = store.get('spider:last', null);
  if (last) {
    const [suits, seed] = last.split('/').map(Number);
    return load(suits, seed);
  }
  load(2, randomSeed());
}

// ---------------------------------------------------------------- actions

function after() {
  save();
  render();
  if (g.isWon()) onWin();
}

function play(mv) {
  const err = g.apply(mv);
  if (err) return flash(err);
  sel = null;
  after();
}

// Move from -> to. Lenient (keyboard): onto a card, move however many cards fit.
function moveTo(from, to, count, lenient) {
  if (lenient && g.columns[to].length) count = g.requiredCount(from, to) ?? count;
  const err = g.checkMove(from, to, count);
  if (err) return flash(err);
  play({ from, to, count });
}

// Where a run would most usefully go: onto its own suit, then any card, then
// an empty column (never just the whole column into another empty one).
function bestDestination(from, count) {
  const src = g.columns[from], bottom = src[src.length - count];
  let best = null, bestScore = 0;
  for (let i = 1; i < NUM_COLS; i++) {
    const to = (from + i) % NUM_COLS;
    if (g.checkMove(from, to, count)) continue;
    const top = g.columns[to].at(-1);
    const score = top === undefined ? (count === src.length ? 0 : 1) : suitOf(top) === suitOf(bottom) ? 3 : 2;
    if (score > bestScore) [best, bestScore] = [to, score];
  }
  return best;
}

function autoMove(from, count) {
  const to = bestDestination(from, count);
  if (to === null) {
    sel = { col: from, count };
    render();
    return flash('Nowhere to move those cards');
  }
  play({ from, to, count });
}

function undoOne() {
  if (g.undoRevealsInfo()) realUndos++;
  undos++;
  g.undo();
}

async function undo() {
  if (!g.canUndo()) return;
  if (g.undoRevealsInfo()) {
    const what = g.history.at(-1).mv.deal ? 'a deal' : 'a move that turned a card over';
    if (!await confirmDialog('Real undo?', `This takes back ${what}, so it counts as a real undo.`, 'Undo', ['u'])) return;
  }
  undoOne();
  sel = null;
  after();
}

function redo() {
  if (!g.redo()) return;
  sel = null;
  after();
}

async function restart() {
  if (!g.canUndo()) return;
  const real = g.history.filter(r => r.mv.deal || r.flips.length).length;
  const text = real ? `Going back to the start takes back cards you have seen: ${plural(real, 'real undo')}.`
    : 'Your moves go onto the redo stack.';
  if (!await confirmDialog('Restart this deal?', text, 'Restart', ['R'])) return;
  while (g.canUndo()) undoOne();
  sel = null;
  after();
}

// ---------------------------------------------------------------- winning

function pending() { return store.get('spider:pending', []); }

function markRecorded(win) {
  const saves = store.get('spider:saves', {});
  const s = saves[keyOf(win.suits, win.seed)];
  if (s) { s.recorded = win.moves; store.set('spider:saves', saves); }
  if (g.suits === win.suits && g.seed === win.seed) recorded = win.moves;
  store.set('spider:pending', pending().filter(p => !(p.suits === win.suits && p.seed === win.seed && p.moves === win.moves)));
}

// Send wins made while logged out.
async function submitPending() {
  for (const win of pending()) {
    try {
      await api('POST', '/wins', win);
      markRecorded(win);
    } catch (e) {
      if (e.status === 400) markRecorded(win); // the server will never take it
    }
  }
}

async function onWin() {
  const win = { suits: g.suits, seed: g.seed, moves: encodeMoves(g.moves()), real_undos: realUndos, undos };
  const d = $('#dangler');
  if (d.hidden) { d.hidden = false; d.style.animation = 'none'; void d.offsetWidth; d.style.animation = ''; }
  if (!me) {
    if (win.moves !== recorded && !pending().some(p => p.suits === win.suits && p.seed === win.seed && p.moves === win.moves)) {
      store.set('spider:pending', [...pending(), win]);
    }
    return showWinDialog(win, `<p>Log in to record this win and see how your friends did.</p>
      <div class="row" style="justify-content:flex-start"><button data-login class="primary">Log in or sign up</button></div>`);
  }
  showWinDialog(win, '<p>Saving…</p>');
  try {
    const data = win.moves === recorded ? await api('GET', `/results/${win.suits}/${win.seed}`) : await api('POST', '/wins', win);
    markRecorded(win);
    save();
    showWinDialog(win, resultsTable(data.results));
  } catch (e) {
    showWinDialog(win, `<p class="error">Could not save this win: ${esc(e.message)}. Reload to try again.</p>`);
  }
}

function showWinDialog(win, body) {
  if (dialog.open && !dialog.querySelector('[data-win]')) return; // don't replace another dialog
  openDialog(`<h2 data-win>Solved!</h2>
    <p>${suitsLabel(win.suits)} · deal ${win.seed}<br>
      <b>${plural(win.moves.split(',').length, 'move')}</b> ·
      <b>${plural(win.real_undos, 'real undo')}</b> <span class="dim">(${plural(win.undos, 'undo')} in all)</span></p>
    <div>${body}</div>
    <div class="row"><button data-close>Look at the board</button><button class="primary" data-new>New game</button></div>`,
  e => {
    if (e.target.closest('[data-new]')) newGameDialog();
    if (e.target.closest('[data-login]')) accountDialog('login');
  });
}

function resultsTable(rows) {
  const mine = me?.username.toLowerCase();
  return `<table><tr><th>Player</th><th class="num">Real undos</th><th class="num">Moves</th><th>Date</th></tr>
    ${rows.map(r => `<tr class="${r.username.toLowerCase() === mine ? 'me' : ''}"><td>${esc(r.username)}</td>
      <td class="num">${r.real_undos}</td><td class="num">${r.moves}</td>
      <td>${new Date(r.at * 1000).toLocaleDateString()}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- dialogs

function openDialog(html, onClick) {
  dialog.onclose = dialog.onkeydown = null;
  dialog.innerHTML = `<div class="panel">${html}</div>`;
  dialog.onclick = e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close(); // backdrop or close button
    else onClick?.(e);
  };
  if (!dialog.open) dialog.showModal();
  return dialog;
}

// Resolves true when confirmed (also by any of `keys`), false when dismissed.
function confirmDialog(title, text, ok, keys = []) {
  return new Promise(resolve => {
    const done = v => { dialog.onclose = null; dialog.close(); resolve(v); };
    openDialog(`<h2>${title}</h2><p>${text}</p>
      <div class="row"><button data-close>Cancel</button><button class="primary" data-ok>${ok}</button></div>`,
    e => { if (e.target.closest('[data-ok]')) done(true); });
    dialog.onclose = () => resolve(false);
    dialog.onkeydown = e => { if (keys.includes(e.key)) { e.preventDefault(); done(true); } };
    dialog.querySelector('[data-ok]').focus();
  });
}

const suitsLabel = n => plural(n, 'suit');

function newGameDialog() {
  let suits = g.suits;
  const choices = () => [1, 2, 4].map(n => `<button type="button" data-suits="${n}" aria-pressed="${n === suits}">${suitsLabel(n)}</button>`).join('');
  openDialog(`<h2>New game</h2>
    <form>
      <label>Suits</label><div class="choices">${choices()}</div>
      <label for="seed">Deal number</label>
      <input id="seed" type="text" inputmode="numeric" autocomplete="off" placeholder="random">
      <p class="error"></p>
      <div class="row"><button type="button" data-close>Cancel</button><button class="primary">Deal</button></div>
    </form>`,
  e => {
    const b = e.target.closest('[data-suits]');
    if (b) { suits = +b.dataset.suits; dialog.querySelector('.choices').innerHTML = choices(); }
  });
  dialog.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const text = dialog.querySelector('#seed').value.trim();
    const seed = text === '' ? randomSeed() : Number(text);
    if (!/^\d*$/.test(text) || seed > MAX_SEED) {
      dialog.querySelector('.error').textContent = 'A deal number is a whole number.';
      return;
    }
    dialog.close();
    load(suits, seed, true);
  };
  dialog.querySelector('form .primary').focus();
}

function accountDialog(mode) {
  const signup = mode === 'signup';
  openDialog(`<h2>${signup ? 'Sign up' : 'Log in'}</h2>
    <form>
      <label for="u">Username</label><input id="u" type="text" autocomplete="username" autocapitalize="off" required>
      <label for="p">Password</label><input id="p" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
      ${signup ? '<label for="i">Invite code</label><input id="i" type="text" autocomplete="off" autocapitalize="off" required>' : ''}
      <p class="error"></p>
      <div class="row">
        <button type="button" data-switch style="margin-right:auto">${signup ? 'I have an account' : 'New here? Sign up'}</button>
        <button type="button" data-close>Cancel</button><button class="primary">${signup ? 'Sign up' : 'Log in'}</button>
      </div>
    </form>`,
  e => { if (e.target.closest('[data-switch]')) accountDialog(signup ? 'login' : 'signup'); });
  const form = dialog.querySelector('form');
  form.onsubmit = async e => {
    e.preventDefault();
    const body = { username: form.u.value, password: form.p.value, invite: signup ? form.i.value : '' };
    try {
      me = await api('POST', signup ? '/signup' : '/login', body);
    } catch (err) {
      form.querySelector('.error').textContent = err.message;
      return;
    }
    dialog.close();
    await loggedIn();
    if (g.isWon()) onWin();
  };
  form.u.focus();
}

async function loggedIn() {
  // The account's settings win over this browser's; a new account takes this browser's.
  if (me.settings?.colors) applySettings(me.settings, false);
  else api('PUT', '/settings', settings).catch(() => {});
  await submitPending();
  render();
}

function applySettings(s, upload = true) {
  settings = { ...settings, ...s };
  store.set('spider:settings', settings);
  document.body.classList.toggle('traditional', settings.colors === 'traditional');
  if (upload && me) api('PUT', '/settings', settings).catch(() => {});
}

function settingsDialog() {
  const choice = (value, label, cls) => `<button type="button" data-colors="${value}" aria-pressed="${settings.colors === value}">
    ${label} <span class="swatch ${cls}"><span>♠&#xFE0E;</span><span>♥&#xFE0E;</span><span>♦&#xFE0E;</span><span>♣&#xFE0E;</span></span></button>`;
  const html = () => `<h2>Settings</h2><label>Suit colours</label>
    <div class="choices">${choice('mine', 'Four colours', 'mine')}${choice('traditional', 'Traditional', 'trad')}</div>
    <div class="row"><button class="primary" data-close>Done</button></div>`;
  openDialog(html(), e => {
    const b = e.target.closest('[data-colors]');
    if (b) { applySettings({ colors: b.dataset.colors }); dialog.querySelector('.panel').innerHTML = html(); }
  });
}

function helpDialog() {
  const keys = [
    ['<kbd>1</kbd> … <kbd>9</kbd> <kbd>0</kbd>', 'pick a column, then the column to move to'],
    ['<kbd>←</kbd> <kbd>→</kbd>', 'move the cursor; <kbd>Enter</kbd> or <kbd>Space</kbd> picks the cursor column'],
    ['<kbd>↑</kbd> <kbd>↓</kbd>', 'pick more or fewer cards (for empty columns)'],
    ['same column twice', 'move the run wherever fits best'],
    ['<kbd>Esc</kbd>', 'drop the selection'],
    ['<kbd>d</kbd>', 'deal'],
    ['<kbd>u</kbd> <kbd>r</kbd>', 'undo, redo'],
    ['<kbd>R</kbd>', 'restart this deal'],
    ['<kbd>n</kbd>', 'new game'],
    ['<kbd>?</kbd>', 'this help'],
  ];
  openDialog(`<h2>How to play</h2>
    <p>Build runs from king down to ace in one suit; a finished run is cleared. Win by clearing all eight.
    Drag cards, or tap a run and then where it should go. Tap a picked run again to move it wherever it fits best.</p>
    <p>Undos are free, except a <b>real undo</b>: one that takes back a card turned over or a deal.
    Wins record your moves and real undos.</p>
    <dl>${keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="row"><button class="primary" data-close>Got it</button></div>`);
}

function menuDialog() {
  const items = [
    ['restart', 'Restart this deal', g.canUndo()],
    ['results', 'Results for this deal', g.isWon()],
    ['link', 'Copy link to this deal', true],
    ['settings', 'Settings', true],
    ['help', 'How to play', true],
    me ? ['logout', `Log out (${esc(me.username)})`, true] : ['login', 'Log in or sign up', true],
  ];
  openDialog(`<h2>Spider</h2><div class="menu">${items.filter(i => i[2]).map(([k, label]) => `<button data-m="${k}">${label}</button>`).join('')}</div>
    <div class="row"><button data-close>Close</button></div>`,
  async e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    dialog.close();
    switch (b.dataset.m) {
      case 'restart': return restart();
      case 'results': return onWin();
      case 'link': return copyLink();
      case 'settings': return settingsDialog();
      case 'help': return helpDialog();
      case 'login': return accountDialog('login');
      case 'logout':
        await api('POST', '/logout').catch(() => {});
        me = null;
        render();
        return flash('Logged out');
    }
  });
}

function copyLink() {
  navigator.clipboard?.writeText(location.href).then(() => flash('Link copied'), () => flash(location.href));
}

// ---------------------------------------------------------------- drawing

function cardBack() {
  const spider = document.getElementById('spider').innerHTML
    .replaceAll('currentColor', '#160d22').replace(/var\(--spider-mark[^)]*\)/g, '#b8243c').replace(/var\(--spider-eye[^)]*\)/g, '#d9c9ef');
  const cx = 50, cy = 70, spokes = 12, web = [];
  const at = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  for (let k = 0; k < spokes; k++) web.push(`M${cx},${cy}L${at(130, (2 * Math.PI * k) / spokes)}`);
  for (let r = 7; r < 110; r *= 1.38) {
    for (let k = 0; k < spokes; k++) {
      const a0 = (2 * Math.PI * k) / spokes, a1 = (2 * Math.PI * (k + 1)) / spokes;
      web.push(`M${at(r, a0)}Q${at(r * 0.84, (a0 + a1) / 2)} ${at(r, a1)}`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">
    <rect width="100" height="140" fill="#4b2d6f"/>
    <path d="${web.join('')}" fill="none" stroke="#e8dcff" stroke-opacity=".3" stroke-width=".8"/>
    <path d="M50,0V58" stroke="#e8dcff" stroke-opacity=".7" stroke-width=".7"/>
    <rect x="4" y="4" width="92" height="132" rx="6" fill="none" stroke="#e8dcff" stroke-opacity=".45" stroke-width="1.4"/>
    <g transform="translate(50 74) scale(.36)">${spider}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function computeLayout() {
  const bw = board.clientWidth;
  const gap = Math.max(3, Math.min(14, bw * 0.012));
  const cw = Math.min(110, Math.floor((bw - gap * (NUM_COLS - 1)) / NUM_COLS));
  const ch = Math.round(cw * 1.4);
  const font = Math.round(Math.max(11, Math.min(22, cw * 0.27)));
  L = {
    gap, cw, ch, font, top0: keyboardUsed ? 26 : 10,
    left0: (bw - cw * NUM_COLS - gap * (NUM_COLS - 1)) / 2,
    down: Math.max(4, Math.round(ch * 0.09)),
    up: Math.max(Math.round(ch * 0.24), Math.round(font * 1.35)),
  };
  const root = document.documentElement.style;
  root.setProperty('--cw', `${cw}px`);
  root.setProperty('--ch', `${ch}px`);
  root.setProperty('--font', `${font}px`);
}

const colX = c => L.left0 + c * (L.cw + L.gap);

// Card tops in a column, squeezed to fit the board's height when possible.
function cardTops(c) {
  const n = g.columns[c].length, fd = g.faceDown[c], ups = Math.max(0, n - fd - 1);
  const room = board.clientHeight - L.top0 - L.ch - 8;
  let down = L.down, up = L.up;
  if (fd * down + ups * up > room) {
    down = Math.max(3, Math.min(down, (room - ups * up) / Math.max(fd, 1)));
    if (ups) up = Math.max(L.font * 1.1, Math.min(up, (room - fd * down) / ups));
  }
  const tops = [];
  let y = L.top0;
  for (let i = 0; i < n; i++) { tops.push(y); y += i < fd ? down : up; }
  return tops;
}

function faceHtml(card, style, extra = '', attrs = '') {
  const s = suitOf(card);
  return `<div class="card up s${s} ${extra}" style="${style}" ${attrs}><div class="corner"><span>${RANKS[rankOf(card)]}</span><span>${SUITS[s]}</span></div><div class="pip">${SUITS[s]}</div></div>`;
}

function render() {
  let html = '';
  for (let c = 0; c < NUM_COLS; c++) {
    const x = colX(c), col = g.columns[c], fd = g.faceDown[c], tops = cardTops(c);
    html += `<div class="slot" style="left:${x}px;top:${L.top0}px"></div>`;
    col.forEach((card, i) => {
      const style = `left:${x}px;top:${tops[i]}px`, attrs = `data-c="${c}" data-i="${i}"`;
      if (i < fd) html += `<div class="card down" style="${style}" ${attrs}></div>`;
      else html += faceHtml(card, style, sel && sel.col === c && i >= col.length - sel.count ? 'sel' : '', attrs);
    });
  }
  if (keyboardUsed) {
    for (let c = 0; c < NUM_COLS; c++) {
      html += `<div class="col-num${showCursor && c === cursor ? ' cursor' : ''}" style="left:${colX(c)}px">${(c + 1) % 10}</div>`;
    }
  }
  board.innerHTML = html;

  const small = L.cw * 0.7;
  $('#done').style.width = `${g.completed.length ? small + (g.completed.length - 1) * small * 0.3 : 0}px`;
  $('#done').innerHTML = g.completed.map((s, i) => faceHtml(s * 13 + 12, `left:${i * small * 0.3}px;top:0`)).join('');
  const deals = g.dealsRemaining();
  $('#stock').style.width = `${deals ? small + (deals - 1) * small * 0.18 : 0}px`;
  $('#stock').innerHTML = Array.from({ length: deals }, (_, i) => `<div class="card down" style="left:${i * small * 0.18}px;top:0"></div>`).join('');

  $('#info').innerHTML = `${suitsLabel(g.suits)} · <span class="seed" title="Copy link to this deal">deal ${g.seed}</span> ·
    <b>${g.history.length}</b> moves · <b>${undos}</b> undos${realUndos ? ` (<b>${realUndos}</b> real)` : ''}`;
  $('#b-undo').disabled = !g.canUndo();
  $('#b-redo').disabled = !g.canRedo();
}

let msgTimer;
function flash(text) {
  const m = $('#msg');
  m.textContent = text;
  m.classList.add('flash');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.textContent = ''; m.classList.remove('flash'); }, 2500);
}

// ---------------------------------------------------------------- mouse and touch

// The column under a page x coordinate, or null outside the columns.
function colAt(x) {
  const rel = x - board.getBoundingClientRect().left - L.left0, step = L.cw + L.gap;
  if (rel < -L.gap || rel > NUM_COLS * step) return null;
  return Math.max(0, Math.min(NUM_COLS - 1, Math.floor((rel + L.gap / 2) / step)));
}

let press = null; // pointer down: {col, i, x, y}
let drag = null; // dragging: {col, count, ghost, dx, dy}

function tap(col, i) {
  const n = g.columns[col].length;
  const movable = i >= 0 && i >= n - g.runLen(col);
  if (sel && col !== sel.col) return moveTo(sel.col, col, sel.count, false);
  if (sel && (!movable || n - i === sel.count)) return autoMove(col, sel.count);
  if (movable) {
    sel = { col, count: n - i };
    render();
  } else if (i >= g.faceDown[col]) {
    flash('Only a same-suit run can move together');
  }
}

function startDrag() {
  const { col, i } = press, n = g.columns[col].length;
  if (i < 0 || i < n - g.runLen(col)) return false;
  const els = [...board.querySelectorAll(`.card[data-c="${col}"]`)].filter(el => +el.dataset.i >= i);
  const first = els[0].getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  for (const el of els) {
    const copy = el.cloneNode(true);
    copy.classList.remove('sel');
    copy.style.left = '0px';
    copy.style.top = `${el.getBoundingClientRect().top - first.top}px`;
    ghost.append(copy);
    el.classList.add('hide');
  }
  document.body.append(ghost);
  drag = { col, count: n - i, ghost, dx: press.x - first.left, dy: press.y - first.top };
  return true;
}

function endDrag() {
  drag?.ghost.remove();
  drag = null;
}

board.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const col = colAt(e.clientX);
  showCursor = false;
  if (col === null) {
    press = null;
    if (sel) { sel = null; render(); }
    return;
  }
  const el = e.target.closest('.card');
  press = { col, i: el ? +el.dataset.i : -1, x: e.clientX, y: e.clientY };
});

window.addEventListener('pointermove', e => {
  if (!press) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    if (!startDrag()) { press = null; return; }
  }
  drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
});

window.addEventListener('pointerup', e => {
  if (!press) return;
  const p = press;
  press = null;
  if (!drag) return tap(p.col, p.i);
  const { col, count } = drag;
  const to = colAt(e.clientX - drag.dx + L.cw / 2);
  endDrag();
  sel = null;
  if (to === null || to === col) return render();
  render();
  moveTo(col, to, count, false);
});

window.addEventListener('pointercancel', () => {
  press = null;
  if (drag) { endDrag(); render(); }
});

// ---------------------------------------------------------------- keyboard

function columnKey(c) {
  cursor = c;
  showCursor = true;
  if (!sel) {
    const run = g.runLen(c);
    if (run) sel = { col: c, count: run };
    render();
  } else if (sel.col === c) {
    autoMove(c, sel.count);
  } else {
    moveTo(sel.col, c, sel.count, true);
  }
}

function changeCount(d) {
  if (!sel) return;
  sel.count = Math.max(1, Math.min(g.runLen(sel.col), sel.count + d));
  render();
}

document.addEventListener('keydown', e => {
  if (dialog.open || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (/^[0-9]$/.test(k)) columnKey(k === '0' ? 9 : +k - 1);
  else if (k === 'ArrowLeft' || k === 'h') { cursor = (cursor + NUM_COLS - 1) % NUM_COLS; showCursor = true; render(); }
  else if (k === 'ArrowRight' || k === 'l') { cursor = (cursor + 1) % NUM_COLS; showCursor = true; render(); }
  else if (k === 'Enter' || k === ' ') columnKey(cursor);
  else if (k === 'ArrowUp' || k === '+' || k === '=') changeCount(1);
  else if (k === 'ArrowDown' || k === '-') changeCount(-1);
  else if (k === 'Escape') { sel = null; render(); }
  else if (k === 'd') play(DEAL);
  else if (k === 'u') undo();
  else if (k === 'r') redo();
  else if (k === 'R') restart();
  else if (k === 'n') newGameDialog();
  else if (k === '?') helpDialog();
  else return;
  e.preventDefault();
  if (!keyboardUsed) {
    keyboardUsed = true;
    store.set('spider:keyboard', true);
    computeLayout();
    render();
  }
});

// ---------------------------------------------------------------- start

for (const b of document.querySelectorAll('#bar button')) b.addEventListener('mousedown', e => e.preventDefault()); // keep keyboard focus on the board
$('#b-new').onclick = newGameDialog;
$('#b-undo').onclick = undo;
$('#b-redo').onclick = redo;
$('#b-menu').onclick = menuDialog;
$('#b-logo').onclick = helpDialog;
$('#stock').onclick = () => play(DEAL);
$('#info').onclick = e => { if (e.target.closest('.seed')) copyLink(); };
window.addEventListener('resize', () => { computeLayout(); render(); });
window.addEventListener('popstate', loadFromUrl);

document.documentElement.style.setProperty('--back', cardBack());
applySettings({}, false);
computeLayout();
loadFromUrl();
api('GET', '/me').then(user => {
  if (user) { me = user; loggedIn(); }
}).catch(() => {});
