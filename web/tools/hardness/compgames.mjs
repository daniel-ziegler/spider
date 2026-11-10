// The computer's game of each listed deal as a saved game of a user `computer`,
// in a database of its own, so that the playstyle analysis's step 1 reads what
// each of its decisions asked for (the shortest line to a clean turn and so on):
//   node compgames.mjs DIR     (DIR/played3.txt, played4.txt from outcomes.mjs; writes DIR/comp.db)
//   node ../playstyle/step1.mjs DIR/comp.db DIR/comp --users=computer
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { Game, treeText, encodeMoves } from '../../static/game.js';
import { computerGame } from '../../static/compare-core.js';
import { nextMoves, useEngine } from '../../static/analysis-worker.js';
import { loadWasm } from '../../static/wasm.js';

const dir = process.argv[2];
const b = readFileSync(new URL('../../static/spider.wasm', import.meta.url));
useEngine(await loadWasm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
let sql = `create table users (id integer primary key, username text);
create table games (user_id integer, game text, suits integer, seed integer, state text, updated_at integer);
insert into users values (1, 'computer');\n`;
for (const suits of [3, 4]) {
  for (const seed of readFileSync(`${dir}/played${suits}.txt`, 'utf8').split('\n').filter(Boolean).map(Number)) {
    const { moves, won } = await computerGame(suits, seed, async position => nextMoves(position));
    const g = new Game(suits, seed);
    for (const mv of moves) g.apply(mv);
    const state = JSON.stringify({ tree: treeText(g.root), moves: encodeMoves(moves), lost: !won });
    sql += `insert into games values (1, 'spider', ${suits}, ${seed}, '${state.replace(/'/g, "''")}', 0);\n`;
    console.error(suits, seed, won ? 'won' : 'lost', moves.length);
  }
}
rmSync(`${dir}/comp.db`, { force: true });
execFileSync('sqlite3', [`${dir}/comp.db`], { input: sql });
