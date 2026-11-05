// The playstyle analysis's page: node page.mjs DIR. Writes DIR/index.html from
// DIR/results.json, with DIR/findings.html (written by hand, if there is one)
// at its head.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FEATURE_TEXT } from './board.mjs';

const dir = process.argv[2];
const R = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
const findings = existsSync(`${dir}/findings.html`) ? readFileSync(`${dir}/findings.html`, 'utf8') : '';
const NAME = { dmz: 'Daniel', amanda: 'Amanda' };
const USERS = ['dmz', 'amanda'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const ci = c => (c ? `${c.est > 0 ? '+' : ''}${c.est.toFixed(1)} <span class="ci">(${c.lo.toFixed(1)} to ${c.hi.toFixed(1)})</span>` : '–');
const sure = c => (c && (c.lo > 0 || c.hi < 0) ? ' class="sure"' : '');
const pct = x => (x === null || x === undefined ? '–' : `${Math.round(100 * x)}%`);

// A line chart of rates over categories, one line per series.
function rates(rows, xKey, series, { w = 460, h = 250, title = '' } = {}) {
  const m = { l: 40, r: 34, t: 12, b: 34 }, X = i => m.l + (i * (w - m.l - m.r)) / (rows.length - 1), Y = v => m.t + (1 - v) * (h - m.t - m.b);
  let g = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) g += `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  rows.forEach((r, i) => { g += `<text class="tick" x="${X(i)}" y="${h - m.b + 16}" text-anchor="middle">${r[xKey]}</text><text class="tick" x="${X(i)}" y="${h - 4}" text-anchor="middle" opacity="0.7">n ${r.n}</text>`; });
  for (const s of series) {
    const pts = rows.map((r, i) => [i, s.get(r), r]).filter(p => p[1] !== null && p[1] !== undefined);
    g += `<polyline class="ln ${s.cls}" points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}"/>`;
    for (const [i, v, r] of pts) g += `<circle class="dot ${s.cls}" cx="${X(i)}" cy="${Y(v)}" r="4.5" data-tip="${esc(`${s.name}, ${xKey} ${r[xKey]}: ${Math.round(100 * v)}% of ${r.n}`)}"/>`;
  }
  return `<figure><figcaption>${title}</figcaption><div class="scroll"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${g}</svg></div></figure>`;
}
const legend = items => `<p class="legend">${items.map(([cls, t]) => `<span><i class="sw ${cls}"></i>${t}</span>`).join('')}</p>`;

// Two players' dots with intervals round zero, one row per name: rows of {name, a, b}.
function intervals(rows, { w = 700, labels = 330, title = '', unit = '', cap = Infinity } = {}) {
  const rowH = 30, m = { l: labels, r: 16, t: 8, b: 26 }, h = m.t + m.b + rows.length * rowH;
  const lim = Math.min(cap, Math.max(1, ...rows.flatMap(r => [Math.abs(r.a.lo), Math.abs(r.a.hi), Math.abs(r.b.lo), Math.abs(r.b.hi)])));
  const X = v => m.l + ((Math.max(-lim, Math.min(lim, v)) + lim) / (2 * lim)) * (w - m.l - m.r);
  let g = `<line class="zero" x1="${X(0)}" x2="${X(0)}" y1="${m.t}" y2="${h - m.b}"/>`;
  for (const v of [-lim, -lim / 2, 0, lim / 2, lim]) g += `<text class="tick" x="${X(v)}" y="${h - 8}" text-anchor="middle">${v > 0 ? '+' : ''}${v.toFixed(1)}</text>`;
  rows.forEach((r, i) => {
    const y = m.t + rowH * i + rowH / 2;
    g += `<text class="lab" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${esc(r.name)}</text>`;
    for (const [c, cls, off, who] of [[r.a, 'c-dmz', -5, 'Daniel'], [r.b, 'c-amanda', 5, 'Amanda']]) {
      g += `<line class="whisk ${cls}" x1="${X(c.lo)}" x2="${X(c.hi)}" y1="${y + off}" y2="${y + off}"/><circle class="dot ${cls}" cx="${X(c.est)}" cy="${y + off}" r="4.5" data-tip="${esc(`${who}, ${r.name}: ${c.est} (${c.lo} to ${c.hi})${unit}`)}"/>`;
    }
  });
  return `${legend([['c-dmz', 'Daniel'], ['c-amanda', 'Amanda']])}<figure><figcaption>${title}</figcaption><div class="scroll"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${g}</svg></div></figure>`;
}

