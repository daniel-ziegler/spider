// The Spider client: a home page with the daily challenges, an archive of past
// ones, and the board, with mouse/touch and keyboard play. In-progress games
// are saved in this browser; wins are recorded on the server.
import { Game, NUM_COLS, DEAL, suitOf, rankOf, encodeMoves, parseMoves } from './game.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// U+FE0E keeps phones from drawing the suits as emoji.
const SUITS = ['♠', '♥', '♦', '♣'].map(s => s + '︎');
const MAX_SEED = 2 ** 53 - 1;
const MAX_SAVES = 30;

const $ = s => document.querySelector(s);
const board = $('#board'), page = $('#page'), dialog = $('#dialog');
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
let settings = { colors: 'mine', breaks: true, ...store.get('spider:settings', {}) };
applySettings({}, false);

let view = 'home'; // 'home', 'archive' or 'game'
let g = null; // the Game, once one is loaded
let undos = 0, realUndos = 0; // real undos take back a card flip or a deal
let recorded = ''; // move list of the last win of this deal sent to the server
let sel = null; // selected run: {col, count}
let cursor = 0, showCursor = false; // keyboard column cursor
let hint = null; // while Tab cycles through hints: {moves, i}
let dailies = null; // daily challenges up to today, from the server: {today, days: [{date, challenges}]}
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
  setUrl(`/play/${suits}/${seed}`, push);
  setView('game');
  computeLayout();
  $('#dangler').hidden = true;
  save();
  render();
  if (g.isWon()) startup.then(onWin); // once we know who is logged in
}

const randomSeed = () => 1 + Math.floor(Math.random() * 999_999_999);

