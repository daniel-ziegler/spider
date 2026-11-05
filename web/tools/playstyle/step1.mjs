// node step1.mjs DB OUTDIR [--suits=3,4] [--users=dmz,amanda] [--limit=N] [--threads=N]
import { createWriteStream, mkdirSync } from 'node:fs';
import os from 'node:os';
import { loadGames } from './games.mjs';
import { runPool } from './pool.mjs';
const args = process.argv.slice(2), opt = n => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
const [db, out] = args.filter(a => !a.startsWith('--'));
mkdirSync(out, { recursive: true });
let rows = loadGames(db, (opt('users') ?? 'dmz,amanda').split(','), (opt('suits') ?? '3,4').split(',').map(Number));
if (opt('limit')) rows = rows.filter((_, i) => i % Math.ceil(rows.length / +opt('limit')) === 0);
const w = name => createWriteStream(`${out}/${name}.jsonl`);
const files = { games: w('games'), stretches: w('stretches'), decisions: w('decisions'), asked: w('asked') };
const t0 = Date.now();
await runPool(new URL('./extract.mjs', import.meta.url), +(opt('threads') ?? os.cpus().length), rows, (m, done, all) => {
  if (m.err) { console.error(m.id, m.err); return; }
  if (!m.out) { console.error(m.id, 'does not replay'); return; }
  files.games.write(JSON.stringify(m.out.game) + '\n');
  for (const k of ['stretches', 'decisions', 'asked']) for (const x of m.out[k]) files[k].write(JSON.stringify(x) + '\n');
  console.error(`${done}/${all} ${m.id} ${m.out.stretches.length} stretches, ${Math.round((Date.now() - t0) / 1000)} s`);
});
for (const f of Object.values(files)) f.end();
