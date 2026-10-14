// The Spider client: a home page with the daily challenges, an archive of past
// ones, and the board, with mouse/touch and keyboard play. In-progress games
// are saved in this browser; wins are recorded on the server.
//
// It plays FreeCell too (freecell.js): g is then a FreeCell, whose columns
// are places 0-7, free cells 8-11, and foundations the place HOME: sel.col, a
// move's from and to, and what placeAt gives are places.
//
// A deal is {game: 'spider' or 'freecell', suits, seed} (FreeCell always has
// 4 suits): g is one, and so are a win and a daily challenge.
import { Game, NUM_COLS, DEAL, suitOf, rankOf, encodeMoves, parseMoves, parseTree, mergeTree, treeText } from './game.js';
import { FreeCell, COLS, HOME, MAX_DEAL, follows } from './freecell.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// U+FE0E keeps phones from drawing the suits as emoji.
const SUITS = ['♠', '♥', '♦', '♣'].map(s => s + '︎');
// Three suits are three sets of spades, three of hearts and two of diamonds.
const SUIT_COUNTS = [1, 2, 3, 4];
const MAX_SEED = 2 ** 53 - 1;
const MAX_SAVES = 30;
const GHOST = 2 / 3; // how much of a face-up card's strip a seen face-down card gets, if its rank still fits
const SYNC_MS = 5000; // a game in progress goes to the server at most this often

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
let settings = { colors: 'mine', breaks: true, lostMark: true, ...store.get('spider:settings', {}) }; // (lostMark: say when the game can no longer be won)
applySettings({}, false);

let view = 'home'; // 'home', 'archive' or 'game'
let homeGame = 'spider'; // the game the home page is showing, 'spider' (at /) or 'freecell' (at /freecell), and the site is dressed for
let g = null; // the Game or FreeCell, once one is loaded
let base = [0, 0]; // undos and real undos made before saves kept the whole tree of moves, which counts the rest
let changedAt = 0; // when this game was last played in, here or (once synced) elsewhere
let recorded = ''; // move list of the last win of this deal sent to the server
let sel = null; // selected run: {col, count}
let cursor = 0, showCursor = false; // keyboard column cursor
let hint = null; // while Tab cycles through hints: {moves, i}
let dailies = null; // daily challenges up to today, from the server: {today, days: [{date, challenges}]}
let keyboardUsed = store.get('spider:keyboard', false); // then columns show their number keys
let finish = null; // once every card is dealt and face up: {key, line}, line being a winning line once one is found
let finishing = false; // while auto-complete plays its line
let L; // layout, see computeLayout
let review = null; // while the game is being analysed (analysis.js): the board shows its positions and is not played on

// ---------------------------------------------------------------- saving and loading

const spiderDeal = (suits, seed) => ({ game: 'spider', suits, seed });
const freecellDeal = seed => ({ game: 'freecell', suits: 4, seed });
const sameDeal = (a, b) => a.game === b.game && a.suits === b.suits && a.seed === b.seed;
// What a deal's save is kept under (a Spider deal's key is older than FreeCell here, so it does not name the game).
const keyOf = d => (d.game === 'freecell' ? `freecell/${d.seed}` : `${d.suits}/${d.seed}`);
const dealOf = key => { const [a, b] = key.split('/'); return a === 'freecell' ? freecellDeal(+b) : spiderDeal(+a, +b); };
const apiPath = d => `${d.game}/${d.suits}/${d.seed}`;
const newGame = d => (d.game === 'freecell' ? new FreeCell(d.seed) : new Game(d.suits, d.seed));
const gameUrl = d => (d.game === 'freecell' ? `/freecell/${d.seed}` : `/play/${d.suits}/${d.seed}`);
const lastKey = game => (game === 'freecell' ? 'spider:last:freecell' : 'spider:last'); // where the last game played is kept
const numCols = () => g.columns.length;
const pileLen = place => (g.freecell ? g.pile(place).length : g.columns[place].length);

// The site's name and mark go by the game: the spider is Spider's, a crown FreeCell's.
const siteName = () => (homeGame === 'freecell' ? 'Freecel Friends' : 'Spider Friends');
const mascot = () => (homeGame === 'freecell' ? '#crown' : '#spider');

function setHomeGame(name) {
  homeGame = name;
  document.body.dataset.game = name;
  document.title = $('.logo .word').textContent = siteName();
  for (const use of document.querySelectorAll('use.mascot')) use.setAttribute('href', mascot());
  $('#icon').href = name === 'freecell' ? '/freecell.svg' : '/spider.svg';
  $('meta[name=theme-color]').content = name === 'freecell' ? '#14263a' : '#14302a';
}

// Real undos take back a card flip or a deal; taking the same move back again does not count again.
const undoCount = () => base[0] + g.undos;
const realUndoCount = () => base[1] + g.realUndos;

// The game as saved here and on the server: the tree of every move played,
// and the line of it that is on the board.
function snapshot() {
  return { tree: g.treeText(), moves: encodeMoves(g.moves()), base, recorded, at: changedAt, ...(lostOnce && { lost: true }) };
}

// Set up g from a snapshot (or nothing, for a new game).
function restore(deal, s) {
  g = newGame(deal);
  base = [0, 0];
  recorded = '';
  changedAt = 0;
  lostOnce = !!s?.lost;
  if (!s) return;
  try {
    if (typeof s.tree === 'string') {
      g.adopt(parseTree(s.tree));
      for (const mv of parseMoves(s.moves)) if (g.apply(mv)) throw new Error('bad save');
      base = [s.base?.[0] | 0, s.base?.[1] | 0];
    } else {
      // A save from before the tree: one line of moves, the undone ones last.
      const redo = parseMoves(s.redo);
      for (const mv of [...parseMoves(s.moves), ...redo]) if (g.apply(mv)) throw new Error('bad save');
      for (const _ of redo) g.undo();
      base = [Math.max(0, (s.undos | 0) - g.undos), Math.max(0, (s.realUndos | 0) - g.realUndos)];
    }
    recorded = s.recorded ?? '';
    changedAt = s.at ?? s.t ?? 0;
  } catch {
    g = newGame(deal);
    base = [0, 0];
  }
}

function save() {
  const saves = store.get('spider:saves', {});
  saves[keyOf(g)] = { ...snapshot(), t: Date.now() };
  for (const k of Object.keys(saves).sort((a, b) => saves[b].t - saves[a].t).slice(MAX_SAVES)) delete saves[k];
  store.set('spider:saves', saves);
  store.set(lastKey(g.game), keyOf(g));
}

// The game changed: save it here and, before long, on the server.
function changed() {
  changedAt = Date.now();
  save();
  queueSync();
}

// ---------------------------------------------------------------- syncing games to the server

let syncTimer = null, syncedAt = 0, unsynced = false;

function queueSync() {
  unsynced = true;
  if (me && !syncTimer) syncTimer = setTimeout(sync, Math.max(0, syncedAt + SYNC_MS - Date.now()));
}