function setUrl(url, push) {
  if (location.pathname !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function setView(v) {
  view = v;
  document.body.dataset.view = v;
}

// The home page or the archive.
function showPage(name, push = false) {
  setUrl(name === 'archive' ? '/archive' : '/', push);
  setView(name);
  sel = hint = null;
  $('#dangler').hidden = true;
  if (dialog.open) dialog.close();
  render();
  page.scrollTop = 0;
}

function route() {
  const m = /^\/play\/([124])\/(\d{1,16})\/?$/.exec(location.pathname);
  if (m && +m[2] <= MAX_SEED) return load(+m[1], +m[2]);
  showPage(location.pathname === '/archive' ? 'archive' : 'home');
}

// ---------------------------------------------------------------- actions

function after() {
  hint = null;
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
    fetchDailies();
  } catch (e) {
    showWinDialog(win, `<p class="error">Could not save this win: ${esc(e.message)}. Reload to try again.</p>`);
  }
}

function showWinDialog(win, body) {
  if (dialog.open && !dialog.querySelector('[data-win]')) return; // don't replace another dialog
  const date = dailyDate(win.suits, win.seed);
  openDialog(`<h2 data-win>Solved!</h2>
    <p>${date ? `Daily challenge · ${dayLabel(date)} · ${suitsLabel(win.suits)}` : `${suitsLabel(win.suits)} · deal ${win.seed}`}<br>
      <b>${plural(win.moves.split(',').length, 'move')}</b> ·
      <b>${plural(win.real_undos, 'real undo')}</b> <span class="dim">(${plural(win.undos, 'undo')} in all)</span></p>
    <div>${body}</div>
    <div class="row"><button data-close>Look at the board</button><button class="primary" data-home>More games</button></div>`,
  e => {
    if (e.target.closest('[data-home]')) showPage('home', true);
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
  dialog.className = '';
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

// ---------------------------------------------------------------- home page and daily challenges

async function fetchDailies() {
  try { dailies = await api('GET', '/dailies'); } catch { /* offline: no dailies */ }
  render();
}

// The date of the daily challenge with this deal, if it is one.
function dailyDate(suits, seed) {
  return dailies?.days.find(d => d.challenges.some(c => c.suits === suits && c.seed === seed))?.date ?? null;
}

function dayLabel(date) {
  if (date === dailies?.today) return 'today';
  return new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const longDate = date => new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const isMe = name => !!me && name.toLowerCase() === me.username.toLowerCase();
const started = (suits, seed) => { const s = store.get('spider:saves', {})[keyOf(suits, seed)]; return !!(s && (s.moves || s.undos)); };

// Green once you have won it; yellow if that took real undos.
const wonClass = c => (c.mine ? (c.mine.real_undos ? ' won undos' : ' won') : '');

function solversText(c) {
  if (!c.solved) return 'No one has won it yet';
  if (!c.solvers) return `Won by ${plural(c.solved, 'player')}`;
  return `Won by ${c.solvers.map(n => (isMe(n) ? 'you' : esc(n))).join(', ')}`;
}

// A challenge on the home page.
function challengeTile(c) {
  const status = c.mine ? `✓ ${plural(c.mine.moves, 'move')} · ${c.mine.real_undos ? plural(c.mine.real_undos, 'real undo') : 'no real undos'}`
    : started(c.suits, c.seed) ? 'In progress' : 'Play';
  const pips = [...new Set(Array.from({ length: 4 }, (_, i) => (c.suits === 1 ? 0 : c.suits === 2 ? i % 2 : i)))]
    .map(s => `<i class="s${s}">${SUITS[s]}</i>`).join('');
  return `<button type="button" class="challenge tile${wonClass(c)}" data-play="${c.suits}/${c.seed}">
    <span class="pips">${pips}</span><span class="name">${suitsLabel(c.suits)}</span>
    <small class="status">${status}</small><small class="who">${solversText(c)}</small></button>`;
}

// A challenge in the archive, whose columns are labelled with the suits.
function challengeCell(c) {
  const lines = c.mine ? [`✓ ${c.mine.moves}`, `${c.mine.real_undos} real`]
    : [started(c.suits, c.seed) ? 'started' : 'play', '&nbsp;'];
  lines.push(c.solvers?.length ? c.solvers.map(n => (isMe(n) ? 'you' : esc(n))).join(', ') : c.solved ? `${c.solved} won` : '&nbsp;');
  const [first, ...rest] = lines;
  return `<button type="button" class="challenge${wonClass(c)}" data-play="${c.suits}/${c.seed}" title="${solversText(c)}">
    <span>${first}</span>${rest.map(l => `<small>${l}</small>`).join('')}</button>`;
}

// The last game played in this browser, unless it is finished.
function unfinishedGame() {
  const key = store.get('spider:last', null), s = key && store.get('spider:saves', {})[key];
  if (!s || !s.moves || s.recorded) return null;
  const [suits, seed] = key.split('/').map(Number);
  if (pending().some(p => p.suits === suits && p.seed === seed)) return null;
  const daily = dailyDate(suits, seed);
  return { key, label: `${daily ? `daily ${dayLabel(daily)}, ${suitsLabel(suits)}` : `${suitsLabel(suits)}, deal ${seed}`} · ${plural(s.moves.split(',').length, 'move')}` };
}

function homeHtml() {
  const today = dailies && dailies.days[0]?.date === dailies.today ? dailies.days[0] : null;
  const last = unfinishedGame();
  return `<div class="pagewrap">
    <div class="hero"><div class="hang"><span class="thread"></span><svg><use href="#spider"/></svg></div><h1>Spider</h1></div>
    <section class="box">
      <h2>Today's challenges</h2>
      <p class="dim">${today ? `${longDate(today.date)} · all winnable` : dailies ? 'No challenges today.' : 'Loading…'}</p>
      ${today ? `<div class="tiles">${today.challenges.map(challengeTile).join('')}</div>` : ''}
      <div class="row start"><button type="button" data-go="archive">Past challenges</button></div>
    </section>
    <section class="box">
      <h2>Free play</h2>
      ${last ? `<div class="row start"><button type="button" class="primary" data-play="${last.key}">Continue: ${last.label}</button></div>` : ''}
      <label>Random deal</label>
      <div class="choices">${[1, 2, 4].map(n => `<button type="button" data-random="${n}">${suitsLabel(n)}</button>`).join('')}</div>
      <form class="deal">
        <label for="seed">Or a deal number</label>
        <div class="choices"><input id="seed" name="seed" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 42">
          <select name="suits" aria-label="Suits">${[1, 2, 4].map(n => `<option value="${n}"${n === 2 ? ' selected' : ''}>${suitsLabel(n)}</option>`).join('')}</select>
          <button>Play</button></div>
        <p class="error"></p>
      </form>
    </section>
    <section class="box account">
      ${me ? `<p>Logged in as <b>${esc(me.username)}</b></p><div class="row start"><button type="button" data-logout>Log out</button></div>`
        : `<p>Log in to record your wins and see how your friends did.</p>
          <div class="row start"><button type="button" class="primary" data-login>Log in</button><button type="button" data-signup>Create account</button></div>`}
    </section>
  </div>`;
}

function archiveHtml() {
  return `<div class="pagewrap">
    <div class="row start"><button type="button" data-go="home">← Home</button></div>
    <section class="box">
      <h2>Daily challenges</h2>
      <p class="dim">Every deal here can be won. Green means you won it with no real undos, yellow that you needed some.</p>
      ${dailies ? `<div class="archive"><span></span>${[1, 2, 4].map(n => `<div class="head">${suitsLabel(n)}</div>`).join('')}
        ${dailies.days.map(d => `<div class="day">${dayLabel(d.date)}</div>${d.challenges.map(challengeCell).join('')}`).join('')}</div>`
        : '<p class="dim">Loading…</p>'}
    </section>
  </div>`;
}

function renderPage() {
  $('#info').innerHTML = '';
  page.innerHTML = view === 'archive' ? archiveHtml() : homeHtml();
}

// Click handler part for anything listing challenges.
function playChallenge(e) {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  const [suits, seed] = b.dataset.play.split('/').map(Number);
  if (dialog.open) dialog.close();
  if (view !== 'game' || suits !== g.suits || seed !== g.seed) load(suits, seed, true);
}

page.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.go) showPage(b.dataset.go, true);
  else if (b.dataset.random) load(+b.dataset.random, randomSeed(), true);
  else if ('login' in b.dataset) accountDialog('login');
  else if ('signup' in b.dataset) accountDialog('signup');
  else if ('logout' in b.dataset) logout();
  else playChallenge(e);
});

page.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, text = form.seed.value.trim();
  if (!/^\d+$/.test(text) || Number(text) > MAX_SEED) {
    form.querySelector('.error').textContent = 'A deal number is a whole number.';
    return;
  }
  load(+form.suits.value, Number(text), true);
});

