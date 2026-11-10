// The medium challenges of the coming days are deals the computer wins, so
// that compare mode has a won game of them to show (from 2026-11-11: the
// ones before were not picked for that). If this fails the computer plays
// differently than when they were picked: run tools/dailies/medium.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computerGame } from '../static/compare-core.js';
import { nextMoves, useEngine } from '../static/analysis-worker.js';
import { loadWasm } from '../static/wasm.js';

const DAYS = 5, FROM = '2026-11-11';
const file = url => { const b = readFileSync(new URL(url, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
useEngine(await loadWasm(file('../static/spider.wasm')));
const day = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ms));
const first = day(Date.now()) > FROM ? day(Date.now()) : FROM, last = day(Date.now() + DAYS * 864e5);
const deals = readFileSync(new URL('../medium-challenges.txt', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
  .map(l => l.split(' ')).filter(([date]) => date >= first && date <= last);
for (const [date, suits, seed] of deals) {
  const { won } = await computerGame(+suits, +seed, async position => nextMoves(position));
  assert.ok(won, `the computer loses the medium challenge of ${date}, ${suits} suits (${seed}): run tools/dailies/medium.sh`);
}
console.log(`ok: the computer wins the ${deals.length} medium challenges of ${first} to ${last}`);
