// The games of the two players, from a copy of the server's database, as lines
// of moves with their stretches; see README ("Playstyle"). A stretch runs up to
// a move that shows cards, as in analysis-core.js.
import { execFileSync } from 'node:child_process';
import { Game, parseTree, parseMoves } from '../../static/game.js';

// One entry per saved Spider game of these users with these numbers of suits.
export function loadGames(db, users, suitsList) {
  const sql = `select u.username as user, g.suits, g.seed, g.state, g.updated_at from games g join users u on u.id = g.user_id
    where g.game = 'spider' and u.username in (${users.map(u => `'${u}'`).join(',')}) and g.suits in (${suitsList.join(',')}) order by 1, 2, 3`;
  return JSON.parse(execFileSync('sqlite3', ['-json', db, sql], { maxBuffer: 1 << 30 }).toString() || '[]');
}

// A game made ready: the line on the board with the tree it is part of.
// Returns {game, moves, seen, branches, undos, ...} or null if it does not replay.
export function openGame(row) {
  const state = JSON.parse(row.state);
  if (typeof state.tree !== 'string') return null;
  const g = new Game(row.suits, row.seed);
  try {
    g.adopt(parseTree(state.tree));
  } catch { return null; }
  const moves = parseMoves(state.moves ?? '');
  // What the branches off the line had shown: for each branch at position s of
  // the line, the places turned over and the deals made there.
  const seen = [];
  let branches = 0, realBranches = 0;
  const walk = (node, s) => {
    const rec = g.enter(node);
    for (const c of rec.flips) seen.push({ s, c, i: g.faceDown[c] });
    if (rec.mv.deal) seen.push({ s, deal: (50 - g.stock.length) / 10 });
    for (const k of node.children) walk(k, s);
    g.leave();
  };
  for (let s = 0; s <= moves.length; s++) {
    const here = g.line.at(-1), next = moves[s], key = next ? (next.deal ? 'd' : `${next.from}>${next.to}:${next.count}`) : null;
    for (const k of here.children) {
      if (k.key === key) continue;
      branches++;
      const before = seen.length;
      walk(k, s);
      if (seen.length > before) realBranches++;
    }
    if (next && g.apply(next)) return null;
  }
  // The game is now at the end of its line.
  return { row, user: row.user, suits: row.suits, seed: row.seed, moves, seen, branches, realBranches, undos: g.undos, realUndos: g.realUndos, won: g.isWon(), lost: !!state.lost };
}

// Whether what the branches had shown still mattered at a position of the line
// (s moves played, its faceDown and deals made): a card seen on a branch from
// that position or before it that on the line is still not to be seen.
export function contaminated(seen, s, faceDown, dealsDone) {
  for (const e of seen) {
    if (e.s > s) continue;
    if (e.deal !== undefined ? e.deal > dealsDone : e.i < faceDown[e.c]) return true;
  }
  return false;
}

// Replays a line, calling visit(game, t) before each of the first n moves' and with t = n after them.
export function replay(suits, seed, moves, upto = moves.length) {
  const g = new Game(suits, seed);
  for (let i = 0; i < upto; i++) { if (g.check(moves[i])) throw new Error('illegal'); g.applyRaw(moves[i]); }
  return g;
}