function accountDialog(mode) {
  const signup = mode === 'signup', invite = store.get('spider:invite', '');
  openDialog(`<h2>${signup ? 'Sign up' : 'Log in'}</h2>
    <form>
      <label for="u">Username</label><input id="u" type="text" autocomplete="username" autocapitalize="off" required>
      <label for="p">Password</label><input id="p" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
      ${signup ? `<div${invite ? ' hidden' : ''}><label for="i">Invite code</label><input id="i" type="text" autocomplete="off" autocapitalize="off" required value="${esc(invite)}"></div>` : ''}
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
      form.i?.parentElement.removeAttribute('hidden'); // a bad code from an invite link can be fixed
      return;
    }
    dialog.close();
    await loggedIn();
    if (view === 'game' && g.isWon()) onWin();
  };
  form.u.focus();
}

async function loggedIn() {
  // The account's settings win over this browser's; a new account takes this browser's.
  if (me.settings?.colors) applySettings(me.settings, false);
  else api('PUT', '/settings', settings).catch(() => {});
  await submitPending();
  fetchDailies();
}

function applySettings(s, upload = true) {
  settings = { ...settings, ...s };
  store.set('spider:settings', settings);
  document.body.classList.toggle('traditional', settings.colors === 'traditional');
  document.body.classList.toggle('show-breaks', !!settings.breaks);
  if (upload && me) api('PUT', '/settings', settings).catch(() => {});
}

function settingsDialog() {
  const choice = (value, label, cls) => `<button type="button" data-colors="${value}" aria-pressed="${settings.colors === value}">
    ${label} <span class="swatch ${cls}"><span>♠&#xFE0E;</span><span>♥&#xFE0E;</span><span>♦&#xFE0E;</span><span>♣&#xFE0E;</span></span></button>`;
  const html = () => `<h2>Settings</h2><label>Suit colours</label>
    <div class="choices">${choice('mine', 'Four colours', 'mine')}${choice('traditional', 'Traditional', 'trad')}</div>
    <label>Mark where a stack breaks (a card on one that is not one rank higher)</label>
    <div class="choices"><button type="button" data-breaks="" aria-pressed="${!settings.breaks}">Off</button><button type="button" data-breaks="1" aria-pressed="${!!settings.breaks}">On</button></div>
    <div class="row"><button class="primary" data-close>Done</button></div>`;
  openDialog(html(), e => {
    const b = e.target.closest('[data-colors]');
    const k = e.target.closest('[data-breaks]');
    if (b) applySettings({ colors: b.dataset.colors });
    else if (k) applySettings({ breaks: !!k.dataset.breaks });
    else return;
    dialog.querySelector('.panel').innerHTML = html();
  });
}

function helpDialog() {
  const keys = [
    ['<kbd>1</kbd> … <kbd>9</kbd> <kbd>0</kbd>', 'pick a column, then the column to move to'],
    ['<kbd>←</kbd> <kbd>→</kbd>', 'move the cursor; <kbd>Enter</kbd> or <kbd>Space</kbd> picks the cursor column'],
    ['<kbd>↑</kbd> <kbd>↓</kbd>', 'pick more or fewer cards (for empty columns)'],
    ['same column twice', 'move the run wherever fits best'],
    ['<kbd>Tab</kbd>', 'hint: step through useful moves, best first (<kbd>Shift</kbd> <kbd>Tab</kbd> back); <kbd>Enter</kbd> plays it'],
    ['<kbd>Esc</kbd>', 'drop the selection'],
    ['<kbd>d</kbd>', 'deal'],
    ['<kbd>u</kbd> <kbd>r</kbd>', 'undo, redo'],
    ['<kbd>R</kbd>', 'restart this deal'],
    ['<kbd>n</kbd>', 'home: daily challenges and new games'],
    ['<kbd>?</kbd>', 'this help'],
  ];
  openDialog(`<h2>How to play</h2>
    <p>Build runs from king down to ace in one suit; a finished run is cleared. Win by clearing all eight.
    Drag cards, or tap a run and then where it should go. Tap a picked run again to move it wherever it fits best.
    <b>Hint</b> steps through useful moves, best first; tap the column outlined in green to play one.</p>
    <p>Undos are free, except a <b>real undo</b>: one that takes back a card turned over or a deal.
    Wins record your moves and real undos.</p>
    <dl>${keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="row"><button class="primary" data-close>Got it</button></div>`);
}

function menuDialog() {
  const playing = view === 'game';
  const items = [
    ['home', 'Home: daily challenges and new games', view !== 'home'],
    ['archive', 'Past daily challenges', view !== 'archive'],
    ['restart', 'Restart this deal', playing && g.canUndo()],
    ['results', 'Results for this deal', playing && g.isWon()],
    ['link', 'Copy link to this deal', playing],
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
      case 'home': return showPage('home', true);
      case 'archive': return showPage('archive', true);
      case 'restart': return restart();
      case 'results': return onWin();
      case 'link': return copyLink();
      case 'settings': return settingsDialog();
      case 'help': return helpDialog();
      case 'login': return accountDialog('login');
      case 'logout': return logout();
    }
  });
}

