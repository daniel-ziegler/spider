# Which measures of a deal say how two players did on it: python3 fit.py DIR
# (DIR: outcomes.json from outcomes.mjs, model3.out and model4.out from
# model_rates, comp/stretches.jsonl from step 1 of the playstyle analysis on
# compgames.mjs's database; or that file as a second argument, `none` to do
# without). Prints the tables and writes DIR/hardness.json and measures.json.
import json, math, sys, collections
import numpy as np

D = sys.argv[1].rstrip('/') + '/'
rng = np.random.default_rng(1)
out = json.load(open(D + 'outcomes.json'))
lg = lambda p: math.log(p / (1 - p))

# The measures of each deal: logits of the model players' win rates, their cards
# left face down, and what the computer's own game asked for.
M = collections.defaultdict(dict)
for s in (3, 4):
    for l in open(D + f'model{s}.out'):
        t = l.split()
        for i in range(2, len(t), 3):
            a, n = map(int, t[i + 1].split('/'))
            M[(s, int(t[1]))][t[i]] = lg((a + 0.5) / (n + 1))
            M[(s, int(t[1]))][t[i] + '.down'] = -int(t[i + 2]) / 100
try:
    per = collections.defaultdict(list)
    for l in open(sys.argv[2] if len(sys.argv) > 2 else D + 'comp/stretches.jsonl'):
        r = json.loads(l)
        per[(r['suits'], r['seed'])].append(r)
    for k, rs in per.items():
        f = lambda cond: sum(1 for r in rs if cond(r))
        flip = lambda r: r['opp'].get('flip')
        early = [r for r in rs if r['dealsLeft'] >= 3]
        M[k].update({
            'c.long4': -f(lambda r: flip(r) and flip(r)['L'] >= 4),
            'c.long6': -f(lambda r: flip(r) and flip(r)['L'] >= 6),
            'c.needs': -f(lambda r: flip(r) and flip(r)['needs']),
            'c.noflip': -f(lambda r: not flip(r)),
            'c.long4share': -f(lambda r: flip(r) and flip(r)['L'] >= 4) / max(1, f(lambda r: flip(r))),
            'c.early4': -sum(1 for r in early if flip(r) and flip(r)['L'] >= 4),
            'c.earlyno': -sum(1 for r in early if not flip(r)),
            'c.v0': rs[0]['v0'],
            'c.vdeal1': next((r['v0'] for r in rs if r['dealsLeft'] <= 4), rs[-1]['v0']),
        })
except FileNotFoundError:
    pass
for k in M:
    if 'comp' in M[k] and 'cap80' in M[k]:
        M[k]['gap'] = M[k]['cap80'] - M[k]['comp']  # low: the deal pays for long lines

def fitlogit(X, y, l2=1e-2, pen=None):
    w = np.zeros(X.shape[1])
    P = np.eye(X.shape[1]) * l2 if pen is None else np.diag(pen)
    for _ in range(60):
        p = 1 / (1 + np.exp(-X @ w))
        H = (X * (p * (1 - p))[:, None]).T @ X + P
        w -= np.linalg.solve(H, X.T @ (p - y) + P @ w)
    p = 1 / (1 + np.exp(-X @ w))
    se = np.sqrt(np.diag(np.linalg.inv((X * (p * (1 - p))[:, None]).T @ X + P)))
    return w, se

def auc(xs, ys, gs):
    xs, ys = np.asarray(xs, float), np.asarray(ys, bool)
    codes = {g: i for i, g in enumerate(sorted(set(gs)))}
    gi = np.array([codes[g] for g in gs])
    c = n = 0
    for g in range(len(codes)):
        pos, neg = xs[(gi == g) & ys], xs[(gi == g) & ~ys]
        if len(pos) and len(neg):
            d = pos[:, None] - neg[None, :]
            c += (d > 0).sum() + 0.5 * (d == 0).sum(); n += d.size
    return (c / n if n else float('nan')), n

