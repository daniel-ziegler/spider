#!/usr/bin/env python3
"""T2: what each chooser's choices of how to end a stretch say it values.

    python3 fit.py DIR   (reads DIR/decisions.jsonl, writes DIR/fit.json)

A conditional logit over the ends of a stretch: the chosen one against a uniform
sample of the others (uniform sampling leaves the coefficients consistent), on
the same positions for every chooser. Bootstrap over games, the same resampling
for all choosers, so that their differences have honest intervals.
Coefficients are per unit of each feature; a chooser's scale says how
deterministic it is, so choosers are compared by ratios."""
import json, sys
import numpy as np

FEATURES = ['deal', 'flipLeft', 'empties', 'same', 'off', 'offHigh', 'breaks', 'runSq', 'done', 'dig', 'minDown', 'spread', 'buriedKings', 'kingBase', 'ranksOpen', 'mobility', 'turnable', 'steps']
P = len(FEATURES)
A = 41
RIDGE = 1.0
BOOT = int(sys.argv[2]) if len(sys.argv) > 2 else 200
d = sys.argv[1]
rows = [json.loads(l) for l in open(f'{d}/decisions.jsonl')]
rows = [r for r in rows if not r['cont']]

def design(rows, who):
    """X: (decisions, A, P), chosen first; mask of what is there; the game of each."""
    keep = []
    for r in rows:
        c = r['choice'].get(who)
        if not c: continue
        others = [o for o in r['pool'] if o['k'] != c['k']]
        if not others: continue
        keep.append((r['g'], c['f'], [o['f'] for o in others]))
    X = np.zeros((len(keep), A, P)); M = np.zeros((len(keep), A), bool)
    for i, (_, f, os) in enumerate(keep):
        X[i, 0] = f; M[i, 0] = True
        n = min(len(os), A - 1)
        X[i, 1:n + 1] = os[:n]; M[i, 1:n + 1] = True
    return X, M, [k[0] for k in keep]

def newton(X, M, w, b, sd, steps=25):
    """b in standardised units; w: a weight per decision."""
    Xs = X / sd
    for it in range(steps):
        u = (Xs * b).sum(-1)
        u = np.where(M, u, -1e9)
        u -= u.max(1, keepdims=True)
        pi = np.exp(u)
        pi /= pi.sum(1, keepdims=True)
        mean = (pi[..., None] * Xs).sum(1)
        g = (w[:, None] * (Xs[:, 0] - mean)).sum(0) - RIDGE * b
        Xc = Xs - mean[:, None, :]
        H = (w[:, None, None] * pi[..., None] * Xc).reshape(-1, P).T @ Xc.reshape(-1, P)
        H += RIDGE * np.eye(P)
        step = np.linalg.solve(H, g)
        # (A damped step: the teacher's choices are nearly separable.)
        n = np.abs(step).max()
        b = b + step * min(1.0, 2.0 / max(n, 1e-9))
        if n < 1e-4: break
    return b

def loglik(X, M, b, sd):
    u = np.where(M, (X / sd * b).sum(-1), -1e9)
    lp = u[:, 0] - np.logaddexp.reduce(u, axis=1)
    return float(lp.sum()), float((u.argmax(1) == 0).mean()), float(-np.log(M.sum(1)).sum())

out = {}
for suits in sorted({r['suits'] for r in rows}):
    rs = [r for r in rows if r['suits'] == suits]
    # A standard deviation for each feature, within a decision.
    pool = [np.array([o['f'] for o in r['pool']]) for r in rs if len(r['pool']) > 1]
    sd = np.sqrt(np.concatenate([(x - x.mean(0)) ** 2 for x in pool]).mean(0))
    sd[sd < 1e-6] = 1.0
    res = {'features': FEATURES, 'sd': sd.tolist(), 'users': {}}
    for user in ['dmz', 'amanda', 'both']:
        ur = [r for r in rs if user == 'both' or r['user'] == user]
        if not ur: continue
        games = sorted({r['g'] for r in ur})
        idx = {g: i for i, g in enumerate(games)}
        rng = np.random.default_rng(12345)
        counts = rng.multinomial(len(games), [1 / len(games)] * len(games), size=BOOT)
        names = ['human', 'line', 'net'] + ([k for k in ['short', 'emptyLow', 'offHigh', 'runLow'] if user == 'both'] if suits == 4 else [])
        if user == 'both': names.remove('human')
        ures = {}
        for who in names:
            X, M, gs = design(ur, who)
            if not len(X): continue
            gi = np.array([idx[g] for g in gs])
            b = newton(X, M, np.ones(len(X)), np.zeros(P), sd)
            ll, top1, ll0 = loglik(X, M, b, sd)
            bs = np.array([newton(X, M, counts[k][gi].astype(float), b.copy(), sd, steps=3) for k in range(BOOT)])
            ures[who] = {'n': len(X), 'beta': (b / sd).tolist(), 'boot': (bs / sd).tolist(), 'll': ll, 'll0': ll0, 'top1': top1}
            print(suits, user, who, len(X), f'r2 {1 - ll / ll0:.3f} top1 {top1:.3f}', ' '.join(f'{f}={x:.2f}' for f, x in zip(FEATURES, b / sd)), flush=True)
        # The null: the line player on half of the games against the other half.
        if suits == 4 and user == 'both':
            X, M, gs = design(ur, 'line')
            gi = np.array([idx[g] for g in gs])
            half = (np.arange(len(games)) % 2)[gi]
            b1 = newton(X, M, (half == 0).astype(float), np.zeros(P), sd)
            b2 = newton(X, M, (half == 1).astype(float), np.zeros(P), sd)
            ures['lineHalves'] = {'a': (b1 / sd).tolist(), 'b': (b2 / sd).tolist()}
        res['users'][user] = ures
    out[str(suits)] = res
json.dump(out, open(f'{d}/fit.json', 'w'))