async function logout() {
  await api('POST', '/logout').catch(() => {});
  me = null;
  fetchDailies();
  flash('Logged out');
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
    gap, cw, ch, font, top0: 26, // room for the column numbers, shown or not
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
  if (view !== 'game') return renderPage();
  const hinted = hint?.moves[hint.i], hintTo = hinted && !hinted.deal ? hinted.to : null;
  let html = '';
  for (let c = 0; c < NUM_COLS; c++) {
    const x = colX(c), col = g.columns[c], fd = g.faceDown[c], tops = cardTops(c);
    html += `<div class="slot${hintTo === c ? ' hint' : ''}" style="left:${x}px;top:${L.top0}px"></div>`;
    col.forEach((card, i) => {
      const style = `left:${x}px;top:${tops[i]}px`, attrs = `data-c="${c}" data-i="${i}"`;
      if (i < fd) html += `<div class="card down" style="${style}" ${attrs}></div>`;
      else {
        const mark = sel && sel.col === c && i >= col.length - sel.count ? 'sel' : hintTo === c && i === col.length - 1 ? 'hint' : '';
        // A break: this card is not one rank lower than the face-up card under it.
        const broken = i > fd && rankOf(card) + 1 !== rankOf(col[i - 1]) ? ' broken' : '';
        html += faceHtml(card, style, mark + broken, attrs);
      }
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
  $('#stock').innerHTML = Array.from({ length: deals }, (_, i) => `<div class="card down${hinted?.deal && i === deals - 1 ? ' hint' : ''}" style="left:${i * small * 0.18}px;top:0"></div>`).join('');

  const daily = dailyDate(g.suits, g.seed);
  $('#info').innerHTML = `${daily ? `<span class="seed" title="Copy link to this deal">Daily ${dayLabel(daily)}</span> · ${suitsLabel(g.suits)}`
    : `${suitsLabel(g.suits)} · <span class="seed" title="Copy link to this deal">deal ${g.seed}</span>`} ·
    <b>${g.history.length}</b> moves · <b>${undos}</b> undos${realUndos ? ` (<b>${realUndos}</b> real)` : ''}`;
  $('#b-undo').disabled = !g.canUndo();
  $('#b-redo').disabled = !g.canRedo();
}

let msgTimer;
function flash(text, ms = 2500) {
  const m = $('#msg');
  m.textContent = text;
  m.classList.add('flash');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.textContent = ''; m.classList.remove('flash'); }, ms);
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
  hint = null;
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

const cardName = c => RANKS[rankOf(c)] + SUITS[suitOf(c)];

// Tab / Shift-Tab: step through the ranked hints, leaving the hinted run
// selected so Enter plays it.
function cycleHint(d) {
  if (!hint) {
    const moves = g.hintMoves();
    if (!moves.length) return flash('No moves left');
    hint = { moves, i: d > 0 ? 0 : moves.length - 1 };
  } else {
    hint.i = (hint.i + d + hint.moves.length) % hint.moves.length;
  }
  const mv = hint.moves[hint.i];
  let text = 'deal';
  sel = null;
  if (!mv.deal) {
    const src = g.columns[mv.from], top = g.columns[mv.to].at(-1);
    sel = { col: mv.from, count: mv.count };
    cursor = mv.to;
    text = `${cardName(src[src.length - mv.count])} onto ${top === undefined ? 'the empty column' : cardName(top)}`;
  }
  render();
  flash(`Hint ${hint.i + 1} of ${hint.moves.length}: ${text}`, 8000);
}

function changeCount(d) {
  if (!sel) return;
  sel.count = Math.max(1, Math.min(g.runLen(sel.col), sel.count + d));
  render();
}

document.addEventListener('keydown', e => {
  if (dialog.open || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (view !== 'game') {
    if (e.target.closest?.('input, select')) return;
    if (k === '?') helpDialog();
    else if (k === 'Escape' && view === 'archive') showPage('home', true);
    return;
  }
  if (k === 'Shift') return;
  if (k === 'Tab') return e.preventDefault(), markKeyboardUsed(), cycleHint(e.shiftKey ? -1 : 1);
  if (hint && (k === 'Enter' || k === ' ')) return e.preventDefault(), play(hint.moves[hint.i]);
  hint = null;
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
  else if (k === 'n') showPage('home', true);
  else if (k === '?') helpDialog();
  else return;
  e.preventDefault();
  markKeyboardUsed();
});

function markKeyboardUsed() {
  if (keyboardUsed) return;
  keyboardUsed = true;
  store.set('spider:keyboard', true);
  render();
}

// ---------------------------------------------------------------- start

for (const b of document.querySelectorAll('#bar button')) b.addEventListener('mousedown', e => e.preventDefault()); // keep keyboard focus on the board
$('#b-new').onclick = () => showPage('home', true);
$('#b-undo').onclick = undo;
$('#b-redo').onclick = redo;
$('#b-hint').onclick = () => cycleHint(1);
$('#b-menu').onclick = menuDialog;
$('#b-logo').onclick = () => showPage('home', true);
$('#stock').onclick = () => play(DEAL);
$('#info').onclick = e => { if (e.target.closest('.seed')) copyLink(); };
window.addEventListener('resize', () => { if (view === 'game') { computeLayout(); render(); } });
window.addEventListener('popstate', route);

document.documentElement.style.setProperty('--back', cardBack());
applySettings({}, false);
const startup = Promise.all([
  api('GET', '/me').then(user => { if (user) { me = user; return loggedIn(); } }).catch(() => {}),
  fetchDailies(),
]);
// An invite link, /join/CODE, opens the sign-up form with the code filled in.
const join = /^\/join\/([^/]+)\/?$/.exec(location.pathname);
if (join) {
  store.set('spider:invite', decodeURIComponent(join[1]));
  history.replaceState(null, '', '/');
  startup.then(() => { if (!me) accountDialog('signup'); });
}
route();