const summaryRows = [4, 3].flatMap(s => USERS.map(u => [s, u, R.summary[`${s}/${u}`]])).filter(x => x[2]);
const summary = `<div class="scroll"><table><thead><tr><th>Player</th><th>Suits</th><th>Games</th><th>Won</th><th>Moves</th><th>Undos</th><th>Real undos</th><th>Decisions</th><th>Set aside</th><th>Same end as the line player</th></tr></thead><tbody>${summaryRows.map(([s, u, x]) => `<tr><td>${NAME[u]}</td><td>${s}</td><td>${x.games}</td><td>${x.won}</td><td>${x.moves}</td><td>${x.undos}</td><td>${x.realUndos}</td><td>${x.stretches}</td><td>${x.contaminated}</td><td>${pct(x.sameAsLine)}</td></tr>`).join('')}</tbody></table></div>`;

function t1Section(s) {
  const a = R.t1[`${s}/dmz`], b = R.t1[`${s}/amanda`];
  if (!a || !b) return '';
  const merge = (ka, kx) => a[ka].map((r, i) => ({ [kx]: r[kx], n: r.n + b[ka][i].n, dmz: r.human?.est ?? null, amanda: b[ka][i].human?.est ?? null, line: (r.line !== undefined && b[ka][i].line !== undefined) ? (r.line * r.n + b[ka][i].line * b[ka][i].n) / (r.n + b[ka][i].n) : null, nd: r.n, na: b[ka][i].n }));
  const series = [{ name: 'Line player', cls: 'c-line', get: r => r.line }, { name: 'Daniel', cls: 'c-dmz', get: r => (r.nd >= 8 ? r.dmz : null) }, { name: 'Amanda', cls: 'c-amanda', get: r => (r.na >= 8 ? r.amanda : null) }];
  const chart1 = rates(merge('flipByL', 'L'), 'L', series, { title: `${s} suits: found a clean turn, by moves needed` });
  const chart2 = rates(merge('flipByCat', 'cat').filter(r => r.n >= 8), 'cat', series, { title: `${s} suits: found it, by kind of line` });
  const costRows = k => USERS.map(u => { const c = R.t1[`${s}/${u}`].cost[k]; return c ? `<td>${c.misses}</td><td${sure(c.perGame)}>${ci(c.perGame)}</td><td${sure(c.meanPts)}>${ci(c.meanPts)}</td>` : '<td>0</td><td>–</td><td>–</td>'; }).join('');
  const keys = [['flip', 'Any clean turn missed'], ['flip:by-deal', '… dealt instead'], ['flip:by-turn', '… turned another, spending an empty column'], ['flip:via-empty', '… line through an empty column'], ['flip:tail-swap', '… line swapping tails'], ['flip:off-suit', '… line through off-suit moves'], ['flip:L2', '… 2 moves'], ['flip:L3', '… 3 moves'], ['flip:L4', '… 4 moves'], ['flip:L5', '… 5 moves'], ['flip:L6+', '… 6 or more moves'], ['run', 'A suit that could be completed'], ['empty', 'A column that could be emptied']];
  return `${legend([['c-line', 'Line player, same positions'], ['c-dmz', 'Daniel'], ['c-amanda', 'Amanda']])}<div class="pair">${chart1}${chart2}</div>
  <div class="scroll"><table class="num"><thead><tr><th rowspan="2">${s} suits: what was missed</th><th colspan="3">Daniel</th><th colspan="3">Amanda</th></tr><tr><th>Misses</th><th>Points a game</th><th>Points each</th><th>Misses</th><th>Points a game</th><th>Points each</th></tr></thead><tbody>${keys.map(([k, t]) => `<tr><td>${t}</td>${costRows(k)}</tr>`).join('')}</tbody></table></div>`;
}

