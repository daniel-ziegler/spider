"""The network of the web game's analysis: one for all four numbers of suits.

    .venv/bin/python web/tools/analysis/train.py train --data runs/analysis2/a?.bin --out runs/analysis2/net.pt
    .venv/bin/python web/tools/analysis/train.py report --data runs/analysis2/a?.bin --ckpt runs/analysis2/net.pt

It is the value network of vnet/train.py (see there for what it is made of)
with one more embedding on the global token, the number of suits, trained on
the records of target/release/adata (src/vnet.rs, record_for_analysis:
positions of games of a line player (whichever adata was given), each with the game's outcome, the
number of suits and what kind of position it is). A twentieth of the games
(by seed) is held out; `report` gives the log loss on them for each number
of suits and how well the probabilities are calibrated, by tenths and by kind
of position. `--suits N` trains or reports on the games of N suits only.
"""
import argparse, json, math, os, sys, time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# (vnet/train.py, under another name than this file's.)
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("vnet_train", os.path.join(ROOT, "vnet", "train.py"))
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
ENC, NUM_COLS, Net = base.ENC, base.NUM_COLS, base.Net

RECORD = ENC + 8  # the encoding, won, suits completed, suits, kind, seed (u32)
WON, SUITS, KIND = ENC, ENC + 2, ENC + 3
KINDS = ["decision", "line end", "mid-line", "stuck", "before a deal", "after a deal", "dealt, unknown"]
NEXT = ENC + 8  # (in memory only: what the line player does next, from the .feat file beside the data)
WIDTH = ENC + 9


class SuitsNet(Net):
    """Net with the number of suits (1 to 4) known to the global token."""

    def __init__(self, d=64, layers=3, heads=4, ff=256):
        super().__init__(d, layers, heads, ff)
        self.suits = nn.Embedding(5, d)
        self.next = nn.Embedding(7, d)
        nn.init.zeros_(self.suits.weight)
        nn.init.zeros_(self.next.weight)

    def forward(self, x, perm=None, suits=None, nxt=None):
        # (Net.forward reads the global token's code embedding once: the
        # suits are added to it there.)
        g = self.code.weight
        extra = self.suits(suits.long()) + self.next(nxt.long())
        b = x.shape[0]
        code, ra, rb, ua, ub, wh, valid = base.card_features(x)
        tok = self.code(code) + self.row(self.rows)[None, None] + self.rel_above(ra) + self.rel_below(rb) + self.run_above(ua) + self.run_below(ub) + self.whole(wh)
        colid = self.cols[None].expand(b, -1) if perm is None else perm
        tok = (tok + self.col(colid)[:, :, None]).view(b, NUM_COLS * base.ROWS, -1)
        valid = valid.view(b, NUM_COLS * base.ROWS)
        length = int(valid.sum(1).max())
        order = torch.argsort((~valid).to(torch.int8), dim=1, stable=True)[:, :length]
        tok = torch.gather(tok, 1, order[..., None].expand(-1, -1, tok.shape[-1]))
        pad = ~torch.gather(valid, 1, order)
        g = g[base.GLOBAL_ID] + self.deals(x[:, -2].long().clamp_max(5)) + self.completed(x[:, -1].long().clamp_max(8)) + extra
        tok = torch.cat([g[:, None], tok], 1)
        pad = torch.cat([torch.zeros_like(pad[:, :1]), pad], 1)
        h = self.enc(tok, src_key_padding_mask=pad)
        out = self.head(self.norm(h[:, 0]))
        return out[:, 0], out[:, 1]


def load(path, dev):
    ck = torch.load(path, map_location=dev, weights_only=False)
    net = SuitsNet(**ck["cfg"]).to(dev)
    net.load_state_dict(ck["model"])
    net.eval()
    return net


def dealt(rec):
    """The positions right after the deals of these positions (before a
    deal), the ten cards dealt not yet known: an unknown card on each
    column (the top ROWS cards of a column are kept), a deal less."""
    out = rec.copy()
    code = out[:, : NUM_COLS * base.ROWS].reshape(len(out), NUM_COLS, base.ROWS)
    n = (code > 0).sum(-1)
    full = n == base.ROWS
    code[full] = np.roll(code[full], -1, axis=-1)
    np.put_along_axis(code, np.minimum(n, base.ROWS - 1)[..., None], 2, axis=-1)
    out[:, ENC - 2] -= 1
    out[:, KIND] = 6
    out[:, NEXT] = 0
    return out


def read(paths, suits=None, feat=True):
    """The records of the files, each with what the line player does next
    there (`feat`; the file beside it written by afeat; else 0), and after
    them the positions dealt and not yet known made of those before a deal."""
    parts = []
    for p in paths:
        n = os.path.getsize(p) // RECORD
        rec = np.zeros((n, WIDTH), np.uint8)
        rec[:, :RECORD] = np.fromfile(p, np.uint8, n * RECORD).reshape(n, RECORD)
        if feat:
            rec[:, NEXT] = np.fromfile(p[:-4] + ".feat", np.uint8, n)
        if suits is not None:
            rec = rec[rec[:, SUITS] == suits]
        parts += [rec, dealt(rec[rec[:, KIND] == 4])]
    data = np.concatenate(parts)
    del parts
    seed = data[:, ENC + 4 : ENC + 8].copy().view("<u4")[:, 0]
    val = seed % 20 == 0
    return data, np.nonzero(~val)[0], np.nonzero(val)[0]


