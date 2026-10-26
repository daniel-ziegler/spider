"""How well the AlphaZero network's value (a summary of each column: src/az.rs
`features`) and the analysis's network (every card: web/tools/analysis/train.py)
predict the end of the line player's games, on the same positions (written by
`vcmp`: target/release/vcmp suits first count out.bin).
Usage: python az/vcmp.py data.bin --az runs/az2/netB/imitate.pt --cards runs/vnet-strong/net.pt

The AlphaZero value is trained on (suits completed, +4 for a win) / 12 and the
analysis's on the win, so besides each network's own log loss against the win
there is that of its logit refitted (a line, on the games of even seeds, the
rest scored), the area under the curve and the correlation."""
import argparse
import importlib.util
import os
import sys

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


def auc(p, y):
    order = np.argsort(p, kind="stable")
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    # (ties are few with real-valued predictions)
    n1 = y.sum()
    n0 = len(y) - n1
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n0 * n1)


def logloss(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def refit(logit, y, fit):
    """A line on the logit, fitted on `fit` by Newton's method."""
    a, b = 1.0, 0.0
    x, t = logit[fit], y[fit]
    for _ in range(30):
        p = 1 / (1 + np.exp(-(a * x + b)))
        w = p * (1 - p) + 1e-9
        g = np.array([((p - t) * x).sum(), (p - t).sum()])
        h = np.array([[(w * x * x).sum(), (w * x).sum()], [(w * x).sum(), w.sum()]])
        a, b = np.array([a, b]) - np.linalg.solve(h, g)
    return 1 / (1 + np.exp(-(a * logit + b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--az", required=True)
    ap.add_argument("--cards", required=True)
    a = ap.parse_args()
    az = module("az_train", "az/train.py")
    cards = module("analysis_train", "web/tools/analysis/train.py")
    POS, ENC = az.POS, cards.ENC
    R = POS + ENC + 8
    rec = np.fromfile(a.data, np.uint8).reshape(-1, R)
    nxt, deals, won, done = (rec[:, POS + ENC + i] for i in range(4))
    seed = rec[:, POS + ENC + 4 :].copy().view("<u4")[:, 0]
    y = won.astype(np.float64)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    net_az, _ = az.load(a.az, dev)
    net_az.eval()
    net_c = cards.load(a.cards, dev)
    la, lc = [], []
    with torch.no_grad():
        for i in range(0, len(rec), 2048):
            r = torch.from_numpy(rec[i : i + 2048]).to(dev)
            la.append(net_az(r[:, :POS])[0].double().cpu().numpy())
            suits = torch.full((len(r),), 4, device=dev)
            lc.append(net_c(r[:, POS : POS + ENC], suits=suits, nxt=r[:, POS + ENC])[0].double().cpu().numpy())
    la, lc = np.concatenate(la), np.concatenate(lc)
    fit = seed % 2 == 0
    games = len(np.unique(seed))
    print(f"{len(rec)} positions of {games} games, {y.mean():.3f} of them in games won; log loss of the rate alone {logloss(np.full_like(y, y[fit].mean())[~fit], y[~fit]):.4f}")
    code = rec[:, POS : POS + ENC - 2]
    print(f"cards a position: {(code > 0).sum(1).mean():.1f}, face down {(code == 1).sum(1).mean():.1f}, face up {(code > 1).sum(1).mean():.1f}, empty columns {(code.reshape(-1, 10, 32)[:, :, 0] == 0).sum(1).mean():.2f}")
    print(f"{'':22}{'positions':>10}{'own loss':>10}{'refitted':>10}{'AUC':>8}{'corr':>8}")
    groups = [("all", np.ones(len(rec), bool))] + [(f"{d} deals left", deals == d) for d in range(5, -1, -1)]
    for name, logit in [("column summaries (az)", la), ("every card (analysis)", lc)]:
        p = 1 / (1 + np.exp(-logit))
        q = refit(logit, y, fit)
        print(name)
        for g, m in groups:
            t = m & ~fit
            if t.sum() < 100 or y[t].min() == y[t].max():
                continue
            print(f"  {g:20}{t.sum():>10}{logloss(p[t], y[t]):>10.4f}{logloss(q[t], y[t]):>10.4f}{auc(p[t], y[t]):>8.4f}{np.corrcoef(p[t], y[t])[0, 1]:>8.3f}")


if __name__ == "__main__":
    main()