function t2Section(s) {
  const a = R.t2[`${s}/dmz`], b = R.t2[`${s}/amanda`];
  if (!a || !b) return '';
  const rows = a.rows.filter(r => r.f !== 'same' && r.f !== 'done');
  const fig = intervals(rows.map(r => ({ name: FEATURE_TEXT[r.f], a: r.diff, b: b.rows.find(x => x.f === r.f).diff })), { cap: 4, title: `${s} suits: how much more (right) or less (left) you weigh each thing than the line player does, in same-suit links`, unit: ' links against the line player' });
  const cell = (r) => `<td>${r.you}</td><td${sure(r.diff)}>${r.diff.est > 0 ? '+' : ''}${r.diff.est} <span class="ci">(${r.diff.lo} to ${r.diff.hi})</span></td>`;
  const table = `<div class="scroll"><table class="num"><thead><tr><th>Worth, in same-suit links</th><th>Line player</th><th>Network's best</th><th>Daniel</th><th>Against line player</th><th>Amanda</th><th>Against line player</th></tr></thead><tbody>${rows.map(r => { const o = b.rows.find(x => x.f === r.f); return `<tr><td>${esc(FEATURE_TEXT[r.f])}</td><td>${r.lineRatio}</td><td>${r.netRatio}</td>${cell(r)}${cell(o)}</tr>`; }).join('')}</tbody></table></div><p class="note">Choices fitted: Daniel ${a.n}, Amanda ${b.n}. The model picks the actual choice out of about 40 alternatives ${pct(a.top1)} and ${pct(b.top1)} of the time, and the line player's ${pct(a.lineTop1)} and ${pct(b.lineTop1)}.</p>`;
  return fig + table;
}

function t3Section(s) {
  const a = R.t3[`${s}/dmz`], b = R.t3[`${s}/amanda`];
  if (!a || !b) return '';
  const row = (t, x, y) => `<tr><td>${t}</td><td>${x.departs}</td><td${sure(x.playout)}>${ci(x.playout)}</td><td>${ci(x.net)}</td><td>${y.departs}</td><td${sure(y.playout)}>${ci(y.playout)}</td><td>${ci(y.net)}</td></tr>`;
  const head = `<thead><tr><th rowspan="2"></th><th colspan="3">Daniel</th><th colspan="3">Amanda</th></tr><tr><th>Departures</th><th>Played out, points a game</th><th>Network</th><th>Departures</th><th>Played out, points a game</th><th>Network</th></tr></thead>`;
  const part = (title, key, field, fmt = v => v) => `<tr class="sub"><td colspan="7">${title}</td></tr>${a[key].map((r, i) => row(fmt(r[field]), r, b[key][i])).join('')}`;
  const fig = intervals(a.byEnd.map((r, i) => ({ name: r.end, a: r.playout, b: b.byEnd[i].playout })), { title: `${s} suits: points a game, by how the decision ended`, unit: ' points a game' });
  const fig2 = intervals(a.bySize.map((r, i) => ({ name: `${r.size} points by the network`, a: r.playout, b: b.bySize[i].playout })), { title: `${s} suits: points a game, by how large the network calls each slip`, unit: ' points a game' });
  return `${fig}${fig2}<div class="scroll"><table class="num">${head}<tbody>
    <tr class="total"><td>All departures from the line player</td><td>${a.departsPerGame} a game</td><td${sure(a.playoutPerGame)}>${ci(a.playoutPerGame)}</td><td>${ci(a.netPerGame)}</td><td>${b.departsPerGame} a game</td><td${sure(b.playoutPerGame)}>${ci(b.playoutPerGame)}</td><td>${ci(b.netPerGame)}</td></tr>
    ${part('By how the decision ended', 'byEnd', 'end')}${part('By size, as the network calls it (points)', 'bySize', 'size')}${part('By deals left', 'byDeals', 'dealsLeft')}${part('By empty columns at hand', 'byEmpties', 'empties', v => (v === 2 ? '2 or more' : v))}${part('By columns still hiding cards', 'byHidColumns', 'hidColumns')}
  </tbody></table></div><p class="note">Network against playouts on the same departures: correlation ${a.netVsPlayout.corr} and ${b.netVsPlayout.corr}, slope ${a.netVsPlayout.slope} and ${b.netVsPlayout.slope}; mean ${a.netVsPlayout.meanNet} against ${a.netVsPlayout.meanPlayout} points for Daniel, ${b.netVsPlayout.meanNet} against ${b.netVsPlayout.meanPlayout} for Amanda. The raw yellow bars average ${a.rawYellow.human} and ${b.rawYellow.human} points a decision while the line player's own average ${a.rawYellow.line} and ${b.rawYellow.line}: that is why every figure here is measured against the line player's choice and not against zero.</p>`;
}

