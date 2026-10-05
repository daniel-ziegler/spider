"""Calibration of a value net on recorded data: mean prediction against the
win rate, by deals left, and just before / just after a deal."""
import sys
import numpy as np
import torch
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from train import ENC, RECORD, load, read_data

dev = torch.device("cuda")
net = load(sys.argv[1], dev)
data = read_data([sys.argv[2]])[: int(sys.argv[3]) if len(sys.argv) > 3 else 400000]
seed = data[:, ENC + 2 :].copy().view("<u4")[:, 0]
deals = data[:, ENC - 2].astype(int)
won = data[:, ENC].astype(float)
pred = []
with torch.no_grad():
    for i in range(0, len(data), 8192):
        x = torch.from_numpy(data[i : i + 8192, :ENC].copy()).to(dev)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            w, _ = net(x)
        pred.append(torch.sigmoid(w.float()).cpu().numpy())
pred = np.concatenate(pred)
print("all: pred %.3f won %.3f" % (pred.mean(), won.mean()))
for d in range(6):
    m = deals == d
    print("deals left %d: n %7d pred %.3f won %.3f" % (d, m.sum(), pred[m].mean(), won[m].mean()))
nxt = np.r_[seed[1:] == seed[:-1], False] & np.r_[deals[1:] == deals[:-1] - 1, False]
pre = np.nonzero(nxt)[0]
post = pre + 1
print("before a deal: n %d pred %.3f won %.3f" % (len(pre), pred[pre].mean(), won[pre].mean()))
print("after a deal:  n %d pred %.3f won %.3f" % (len(post), pred[post].mean(), won[post].mean()))
for lo, hi in [(0, .1), (.1, .3), (.3, .5), (.5, .7), (.7, .9), (.9, 1)]:
    m = (pred >= lo) & (pred < hi)
    print("pred in [%.1f, %.1f): n %7d pred %.3f won %.3f" % (lo, hi, m.sum(), pred[m].mean(), won[m].mean()))
