"""Fit, for each stage, the chance that the reference player wins from the
position it is about to deal from: logistic regression on visible features.
Usage: fit.py feat.csv out   (feat.csv from `stage feat`; writes out.json for
ev.py and out.txt for SPIDER_V_MODEL)"""
import json, sys
import numpy as np

d = np.genfromtxt(sys.argv[1], delimiter=",", names=True)
names = list(d.dtype.names[3:])
X = np.stack([d[n] for n in names], 1)
k = d["k"].astype(int)
won = d["won"]
seed = d["seed"].astype(int)


def fit(X, y, l2=1.0, iters=50):
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.c_[np.ones(len(X)), (X - mu) / sd]
    w = np.zeros(Z.shape[1])
    R = l2 * np.eye(Z.shape[1])
    R[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        H = Z.T @ (Z * (p * (1 - p))[:, None]) + R
        w += np.linalg.solve(H, Z.T @ (y - p) - R @ w)
    return mu, sd, w


def predict(m, X):
    mu, sd, w = m
    return 1 / (1 + np.exp(-(np.c_[np.ones(len(X)), (X - mu) / sd] @ w)))


def ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()


out = {"names": names}
for L in [5, 4, 3, 2, 1]:
    m = k == L
    Xs, ys, ss = X[m], won[m], seed[m]
    cv, cvh = [], []
    hid = [names.index("hidden")]
    for f in range(5):
        te = ss % 5 == f
        cv.append(ll(predict(fit(Xs[~te], ys[~te]), Xs[te]), ys[te]))
        cvh.append(ll(predict(fit(Xs[~te][:, hid], ys[~te]), Xs[te][:, hid]), ys[te]))
    base = ll(np.full(len(ys), ys.mean()), ys)
    mdl = fit(Xs, ys)
    p = predict(mdl, Xs)
    print(f"k={L}: n={m.sum()} win {ys.mean():.3f}  logloss const {base:.4f} hidden-only {np.mean(cvh):.4f} all {np.mean(cv):.4f}  sd(V) {p.std():.3f}")
    out[str(L)] = {"mu": mdl[0].tolist(), "sd": mdl[1].tolist(), "w": mdl[2].tolist()}
    order = np.argsort(-np.abs(mdl[2][1:]))
    print("   " + " ".join(f"{names[i]}:{mdl[2][1 + i]:+.2f}" for i in order[:12]))
json.dump(out, open(sys.argv[2] + ".json", "w"))
with open(sys.argv[2] + ".txt", "w") as f:
    for L in "54321":
        f.write(" ".join([L] + [repr(x) for x in out[L]["mu"] + out[L]["sd"] + out[L]["w"]]) + "\n")
