"""How much a choice matters. Usage: headroom.py deal|contrast file.csv
(from `dealgen` or `contrast`: candidates played on in the same worlds, the
line player's choice first). Per stage: the value of the line player's
choice, of the others, the spread between candidates beyond the noise of
the worlds, and what picking the best by half of the worlds gains in the
other half."""
import sys
from collections import defaultdict
import numpy as np


def read(kind, path):
    """{(seed, decision, k): [(index, tag, values)]}; tag: the evaluation
    given up (deal) or whether the candidate is the deal (contrast)."""
    groups = defaultdict(list)
    for l in open(path):
        p = l.rstrip("\n").split(",")
        if len(p) < 7:
            continue
        if kind == "deal":
            key, row = (int(p[0]), 0, int(p[1])), (int(p[2]), int(p[3]), np.array([float(x) for x in p[4].split(";")]))
        else:
            key, row = (int(p[0]), int(p[1]), int(p[2])), (int(p[3]), int(p[4]), np.array([float(x) for x in p[5].split(";")]))
        groups[key].append(row)
    return {k: sorted(v, key=lambda r: r[0]) for k, v in groups.items() if len(v) > 1}


if __name__ == "__main__":
    kind = sys.argv[1]
    groups = read(kind, sys.argv[2])
    se = lambda x: np.std(x) / np.sqrt(len(x)) if len(x) else float("nan")
    m = lambda x: np.mean(x) if len(x) else float("nan")
    for k in sorted({key[2] for key in groups}, reverse=True):
        gs = [v for key, v in groups.items() if key[2] == k]
        W = len(gs[0][0][2])
        if W < 4:
            print(f"k={k}: {len(gs)} decisions, {W} worlds (4 needed)")
            continue
        h = W // 2
        root = np.array([g[0][2].mean() for g in gs])
        a, b, gain_half, sig2, oracle, res, flat = [], [], [], [], [], [], 0
        adv, adv_noise, gain_sure = [], [], []
        for g in gs:
            V = np.stack([c[2] for c in g])  # candidate x world
            tags = np.array([c[1] for c in g])
            d = V[1:].mean(1) - V[0].mean()
            if kind == "deal":
                a += list(d[tags[1:] == 0])
                b += list(d[tags[1:] < 0])
            elif tags[0] == 1:
                b += list(d)
            else:
                a += list(d[tags[1:] == 0])
                b += list(d[tags[1:] == 1])
            flat += np.ptp(V, 0).max() < 1e-9
            D = V[1:] - V[0]
            adv += list(D.mean(1))
            adv_noise += list(D.var(1, ddof=1) / W)
            for x, y in [(slice(0, h), slice(h, W)), (slice(h, W), slice(0, h))]:
                pick = V[:, x].mean(1).argmax()
                gain_half.append(V[pick, y].mean() - V[0, y].mean())
                # only when ahead of the choice by two standard errors
                dx = D[:, x]
                z = dx.mean(1) / (dx.std(1, ddof=1) / np.sqrt(dx.shape[1]) + 1e-12)
                j = int(np.argmax(dx.mean(1)))
                gain_sure.append(D[j, y].mean() if dx.mean(1)[j] > 0 and z[j] > 2 else 0.0)
            C = len(g)
            r = V - V.mean(0, keepdims=True) - V.mean(1, keepdims=True) + V.mean()
            ms_res = (r**2).sum() / ((C - 1) * (W - 1))
            ms_c = W * ((V.mean(1) - V.mean()) ** 2).sum() / (C - 1)
            sig2.append((ms_c - ms_res) / W)
            res.append(ms_res)
            oracle.append(V.mean(1).max() - V[0].mean())
        gh = np.array(gain_half).reshape(-1, 2).mean(1)
        gs2 = np.array(gain_sure).reshape(-1, 2).mean(1)
        # Were the true differences from the choice normal: what knowing them would gain.
        mu, tau2 = np.mean(adv), max(np.var(adv) - np.mean(adv_noise), 0)
        nc = int(round(np.mean([len(g) for g in gs]))) - 1
        sim = np.random.default_rng(0).normal(mu, np.sqrt(tau2), (200000, max(nc, 1)))
        know = np.maximum(sim.max(1), 0).mean()
        names = ("others, same evaluation", "lower") if kind == "deal" else ("other lines (the choice a line)", "dealing instead / lines instead of dealing")
        print(
            f"k={k}: {len(gs)} decisions ({flat} all the same), {np.mean([len(g) for g in gs]):.1f} candidates, {W} worlds; chosen {100*root.mean():.2f}%\n"
            f"   {names[0]}: {100*m(a):+.2f} +-{100*se(a):.2f} ({len(a)});  {names[1]}: {100*m(b):+.2f} +-{100*se(b):.2f} ({len(b)})\n"
            f"   best by half the worlds, judged by the other half: {100*gh.mean():+.2f} +-{100*se(gh):.2f}\n"
            f"   sd between candidates beyond noise: {100*np.sqrt(max(np.mean(sig2), 0)):.2f} (var {1e4*np.mean(sig2):+.3f} +-{1e4*se(sig2):.3f}), noise sd {100*np.sqrt(np.mean(res)):.2f};  best by all worlds (biased up): {100*np.mean(oracle):+.2f}\n"
            f"   others less the choice: mean {100*mu:+.2f}, sd beyond noise {100*np.sqrt(tau2):.2f}; knowing them (if normal): {100*know:+.2f};  best by half the worlds if 2 se ahead, judged by the other half: {100*gs2.mean():+.2f} +-{100*se(gs2):.2f} ({100*np.mean(gs2 != 0):.0f}%)"
        )