def batch(data, idx, dev):
    rec = torch.from_numpy(data[idx]).to(dev, non_blocking=True)
    return rec[:, :ENC], rec[:, WON].float(), rec[:, ENC + 1].float() / 8, rec[:, SUITS], rec[:, NEXT]


@torch.no_grad()
def predict(net, data, idx, dev, bs=2048):
    net.eval()
    out = np.empty(len(idx), np.float64)
    for i in range(0, len(idx), bs):
        x, _, _, suits, nxt = batch(data, idx[i : i + bs], dev)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            w, _ = net(x, None, suits, nxt)
        out[i : i + bs] = torch.sigmoid(w.float()).double().cpu().numpy()
    net.train()
    return out


def log_loss(p, y):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def by_suits(data, idx, p):
    out = {}
    for s in range(1, 5):
        m = data[idx, SUITS] == s
        if m.any():
            out[s] = round(log_loss(p[m], data[idx[m], WON]), 4)
    return out


def cmd_train(a, dev):
    torch.manual_seed(a.seed)
    data, tr, va = read(a.data, a.suits, not a.no_feat)
    va = va[np.random.default_rng(0).permutation(len(va))[: a.val_size]]
    net = SuitsNet(a.d, a.layers, a.heads, a.ff).to(dev)
    if a.init:
        net.load_state_dict(torch.load(a.init, map_location=dev, weights_only=False)["model"])
    params = sum(p.numel() for p in net.parameters())
    print(json.dumps(dict(records=len(data), train=len(tr), val=len(va), win_rate=round(float(data[tr, WON].mean()), 4), params=params)), flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=a.wd)
    steps = int(a.epochs * len(tr) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=steps, pct_start=0.05)
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    run = 0.0
    for step in range(1, steps + 1):
        idx = np.sort(tr[rng.integers(0, len(tr), a.batch)])
        x, won, done, suits, nxt = batch(data, idx, dev)
        perm = torch.argsort(torch.rand(len(idx), NUM_COLS, device=dev), 1)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            w, s = net(x, perm, suits, nxt)
        loss = F.binary_cross_entropy_with_logits(w.float(), won) + a.aux * F.binary_cross_entropy_with_logits(s.float(), done)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        run = 0.99 * run + 0.01 * loss.item() if step > 1 else loss.item()
        if step % a.log_every == 0 or step == steps:
            p = predict(net, data, va, dev)
            print(json.dumps(dict(step=step, of=steps, loss=round(run, 4), val=round(log_loss(p, data[va, WON]), 4), val_suits=by_suits(data, va, p), secs=round(time.time() - t0))), flush=True)
            torch.save({"cfg": net.cfg, "model": net.state_dict()}, a.out)


def cmd_report(a, dev):
    data, _, va = read(a.data, a.suits, not a.no_feat)
    nets = {s: load(path, dev) for s, path in zip(range(1, 5), a.ckpt)} if len(a.ckpt) == 4 else None
    one = load(a.ckpt[0], dev) if nets is None else None
    for s in range(1, 5):
        idx = va[data[va, SUITS] == s]
        if not len(idx):
            continue
        p = predict(one or nets[s], data, idx, dev)
        y = data[idx, WON].astype(np.float64)
        rate = y.mean()
        ent = -(rate * math.log(rate) + (1 - rate) * math.log(1 - rate))
        print(f"{s} suits: {len(idx)} held-out positions, won {rate:.4f}, mean value {p.mean():.4f}, log loss {log_loss(p, y):.4f} (knowing nothing {ent:.4f}), Brier {((p - y) ** 2).mean():.4f}")
        bins = np.minimum((p * 10).astype(int), 9)
        ece = 0.0
        row = []
        for b in range(10):
            m = bins == b
            if m.any():
                ece += m.mean() * abs(p[m].mean() - y[m].mean())
                row.append(f"{p[m].mean():.3f}/{y[m].mean():.3f} ({m.sum()})")
        print(f"  by tenths, value/won (positions): {', '.join(row)}\n  expected calibration error {ece:.4f}")
        kinds = data[idx, KIND]
        row = [f"{KINDS[k]} {p[kinds == k].mean():.3f}/{y[kinds == k].mean():.3f} ({(kinds == k).sum()})" for k in range(len(KINDS)) if (kinds == k).any()]
        print(f"  by kind: {', '.join(row)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", nargs="+", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--init")
    t.add_argument("--suits", type=int)
    t.add_argument("--d", type=int, default=80)
    t.add_argument("--layers", type=int, default=4)
    t.add_argument("--heads", type=int, default=4)
    t.add_argument("--ff", type=int, default=320)
    t.add_argument("--lr", type=float, default=1e-3)
    t.add_argument("--wd", type=float, default=0.01)
    t.add_argument("--batch", type=int, default=1024)
    t.add_argument("--epochs", type=float, default=2)
    t.add_argument("--aux", type=float, default=0.5)
    t.add_argument("--val-size", type=int, default=200000)
    t.add_argument("--log-every", type=int, default=2000)
    t.add_argument("--seed", type=int, default=0)
    t.add_argument("--no-feat", action="store_true", help="without what the line player does next")
    r = sub.add_parser("report")
    r.add_argument("--data", nargs="+", required=True)
    r.add_argument("--ckpt", nargs="+", required=True, help="one network, or four (for one to four suits)")
    r.add_argument("--suits", type=int)
    r.add_argument("--no-feat", action="store_true")
    a = ap.parse_args()
    {"train": cmd_train, "report": cmd_report}[a.cmd](a, torch.device("cuda"))


if __name__ == "__main__":
    main()