def study(rows, label, names, base='weak'):
    """rows: outcome entries (won or lost). For each measure: the AUC within a
    player's games of one number of suits, with a 90% interval from resampling
    deals; its slope per SD beside `base`; and the log loss it saves over
    `base` alone on deals left out (10 folds by deal, 5 times)."""
    rows = [r for r in rows if all(m in M[(r['suits'], r['seed'])] for m in names if m not in OWN)]
    y = np.array([r['res'] == 'won' for r in rows], float)
    gs = [(r['user'], r['suits'], r['kind'] if KIND else '') for r in rows]
    G = sorted(set(gs))
    F = np.array([[float(g == h) for h in G] for g in gs])
    deals = sorted({(r['suits'], r['seed']) for r in rows})
    di = np.array([deals.index((r['suits'], r['seed'])) for r in rows])
    col = lambda m: np.array([M[(r['suits'], r['seed'])][OWN[m][r['user']] if m in OWN else m] for r in rows])
    z = lambda x: (x - x.mean()) / (x.std() or 1)
    print(f'\n== {label}: {len(rows)} games on {len(deals)} deals, {int(y.sum())} won')
    res = {}
    def cv(cols):
        tot = []
        for rep in range(REPS):
            fold = np.random.default_rng(rep).permutation(len(deals)) % 10
            ll = 0
            for k in range(10):
                te = fold[di] == k
                X = np.column_stack([F] + cols) if cols else F
                w, _ = fitlogit(X[~te], y[~te], pen=[1e-2] * F.shape[1] + [0.3] * len(cols))
                p = np.clip(1 / (1 + np.exp(-X[te] @ w)), 1e-4, 1 - 1e-4)
                ll += np.sum(y[te] * np.log(p) + (1 - y[te]) * np.log(1 - p))
            tot.append(ll)
        return float(np.mean(tot))
    ll0 = cv([])
    llb = cv([z(col(base))]) if base else ll0
    for m in names:
        x = col(m)
        a, n = auc(x, y, gs)
        bs, bd = [], []
        xb = col(base) if base else x
        for _ in range(200):
            pick = rng.integers(0, len(deals), len(deals))
            idx = np.concatenate([np.flatnonzero(di == d) for d in pick])
            g2 = [gs[i] for i in idx]
            bs.append(auc(x[idx], y[idx], g2)[0])
            bd.append(bs[-1] - auc(xb[idx], y[idx], g2)[0])
        lo, hi = np.nanpercentile(bs, [5, 95])
        dlo, dhi = np.nanpercentile(bd, [5, 95])
        w1, se1 = fitlogit(np.column_stack([F, z(x)]), y)
        line = f'  {m:13s} AUC {a:.2f} ({lo:.2f}-{hi:.2f}, {n} pairs)  alone {w1[-1]:+.2f}±{se1[-1]:.2f}  held-out {cv([z(x)]) - ll0:+.1f}'
        res[m] = dict(auc=a, lo=lo, hi=hi, pairs=n, slope=w1[-1], se=se1[-1], cv=cv([z(x)]) - ll0)
        if base and m != base:
            w2, se2 = fitlogit(np.column_stack([F, z(col(base)), z(x)]), y)
            gain = cv([z(col(base)), z(x)]) - llb
            line += f'  | AUC over {base} {a - auc(xb, y, gs)[0]:+.2f} ({dlo:+.2f} to {dhi:+.2f}); beside it {w2[-1]:+.2f}±{se2[-1]:.2f}, held-out {gain:+.1f}'
            res[m].update(beside=w2[-1], beside_se=se2[-1], gain=gain, over=a - auc(xb, y, gs)[0], over_lo=dlo, over_hi=dhi)
        print(line)
    return dict(n=len(rows), deals=len(deals), won=int(y.sum()), measures=res)

KIND = False
# The model fitted to each player's own found rates (see games.py), and the other's.
OWN = {'own': {'amanda': 'cap80', 'dmz': 'cap95'}, 'other': {'amanda': 'cap95', 'dmz': 'cap80'}}
REPS = 5
dec = [r for r in out if r['res'] in ('won', 'lost')]
names = [m for m in ['weak', 'cap65', 'cap80', 'cap90', 'cap95', 'low80', 'low90', 'comp', 'own', 'other', 'gap', 'weak.down', 'cap80.down', 'comp.down',
                     'c.long4', 'c.long6', 'c.needs', 'c.noflip', 'c.long4share', 'c.early4', 'c.earlyno', 'c.v0', 'c.vdeal1'] if m in OWN or all(m in v for v in M.values())]  # (only those every deal has)
