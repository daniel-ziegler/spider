"""Value network for the line player (see src/vnet.rs).

    python vnet/train.py train --data runs/vnet/d1.bin --out runs/vnet/v1.pt
    python vnet/train.py play --ckpt runs/vnet/v1.pt --suits 4 --first 20001 --count 2000

A position comes as a grid of codes, ROWS per column from the bottom (0: no
card, 1: face down, 2: face up but unknown, 3 + card with card = suit * 13 +
rank), then the deals left and the completed suits. Every card present is a
token, and so is an empty column; each token sums embeddings of its code,
row, column, its relation with the card above and the card below (none, a
face-down card, same-suit link, off-suit link, not linked, unknown), how
many cards of its same-suit run are above it and below it, and whether its
column is whole (all its face-up cards one same-suit run). A global token
carries the deals left and the completed suits, and the value is read from
it: the probability of winning (and, as an auxiliary target, the fraction
of suits completed).
"""

import argparse
import json
import math
import os
import struct
import subprocess
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VPLAY = os.environ.get("VPLAY", os.path.join(ROOT, "target", "release", "vplay"))
NUM_COLS = 10
ROWS = 32
ENC = NUM_COLS * ROWS + 2
RECORD = ENC + 6
EMPTY_ID = 55
GLOBAL_ID = 56


def card_features(x):
    """x: uint8 (B, ENC) on the device. Returns per-slot integer features,
    each (B, NUM_COLS, ROWS): code, rel_above, rel_below, run_above,
    run_below, whole; and a validity mask."""
    b = x.shape[0]
    code = x[:, : NUM_COLS * ROWS].view(b, NUM_COLS, ROWS).long()
    present = code > 0
    down = code == 1
    unknown = code == 2
    card = (code - 3).clamp_min(0)
    rank = card % 13
    suit = card // 13
    # Relation of each slot with the next one up the column (slot r with r+1).
    a_, b_ = slice(None, -1), slice(1, None)
    both = present[..., a_] & present[..., b_]
    anydown = down[..., a_] | down[..., b_]
    anyunk = unknown[..., a_] | unknown[..., b_]
    seq = rank[..., a_] == rank[..., b_] + 1
    same = suit[..., a_] == suit[..., b_]
    rel = torch.full_like(rank[..., a_], 4)
    rel = torch.where(seq & ~same, torch.full_like(rel, 3), rel)
    rel = torch.where(seq & same, torch.full_like(rel, 2), rel)
    rel = torch.where(anyunk, torch.full_like(rel, 5), rel)
    rel = torch.where(anydown, torch.full_like(rel, 1), rel)
    rel = torch.where(both, rel, torch.zeros_like(rel))
    zero = torch.zeros_like(rel[..., :1])
    rel_above = torch.cat([zero, rel], -1)
    rel_below = torch.cat([rel, zero], -1)
    link = rel == 2  # slot r and r+1 same-suit linked
    run_above = torch.zeros_like(rank)
    for r in range(1, ROWS):
        run_above[..., r] = torch.where(link[..., r - 1], run_above[..., r - 1] + 1, 0)
    run_below = torch.zeros_like(rank)
    for r in range(ROWS - 2, -1, -1):
        run_below[..., r] = torch.where(link[..., r], run_below[..., r + 1] + 1, 0)
    n = present.sum(-1)
    top = (n - 1).clamp_min(0)
    top_known = torch.gather(code, -1, top[..., None])[..., 0] >= 3
    top_run = torch.gather(run_above, -1, top[..., None])[..., 0] + 1
    faceup = (present & ~down).sum(-1)
    whole = (n > 0) & top_known & (top_run == faceup)
    whole = whole[..., None].expand(-1, -1, ROWS).long()
    # An empty column is one token, in row 0.
    empty = n == 0
    code = code.clone()
    code[..., 0] = torch.where(empty, torch.full_like(code[..., 0], EMPTY_ID), code[..., 0])
    valid = present.clone()
    valid[..., 0] |= empty
    return code, rel_above, rel_below, run_above.clamp_max(12), run_below.clamp_max(12), whole, valid


