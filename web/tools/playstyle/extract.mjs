// A game's decisions: what T1 to T5 of the playstyle analysis need of each
// stretch, none of it played out. Runs in worker threads; see run.mjs.
import { readFileSync } from 'node:fs';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { Game } from '../../static/game.js';
import { analysisConfig, makeState, MAXC } from '../../static/lineplayer.js';
import { encode } from '../../static/vnet.js';
import { random } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';
import { fromGame, keyOf, empties, hiddenOf, reach, pathOf, tagsOf, categoryOf, play, features, questions, canDeal } from './board.mjs';
import { openGame, contaminated } from './games.mjs';
import { planted } from './planted.mjs';

const POOL = 40; // other ends of a stretch kept for the fit and the network's choice
const file = u => { const b = readFileSync(new URL(u, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

let engine, netBytes, net, netSuits = 0;
const valueOf = (p, suits) => {
  if (netSuits !== suits) { net = engine.net(netBytes, suits); netSuits = suits; }
  const columns = p.cols.map((c, i) => [...new Array(p.down[i]).fill(0), ...c]);
  return net.winProb(encode(columns, p.down, p.left / 10, p.done));
};

// The moves a line player makes from a game's position up to its first that shows cards.
function lineOf(g, cfg) {
  if (g.columns.some(c => c.length > MAXC)) return [];
  const s = makeState(g.columns, g.faceDown, g.completed.length), moves = [];
  engine.playOut(s, Uint8Array.from(g.stock), cfg, moves, true);
  return moves;
}

// Where moves end from start, as a stretch: stopped at the first that shows cards.
function endOf(start, moves) {
  let p = start, n = 0;
  for (const mv of moves) { p = play(p, mv); n++; if (p.shows) break; }
  return { p, moves: moves.slice(0, n), shows: !!p.shows };
}

// What a stretch came to, for T1.
function outcome(start, end) {
  const e0 = empties(start), e1 = empties(end.p);
  return {
    kind: !end.shows ? 'none' : end.p.left < start.left ? 'deal' : 'turn',
    empties: e1 - e0, done: end.p.done - start.done, n: end.moves.length,
  };
}

// The opportunities at a stretch's start (T1): the shortest line to each goal.
function opportunities(start, found) {
  const e0 = empties(start), opp = {};
  let clean = null, burn = null;
  for (const c of found.commits.values()) {
    if (c.kind !== 'turn') continue;
    if (empties(c.p) >= e0) { if (!clean || c.depth < clean.depth) clean = c; }
    else if (!burn || c.depth < burn.depth) burn = c;
  }
  const entry = (path, needs) => {
    const tags = tagsOf(start, path);
    return { L: path.length, cat: categoryOf(tags, path.length), needs, path };
  };
  if (clean) {
    let path = pathOf(clean.node, clean.mv), needs = false;
    // Whether it takes an empty column for a while: as far without any.
    if (e0 > 0 && tagsOf(start, path).toEmpty) {
      const none = reach(start, { filter: m => !m.toEmpty, maxNodes: 10000 });
      let other = null;
      for (const c of none.commits.values()) if (c.kind === 'turn' && empties(c.p) >= e0 && (!other || c.depth < other.depth)) other = c;
      if (other) path = pathOf(other.node, other.mv); else needs = true;
    }
    opp.flip = entry(path, needs);
  }
  if (burn) opp.burnL = burn.depth;
  if (found.run) opp.run = entry(pathOf(found.run.node, found.run.mv), false);
  if (found.empty) opp.empty = entry(pathOf(found.empty), false);
  return opp;
}

function analyse(row) {
  const o = openGame(row);
  if (!o) return null;
  const { suits, seed, moves, user } = o, id = `${user}/${suits}/${seed}`;
  const g = new Game(suits, seed), line = analysisConfig(suits), flawed = suits === 4 ? planted(suits) : {};
  const below = random(seed ^ 0x5EED), stretches = [], decisions = [], asked = [];
  // Questions along a chooser's moves from a position.
  const askAlong = (who, start, ms, t, cont) => {
    let p = start, pre = 0;
    for (const mv of ms) {
      const open = who === 'human' ? new Set() : null;
      for (const a of questions(p, mv, below, open)) asked.push({ g: id, user, suits, who, t, pre, q: a.q, pick: a.pick, cont, ...(who === 'human' ? { A: a.A, B: a.B, before: ms.slice(0, pre) } : {}) });
      if (open) for (const q of open) asked.push({ g: id, user, suits, who, t, pre, q, open: true, cont });
      p = play(p, mv);
      pre++;
      if (p.shows) break;
    }
  };
  let from = 0;
  while (from < moves.length) {
    // The stretch's moves.
    let to = from;
    const start = fromGame(g), t = from;
    const cont = contaminated(o.seen, from, g.faceDown, (50 - g.stock.length) / 10);
    const human = [];
    {
      let p = start;
      while (to < moves.length) { const mv = moves[to++]; human.push(mv); p = play(p, mv); if (p.shows) break; }
    }
    const hEnd = endOf(start, human);
    const dealsLeft = g.stock.length / 10;
    if (hEnd.shows && g.columns.every(c => c.length <= MAXC)) {
      const found = reach(start);
      const lEnd = endOf(start, lineOf(g, line));
      const chooser = { human: hEnd, line: lEnd };
      for (const [name, cfg] of Object.entries(flawed)) chooser[name] = endOf(start, lineOf(g, cfg));
      const opp = opportunities(start, found);
      const sameEnd = keyOf(hEnd.p) === keyOf(lEnd.p);
      const hidColumns = g.faceDown.filter(n => n > 0).length;
      const rec = {
        g: id, user, suits, seed, t, n: human.length, cont, dealsLeft, e0: empties(start), hidden: hiddenOf(start), hidColumns, done: start.done,
        nodes: found.nodes, capped: found.capped, depthReached: found.depthReached, ncand: found.commits.size, moves: human, lineMoves: lEnd.moves, sameEnd, opp,
        v0: valueOf(start, suits), vH: valueOf(hEnd.p, suits), vL: lEnd.shows ? valueOf(lEnd.p, suits) : null,
        out: Object.fromEntries(Object.entries(chooser).map(([k, e]) => [k, outcome(start, e)])),
        flawed: Object.fromEntries(Object.keys(flawed).map(k => [k, { moves: chooser[k].moves, same: keyOf(chooser[k].p) === keyOf(lEnd.p), shows: chooser[k].shows }])),
      };
      // The others for the fit: a uniform sample of the ends found.
      const all = [...found.commits.entries()];
      for (let i = all.length - 1; i > 0; i--) { const j = below(i + 1); [all[i], all[j]] = [all[j], all[i]]; }
      const depthOf = (e) => found.commits.get(keyOf(e.p))?.depth ?? e.moves.length;
      const kindOf = e => (e.p.left < start.left ? 'deal' : 'turn');
      const pool = all.slice(0, POOL).map(([k, c]) => ({ k, f: features(c.p, c.kind, start, c.depth), v: valueOf(c.p, suits) }));
      let best = -1, bestK = null, bestF = null;
      for (const c of pool) if (c.v > best) { best = c.v; bestK = c.k; bestF = c.f; }
      const fOf = e => features(e.p, kindOf(e), start, depthOf(e));
      if (rec.vH > best) { best = rec.vH; bestK = keyOf(hEnd.p); bestF = fOf(hEnd); }
      if (rec.vL !== null && rec.vL > best) { best = rec.vL; bestK = keyOf(lEnd.p); bestF = fOf(lEnd); }
      rec.vBest = best;
      const choice = { net: { k: bestK, f: bestF } };
      for (const [k, e] of Object.entries(chooser)) if (e.shows) choice[k] = { k: keyOf(e.p), f: fOf(e) };
      decisions.push({ g: id, user, suits, t, cont, dealsLeft, pool: pool.map(c => ({ k: c.k, f: c.f })), choice });
      stretches.push(rec);
      askAlong('human', start, human, t, cont);
      askAlong('line', start, lEnd.moves, t, cont);
      for (const k of Object.keys(flawed)) askAlong(k, start, chooser[k].moves, t, cont);
    }
    for (let i = from; i < to; i++) g.applyRaw(moves[i]);
    from = to;
  }
  return {
    game: { id, user, suits, seed, moves: moves.length, won: o.won, lost: o.lost, undos: o.undos, realUndos: o.realUndos, branches: o.branches, realBranches: o.realBranches },
    stretches, decisions, asked,
  };
}

if (!isMainThread) {
  netBytes = file('../../static/nets/value.bin');
  engine = await loadWasm(file('../../static/spider.wasm'));
  parentPort.on('message', row => {
    if (row === null) return process.exit(0);
    let out = null, err = null;
    try { out = analyse(row); } catch (e) { err = String(e.stack); }
    parentPort.postMessage({ out, err, id: `${row.user}/${row.suits}/${row.seed}` });
  });
  parentPort.postMessage({ ready: true });
}