// Send the game now if it has changed; leaving: the page may be going away.
function sync(leaving = false) {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (!unsynced || !me || !g) return;
  unsynced = false;
  syncedAt = Date.now();
  const body = JSON.stringify(snapshot());
  fetch(`/api/games/${apiPath(g)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body,
    keepalive: leaving && body.length < 60000, // browsers refuse to keep bigger requests alive
  }).then(res => { if (!res.ok && res.status !== 401) unsynced = true; }, () => { unsynced = true; }); // the next change tries again
}

// Fetch the server's copy of this game and merge it in: the trees are joined,
// and the board shows whichever copy was played in last.
async function pull() {
  if (!me || view !== 'game' || review) return;
  const deal = { game: g.game, suits: g.suits, seed: g.seed }, was = changedAt;
  let remote;
  try { remote = (await api('GET', `/games/${apiPath(deal)}`)).state; } catch { return; }
  if (view !== 'game' || !sameDeal(g, deal) || finishing) return;
  const local = snapshot();
  if (typeof remote?.tree !== 'string') {
    if (local.tree) queueSync();
    return;
  }
  if (remote.tree === local.tree && remote.moves === local.moves) return;
  try {
    const theirs = changedAt === was && remote.at > local.at; // else a move was made here meanwhile, or last
    const [a, b] = theirs ? [remote, local] : [local, remote];
    const tree = treeText(mergeTree(parseTree(a.tree), parseTree(b.tree)));
    if (!theirs && tree === local.tree) return queueSync(); // nothing new there
    endDrag();
    press = sel = hint = null;
    restore(deal, {
      tree, moves: a.moves, recorded: a.recorded || b.recorded, lost: a.lost || b.lost,
      base: [0, 1].map(i => Math.max(a.base?.[i] | 0, b.base?.[i] | 0)), at: Math.max(a.at || 0, b.at || 0),
    });
  } catch {
    restore(deal, local);
  }
  save();
  queueSync();
  render();
  if (g.isWon()) onWin();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) sync(true);
  else pull(); // it may have been played elsewhere meanwhile
});
window.addEventListener('pagehide', () => sync(true));

function load(deal, push = false) {
  closeReview();
  sync();
  restore(deal, store.get('spider:saves', {})[keyOf(deal)]);
  sel = null;
  setHomeGame(deal.game);
  setUrl(gameUrl(deal), push);
  setView('game');
  computeLayout();
  $('#dangler').hidden = true;
  save();
  render();
  startup.then(() => { // once we know who is logged in
    if (view !== 'game' || !sameDeal(g, deal)) return;
    if (g.isWon()) onWin();
    pull();
  });
}

const randomSeed = () => 1 + Math.floor(Math.random() * 999_999_999);

function setUrl(url, push) {
  if (location.pathname !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function setView(v) {
  view = v;
  document.body.dataset.view = v;
}

// The home page or the archive, of the game the site is dressed for.
function showPage(name, push = false) {
  setUrl((homeGame === 'freecell' ? '/freecell' : '') + (name === 'archive' ? '/archive' : '') || '/', push);
  closeReview();
  setView(name);
  sync();
  sel = hint = null;
  $('#dangler').hidden = true;
  if (dialog.open) dialog.close();
  render();
  page.scrollTop = 0;
}

function route() {
  const m = /^\/play\/([1-4])\/(\d{1,16})\/?$/.exec(location.pathname);
  if (m && +m[2] <= MAX_SEED) return load(spiderDeal(+m[1], +m[2]));
  const f = /^\/freecell(?:\/(\d{1,10}|archive))?\/?$/.exec(location.pathname);
  if (f && +f[1] <= MAX_DEAL) return load(freecellDeal(+f[1]));
  setHomeGame(f ? 'freecell' : 'spider');
  showPage(location.pathname === '/archive' || f?.[1] === 'archive' ? 'archive' : 'home');
}

// ---------------------------------------------------------------- actions

function after() {
  hint = null;
  changed();
  render();
  if (g.isWon()) onWin();
}

function play(mv) {
  if (review) return;
  const err = g.apply(mv);
  if (err) return flash(err);
  sel = null;
  if (hint) clearFlash(); // the hint's text
  after();
}

// Move from -> to. Lenient (keyboard): onto a card, move however many cards fit.
function moveTo(from, to, count, lenient) {
  if (g.freecell) {
    // A free cell or a foundation takes the top card; an empty column as much of the run as can get there.
    if (lenient) count = to >= COLS ? 1 : g.columns[to].length ? g.requiredCount(from, to) ?? count : Math.min(count, g.capacity(to));
  } else if (lenient && g.columns[to].length) count = g.requiredCount(from, to) ?? count;
  const err = g.checkMove(from, to, count);
  if (err) return flash(err);
  play({ from, to, count });
}

// Where a run would most usefully go: onto its own suit, then any card, then
// an empty column (never just the whole column into another empty one).
function bestDestination(from, count) {
  if (g.freecell) return bestPlace(from, count);
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

// In FreeCell: a foundation, then onto a card, then an empty column, then a free cell.
function bestPlace(from, count) {
  if (!g.checkMove(from, HOME, count)) return HOME;
  let best = null;
  for (let i = 1; i <= COLS; i++) {
    const to = (from + i) % COLS;
    if (to === from || g.checkMove(from, to, count)) continue;
    if (g.columns[to].length) return to;
    if (best === null && (from >= COLS || count < g.columns[from].length)) best = to;
  }
  const cell = g.cells.indexOf(null);
  return best === null && from < COLS && count === 1 && cell >= 0 ? COLS + cell : best;
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

async function undo() {
  if (!g.canUndo() || review) return;
  if (g.freecell) {
    // Only the first undo that counts is asked about.
    if (g.undoCosts() && !realUndoCount() && !await confirmDialog('Use an undo?', 'This move cannot just be played back, so taking it back counts as an undo, and you have not used one in this game.', 'Undo', ['u'])) return;
  } else if (g.undoCosts()) {
    const what = g.history.at(-1).mv.deal ? 'a deal' : 'a move that turned a card over';
    if (!await confirmDialog('Use an undo?', `This takes back ${what}, so it counts as an undo, not a free one.`, 'Undo', ['u'])) return;
  }
  g.undo();
  sel = null;
  after();
}

function redo() {
  if (review || !g.redo()) return;
  sel = null;
  after();
}

async function restart() {
  if (!g.canUndo() || review) return;
  const real = g.line.filter(n => n.real && !n.undone).length;
  const text = real ? g.freecell ? `Going back to the start counts as ${plural(real, 'undo')}.`
    : `Going back to the start takes back cards you have seen: ${plural(real, 'undo')}.`
    : 'Your moves go onto the redo stack.';
  if (!await confirmDialog('Restart this deal?', text, 'Restart', ['R'])) return;
  while (g.canUndo()) g.undo();
  sel = null;
  after();
}

// ---------------------------------------------------------------- auto-complete

// Once every card is dealt and face up, a worker tries to play out a win
// (see solve.js); a new position replaces any attempt still running.
let solver = null;

function updateFinish() {
  if (g.freecell) {
    // In FreeCell: once sending cards to the foundations is all that is left.
    solver?.terminate();
    solver = null;
    const key = `${keyOf(g)}/${g.positionText()}`;
    if (finish?.key !== key && !finishing) finish = { key, line: g.finishLine() };
    $('#b-finish').hidden = !finish?.line || finishing;
    return;
  }
  const open = g.stock.length === 0 && g.faceDown.every(n => n === 0) && !g.isWon();
  const key = open ? `${keyOf(g)}/${g.positionText()}` : null;
  if (finish?.key !== key && !finishing) {
    solver?.terminate();
    solver = null;
    finish = key && { key, line: null };
    if (key) {
      solver = new Worker('/solve.js', { type: 'module' });
      solver.onmessage = ({ data }) => {
        solver?.terminate();
        solver = null;
        if (finish?.key !== data.key) return;
        finish.line = data.line && parseMoves(data.line);
        $('#b-finish').hidden = !finish.line || finishing;
      };
      solver.postMessage({ key, suits: g.suits, seed: g.seed, moves: encodeMoves(g.moves()) });
    }
  }
  $('#b-finish').hidden = !finish?.line || finishing;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function autoComplete() {
  if (!finish?.line || finishing || review) return;
  const line = finish.line;
  finishing = true;
  sel = hint = null;
  try {
    for (const mv of line) {
      if (view !== 'game' || g.apply(mv)) break; // left the board, or (shouldn't happen) an illegal move
      changed();
      render();
      await sleep(g.freecell ? 90 : 140);
    }
  } finally {
    finishing = false;
  }
  after();
}

// ---------------------------------------------------------------- can it still be won?

// With the setting on, a worker (winnable.js) works out after every move
// whether the game is lost whatever the cards you have not seen are, and a
// mark and a message say so if it is. It is given only what you have seen:
// the cards face up, those turned up in some line since taken back, and the
// stock if every deal has been made at some point. So it gives nothing away;
// it proves nothing while cards in the stock are unseen. With nothing unseen
// at all it may also search for a win (and still only says when there is none).
//
// FreeCell hides nothing, so there the worker (fcwinnable.js) just searches:
// the game is marked when no line at all wins. When it finds a winning line,
// every position on it is noted as one that can be won, so playing along it
// needs no more searching.
const LOST_LIMIT = 200_000, LOST_BUDGET = 2_000_000, FREECELL_LIMIT = 2_000_000;
const lostKnown = new Map(); // what has been seen, as a key -> whether the game is lost
let lostWorker = null;
let lostAt = null; // what was last looked at: {key, moves: how many moves led to it, slipped}
let lostWaiting = null; // the key the worker is on
let lostOnce = false; // whether this deal has ever been played to where it was lost: kept with the game, and its challenge shows red

function stopLost() {
  lostWorker?.terminate();
  lostWorker = lostWaiting = null;
}

// The most deals made in any line played: that many deals' cards have been seen.
function dealsSeen() {
  let most = 0;
  const stack = [[g.root, 0]];
  while (stack.length) {
    const [node, deals] = stack.pop();
    if (deals > most) most = deals;
    for (const n of node.children) stack.push([n, deals + (n.mv.deal ? 1 : 0)]);
  }
  return most;
}

function updateLost() {
  if (finishing) return;
  const el = $('#fate');
  if (!settings.lostMark || view !== 'game' || g.isWon()) {
    stopLost();
    lostAt = null;
    el.hidden = true;
    return;
  }
  const moves = g.history.length;
  let key, stockSeen = true;
  if (g.freecell) key = `freecell/${g.key()}`;
  else {
    const dealt = g.history.filter(r => r.mv.deal).length;
    stockSeen = dealsSeen() >= dealt + g.dealsRemaining();
    key = `${g.suits}/${g.seed}/${g.stock.length}/${g.positionText()}/${g.seen.join(',')}/${stockSeen}`;
  }
  if (lostAt?.key !== key) {
    const before = lostAt && lostKnown.get(lostAt.key), step = lostAt ? moves - lostAt.moves : 0;
    if (step === 1 && before === true) lostKnown.set(key, true); // a lost game stays lost
    // Whether one move led here from a position not known to be lost: then finding this one lost gets a message.
    lostAt = { key, moves, slipped: step === 1 && before !== true };
    if (lostAt.slipped && lostKnown.get(key)) warnLost();
  }
  el.hidden = lostKnown.get(key) !== true;
  if (!el.hidden) noteLost();
  if (lostKnown.has(key)) {
    if (lostWaiting !== key) stopLost();
    return;
  }
  if (lostWaiting === key) return;
  stopLost();
  if (!stockSeen && g.stock.length) return lostKnown.set(key, false); // nothing can be proved
  lostWaiting = key;
  if (g.freecell) {
    const worker = lostWorker = new Worker('/fcwinnable.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (lostWorker !== worker || data.key !== key) return;
      if (data.line && view === 'game' && g.freecell && `freecell/${g.key()}` === key) noteLine(parseMoves(data.line));
      lostAnswer(key, data.lost);
    };
    worker.onerror = () => { if (lostWorker === worker) stopLost(); };
    worker.postMessage({ key, columns: g.columns, cells: g.cells, limit: FREECELL_LIMIT });
    return;
  }
  // What has been seen: the cards of each column from seen[c] up, and how
  // many of each rank the others are and which cards they may be.
  const unseen = { hidden: [...g.seen], cards: new Array(13).fill(0), values: new Uint8Array(52) };
  const columns = g.columns.map((col, c) => col.map((v, i) => {
    if (i >= g.seen[c]) return v;
    unseen.cards[rankOf(v)]++;
    unseen.values[v] = 1;
    return 255;
  }));
  const open = unseen.hidden.every(n => n === 0) && { suits: g.suits, seed: g.seed, moves: encodeMoves(g.moves()), budget: LOST_BUDGET };
  const worker = lostWorker = new Worker('/winnable.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (lostWorker === worker && data.key === key) lostAnswer(key, data.lost);
  };
  worker.onerror = () => { if (lostWorker === worker) stopLost(); };
  worker.postMessage({ key, columns, faceDown: g.faceDown, stock: g.stock, unseen, limit: LOST_LIMIT, open });
}

// The worker's answer for the position with this key.
function lostAnswer(key, lost) {
  stopLost();
  if (lostKnown.size > 20000) lostKnown.clear();
  lostKnown.set(key, lost);
  if (lostAt?.key !== key || !lost) return;
  $('#fate').hidden = false;
  updateAnalyze();
  noteLost();
  if (lostAt.slipped) warnLost();
}

// A line wins the FreeCell game from here: every position on it can be won.
function noteLine(line) {
  const recs = [];
  for (const mv of line) {
    if (g.check(mv)) break;
    recs.push(g.applyRaw(mv));
    lostKnown.set(`freecell/${g.key()}`, false);
  }
  while (recs.length) g.unapply(recs.pop());
}

function noteLost() {
  if (lostOnce) return;
  lostOnce = true;
  save();
  queueSync();
}

function warnLost() {
  flash('Undo to go back.', 8000);
}

// ---------------------------------------------------------------- analysis

// A game of Spider can be looked over once it is won or lost (or at any
// time, from the menu): how the chance of winning went over the line of moves
// on the board, and at its biggest drops whether the moves or the cards were
// to blame. analysis.js does it, with a network and a player that are fetched
// only when this is first asked for. While it is open the board shows the
// position it is looking at (review.shown), and the game is not played on.
async function analyze() {
  if (review || view !== 'game' || g.freecell || finishing || !g.history.length) return;
  if (dialog.open) dialog.close();
  const deal = { game: g.game, suits: g.suits, seed: g.seed }, moves = g.moves();
  let open;
  try { ({ open } = await import('./analysis.js')); } catch { return flash('Could not load the analysis'); }
  if (review || view !== 'game' || !sameDeal(g, deal) || g.history.length !== moves.length) return;
  endDrag();
  press = sel = hint = null;
  clearFlash();
  $('#dangler').hidden = true;
  review = open({ suits: g.suits, seed: g.seed, moves, undos: undoCount(), cardName, render, close: closeReview });
  document.body.dataset.review = '';
  render();
}

function closeReview() {
  if (!review) return;
  review.destroy();
  review = null;
  delete document.body.dataset.review;
  if (view === 'game') render();
}

// The Analyze button is in the tray once the game is won or marked as lost.
function updateAnalyze() {
  $('#b-analyze').hidden = view !== 'game' || g.freecell || finishing || !g.history.length || !(g.isWon() || !$('#fate').hidden);
}

// ---------------------------------------------------------------- winning

// Wins made while logged out (those from before FreeCell do not name their game).
function pending() { return store.get('spider:pending', []).map(p => ({ game: 'spider', ...p })); }

function markRecorded(win) {
  const saves = store.get('spider:saves', {});
  const s = saves[keyOf(win)];
  if (s) { s.recorded = win.moves; store.set('spider:saves', saves); }
  if (sameDeal(g, win)) recorded = win.moves;
  store.set('spider:pending', pending().filter(p => !(sameDeal(p, win) && p.moves === win.moves)));
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
  const win = { game: g.game, suits: g.suits, seed: g.seed, moves: encodeMoves(g.moves()), real_undos: realUndoCount(), undos: undoCount() };
  const d = $('#dangler');
  if (d.hidden) { d.hidden = false; d.style.animation = 'none'; void d.offsetWidth; d.style.animation = ''; }
  if (!me) {
    if (win.moves !== recorded && !pending().some(p => sameDeal(p, win) && p.moves === win.moves)) {
      store.set('spider:pending', [...pending(), win]);
    }
    return showWinDialog(win, `<p>Log in to record this win and see how your friends did.</p>
      <div class="row" style="justify-content:flex-start"><button data-login class="primary">Log in or sign up</button></div>`);
  }
  showWinDialog(win, '<p>Saving…</p>');
  try {
    const data = win.moves === recorded ? await api('GET', `/results/${apiPath(win)}`) : await api('POST', '/wins', win);
    markRecorded(win);
    save();
    queueSync();
    showWinDialog(win, resultsTable(data.results));
    fetchDailies();
  } catch (e) {
    showWinDialog(win, `<p class="error">Could not save this win: ${esc(e.message)}. Reload to try again.</p>`);
  }
}

function showWinDialog(win, body) {
  if (dialog.open && !dialog.querySelector('[data-win]')) return; // don't replace another dialog
  const daily = dailyOf(win);
  openDialog(`<h2 data-win>Solved!</h2>
    <p>${daily ? `Daily challenge · ${dayLabel(daily.date)} · ${challengeLabel(daily)}` : `${dealLabel(win)} · deal ${win.seed}`}<br>
      <b>${plural(win.moves.split(',').length, 'move')}</b> ·
      <b>${plural(win.real_undos, 'undo')}</b>${win.game === 'spider' ? ` <span class="dim">(${plural(win.undos - win.real_undos, 'free undo')})</span>` : ''}</p>
    <div>${body}</div>
    <div class="row"><button data-close>Look at the board</button>${win.game === 'spider' ? '<button data-analyze>Analyze</button>' : ''}<button class="primary" data-home>More games</button></div>`,
  e => {
    if (e.target.closest('[data-home]')) showPage('home', true);
    if (e.target.closest('[data-analyze]')) analyze();
    if (e.target.closest('[data-login]')) accountDialog('login');
  });
}

function resultsTable(rows) {
  const mine = me?.username.toLowerCase();
  return `<table><tr><th>Player</th><th class="num">Undos</th><th class="num">Moves</th><th>Date</th></tr>
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
const dealLabel = d => (d.game === 'freecell' ? 'FreeCell' : suitsLabel(d.suits));

// ---------------------------------------------------------------- home page and daily challenges

async function fetchDailies() {
  try { dailies = await api('GET', '/dailies'); } catch { /* offline: no dailies */ }
  render();
}

// The daily challenge with this deal, if it is one, with its date.
function dailyOf(deal) {
  for (const d of dailies?.days ?? []) {
    const c = d.challenges.find(c => sameDeal(c, deal));
    if (c) return { ...c, date: d.date };
  }
  return null;
}

// With three and four suits a day has two challenges, a medium and a hard
// one (c.tier), which are different deals.
const challengeLabel = c => dealLabel(c) + (c.tier ? ` · ${c.tier}` : '');

function dayLabel(date) {
  if (date === dailies?.today) return 'today';
  return new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const longDate = date => new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const isMe = name => !!me && name.toLowerCase() === me.username.toLowerCase();
const started = c => { const s = store.get('spider:saves', {})[keyOf(c)]; return !!(s && (s.moves || s.tree || s.undos)); };

// Whether the deal was ever played to where it could no longer be won.
const wasLost = c => !!(c.lost || store.get('spider:saves', {})[keyOf(c)]?.lost);
// Green once you have won it; yellow if that took real undos; red if it was
// lost and has not been won.
const wonClass = c => (c.mine ? (c.mine.real_undos ? ' won undos' : ' won') : wasLost(c) ? ' lost' : '');

function solversText(c) {
  if (!c.solved) return 'No one has won it yet';
  if (!c.solvers) return `Won by ${plural(c.solved, 'player')}`;
  return `Won by ${c.solvers.map(n => (isMe(n) ? 'you' : esc(n))).join(', ')}`;
}

// A challenge on the home page.
function challengeTile(c) {
  const status = c.mine ? `✓ ${plural(c.mine.moves, 'move')} · ${plural(c.mine.real_undos, 'undo')}`
    : wasLost(c) ? 'Lost' : started(c) ? 'In progress' : 'Play';
  const pips = Array.from({ length: c.suits }, (_, s) => s)
    .map(s => `<i class="s${s}">${SUITS[s]}</i>`).join('');
  const name = c.game === 'freecell' ? `Deal ${c.seed}` : suitsLabel(c.suits);
  const tier = c.tier ? `<b class="tier">${c.tier === 'hard' ? 'Hard' : 'Medium'}</b>` : '';
  return `<button type="button" class="challenge tile${wonClass(c)}${c.tier ? ` ${c.tier}` : ''}" data-play="${keyOf(c)}">
    <span class="pips">${pips}</span><span class="name">${name}</span>${tier}
    <small class="status">${status}</small><small class="who">${solversText(c)}</small></button>`;
}

// The day's challenges of the game the site is dressed for, the medium ones
// before the hard ones (the tiles put each hard one under its medium one).
const challengesOf = day => day.challenges.filter(c => c.game === homeGame)
  .sort((a, b) => (a.tier === 'hard') - (b.tier === 'hard'));
// The archive shows one tier at a time: the one last chosen there.
let archiveTier = store.get('spider:archiveTier', 'hard');

// A challenge in the archive, whose columns are labelled with the suits.
function challengeCell(c) {
  const lines = c.mine ? [`✓ ${c.mine.moves}`, plural(c.mine.real_undos, 'undo')]
    : [wasLost(c) ? 'lost' : started(c) ? 'started' : 'play', '&nbsp;'];
  lines.push(c.solvers?.length ? c.solvers.map(n => (isMe(n) ? 'you' : esc(n))).join(', ') : c.solved ? `${c.solved} won` : '&nbsp;');
  const [first, ...rest] = lines;
  return `<button type="button" class="challenge${wonClass(c)}" data-play="${keyOf(c)}" title="${solversText(c)}">
    <span>${first}</span>${rest.map(l => `<small>${l}</small>`).join('')}</button>`;
}

// The last game (of Spider, or of FreeCell) played in this browser, unless it is finished.
function unfinishedGame(game) {
  const key = store.get(lastKey(game), null), s = key && store.get('spider:saves', {})[key];
  if (!s || !s.moves || s.recorded) return null;
  const deal = dealOf(key);
  if (deal.game !== game || pending().some(p => sameDeal(p, deal))) return null;
  const daily = dailyOf(deal);
  return { key, label: `${daily ? `daily ${dayLabel(daily.date)}, ${challengeLabel(daily)}` : `${dealLabel(deal)}, deal ${deal.seed}`} · ${plural(s.moves.split(',').length, 'move')}` };
}

function homeHtml() {
  const freecell = homeGame === 'freecell';
  const last = unfinishedGame(homeGame);
  const resume = last ? `<div class="row start"><button type="button" class="primary" data-play="${last.key}">Continue: ${last.label}</button></div>` : '';
  const game = (name, label) => `<button type="button" data-game="${name}" aria-pressed="${homeGame === name}">${label}</button>`;
  return `<div class="pagewrap">
    <div class="hero"><div class="hang"><span class="thread"></span><svg><use href="${mascot()}"/></svg></div><h1>${siteName()}</h1></div>
    <div class="games">${game('spider', 'Spider')}${game('freecell', 'FreeCell')}</div>
    ${freecell ? freecellHtml(resume) : spiderHtml(resume)}
    <section class="box account">
      ${me ? `<p>Logged in as <b>${esc(me.username)}</b></p><div class="row start"><button type="button" data-logout>Log out</button></div>`
        : `<p>Log in to record your wins and see how your friends did.</p>
          <div class="row start"><button type="button" class="primary" data-login>Log in</button><button type="button" data-signup>Create account</button></div>`}
    </section>
  </div>`;
}

function spiderHtml(resume) {
  const today = dailies && dailies.days[0]?.date === dailies.today ? dailies.days[0] : null;
  return `<section class="box">
      <h2>Today's challenges</h2>
      <p class="dim">${today ? `${longDate(today.date)} · all winnable${today.challenges.some(c => c.tier) ? ' · three and four suits have a medium deal and a hard one' : ''}` : dailies ? 'No challenges today.' : 'Loading…'}</p>
      ${today ? `<div class="tiles">${challengesOf(today).map(challengeTile).join('')}</div>` : ''}
      <div class="row start"><button type="button" data-go="archive">Past challenges</button></div>
    </section>
    <section class="box">
      <h2>Free play</h2>
      ${resume}
      <label>Random deal</label>
      <div class="choices">${SUIT_COUNTS.map(n => `<button type="button" data-random="${n}">${suitsLabel(n)}</button>`).join('')}</div>
      <form class="deal">
        <label for="seed">Or a deal number</label>
        <div class="choices"><input id="seed" name="seed" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 42">
          <select name="suits" aria-label="Suits">${SUIT_COUNTS.map(n => `<option value="${n}"${n === 2 ? ' selected' : ''}>${suitsLabel(n)}</option>`).join('')}</select>
          <button>Play</button></div>
        <p class="error"></p>
      </form>
    </section>`;
}

function freecellHtml(resume) {
  const today = dailies && dailies.days[0]?.date === dailies.today ? dailies.days[0] : null;
  return `<section class="box">
      <h2>Today's challenge</h2>
      <p class="dim">${today ? `${longDate(today.date)} · winnable, and not an easy one` : dailies ? 'No challenge today.' : 'Loading…'}</p>
      ${today ? `<div class="tiles">${challengesOf(today).map(challengeTile).join('')}</div>` : ''}
      <div class="row start"><button type="button" data-go="archive">Past challenges</button></div>
    </section>
    <section class="box">
      <h2>Free play</h2>
      <p class="dim">Every card is face up, so undos count, except of a move you could just play back. Deals are numbered as in Microsoft FreeCell.</p>
      ${resume}
      <div class="row start"><button type="button" data-random="freecell">Random deal</button></div>
      <form class="deal">
        <label for="seed">Or a deal number</label>
        <div class="choices"><input id="seed" name="seed" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 617">
          <button>Play</button></div>
        <p class="error"></p>
      </form>
    </section>`;
}

function archiveHtml() {
  const freecell = homeGame === 'freecell';
  const tiers = !freecell && dailies?.days.some(d => d.challenges.some(c => c.tier));
  const tier = (name, label) => `<button type="button" data-tier="${name}" aria-pressed="${archiveTier === name}">${label}</button>`;
  // (The medium ones began on 2026-10-14: before that, their cells are empty.)
  const cells = d => challengesOf(d).filter(c => !c.tier || c.tier === archiveTier)
    .map(c => (tiers && archiveTier === 'medium' && c.suits > 2 && !c.tier ? '<span></span>' : challengeCell(c))).join('');
  return `<div class="pagewrap">
    <div class="row start"><button type="button" data-go="home">← Home</button></div>
    <section class="box">
      <h2>Daily challenges</h2>
      <p class="dim">Every deal here can be won. Green means you won it with no undos, yellow that you needed some, red that you played it to where it could no longer be won and have not won it since.${freecell ? '' : ' Free undos don\'t count.'}</p>
      ${tiers ? `<label>With three and four suits, each day has a medium deal and a hard one</label><div class="choices tiers">${tier('medium', 'Medium')}${tier('hard', 'Hard')}</div>` : ''}
      ${dailies ? `<div class="archive${freecell ? ' one' : ''}"><span></span>${freecell ? '<div class="head">FreeCell</div>' : SUIT_COUNTS.map(n => `<div class="head">${suitsLabel(n)}${tiers && n > 2 ? ` · ${archiveTier}` : ''}</div>`).join('')}
        ${dailies.days.map(d => `<div class="day">${dayLabel(d.date)}</div>${cells(d)}`).join('')}</div>`
        : '<p class="dim">Loading…</p>'}
    </section>
  </div>`;
}

function renderPage() {
  updateLost();
  $('#info').innerHTML = '';
  page.innerHTML = view === 'archive' ? archiveHtml() : homeHtml();
}

// Click handler part for anything listing challenges.
function playChallenge(e) {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  const deal = dealOf(b.dataset.play);
  if (dialog.open) dialog.close();
  if (view !== 'game' || !sameDeal(g, deal)) load(deal, true);
}

page.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.go) showPage(b.dataset.go, true);
  else if (b.dataset.game) { setHomeGame(b.dataset.game); showPage('home', true); }
  else if (b.dataset.tier) { archiveTier = b.dataset.tier; store.set('spider:archiveTier', archiveTier); renderPage(); }
  else if (b.dataset.random) load(b.dataset.random === 'freecell' ? freecellDeal(randomSeed()) : spiderDeal(+b.dataset.random, randomSeed()), true);
  else if ('login' in b.dataset) accountDialog('login');
  else if ('signup' in b.dataset) accountDialog('signup');
  else if ('logout' in b.dataset) logout();
  else playChallenge(e);
});