function t4Section(s) {
  const a = R.t4[`${s}/dmz`], b = R.t4[`${s}/amanda`];
  if (!a || !b) return '';
  const row = (x, y) => {
    const [text, A, B] = x.text;
    const cell = r => `<td>${r.n}</td><td>${pct(r.pickA)}</td><td${sure(r.delta)}>${ci(r.delta)}</td><td${sure(r.deltaIfB)}>${ci(r.deltaIfB)}</td><td${sure(r.deltaIfA)}>${ci(r.deltaIfA)}</td>`;
    return `<tr><td class="q">${esc(text)}<br><span class="ci">Picks and points are for <b>${esc(A)}</b> over ${esc(B)}</span></td><td>${pct((x.linePickA * x.lineN + y.linePickA * y.lineN) / Math.max(1, x.lineN + y.lineN))}</td>${cell(x)}${cell(y)}</tr>`;
  };
  return `<div class="scroll"><table class="num"><thead><tr><th rowspan="2">${s} suits: the question</th><th rowspan="2">Line player picks</th><th colspan="5">Daniel</th><th colspan="5">Amanda</th></tr><tr><th>Times</th><th>Picks</th><th>Worth, points</th><th>…when you chose the other</th><th>…when you chose this</th><th>Times</th><th>Picks</th><th>Worth, points</th><th>…when you chose the other</th><th>…when you chose this</th></tr></thead><tbody>${a.map((x, i) => row(x, b[i])).join('')}</tbody></table></div>`;
}

