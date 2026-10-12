// Checks the FreeCell solver (static/fcwinnable.js) against a search that
// shares nothing with it: every move of the game's own rules (static/
// freecell.js, runs of several cards included), positions kept by their
// text. Positions come from random play, which soon gets stuck. A position
// the solver wins is checked by playing its line; one it finds lost (the
// smaller ones) by the other search. Prints how many of each there were. Deal 11982 is the one of Microsoft's first 32,000 that
// cannot be won.
import { FreeCell, HOME } from '../static/freecell.js';
import { solve } from '../static/fcwinnable.js';

let state = 2024;
const rand = n => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state % n;
};

function legalMoves(g) {
  const out = [];
  for (let from = 0; from < HOME; from++)
    for (let to = 0; to <= HOME; to++)
      for (let count = 1; count <= g.runLen(from); count++)
        if (!g.checkMove(from, to, count)) out.push({ from, to, count });
  return out;
}

// 'won', 'lost', or 'unknown' after `limit` positions.
function brute(g, limit) {
  const seen = new Set([g.key()]), stack = [legalMoves(g)], recs = [];
  let verdict = g.isWon() ? 'won' : 'lost';
  while (stack.length && verdict === 'lost') {
    const mv = stack.at(-1).pop();
    if (!mv) {
      stack.pop();
      if (recs.length) g.unapply(recs.pop());
      continue;
    }
    recs.push(g.applyRaw(mv));
    const key = g.key();
    if (g.isWon()) verdict = 'won';
    else if (seen.has(key)) g.unapply(recs.pop());
    else if (seen.size >= limit) verdict = 'unknown';
    else {
      seen.add(key);
      stack.push(legalMoves(g));
    }
  }
  while (recs.length) g.unapply(recs.pop());
  return verdict;
}

let lost = 0, won = 0;
const judged = new Set();
for (let seed = 1; seed <= 150; seed++) {
  const g = new FreeCell(seed);
  for (let step = 1; step <= 60; step++) {
    const moves = step % 4 ? legalMoves(g) : g.hintMoves();
    if (!moves.length) break;
    g.apply(moves[rand(moves.length)]);
    if (g.isWon()) break;
    if (step % 3 || judged.has(g.key())) continue;
    judged.add(g.key());
    const text = g.positionText();
    const r = solve(g.columns, g.cells, 300_000);
    if (r.verdict === 'won') {
      // A line is its own proof.
      const h = new FreeCell(seed);
      for (const mv of [...g.moves(), ...r.line]) if (h.apply(mv)) throw new Error(`deal ${seed}: illegal move in a line`);
      if (!h.isWon()) throw new Error(`deal ${seed}: a line does not win`);
      won++;
    } else if (r.verdict === 'lost' && r.nodes <= 4000) {
      const b = brute(g, 10_000);
      if (b !== 'lost') throw new Error(`deal ${seed} after ${g.history.length} moves: found lost, but the check says ${b}\n${text}`);
      lost++;
    }
    if (g.positionText() !== text) throw new Error('a search changed the game');
  }
}
const g = new FreeCell(11982);
if (solve(g.columns, g.cells, 1_000_000).verdict !== 'lost') throw new Error('deal 11982 is not found lost');
console.log(lost, won);