page.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, text = form.seed.value.trim();
  const suits = form.suits && +form.suits.value; // the FreeCell form has no suits to choose
  if (!/^\d+$/.test(text) || Number(text) > (suits ? MAX_SEED : MAX_DEAL)) {
    form.querySelector('.error').textContent = suits ? 'A deal number is a whole number.' : `A deal number is a whole number up to ${MAX_DEAL}.`;
    return;
  }
  load(suits ? spiderDeal(suits, Number(text)) : freecellDeal(Number(text)), true);
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
  pull();
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
  const html = () => `<h2>Settings</h2><label>Suit colours in Spider (FreeCell is always red and black)</label>
    <div class="choices">${choice('mine', 'Four colours', 'mine')}${choice('traditional', 'Traditional', 'trad')}</div>
    <label>Mark where a stack breaks (a card on one that is not one rank higher; in FreeCell, or not the other colour)</label>
    <div class="choices"><button type="button" data-breaks="" aria-pressed="${!settings.breaks}">Off</button><button type="button" data-breaks="1" aria-pressed="${!!settings.breaks}">On</button></div>
    <label>Say when the game can no longer be won (going only by the cards you have seen)</label>
    <div class="choices"><button type="button" data-fate="" aria-pressed="${!settings.lostMark}">Off</button><button type="button" data-fate="1" aria-pressed="${!!settings.lostMark}">On</button></div>
    <div class="row"><button class="primary" data-close>Done</button></div>`;
  openDialog(html(), e => {
    const b = e.target.closest('[data-colors]');
    const k = e.target.closest('[data-breaks]');
    const f = e.target.closest('[data-fate]');
    if (b) applySettings({ colors: b.dataset.colors });
    else if (k) applySettings({ breaks: !!k.dataset.breaks });
    else if (f) { applySettings({ lostMark: !!f.dataset.fate }); render(); }
    else return;
    dialog.querySelector('.panel').innerHTML = html();
  });
}

