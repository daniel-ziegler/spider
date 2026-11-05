// The tables of the playstyle analysis from step1's and step2's files and
// fit.py's: node analyze.mjs DIR  (writes DIR/results.json, prints a summary).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { QUESTIONS } from './board.mjs';
import { random } from '../../static/analysis-worker.js';

const dir = process.argv[2];
const jsonl = name => (existsSync(`${dir}/${name}.jsonl`) ? readFileSync(`${dir}/${name}.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const games = jsonl('games'), stretches = jsonl('stretches'), asked = jsonl('asked');
// (Step 2's T4 may have been run again by itself: --only=t4.)
const again = jsonl('paired-t4'), paired = [...jsonl('paired').filter(p => !again.length || p.test !== 't4'), ...again];
const fit = existsSync(`${dir}/fit.json`) ? JSON.parse(readFileSync(`${dir}/fit.json`, 'utf8')) : null;
const below = random(0xBEEF);
const USERS = ['dmz', 'amanda'];

// A statistic over rows, with a 90% interval from resampling games. `stat` gets rows.
function boot(rows, ids, stat, B = 400) {
  const by = new Map(ids.map(i => [i, []]));
  for (const r of rows) by.get(r.g)?.push(r);
  const lists = ids.map(i => by.get(i)), out = [];
  for (let b = 0; b < B; b++) {
    const xs = [];
    for (let i = 0; i < ids.length; i++) for (const r of lists[below(ids.length)]) xs.push(r);
    const v = stat(xs);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return { est: stat(rows), lo: out[Math.floor(out.length * 0.05)], hi: out[Math.floor(out.length * 0.95)] };
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const round = (x, k = 2) => (Number.isFinite(x) ? +x.toFixed(k) : null);
const pts = c => ({ est: round(100 * c.est), lo: round(100 * c.lo), hi: round(100 * c.hi) });

const results = { summary: {}, t1: {}, t2: {}, t3: {}, t4: {}, t5: {} };

for (const suits of [4, 3]) {
  for (const user of USERS) {
    const gs = games.filter(g => g.suits === suits && g.user === user), ids = gs.map(g => g.id), key = `${suits}/${user}`, ng = gs.length;
    if (!ng) continue;
    const st = stretches.filter(r => r.suits === suits && r.user === user), clean = st.filter(r => !r.cont);
    results.summary[key] = {
      games: ng, won: gs.filter(g => g.won).length, markedLost: gs.filter(g => g.lost).length, moves: sum(gs.map(g => g.moves)), undos: sum(gs.map(g => g.undos)), realUndos: sum(gs.map(g => g.realUndos)),
      gamesWithRealUndo: gs.filter(g => g.realUndos > 0).length, branches: sum(gs.map(g => g.branches)), realBranches: sum(gs.map(g => g.realBranches)),
      stretches: st.length, contaminated: st.length - clean.length, sameAsLine: round(mean(clean.map(r => +r.sameEnd)), 3), capped: round(mean(st.map(r => +r.capped)), 3), meanCand: round(mean(st.map(r => r.ncand)), 0),
    };

    // ---------------------------------------------------------------- T1
    const nextOf = new Map();
    for (const r of st) nextOf.set(`${r.g}/${r.t}`, null);
    const byGame = new Map();
    for (const r of st) (byGame.get(r.g) ?? byGame.set(r.g, []).get(r.g)).push(r);
    for (const list of byGame.values()) { list.sort((a, b) => a.t - b.t); list.forEach((r, i) => nextOf.set(`${r.g}/${r.t}`, list[i + 1] ?? null)); }
    const got = (out, goal) => (goal === 'flip' ? out.kind === 'turn' && out.empties >= 0 : goal === 'run' ? out.done > 0 : out.empties > 0);
    const curve = (goal, field, values) => values.map(v => {
      const rows = clean.filter(r => r.opp[goal] && (field === 'L' ? (v === '6+' ? r.opp[goal].L >= 6 : r.opp[goal].L === v) : r.opp[goal][field] === v));
      const row = { [field]: v, n: rows.length };
      if (rows.length < 3) return row;
      const rate = (who, xs) => mean(xs.map(r => +got(r.out[who], goal)));
      const b = boot(rows, ids, xs => rate('human', xs));
      row.human = { est: round(b.est, 3), lo: round(b.lo, 3), hi: round(b.hi, 3) };
      row.line = round(rate('line', rows), 3);
      if (suits === 4 && rows[0].out.short) { for (const k of ['short', 'emptyLow', 'offHigh', 'runLow']) row[k] = round(rate(k, rows), 3); }
      // The goal reached one stretch on, for those that the stretch itself does not end at.
      if (goal !== 'flip') row.humanLater = round(mean(rows.map(r => { const nx = nextOf.get(`${r.g}/${r.t}`); return +(got(r.out.human, goal) || (nx && got(nx.out.human, goal))); })), 3);
      return row;
    });
    const costRows = paired.filter(p => p.test === 't1' && p.who === 'human' && p.user === user && p.suits === suits);
    const cost = rows => ({
      misses: rows.length,
      meanPts: pts(boot(rows, ids, xs => mean(xs.map(r => r.d)))),
      perGame: pts(boot(rows, ids, xs => sum(xs.map(r => r.d)) / ng)),
      worthTaking: round(mean(rows.map(r => +(r.d > 0))), 2),
    });
    const groups = {};
    for (const r of costRows) { for (const k of [`${r.goal}`, `${r.goal}:${r.cat}`, `${r.goal}:L${r.L >= 6 ? '6+' : r.L}`, `${r.goal}:by-${r.kind}`, ...(r.needs ? [`${r.goal}:needs-empty`] : [])]) (groups[k] ??= []).push(r); }
    const examples = costRows.filter(r => r.goal !== 'empty' && r.L >= 2 && r.d - 1.5 * r.se > 0.03).sort((a, b) => (b.d - b.se) - (a.d - a.se)).slice(0, 6).map(r => ({ g: r.g, t: r.t, goal: r.goal, L: r.L, cat: r.cat, d: round(100 * r.d, 1), se: round(100 * r.se, 1), kind: r.kind }));
    for (const ex of examples) ex.path = st.find(r => r.g === ex.g && r.t === ex.t).opp[ex.goal].path, ex.played = st.find(r => r.g === ex.g && r.t === ex.t).moves;
    results.t1[key] = {
      flipByL: curve('flip', 'L', [1, 2, 3, 4, 5, '6+']),
      flipByCat: curve('flip', 'cat', ['direct', 'chain', 'off-suit', 'tail-swap', 'split-run', 'via-empty']),
      flipNeeds: curve('flip', 'needs', [true]),
      runByL: curve('run', 'L', [1, 2, 3, 4, 5, '6+']),
      emptyByL: curve('empty', 'L', [1, 2, 3, 4, 5, '6+']),
      cost: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, cost(v)])),
      examples,
    };

    // ---------------------------------------------------------------- T3
    const t3 = paired.filter(p => p.test === 't3' && p.user === user && p.suits === suits);
    const netLoss = new Map(clean.map(r => [`${r.g}/${r.t}`, r]));
    const rowsT3 = t3.map(p => { const r = netLoss.get(`${p.g}/${p.t}`); return { g: p.g, t: p.t, d: p.d, se: p.se, net: r.vL - r.vH, dealsLeft: r.dealsLeft, e0: r.e0, hidColumns: r.hidColumns, r }; });
    const bucket = x => (x < 0.01 ? '<1' : x < 0.02 ? '1-2' : x < 0.05 ? '2-5' : x < 0.1 ? '5-10' : '10+');
    const perGame = (rows, f) => boot(rows, ids, xs => sum(xs.map(f)) / ng);
    const split = (name, fn, values) => values.map(v => {
      const rows = rowsT3.filter(r => fn(r) === v);
      const all = clean.filter(r => fn({ ...r, net: r.vL === null ? 0 : r.vL - r.vH }) === v);
      return { [name]: v, stretches: all.length, departs: rows.length, net: pts(perGame(rows, r => r.net)), playout: pts(perGame(rows, r => r.d)) };
    });
    const xs = rowsT3.map(r => r.net), ys = rowsT3.map(r => r.d), mx = mean(xs), my = mean(ys);
    const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my))), corr = cov / Math.sqrt(mean(xs.map(x => (x - mx) ** 2)) * mean(ys.map(y => (y - my) ** 2)));
    results.t3[key] = {
      stretchesPerGame: round(clean.length / ng, 1), departsPerGame: round(rowsT3.length / ng, 1),
      netPerGame: pts(perGame(rowsT3, r => r.net)), playoutPerGame: pts(perGame(rowsT3, r => r.d)),
      netVsPlayout: { corr: round(corr, 3), slope: round(cov / mean(xs.map(x => (x - mx) ** 2)), 3), meanNet: round(100 * mx, 2), meanPlayout: round(100 * my, 2), meanSe: round(100 * mean(rowsT3.map(r => r.se)), 2) },
      // The raw yellow bars, and the line player's on the same positions: the network's bias at a stretch.
      rawYellow: { human: round(100 * mean(clean.map(r => r.vH - r.v0)), 2), line: round(100 * mean(clean.filter(r => r.vL !== null).map(r => r.vL - r.v0)), 2) },
      bySize: split('size', r => bucket(r.net), ['<1', '1-2', '2-5', '5-10', '10+']),
      byDeals: split('dealsLeft', r => r.dealsLeft, [5, 4, 3, 2, 1, 0]),
      byEmpties: split('empties', r => Math.min(r.e0, 2), [0, 1, 2]),
      // How the decision ended, and what the search knew was there.
      byEnd: split('end', r => { const o = r.r ?? r; const k = o.out.human.kind, f = o.opp.flip, e = o.opp.empty, got = o.out.human; return k === 'deal' ? (f ? 'dealt with a clean turn findable' : e ? 'dealt with a column to empty findable' : 'dealt, neither findable') : got.empties < 0 ? (f ? 'turned, spending an empty with a clean turn findable' : 'turned, spending an empty') : (e && !(got.empties > 0) ? 'turned, with a column to empty findable' : 'turned, otherwise'); }, ['dealt with a clean turn findable', 'dealt with a column to empty findable', 'dealt, neither findable', 'turned, spending an empty with a clean turn findable', 'turned, spending an empty', 'turned, with a column to empty findable', 'turned, otherwise']),
      byHidColumns: split('hidColumns', r => (r.hidColumns >= 7 ? '7+' : r.hidColumns >= 4 ? '4-6' : r.hidColumns >= 1 ? '1-3' : '0'), ['7+', '4-6', '1-3', '0']),
    };

    // ---------------------------------------------------------------- T4
    const ask = asked.filter(a => a.suits === suits && a.user === user && !a.cont);
    const vals = paired.filter(p => p.test === 't4' && p.user === user && p.suits === suits);
    results.t4[key] = Object.keys(QUESTIONS).map(q => {
      const mine = ask.filter(a => a.who === 'human' && a.q === q && !a.open), line = ask.filter(a => a.who === 'line' && a.q === q && !a.open);
      const v = vals.filter(p => p.q === q), A = mine.filter(a => a.pick === 'A').length, B = mine.length - A;
      const row = { q, text: QUESTIONS[q], asked: ask.filter(a => a.who === 'human' && a.q === q && a.open).length, n: mine.length, A, B, pickA: round(mine.length ? A / mine.length : NaN, 3), linePickA: round(line.length ? line.filter(a => a.pick === 'A').length / line.length : NaN, 3), lineN: line.length, sampled: v.length };
      for (const k of ['short', 'emptyLow', 'offHigh', 'runLow']) { const x = ask.filter(a => a.who === k && a.q === q && !a.open); if (x.length) row[k] = round(x.filter(a => a.pick === 'A').length / x.length, 3); }
      if (v.length >= 5) {
        row.delta = pts(boot(v, ids, xs => mean(xs.map(r => r.d))));
        const va = v.filter(p => p.pick === 'A'), vb = v.filter(p => p.pick === 'B');
        if (va.length >= 5) row.deltaIfA = pts(boot(va, ids, xs => mean(xs.map(r => r.d))));
        if (vb.length >= 5) row.deltaIfB = pts(boot(vb, ids, xs => mean(xs.map(r => r.d))));
        // What each choice cost against always the other, scaled up from the sample, per game.
        if (vb.length >= 5 && B) row.costOfB = pts(boot(vb, ids, xs => (mean(xs.map(r => r.d)) * B) / ng));
        if (va.length >= 5 && A) row.costOfA = pts(boot(va, ids, xs => (-mean(xs.map(r => r.d)) * A) / ng));
      }
      return row;
    });

    // ---------------------------------------------------------------- T2
    const f = fit?.[suits]?.users?.[user];
    if (f?.human) {
      const names = fit[suits].features, us = f.human, li = f.line, ne = f.net;
      const ratioOf = (b, i, ref) => b[i] / b[ref];
      const REF = names.indexOf('same');
      const scale = (a, b) => { const sd = fit[suits].sd; let xy = 0, xx = 0; for (let i = 0; i < a.length; i++) { xy += a[i] * sd[i] * b[i] * sd[i]; xx += b[i] * sd[i] * b[i] * sd[i]; } return xy / xx; };
      const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
      results.t2[key] = {
        n: us.n, r2: round(1 - us.ll / us.ll0, 3), top1: round(us.top1, 3), lineTop1: round(li.top1, 3), netTop1: round(ne.top1, 3),
        rows: names.map((nm, i) => {
          if (nm === 'same') return { f: nm, beta: round(us.beta[i], 3), line: round(li.beta[i], 3), net: round(ne.beta[i], 3) };
          const diffs = us.boot.map((b, k) => ratioOf(b, i, REF) - ratioOf(li.boot[k], i, REF));
          const diffsNet = us.boot.map((b, k) => ratioOf(b, i, REF) - ratioOf(ne.boot[k], i, REF));
          return {
            f: nm, beta: round(us.beta[i], 3), line: round(li.beta[i], 3), net: round(ne.beta[i], 3),
            you: round(ratioOf(us.beta, i, REF), 2), lineRatio: round(ratioOf(li.beta, i, REF), 2), netRatio: round(ratioOf(ne.beta, i, REF), 2),
            diff: { est: round(ratioOf(us.beta, i, REF) - ratioOf(li.beta, i, REF), 2), lo: round(q(diffs, 0.05), 2), hi: round(q(diffs, 0.95), 2) },
            diffNet: { est: round(ratioOf(us.beta, i, REF) - ratioOf(ne.beta, i, REF), 2), lo: round(q(diffsNet, 0.05), 2), hi: round(q(diffsNet, 0.95), 2) },
          };
        }),
      };
    }
  }
}

// ---------------------------------------------------------------- T5
{
  const both = games.filter(g => g.suits === 4), ids = both.map(g => g.id), st = stretches.filter(r => r.suits === 4 && r.flawed?.short);
  const t5 = results.t5;
  // T1: the short player's curve against the line player's.
  const got = (out, goal) => (goal === 'flip' ? out.kind === 'turn' && out.empties >= 0 : goal === 'run' ? out.done > 0 : out.empties > 0);
  t5.t1Curve = [1, 2, 3, 4, 5, '6+'].map(L => {
    const rows = st.filter(r => r.opp.flip && (L === '6+' ? r.opp.flip.L >= 6 : r.opp.flip.L === L));
    const row = { L, n: rows.length };
    for (const who of ['line', 'short', 'emptyLow', 'offHigh', 'runLow']) row[who] = round(mean(rows.map(r => +got(r.out[who], 'flip'))), 3);
    return row;
  });
  const shortMiss = paired.filter(p => p.test === 't1' && p.who === 'short');
  if (shortMiss.length) t5.t1ShortCost = { sampled: shortMiss.length, total: shortMiss[0].total, meanPts: pts(boot(shortMiss, ids, xs => mean(xs.map(r => r.d)))) };
  // T3: the flaws' cost by the stretch against what they cost whole games.
  const strength = paired.filter(p => p.kind === 'strength');
  const win = who => mean(strength.filter(p => p.who === who).map(p => p.won));
  t5.t3 = ['short', 'emptyLow', 'offHigh', 'runLow'].map(who => {
    const rows = paired.filter(p => p.test === 't5' && p.who === who);
    const m = rows.length ? boot(rows, ids, xs => mean(xs.map(r => r.d))) : null;
    const departs = rows[0]?.total ?? 0, all = rows[0]?.all ?? 1;
    const netRows = st.filter(r => r.flawed[who] && !r.flawed[who].same && r.flawed[who].shows);
    return {
      who, departShare: round(departs / all, 3), sampled: rows.length, perDeparture: m && pts(m), perStretch: m && round(100 * m.est * departs / all, 2),
      per45Stretches: m && round(100 * m.est * departs / all * 45, 1), wholeGameDrop: round(100 * (win('line') - win(who)), 1), winRate: round(100 * win(who), 1), lineWinRate: round(100 * win('line'), 1), gamesEach: strength.filter(p => p.who === who).length,
    };
  });
  // T2: the planted coefficient.
  const u = fit?.[4]?.users?.both;
  if (u?.line) {
    const names = fit[4].features, REF = names.indexOf('same');
    t5.t2 = [['short', 'steps'], ['emptyLow', 'empties'], ['offHigh', 'off'], ['offHigh', 'offHigh'], ['runLow', 'runSq']].map(([who, nm]) => {
      if (!u[who]) return null;
      const i = names.indexOf(nm);
      const diffs = u[who].boot.map((b, k) => b[i] / b[REF] - u.line.boot[k][i] / u.line.boot[k][REF]).sort((a, b) => a - b);
      const raw = u[who].boot.map((b, k) => b[i] - u.line.boot[k][i]).sort((a, b) => a - b);
      return {
        who, feature: nm, line: round(u.line.beta[i], 3), planted: round(u[who].beta[i], 3), lineRatio: round(u.line.beta[i] / u.line.beta[REF], 2), plantedRatio: round(u[who].beta[i] / u[who].beta[REF], 2),
        ratioDiff: { lo: round(diffs[Math.floor(diffs.length * 0.05)], 2), hi: round(diffs[Math.floor(diffs.length * 0.95)], 2) },
        rawDiff: { lo: round(raw[Math.floor(raw.length * 0.05)], 2), hi: round(raw[Math.floor(raw.length * 0.95)], 2) },
      };
    }).filter(Boolean);
    t5.t2All = Object.fromEntries(['line', 'short', 'emptyLow', 'offHigh', 'runLow', 'net'].filter(w => u[w]).map(w => [w, { beta: u[w].beta.map(x => round(x, 2)), top1: round(u[w].top1, 3) }]));
    t5.features = names;
    if (u.lineHalves) t5.t2Null = names.map((nm, i) => ({ f: nm, a: round(u.lineHalves.a[i] / u.lineHalves.a[REF], 2), b: round(u.lineHalves.b[i] / u.lineHalves.b[REF], 2) }));
  }
  // T4: the preferences the flaws should move.
  t5.t4 = Object.keys(QUESTIONS).map(q => {
    const row = { q };
    for (const who of ['line', 'short', 'emptyLow', 'offHigh', 'runLow']) {
      const x = asked.filter(a => a.suits === 4 && a.who === who && a.q === q && !a.open);
      row[who] = round(x.length ? x.filter(a => a.pick === 'A').length / x.length : NaN, 3);
      row[`${who}N`] = x.length;
    }
    return row;
  });
}
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary, null, 0));