R = {}

# 1. How much of a result is the deal's at all: the two players on the same deals.
both = collections.defaultdict(dict)
for r in dec: both[(r['suits'], r['seed'])][r['user']] = r
pairs = [(v['dmz'], v['amanda']) for v in both.values() if len(v) == 2]
Z = np.random.default_rng(0).standard_normal((2, 60000))
ZS = np.sort(Z[0])
def tetra(a, b):
    """The correlation of two normal variables cut at the rates of a and b that gives their rate of both (by a fixed sample)."""
    pa, pb, pab = a.mean(), b.mean(), (a * b).mean()
    if min(pa, pb) <= 0 or max(pa, pb) >= 1: return float('nan')
    ta, tb = np.quantile(ZS, pa), np.quantile(ZS, pb)  # "won" is below the cut
    lo, hi = -0.99, 0.99
    for _ in range(14):
        mid = (lo + hi) / 2
        if ((Z[0] < ta) & (mid * Z[0] + math.sqrt(1 - mid * mid) * Z[1] < tb)).mean() < pab: lo = mid
        else: hi = mid
    return (lo + hi) / 2
def agreement(pairs, label):
    a = np.array([p[0]['res'] == 'won' for p in pairs], float); b = np.array([p[1]['res'] == 'won' for p in pairs], float)
    same = int((a == b).sum()); chance = len(a) * (a.mean() * b.mean() + (1 - a.mean()) * (1 - b.mean()))
    rho = tetra(a, b)
    bs = []
    for _ in range(300):
        i = rng.integers(0, len(a), len(a)); bs.append(tetra(a[i], b[i]))
    lo, hi = np.nanpercentile(bs, [5, 95])
    print(f'  {label}: {len(a)} deals, Daniel won {int(a.sum())}, Amanda {int(b.sum())}, both {int((a * b).sum())}; same result {same} against {chance:.1f} by chance; correlation of the deal in the two {rho:+.2f} ({lo:+.2f} to {hi:+.2f})')
    return dict(n=len(a), same=same, chance=chance, rho=rho, lo=lo, hi=hi, dwon=int(a.sum()), awon=int(b.sum()), both=int((a * b).sum()))
print('== the same deals played by both')
R['agreement'] = {k: agreement([p for p in pairs if f(p[0])], k) for k, f in
                  [('all', lambda r: True), ('3 suits', lambda r: r['suits'] == 3), ('4 suits', lambda r: r['suits'] == 4), ('medium', lambda r: r['kind'] == 'medium'), ('hard', lambda r: r['kind'] == 'hard')]}
def ceiling(rho, p=0.4, n=400000):
    """The AUC of the deal's own share of the result, were it known exactly, when two players' results correlate by rho."""
    if not rho > 0: return 0.5
    r = np.random.default_rng(2); d = r.standard_normal(n); x = math.sqrt(rho) * d + math.sqrt(1 - rho) * r.standard_normal(n)
    won = x > np.quantile(x, 1 - p)
    order = np.argsort(d); ranks = np.empty(n); ranks[order] = np.arange(n)
    return (ranks[won].mean() - (won.sum() - 1) / 2) / (n - won.sum())
R['ceiling'] = {str(rho): ceiling(rho) for rho in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6)}
print('  best AUC a perfect measure of the deal could have, by that correlation:', {k: round(v, 2) for k, v in R['ceiling'].items()})

# 2. Each measure against the weak player's rate.
R['all'] = study(dec, 'all decided games', names)
for u in ('dmz', 'amanda'): R[u] = study([r for r in dec if r['user'] == u], u, names)
for s in (3, 4): R[f'{s} suits'] = study([r for r in dec if r['suits'] == s], f'{s} suits', names)
R['medium'] = study([r for r in dec if r['kind'] == 'medium'], 'medium only', names)
R['hard'] = study([r for r in dec if r['kind'] == 'hard'], 'hard only', names)
for u in ('dmz', 'amanda'): R[u + ' hard'] = study([r for r in dec if r['user'] == u and r['kind'] == 'hard'], u + ' hard only', names)