function freecellHelp() {
  const keys = [
    ['<kbd>1</kbd> … <kbd>8</kbd>', 'pick a column, then the column to move to'],
    ['<kbd>z</kbd> <kbd>x</kbd> <kbd>c</kbd> <kbd>v</kbd>', 'the free cells: pick the card in one, or put the picked card there'],
    ['<kbd>f</kbd>', 'send the picked card (or the cursor column\'s) to its foundation'],
    ['<kbd>←</kbd> <kbd>→</kbd>', 'move the cursor; <kbd>Enter</kbd> or <kbd>Space</kbd> picks the cursor column'],
    ['<kbd>↑</kbd> <kbd>↓</kbd>', 'pick more or fewer cards (for empty columns)'],
    ['same column twice', 'move the run wherever fits best'],
    ['<kbd>Tab</kbd>', 'hint: step through useful moves, best first (<kbd>Shift</kbd> <kbd>Tab</kbd> back); <kbd>Enter</kbd> plays it'],
    ['<kbd>Esc</kbd>', 'drop the selection'],
    ['<kbd>a</kbd>', 'auto-complete, once only sending cards to the foundations is left'],
    ['<kbd>u</kbd> <kbd>r</kbd>', 'undo, redo'],
    ['<kbd>R</kbd>', 'restart this deal'],
    ['<kbd>n</kbd>', 'home: the daily challenge and new games'],
    ['<kbd>?</kbd>', 'this help'],
  ];
  openDialog(`<h2>How to play FreeCell</h2>
    <p>Build each suit up from the ace on the four foundations at the top right. In the columns, a card goes on one a rank higher
    of the other colour, and anything goes in an empty column. Each of the four free cells at the top left holds one card.
    A run moves in one go if there are free cells and empty columns enough to move it a card at a time.
    Cards that are no more use in the columns go to the foundations by themselves.</p>
    <p>Drag cards, or tap a run and then where it should go. Tap a picked run again to move it wherever it fits best.
    <b>Hint</b> steps through useful moves, best first; tap the place outlined in green to play one.</p>
    <p>Nothing is hidden, so an <b>undo</b> counts, unless the move could just be played back (a card put in a free cell, say,
    with nothing gone to the foundations since). Taking the same move back again after a redo does not count again.
    Wins record your moves and undos.</p>
    <p>In Settings you can have the game say when it <b>can no longer be won</b>.</p>
    <dl>${keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="row"><button class="primary" data-close>Got it</button></div>`);
}