const v = R.t5;
const val = `
<h3>T1: lines too short for the player</h3>
<p>The line player cut down to two-step lines should find long lines less and less. It does.</p>
<div class="scroll"><table class="num"><thead><tr><th>Moves needed</th><th>Positions</th><th>Line player</th><th>Two-step player</th><th>Fewer empties wanted</th><th>Off-suit liked</th><th>Runs not valued</th></tr></thead><tbody>${v.t1Curve.map(r => `<tr><td>${r.L}</td><td>${r.n}</td><td>${pct(r.line)}</td><td>${pct(r.short)}</td><td>${pct(r.emptyLow)}</td><td>${pct(r.offHigh)}</td><td>${pct(r.runLow)}</td></tr>`).join('')}</tbody></table></div>
${v.t1ShortCost ? `<p class="note">Its misses, ${v.t1ShortCost.sampled} sampled of ${v.t1ShortCost.total}, cost ${ci(v.t1ShortCost.meanPts)} points each when played out.</p>` : ''}
<h3>T2: a weight put in</h3>
${v.t2 ? `<div class="scroll"><table class="num"><thead><tr><th>Flaw put in</th><th>Weight to find</th><th>Line player, in links</th><th>Flawed player, in links</th><th>Raw line</th><th>Raw flawed</th><th>Raw difference, 90%</th></tr></thead><tbody>${v.t2.map(r => `<tr><td>${r.who}</td><td>${esc(FEATURE_TEXT[r.feature])}</td><td>${r.lineRatio}</td><td>${r.plantedRatio}</td><td>${r.line}</td><td>${r.planted}</td><td>${r.rawDiff.lo} to ${r.rawDiff.hi}</td></tr>`).join('')}</tbody></table></div>` : ''}
<h3>T3: what a flaw costs</h3>
<div class="scroll"><table class="num"><thead><tr><th>Flaw</th><th>Decisions that differ</th><th>Sampled</th><th>Points per differing decision</th><th>Points per 45 decisions</th><th>Whole games: win rate lost, points</th><th>Win rate</th></tr></thead><tbody>${v.t3.map(r => `<tr><td>${r.who}</td><td>${pct(r.departShare)}</td><td>${r.sampled}</td><td>${ci(r.perDeparture)}</td><td>${r.per45Stretches}</td><td>${r.wholeGameDrop}</td><td>${r.winRate}% (line player ${r.lineWinRate}%, ${r.gamesEach} deals)</td></tr>`).join('')}</tbody></table></div>
<h3>T4: preferences a flaw should move</h3>
<div class="scroll"><table class="num"><thead><tr><th>Question (share choosing the first option)</th><th>Line player</th><th>Two-step</th><th>Fewer empties wanted</th><th>Off-suit liked</th><th>Runs not valued</th></tr></thead><tbody>${v.t4.map(r => `<tr><td>${r.q}</td>${['line', 'short', 'emptyLow', 'offHigh', 'runLow'].map(w => `<td>${pct(r[w])} <span class="ci">${r[`${w}N`]}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spider Playstyle Diagnosis</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500;8..60,700&family=Figtree:wght@400;600&display=swap" rel="stylesheet">
<style>
/* A plain report on felt-green ink: findings first, the evidence under them. */
:root {
  color-scheme: light;
  --bg: #f7f8f6; --panel: #ffffff; --ink: #14241f; --dim: #55655f; --rule: #d5dcd8; --accent: #17614a;
  --dmz: #2a78d6; --amanda: #eb6834; --line: #6f7a75; --good: #16764f; --sure: #e6f0ec;
  --display: "Source Serif 4", Georgia, serif; --body: Figtree, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --bg: #101a17; --panel: #16231f; --ink: #e8efec; --dim: #a3b2ac; --rule: #2d3d37; --accent: #6fcaa8; --dmz: #3987e5; --amanda: #d95926; --line: #93a09a; --good: #6fcaa8; --sure: #1f3a31; } }
:root[data-theme="dark"] { color-scheme: dark; --bg: #101a17; --panel: #16231f; --ink: #e8efec; --dim: #a3b2ac; --rule: #2d3d37; --accent: #6fcaa8; --dmz: #3987e5; --amanda: #d95926; --line: #93a09a; --good: #6fcaa8; --sure: #1f3a31; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--body); font-variant-numeric: tabular-nums; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 72px; display: flex; flex-direction: column; gap: 14px; }
h1, h2, h3 { font-family: var(--display); line-height: 1.2; text-wrap: balance; margin: 0; }
h1 { font-size: 34px; } h2 { font-size: 24px; margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--rule); color: var(--accent); } h3 { font-size: 18px; margin-top: 14px; }
p, ul, ol { margin: 0; max-width: 70ch; } li + li { margin-top: 6px; }
a { color: var(--accent); }
.note { color: var(--dim); font-size: 14px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-size: 14px; width: 100%; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
th { font-weight: 600; color: var(--dim); font-size: 13px; }
td.q { min-width: 260px; }
.ci { color: var(--dim); font-size: 12px; white-space: nowrap; }
td.sure { background: var(--sure); }
tr.sub td { font-weight: 600; color: var(--dim); padding-top: 12px; }
tr.total td { font-weight: 600; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 12px; min-width: 0; }
figcaption { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
svg { display: block; width: 100%; min-width: 420px; height: auto; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.grid { stroke: var(--rule); stroke-width: 1; } .zero { stroke: var(--dim); stroke-width: 1; }
.tick { fill: var(--dim); font-size: 11px; } .lab { fill: var(--ink); font-size: 12px; }
.ln { fill: none; stroke-width: 2; } .whisk { stroke-width: 2; }
.dot { stroke: var(--panel); stroke-width: 2; cursor: default; }
.c-dmz { stroke: var(--dmz); } circle.c-dmz, i.c-dmz { fill: var(--dmz); background: var(--dmz); }
.c-amanda { stroke: var(--amanda); } circle.c-amanda, i.c-amanda { fill: var(--amanda); background: var(--amanda); }
.c-line { stroke: var(--line); } circle.c-line, i.c-line { fill: var(--line); background: var(--line); }
circle.dot { stroke: var(--panel); }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 14px; color: var(--dim); max-width: none; }
.legend span { display: inline-flex; align-items: center; gap: 6px; } .sw { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); padding: 4px 8px; border-radius: 4px; font-size: 13px; display: none; max-width: 280px; z-index: 5; }
.finding { background: var(--panel); border: 1px solid var(--rule); border-left: 4px solid var(--accent); border-radius: 4px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.finding.dmz { border-left-color: var(--dmz); } .finding.amanda { border-left-color: var(--amanda); }
.finding h3 { margin: 0; }
.tag { font-size: 12px; font-weight: 600; color: var(--dim); }
</style></head><body><main>
<h1>Spider playstyle diagnosis</h1>
${findings}
<h2>The games</h2>
<p>Only the saved games of these two players, on the line each game ended on. A decision is everything between one turned card or deal and the next. Decisions made after seeing a card on an abandoned branch that was still hidden on the kept line are set aside.</p>
${summary}
<h2>T1: long lines that were there to find</h2>
<p>At each decision, a search over every move that shows nothing, up to 12 moves and 30,000 positions, finds the shortest line to a clean turn: a card turned without ending with fewer empty columns. Did the decision end in a clean turn? The line player's rate on the same positions is the control. Points are the line against what was played, in the same shuffles of the unseen cards. A shaded cell's 90% interval, resampling games, excludes zero.</p>
${t1Section(4)}${t1Section(3)}
<h2>T2: the weights your choices imply</h2>
<p>For each decision, a conditional logit of the end chosen against about 40 others that could have been reached, on 18 features. The weights are divided by the weight of a same-suit link, since a noisier chooser has smaller weights all round, and compared with the line player's on the same positions.</p>
${t2Section(4)}${t2Section(3)}
<h2>T3: how the loss is made up</h2>
<p>Every decision that ended somewhere other than the line player's end, played out both ways in 24 shuffles of the unseen cards. Size buckets use the network's figure, so the playouts in them are not selected on their own noise. These are win chance points for the line player continuing, so a total says what the decisions alone give up, assuming strong play afterwards.</p>
${t3Section(4)}${t3Section(3)}
<h2>T4: named questions</h2>
<p>Positions that pose one clean question, with the two moves played out in the same shuffles. Worth is the first option's lead over the second. It is measured with the line player continuing, which may suit one choice better than it suits a person. Shaded cells have 90% intervals that exclude zero.</p>
${t4Section(4)}${t4Section(3)}
<h2>T5: whether the tests can see a flaw put in</h2>
<p>The line player with a known flaw, asked at the same four-suit positions. A test that cannot find a flaw put in on purpose is not to be believed about a person.</p>
${val}
</main><div id="tip" role="status"></div>
<script>
const tip = document.getElementById('tip');
document.addEventListener('pointerover', e => { const t = e.target.dataset?.tip; if (t) { tip.textContent = t; tip.style.display = 'block'; } });
document.addEventListener('pointermove', e => { tip.style.left = Math.min(innerWidth - 290, e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; });
document.addEventListener('pointerout', e => { if (e.target.dataset?.tip) tip.style.display = 'none'; });
</script></body></html>`;
writeFileSync(`${dir}/index.html`, html);