# 3. Other outcomes: how far a lost game got, and the undos of one who undoes.
def spear(x, y):
    rk = lambda v: np.argsort(np.argsort(v)).astype(float)
    return float(np.corrcoef(rk(np.array(x)), rk(np.array(y)))[0, 1]) if len(x) > 3 else float('nan')
def other(rows, value, label):
    print(f'\n== {label}')
    res = {}
    for m in [m for m in names if m not in OWN]:
        cs, ns = [], []
        for g in sorted({(r['user'], r['suits']) for r in rows}):
            rs = [r for r in rows if (r['user'], r['suits']) == g and m in M[(r['suits'], r['seed'])]]
            if len(rs) > 8:
                cs.append(spear([M[(r['suits'], r['seed'])][m] for r in rs], [value(r) for r in rs])); ns.append(len(rs))
        if ns:
            c = float(np.average(cs, weights=ns)); se = 1 / math.sqrt(sum(ns) - 3 * len(ns))
            res[m] = dict(r=c, se=se, n=sum(ns))
            print(f'  {m:13s} rank correlation {c:+.2f} ±{se:.2f} ({sum(ns)} games)')
    return res
R['progress'] = other([r for r in dec if r['user'] == 'amanda'], lambda r: -r['down'] + 2 * r['done'], 'Amanda: how far the game got (cards turned, suits made; a win is furthest)')
R['progress_lost'] = other([r for r in dec if r['user'] == 'amanda' and r['res'] == 'lost'], lambda r: -r['down'] + 2 * r['done'], 'Amanda, lost games only: how far the game got')
R['undos'] = other([r for r in dec if r['user'] == 'dmz'], lambda r: -math.log(1 + r['undos']) - (5 if r['res'] == 'lost' else 0), 'Daniel: few undos (a loss counts as most)')
R['undos_won'] = other([r for r in dec if r['user'] == 'dmz' and r['res'] == 'won'], lambda r: -math.log(1 + r['undos']), 'Daniel, wins only: few undos')

# 4. Does a measure say which of the two a deal is harder for?
print('\n== deals both played: Daniel\'s result minus Amanda\'s against each measure (rank correlation)')
R['between'] = {}
for m in [m for m in names if m not in OWN]:
    ps = [p for p in pairs if m in M[(p[0]['suits'], p[0]['seed'])]]
    c = spear([M[(p[0]['suits'], p[0]['seed'])][m] for p in ps], [(p[0]['res'] == 'won') - (p[1]['res'] == 'won') for p in ps])
    R['between'][m] = dict(r=c, n=len(ps))
    print(f'  {m:13s} {c:+.2f} ({len(ps)} deals, ±{1 / math.sqrt(len(ps) - 3):.2f})')

# 5. How the measures go together across deals.
ms = [m for m in ['weak', 'cap80', 'cap95', 'low80', 'comp', 'c.long4', 'c.noflip', 'c.v0'] if m in names]
for s in (3, 4):
    ks = [k for k in M if k[0] == s and all(m in M[k] for m in ms)]
    print(f'\ncorrelations across the {len(ks)} deals of {s} suits:', ms)
    print(np.round(np.corrcoef(np.array([[M[k][m] for m in ms] for k in ks]).T), 2))
json.dump(R, open(D + 'hardness.json', 'w'), indent=1, default=float)
json.dump({f'{k[0]}/{k[1]}': v for k, v in M.items()}, open(D + 'measures.json', 'w'))

# 6. The deals the models set furthest apart for the two, with what happened.
res_of = collections.defaultdict(dict)
for r in out: res_of[(r['suits'], r['seed'])][r['user']] = r['res']
pc = lambda x: round(100 / (1 + math.exp(-x)))
ks = [k for k in M if 'gap' in M[k] and res_of[k]]
print('\nmodel of Amanda (cap80) furthest below the computer, and nearest it:   suits/seed  cap80  cap95  comp  results')
for k in sorted(ks, key=lambda k: M[k]['gap'])[:12] + sorted(ks, key=lambda k: -M[k]['gap'])[:12]:
    print(f"  {k[0]}/{k[1]:<10d} {pc(M[k]['cap80']):3d}% {pc(M[k]['cap95']):3d}% {pc(M[k]['comp']):3d}%  " + ', '.join(f'{u} {v}' for u, v in sorted(res_of[k].items())))