function helpDialog() {
  if (view === 'game' ? g.freecell : homeGame === 'freecell') return freecellHelp();
  const keys = [
    ['<kbd>1</kbd> … <kbd>9</kbd> <kbd>0</kbd>', 'pick a column, then the column to move to'],
    ['<kbd>←</kbd> <kbd>→</kbd>', 'move the cursor; <kbd>Enter</kbd> or <kbd>Space</kbd> picks the cursor column'],
    ['<kbd>↑</kbd> <kbd>↓</kbd>', 'pick more or fewer cards (for empty columns)'],
    ['same column twice', 'move the run wherever fits best'],
    ['<kbd>Tab</kbd>', 'hint: step through useful moves, best first (<kbd>Shift</kbd> <kbd>Tab</kbd> back); <kbd>Enter</kbd> plays it'],
    ['<kbd>Esc</kbd>', 'drop the selection'],
    ['<kbd>d</kbd>', 'deal'],
    ['<kbd>a</kbd>', 'auto-complete, once every card is dealt and face up and a win is found'],
    ['<kbd>u</kbd> <kbd>r</kbd>', 'undo, redo'],
    ['<kbd>R</kbd>', 'restart this deal'],
    ['<kbd>n</kbd>', 'home: daily challenges and new games'],
    ['<kbd>?</kbd>', 'this help'],
  ];
  openDialog(`<h2>How to play</h2>
    <p>Build runs from king down to ace in one suit; a finished run is cleared. Win by clearing all eight.
    Drag cards, or tap a run and then where it should go. Tap a picked run again to move it wherever it fits best.
    <b>Hint</b> steps through useful moves, best first; tap the column outlined in green to play one.</p>
    <p>An <b>undo</b> takes back a card turned over or a deal. Taking back anything else is a <b>free undo</b>,
    and so is taking the same move back again after a redo.
    A card you have seen and turned back over stays half shown.
    Wins record your moves and undos.</p>
    <p>In Settings you can have the game say when it <b>can no longer be won</b>. It goes only by the cards you have seen,
    and says so only when the game is lost whatever the others are, so it gives nothing away (and often says nothing for a while after a game is lost).</p>
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
    ['analyze', 'Analyze this game', playing && !g.freecell && g.history.length > 0 && !review],
    ['link', 'Copy link to this deal', playing],
    ['settings', 'Settings', true],
    ['help', 'How to play', true],
    me ? ['logout', `Log out (${esc(me.username)})`, true] : ['login', 'Log in or sign up', true],
  ];
  openDialog(`<h2>${siteName()}</h2><div class="menu">${items.filter(i => i[2]).map(([k, label]) => `<button data-m="${k}">${label}</button>`).join('')}</div>
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
      case 'analyze': return analyze();
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
  const n = numCols();
  const cw = Math.min(110, Math.floor((bw - gap * (n - 1)) / n));
  const ch = Math.round(cw * 1.4);
  const font = Math.round(Math.max(11, Math.min(22, cw * 0.27)));
  L = {
    // top0: the columns' top, with room for the column numbers, shown or not.
    // In FreeCell the free cells and foundations are a row above them, at cellTop.
    gap, cw, ch, font, cellTop: 22, top0: g.freecell ? 22 + ch + 28 : 26,
    left0: (bw - cw * n - gap * (n - 1)) / 2,
    down: Math.max(4, Math.round(ch * 0.09)),
    up: Math.max(Math.round(ch * 0.24), Math.round(font * 1.35)),
  };
  const root = document.documentElement.style;
  root.setProperty('--cw', `${cw}px`);
  root.setProperty('--ch', `${ch}px`);
  root.setProperty('--font', `${font}px`);
}

const colX = c => L.left0 + c * (L.cw + L.gap);

// The position on the board: the game's, or the one an analysis is looking at.
const shown = () => review?.shown ?? g;

// Card tops in a column, squeezed to fit the board's height when possible.
function cardTops(c, g = shown()) {
  if (g.freecell) {
    const n = g.columns[c].length, room = board.clientHeight - L.top0 - L.ch - 8;
    const up = n > 1 ? Math.max(L.font * 1.1, Math.min(L.up, room / (n - 1))) : L.up;
    return Array.from({ length: n }, (_, i) => L.top0 + i * up);
  }
  // Face-down cards that have been seen show what they are, in two thirds of a face-up card's strip.
  const n = g.columns[c].length, fd = Math.min(g.faceDown[c], g.seen[c]), ghosts = g.faceDown[c] - fd;
  const ups = Math.max(0, n - g.faceDown[c] - 1) + ghosts * GHOST;
  const room = board.clientHeight - L.top0 - L.ch - 8;
  let down = L.down, up = L.up;
  if (fd * down + ups * up > room) {
    down = Math.max(3, Math.min(down, (room - ups * up) / Math.max(fd, 1)));
    if (ups) up = Math.max(L.font * 1.1, Math.min(up, (room - fd * down) / ups));
  }
  const ghost = Math.min(up, Math.max(up * GHOST, L.font * 1.1));
  const tops = [];
  let y = L.top0;
  for (let i = 0; i < n; i++) { tops.push(y); y += i < fd ? down : i < g.faceDown[c] ? ghost : up; }
  return tops;
}

function faceHtml(card, style, extra = '', attrs = '') {
  const s = suitOf(card);
  return `<div class="card up s${s} ${extra}" style="${style}" ${attrs}><div class="corner"><span>${RANKS[rankOf(card)]}</span><span>${SUITS[s]}</span></div><div class="pip">${SUITS[s]}</div></div>`;
}

// The FreeCell board: free cells and foundations in a row, the columns below.
function renderFreecell() {
  const hinted = hint?.moves[hint.i], hintTo = hinted ? hinted.to : null;
  const hintSuit = hintTo === HOME ? suitOf(g.pile(hinted.from).at(-1)) : -1;
  const mark = (place, i, n) => (sel && sel.col === place && i >= n - sel.count ? 'sel' : hintTo === place && i === n - 1 ? 'hint' : '');
  let html = '';
  for (let k = 0; k < 4; k++) {
    const place = COLS + k, style = `left:${colX(k)}px;top:${L.cellTop}px`, card = g.cells[k];
    html += `<div class="slot cell${hintTo === place ? ' hint' : ''}" style="${style}"></div>`;
    if (card !== null) html += faceHtml(card, style, mark(place, 0, 1), `data-c="${place}" data-i="0"`);
  }
  for (let s = 0; s < 4; s++) {
    const style = `left:${colX(4 + s)}px;top:${L.cellTop}px`, hinting = hintSuit === s ? ' hint' : '';
    html += `<div class="slot found${hinting}" style="${style}">${SUITS[s]}</div>`;
    if (g.found[s]) html += faceHtml(s * 13 + g.found[s] - 1, style, `home${hinting}`);
  }
  for (let c = 0; c < COLS; c++) {
    const x = colX(c), col = g.columns[c], tops = cardTops(c);
    html += `<div class="slot${hintTo === c ? ' hint' : ''}" style="left:${x}px;top:${L.top0}px"></div>`;
    col.forEach((card, i) => {
      const broken = i > 0 && !follows(col[i - 1], card) ? ' broken' : '';
      html += faceHtml(card, `left:${x}px;top:${tops[i]}px`, mark(c, i, col.length) + broken, `data-c="${c}" data-i="${i}"`);
    });
  }
  if (keyboardUsed) {
    for (let c = 0; c < COLS; c++) {
      html += `<div class="col-num${showCursor && c === cursor ? ' cursor' : ''}" style="left:${colX(c)}px;top:${L.top0 - 23}px">${c + 1}</div>`;
      html += `<div class="col-num" style="left:${colX(c)}px;top:${L.cellTop - 20}px">${'zxcvffff'[c]}</div>`;
    }
  }
  board.innerHTML = html;
  renderStatus();
}

// The line about the game in the header, and the buttons.
function renderStatus() {
  const daily = dailyOf(g);
  $('#info').innerHTML = `${daily ? `<span class="seed" title="Copy link to this deal">Daily ${dayLabel(daily.date)}</span> · ${challengeLabel(daily)}`
    : `${dealLabel(g)} · <span class="seed" title="Copy link to this deal">deal ${g.seed}</span>`} ·
    <b>${g.history.length}</b> moves · <b>${realUndoCount()}</b> undos${g.freecell ? '' : ` · <b>${undoCount() - realUndoCount()}</b> free undos`}`;
  $('#b-undo').disabled = !g.canUndo() || finishing;
  $('#b-redo').disabled = !g.canRedo() || finishing;
  updateFinish();
  updateLost();
  updateAnalyze();
}

function render() {
  if (view !== 'game') return renderPage();
  if (g.freecell) return renderFreecell();
  if (review) return renderReview();
  const hinted = hint?.moves[hint.i], hintTo = hinted && !hinted.deal ? hinted.to : null;
  let html = '';
  for (let c = 0; c < NUM_COLS; c++) {
    const x = colX(c), col = g.columns[c], fd = g.faceDown[c], tops = cardTops(c);
    html += `<div class="slot${hintTo === c ? ' hint' : ''}" style="left:${x}px;top:${L.top0}px"></div>`;
    col.forEach((card, i) => {
      const style = `left:${x}px;top:${tops[i]}px`, attrs = `data-c="${c}" data-i="${i}"`;
      if (i < fd) html += i < g.seen[c] ? `<div class="card down" style="${style}" ${attrs}></div>` : faceHtml(card, style, 'seen', attrs);
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
  renderTray(g, hinted?.deal);
  renderStatus();
}

// The finished suits and the stock of a position.
function renderTray(g, hintDeal) {
  const small = L.cw * 0.7;
  $('#done').style.width = `${g.completed.length ? small + (g.completed.length - 1) * small * 0.3 : 0}px`;
  $('#done').innerHTML = g.completed.map((s, i) => faceHtml(s * 13 + 12, `left:${i * small * 0.3}px;top:0`)).join('');
  const deals = g.dealsRemaining();
  $('#stock').style.width = `${deals ? small + (deals - 1) * small * 0.18 : 0}px`;
  $('#stock').innerHTML = Array.from({ length: deals }, (_, i) => `<div class="card down${hintDeal && i === deals - 1 ? ' hint' : ''}" style="left:${i * small * 0.18}px;top:0"></div>`).join('');
}

// The board of an analysis: the position it is looking at, with the cards
// the last move put down outlined (review.mark: {col, count}).
function renderReview() {
  const b = review.shown, mark = review.mark;
  let html = '';
  for (let c = 0; c < NUM_COLS; c++) {
    const x = colX(c), col = b.columns[c], fd = b.faceDown[c], tops = cardTops(c);
    html += `<div class="slot" style="left:${x}px;top:${L.top0}px"></div>`;
    col.forEach((card, i) => {
      const style = `left:${x}px;top:${tops[i]}px`;
      if (i < fd) html += `<div class="card down" style="${style}"></div>`;
      else {
        const broken = i > fd && rankOf(card) + 1 !== rankOf(col[i - 1]) ? ' broken' : '';
        html += faceHtml(card, style, (mark && mark.col === c && i >= col.length - mark.count ? 'hint' : '') + broken);
      }
    });
  }
  board.innerHTML = html;
  renderTray(b, false);
  $('#info').innerHTML = review.info;
}

let msgTimer;
function flash(text, ms = 2500) {
  const m = $('#msg');
  m.textContent = text;
  m.classList.add('flash');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(clearFlash, ms);
}

function clearFlash() {
  clearTimeout(msgTimer);
  $('#msg').textContent = '';
  $('#msg').classList.remove('flash');
}

// ---------------------------------------------------------------- mouse and touch

// The column under a page x coordinate, or null outside the columns.
function colAt(x) {
  const rel = x - board.getBoundingClientRect().left - L.left0, step = L.cw + L.gap;
  if (rel < -L.gap || rel > numCols() * step) return null;
  return Math.max(0, Math.min(numCols() - 1, Math.floor((rel + L.gap / 2) / step)));
}

// In FreeCell, the place under a page point: above the columns it is a free cell or the foundations.
function placeAt(x, y) {
  const c = colAt(x);
  if (c === null || y - board.getBoundingClientRect().top + board.scrollTop > L.top0 - 14) return c;
  return c < 4 ? COLS + c : HOME;
}

let press = null; // pointer down: {col, i, x, y}
let drag = null; // dragging: {col, count, ghost, dx, dy}

function tap(col, i) {
  if (sel && col !== sel.col) return moveTo(sel.col, col, sel.count, false);
  if (g.freecell && col === HOME) return;
  const n = pileLen(col);
  const movable = i >= 0 && i >= n - g.runLen(col);
  if (sel && (!movable || n - i === sel.count)) return autoMove(col, sel.count);
  if (movable) {
    sel = { col, count: n - i };
    render();
  } else if (g.freecell ? i >= 0 : i >= g.faceDown[col]) {
    flash(g.freecell ? 'Only a run of alternating colours can move together' : 'Only a same-suit run can move together');
  }
}

function startDrag() {
  const { col, i } = press;
  if (g.freecell && col === HOME) return false;
  const n = pileLen(col);
  if (!(i >= 0) || i < n - g.runLen(col)) return false;
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
  if (e.button !== 0 || finishing || review) return;
  const col = g.freecell ? placeAt(e.clientX, e.clientY) : colAt(e.clientX);
  showCursor = false;
  if (hint) {
    // Tapping the hinted destination plays the hint; tapping anywhere else
    // just leaves hint mode.
    const mv = hint.moves[hint.i];
    hint = null;
    clearFlash();
    if (mv.deal || col !== mv.to) {
      press = sel = null;
      return render();
    }
  }
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
  // By the middle of the dragged card; in FreeCell it is in the top row if that or the pointer is.
  const x = e.clientX - drag.dx + L.cw / 2;
  const to = g.freecell ? placeAt(x, Math.min(e.clientY, e.clientY - drag.dy + L.ch / 2)) : colAt(x);
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
  if (c < numCols()) { // (not a free cell)
    cursor = c;
    showCursor = true;
  }
  if (!sel) {
    const run = g.runLen(c);
    if (run) sel = { col: c, count: run };
    render();
  } else {
    // A move that doesn't work drops the pick too, so the next key starts over.
    if (sel.col === c) autoMove(c, sel.count);
    else moveTo(sel.col, c, sel.count, true);
    if (sel) { sel = null; render(); }
  }
}

const cardName = c => RANKS[rankOf(c)] + SUITS[suitOf(c)];

// Tab / Shift-Tab: step through the ranked hints, leaving the hinted run
// selected so Enter plays it.
function cycleHint(d) {
  if (review) return;
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
  if (g.freecell) {
    const src = g.pile(mv.from), top = g.columns[mv.to]?.at(-1);
    sel = { col: mv.from, count: mv.count };
    if (mv.to < COLS) cursor = mv.to;
    text = cardName(src[src.length - mv.count]) + (mv.to === HOME ? ' to its foundation' : mv.to >= COLS ? ' to a free cell'
      : ` onto ${top === undefined ? 'the empty column' : cardName(top)}`);
  } else if (!mv.deal) {
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
  if (dialog.open || finishing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (review) return review.key(e);
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
  const n = numCols();
  if (/^[0-9]$/.test(k)) { if ((+k || 10) <= n) columnKey((+k || 10) - 1); }
  else if (g.freecell && 'zxcv'.includes(k)) columnKey(COLS + 'zxcv'.indexOf(k));
  else if (g.freecell && k === 'f') { moveTo(sel ? sel.col : cursor, HOME, 1, true); if (sel) { sel = null; render(); } }
  else if (k === 'ArrowLeft' || k === 'h') { cursor = (cursor + n - 1) % n; showCursor = true; render(); }
  else if (k === 'ArrowRight' || k === 'l') { cursor = (cursor + 1) % n; showCursor = true; render(); }
  else if (k === 'Enter' || k === ' ') columnKey(cursor);
  else if (k === 'ArrowUp' || k === '+' || k === '=') changeCount(1);
  else if (k === 'ArrowDown' || k === '-') changeCount(-1);
  else if (k === 'Escape') { sel = null; clearFlash(); render(); }
  else if (k === 'd' && !g.freecell) play(DEAL);
  else if (k === 'a') autoComplete();
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
$('#b-hint').onclick = () => { if (!finishing) cycleHint(1); };
$('#b-menu').onclick = menuDialog;
$('#b-logo').onclick = () => showPage('home', true);
$('#stock').onclick = () => { if (!finishing && !g.freecell) play(DEAL); };
$('#b-finish').onclick = autoComplete;
$('#b-analyze').onclick = analyze;
$('#tray').addEventListener('pointerdown', e => {
  if (hint && !e.target.closest('#stock')) { hint = sel = null; clearFlash(); render(); }
});
$('#info').onclick = e => { if (e.target.closest('.seed')) copyLink(); };
window.addEventListener('resize', () => { if (view === 'game') { computeLayout(); render(); } });
window.addEventListener('popstate', route);

setHomeGame(homeGame);
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