class Net(nn.Module):
    def __init__(self, d=64, layers=3, heads=4, ff=256):
        super().__init__()
        self.cfg = dict(d=d, layers=layers, heads=heads, ff=ff)
        self.code = nn.Embedding(57, d)
        self.row = nn.Embedding(ROWS, d)
        self.col = nn.Embedding(NUM_COLS, d)
        self.rel_above = nn.Embedding(6, d)
        self.rel_below = nn.Embedding(6, d)
        self.run_above = nn.Embedding(13, d)
        self.run_below = nn.Embedding(13, d)
        self.whole = nn.Embedding(2, d)
        self.deals = nn.Embedding(6, d)
        self.completed = nn.Embedding(9, d)
        layer = nn.TransformerEncoderLayer(d, heads, ff, dropout=0.0, batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.head = nn.Linear(d, 2)
        self.register_buffer("rows", torch.arange(ROWS))
        self.register_buffer("cols", torch.arange(NUM_COLS))

    def forward(self, x, perm=None):
        """x: uint8 (B, ENC). perm: optional (B, NUM_COLS) column order.
        Returns (win logit, suits logit), each (B,)."""
        b = x.shape[0]
        code, ra, rb, ua, ub, wh, valid = card_features(x)
        tok = (
            self.code(code)
            + self.row(self.rows)[None, None]
            + self.rel_above(ra)
            + self.rel_below(rb)
            + self.run_above(ua)
            + self.run_below(ub)
            + self.whole(wh)
        )
        colid = self.cols[None].expand(b, -1) if perm is None else perm
        tok = tok + self.col(colid)[:, :, None]
        tok = tok.view(b, NUM_COLS * ROWS, -1)
        valid = valid.view(b, NUM_COLS * ROWS)
        # Pack the tokens present to the front.
        length = int(valid.sum(1).max())
        order = torch.argsort((~valid).to(torch.int8), dim=1, stable=True)[:, :length]
        tok = torch.gather(tok, 1, order[..., None].expand(-1, -1, tok.shape[-1]))
        pad = ~torch.gather(valid, 1, order)
        g = self.code.weight[GLOBAL_ID] + self.deals(x[:, -2].long().clamp_max(5)) + self.completed(x[:, -1].long().clamp_max(8))
        tok = torch.cat([g[:, None], tok], 1)
        pad = torch.cat([torch.zeros_like(pad[:, :1]), pad], 1)
        h = self.enc(tok, src_key_padding_mask=pad)
        out = self.head(self.norm(h[:, 0]))
        return out[:, 0], out[:, 1]


def load(path, dev):
    ck = torch.load(path, map_location=dev, weights_only=False)
    net = Net(**ck["cfg"]).to(dev)
    net.load_state_dict(ck["model"])
    net.eval()
    return net


def read_data(paths):
    arrs = [np.fromfile(p, np.uint8).reshape(-1, RECORD) for p in paths]
    return np.concatenate(arrs) if len(arrs) > 1 else arrs[0]


def split(data, val_mod):
    seed = data[:, ENC + 2 :].copy().view("<u4")[:, 0]
    val = seed % val_mod == 0
    return np.nonzero(~val)[0], np.nonzero(val)[0]


def batch_of(data, idx, dev):
    rec = torch.from_numpy(data[idx]).to(dev, non_blocking=True)
    x = rec[:, :ENC]
    won = rec[:, ENC].float()
    suits = rec[:, ENC + 1].float() / 8
    return x, won, suits


@torch.no_grad()
def validate(net, data, idx, dev, bs=4096):
    net.eval()
    tot = n = 0.0
    tot_s = 0.0
    for i in range(0, len(idx), bs):
        x, won, suits = batch_of(data, idx[i : i + bs], dev)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            w, s = net(x)
        tot += F.binary_cross_entropy_with_logits(w.float(), won, reduction="sum").item()
        tot_s += F.binary_cross_entropy_with_logits(s.float(), suits, reduction="sum").item()
        n += len(won)
    net.train()
    return tot / n, tot_s / n


def cmd_train(a, dev):
    torch.manual_seed(a.seed)
    data = read_data(a.data)
    tr, va = split(data, a.val_mod)
    va = va[np.random.default_rng(0).permutation(len(va))[: a.val_size]]
    base = data[tr, ENC].mean()
    ent = -(base * math.log(base) + (1 - base) * math.log(1 - base))
    net = Net(a.d, a.layers, a.heads, a.ff).to(dev)
    if a.init:
        net.load_state_dict(torch.load(a.init, map_location=dev, weights_only=False)["model"])
    params = sum(p.numel() for p in net.parameters())
    print(json.dumps(dict(records=len(data), train=len(tr), val=len(va), win_rate=round(float(base), 4), base_loss=round(ent, 4), params=params)), flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=a.wd)
    steps = int(a.epochs * len(tr) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=steps, pct_start=0.05)
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    run = 0.0
    for step in range(1, steps + 1):
        idx = np.sort(rng.choice(tr, a.batch, replace=False)) if len(tr) < 4 * a.batch else np.sort(tr[rng.integers(0, len(tr), a.batch)])
        x, won, suits = batch_of(data, idx, dev)
        perm = torch.argsort(torch.rand(len(idx), NUM_COLS, device=dev), 1)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            w, s = net(x, perm)
        loss = F.binary_cross_entropy_with_logits(w.float(), won) + a.aux * F.binary_cross_entropy_with_logits(s.float(), suits)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        run = 0.99 * run + 0.01 * loss.item() if step > 1 else loss.item()
        if step % a.log_every == 0 or step == steps:
            vl, vs = validate(net, data, va, dev)
            print(json.dumps(dict(step=step, of=steps, loss=round(run, 4), val_win=round(vl, 4), val_suits=round(vs, 4), secs=round(time.time() - t0))), flush=True)
            torch.save({"cfg": net.cfg, "model": net.state_dict()}, a.out)
    torch.save({"cfg": net.cfg, "model": net.state_dict()}, a.out)


def cmd_play(a, dev):
    net = load(a.ckpt, dev)
    env = dict(os.environ)
    env["SPIDER_V_CONCURRENT"] = str(a.concurrent)
    args = [VPLAY, str(a.suits), str(a.first), str(a.count)] + ([a.record] if a.record else [])
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    out, inp = p.stdout, p.stdin
    games = won = suits = 0
    evals = 0
    t0 = time.time()
    results = []
    while True:
        t = out.read(1)
        if t == b"E":
            (n,) = struct.unpack("<I", out.read(4))
            x = np.frombuffer(out.read(n * ENC), np.uint8).reshape(n, ENC)
            vals = []
            with torch.no_grad():
                for i in range(0, n, a.chunk):
                    xt = torch.from_numpy(x[i : i + a.chunk].copy()).to(dev)
                    with torch.autocast("cuda", dtype=torch.bfloat16):
                        w, _ = net(xt)
                    vals.append(torch.sigmoid(w.float()).cpu().numpy())
            inp.write(np.concatenate(vals).astype("<f4").tobytes())
            inp.flush()
            evals += n
        elif t == b"G":
            seed, comp, w, moves = struct.unpack("<QBBI", out.read(14))
            games += 1
            won += w
            suits += comp
            results.append((seed, comp, w, moves))
            if not a.quiet:
                print(f"seed {seed}: {'WIN ' if w else 'loss'} suits {comp} moves {moves}", flush=True)
        elif t == b"Q" or t == b"":
            break
    p.wait()
    secs = time.time() - t0
    print(f"suits {a.suits}: won {won}/{games}, {suits / max(games, 1):.2f} suits/deal, {evals / max(games, 1):.0f} evals/deal, {secs / max(games, 1) * 1000:.0f} ms/deal (wall)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", nargs="+", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--init")
    t.add_argument("--d", type=int, default=64)
    t.add_argument("--layers", type=int, default=3)
    t.add_argument("--heads", type=int, default=4)
    t.add_argument("--ff", type=int, default=256)
    t.add_argument("--lr", type=float, default=1e-3)
    t.add_argument("--wd", type=float, default=0.01)
    t.add_argument("--batch", type=int, default=1024)
    t.add_argument("--epochs", type=float, default=3)
    t.add_argument("--aux", type=float, default=0.5)
    t.add_argument("--val-mod", type=int, default=20)
    t.add_argument("--val-size", type=int, default=100000)
    t.add_argument("--log-every", type=int, default=1000)
    t.add_argument("--seed", type=int, default=0)
    p = sub.add_parser("play")
    p.add_argument("--ckpt", required=True)
    p.add_argument("--suits", type=int, default=4)
    p.add_argument("--first", type=int, default=20001)
    p.add_argument("--count", type=int, default=200)
    p.add_argument("--concurrent", type=int, default=256)
    p.add_argument("--chunk", type=int, default=8192)
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--record", help="append the games' records here (set SPIDER_V_RECORD)")
    a = ap.parse_args()
    dev = torch.device("cuda")
    {"train": cmd_train, "play": cmd_play}[a.cmd](a, dev)


if __name__ == "__main__":
    main()
