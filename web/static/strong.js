// The stronger computer player: the one that at every choice plays what the
// analysis would rate best. From one move that shows cards to the next, the
// line player's own moves and a few other lines are each played on by the
// line player in the same worlds (shuffles of the cards not seen), as the
// analysis measures a mistake, and the one that does best is played. So it
// sees only what is face up, and its game of a deal is always the same one:
// the worlds are numbered and made from the deal's seed.
//
// ../wasm/src/strong.rs is the same player, and has the choices and what
// each is worth in a world (through the worker here); this file has the
// choosing, as its `choose` does it, number for number
// (tools/analysis/strong.mjs checks that the two play the same games).
import { Game } from './game.js';

// How it chooses, for a game of this many suits: `most` lines that turn a
// card besides the line player's own (`perCol` at most of one column) and
// with `deal` what the line player would play if it were about to deal; each
// played in `first` worlds, then twice as many up to `max`, a choice being
// dropped once it is `zDrop` standard errors behind the best; the line
// player's own kept unless the best is `zKeep` standard errors ahead; the
// games stopped after `stop` moves that show cards and valued by the network
// (0: played to the end), as the analysis's are.
export const strongParams = suits => (suits > 1
  ? { most: 6, perCol: 2, deal: true, first: 16, max: 64, zDrop: 2, zKeep: 1, stop: 8 }
  : { most: 6, perCol: 2, deal: true, first: 32, max: 128, zDrop: 2, zKeep: 1, stop: 0 });

// The seed of a choice's worlds: the analysis's for the same stretch of the game.
export const worldSeed = (seed, turn) => (Number(BigInt(seed) % 1000003n) * 131 + turn) | 0;

// The mean of a - b over the worlds, and its standard error.
function ahead(a, b) {
  const n = a.length;
  let sum = 0;
  for (let w = 0; w < n; w++) sum += a[w] - b[w];
  const mean = sum / n;
  if (n < 2) return [mean, 0];
  let sq = 0;
  for (let w = 0; w < n; w++) { const d = a[w] - b[w] - mean; sq += d * d; }
  return [mean, Math.sqrt(sq / (n - 1) / n)];
}

// The best of the choices still in the running by what they were worth so
// far (the first of equals), and those of the others to drop.
function standings(vals, alive, zDrop) {
  const mean = c => { let s = 0; for (const v of vals[c]) s += v; return s / vals[c].length; };
  let best = alive[0], most = mean(best);
  for (const c of alive.slice(1)) {
    const m = mean(c);
    if (m > most) { best = c; most = m; }
  }
  const dropped = alive.filter(c => {
    if (c === best) return false;
    const [d, se] = ahead(vals[best], vals[c]);
    return se === 0 || d > zDrop * se;
  });
  return [best, dropped];
}

// Which of n choices (the first the line player's) to play: worth(c, from,
// to) is a promise of choice c's worth in the worlds from..to (a number for
// each). `seen(done, alive)` is told how far it is.
export async function choose(n, p, worth, seen = () => {}) {
  if (n < 2) return 0;
  const vals = Array.from({ length: n }, () => []);
  let alive = vals.map((_, c) => c), done = 0, upto = Math.min(p.first, p.max), best;
  for (;;) {
    const more = await Promise.all(alive.map(c => worth(c, done, upto)));
    alive.forEach((c, i) => { for (const v of more[i]) vals[c].push(v); });
    done = upto;
    let dropped;
    [best, dropped] = standings(vals, alive, p.zDrop);
    alive = alive.filter(c => !dropped.includes(c));
    seen(done, alive.length);
    if (alive.length === 1 || done >= p.max) break;
    upto = Math.min(2 * done, p.max);
  }
  if (best !== 0 && p.zKeep > 0 && alive.includes(0)) {
    const [d, se] = ahead(vals[best], vals[0]);
    if (d < p.zKeep * se) return 0;
  }
  return best;
}

// The stronger player's game of a deal. `ask` does the work (the worker's
// `strong` messages): ask({candidates: position, most, perCol, deal}) is a
// promise of the choices there, each its moves, and ask({worth: position,
// cand, seed, from, to, stop}) of what one is worth in some worlds. `piece`
// worlds go in one piece of work. `step(moves, turn)` is called after each
// choice (false from it stops the game). Returns {moves, won, turns, changed}:
// changed, the choices that were not the line player's.
export async function strongGame(suits, seed, ask, { params = strongParams(suits), piece = 4, step = () => true } = {}) {
  const g = new Game(suits, seed), moves = [];
  let turns = 0, changed = 0;
  while (!g.isWon()) {
    const position = { suits, columns: g.columns.map(c => [...c]), faceDown: [...g.faceDown], completed: g.completed.length, stock: [...g.stock] };
    const cands = await ask({ candidates: position, most: params.most, perCol: params.perCol, deal: params.deal });
    if (!cands.length) break;
    const ws = worldSeed(seed, turns);
    const at = await choose(cands.length, params, async (c, from, to) => {
      const parts = [];
      for (let w = from; w < to; w += piece) parts.push(ask({ worth: position, cand: cands[c], seed: ws, from: w, to: Math.min(to, w + piece), stop: params.stop }));
      return (await Promise.all(parts)).flatMap(part => [...part]);
    });
    turns++;
    if (at) changed++;
    let shown = false, stuck = false;
    for (const mv of cands[at]) {
      if (g.check(mv)) { stuck = true; break; } // (a deal it cannot make: a column too long for it)
      const rec = g.applyRaw(mv);
      moves.push(mv);
      if (mv.deal || rec.flips.length) shown = true;
    }
    if (stuck || !shown || step(moves, turns, g) === false) break;
  }
  return { moves, won: g.isWon(), turns, changed };
}
