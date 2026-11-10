// How each of two players' games of three and four suits came out, from a copy
// of the server's database: node outcomes.mjs DB OUTDIR [--users=dmz,amanda]
// writes OUTDIR/outcomes.json (one entry per player and deal: won, lost or
// open, its undos, and how far the line on the board got) and
// OUTDIR/played3.txt, played4.txt (the seeds, for model_rates and the others).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadGames, openGame, replay } from '../playstyle/games.mjs';

const args = process.argv.slice(2), opt = n => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
const [db, out] = args.filter(a => !a.startsWith('--'));
const users = (opt('users') ?? 'dmz,amanda').split(',');
mkdirSync(out, { recursive: true });
const listed = name => {
  const m = new Map();
  for (const l of readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8').split('\n')) {
    if (!l.trim() || l.startsWith('#')) continue;
    const [date, suits, seed] = l.split(/\s+/);
    m.set(`${suits}/${seed}`, date);
  }
  return m;
};
const hard = listed('challenges.txt'), medium = listed('medium-challenges.txt');
const sql = q => JSON.parse(execFileSync('sqlite3', ['-json', db, q], { maxBuffer: 1 << 30 }).toString() || '[]');
const wins = new Map();
for (const w of sql(`select u.username as user, w.suits, w.seed, w.moves, w.real_undos, w.undos, w.created_at from wins w join users u on u.id = w.user_id
    where w.game = 'spider' and w.suits in (3, 4) and u.username in (${users.map(u => `'${u}'`).join(',')}) order by w.created_at`)) {
  const k = `${w.user}/${w.suits}/${w.seed}`;
  if (!wins.has(k)) wins.set(k, w);
}
const rows = [], seen = new Set();
const entry = (user, suits, seed, more) => {
  const d = `${suits}/${seed}`;
  rows.push({ user, suits, seed, kind: medium.has(d) ? 'medium' : hard.has(d) ? 'hard' : 'other', date: medium.get(d) ?? hard.get(d) ?? null, ...more });
};
for (const row of loadGames(db, users, [3, 4])) {
  const o = openGame(row), k = `${row.user}/${row.suits}/${row.seed}`, w = wins.get(k);
  seen.add(k);
  if (!o) { if (w) entry(row.user, row.suits, row.seed, { res: 'won', moves: w.moves, undos: w.undos, realUndos: w.real_undos, down: 0, done: 8, dealsLeft: 0, at: w.created_at }); continue; }
  const g = replay(o.suits, o.seed, o.moves);
  const far = { down: g.faceDown.reduce((a, b) => a + b, 0), done: g.completed.length, dealsLeft: g.stock.length / 10 };
  if (w) entry(o.user, o.suits, o.seed, { res: 'won', moves: w.moves, undos: w.undos, realUndos: w.real_undos, down: 0, done: 8, dealsLeft: 0, at: w.created_at, timed: !!JSON.parse(row.state).times });
  else entry(o.user, o.suits, o.seed, { res: o.won ? 'won' : o.lost ? 'lost' : 'open', moves: o.moves.length, undos: o.undos, realUndos: o.realUndos, ...far, at: row.updated_at, timed: !!JSON.parse(row.state).times });
}
for (const [k, w] of wins) if (!seen.has(k)) entry(w.user, w.suits, w.seed, { res: 'won', moves: w.moves, undos: w.undos, realUndos: w.real_undos, down: 0, done: 8, dealsLeft: 0, at: w.created_at });
writeFileSync(`${out}/outcomes.json`, JSON.stringify(rows));
for (const s of [3, 4]) writeFileSync(`${out}/played${s}.txt`, [...new Set(rows.filter(r => r.suits === s).map(r => r.seed))].sort((a, b) => a - b).join('\n') + '\n');
const count = {};
for (const r of rows) { const k = `${r.user} ${r.suits} suits ${r.kind} ${r.res}`; count[k] = (count[k] ?? 0) + 1; }
for (const k of Object.keys(count).sort()) console.log(k, count[k]);
