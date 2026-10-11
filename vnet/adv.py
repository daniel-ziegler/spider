"""A network that ranks the line player's candidates, trained on contrasts:
candidates of one decision played on in the same worlds (`contrast` and
`dealgen`, see src/contrast.rs).

    python vnet/adv.py train --data runs/contrast/c*.csv --out runs/contrast/a1.pt

The network (vnet/train.py's, with a mark for a candidate that deals) gives
each candidate's position a value. It is trained on the value itself (the
mean over the worlds) and, more heavily, on the differences within a
decision, where the luck of the worlds cancels. Validation, on decisions of
held-out seeds: what playing the candidate the network puts first, when
it is ahead of the line player's choice by a margin, gains over that choice
(in points of fitted win probability, per decision).
"""
import argparse, json, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import ENC, NUM_COLS, ROWS, GLOBAL_ID, Net, card_features

EXT = ENC + 3


class AdvNet(Net):
    def __init__(self, d=64, layers=3, heads=4, ff=256):
        super().__init__(d, layers, heads, ff)
        self.dealt = nn.Embedding(2, d)
        nn.init.zeros_(self.dealt.weight)
        # The line player's view of the candidate: whether it is its choice,
        # and its evaluations less the choice's (src/contrast.rs, extras).
        self.ext = nn.Linear(3, d)
        nn.init.zeros_(self.ext.weight)
        nn.init.zeros_(self.ext.bias)

    def forward(self, x, perm=None):
        b = x.shape[0]
        e = x[:, ENC:].float()
        e = torch.stack([e[:, 0], (e[:, 1] - 128) / 32, (e[:, 2] - 128) / 32], 1)
        x = x[:, :ENC]
        code, ra, rb, ua, ub, wh, valid = card_features(x)
        tok = self.code(code) + self.row(self.rows)[None, None] + self.rel_above(ra) + self.rel_below(rb) + self.run_above(ua) + self.run_below(ub) + self.whole(wh)
        colid = self.cols[None].expand(b, -1) if perm is None else perm
        tok = (tok + self.col(colid)[:, :, None]).view(b, NUM_COLS * ROWS, -1)
        valid = valid.view(b, NUM_COLS * ROWS)
        length = int(valid.sum(1).max())
        order = torch.argsort((~valid).to(torch.int8), dim=1, stable=True)[:, :length]
        tok = torch.gather(tok, 1, order[..., None].expand(-1, -1, tok.shape[-1]))
        pad = ~torch.gather(valid, 1, order)
        deals = x[:, -2].long()
        g = self.code.weight[GLOBAL_ID] + self.deals((deals & 15).clamp_max(5)) + self.dealt(deals >> 4) + self.completed(x[:, -1].long().clamp_max(8)) + self.ext(e)
        tok = torch.cat([g[:, None], tok], 1)
        pad = torch.cat([torch.zeros_like(pad[:, :1]), pad], 1)
        h = self.enc(tok, src_key_padding_mask=pad)
        return self.head(self.norm(h[:, 0]))[:, 0]


def read(paths):
    """Candidates' encodings (N, EXT), mean values (N,), group ids (N,),
    seeds (N,), deals left (N,), and whether first of its group."""
    encs, vals, gid, seeds, ks, key2id = [], [], [], [], [], {}
    for fi, path in enumerate(paths):
        for l in open(path):
            p = l.rstrip("\n").split(",")
            if len(p) < 7 or len(p[6]) != 2 * EXT:
                continue
            deal = len(p[5].split(";")) > 8  # dealgen: seed,k,index,gain,values,features,enc
            key = (fi, p[0], p[1]) if deal else (fi, p[0], p[1], p[2])
            v = p[4] if deal else p[5]
            gid.append(key2id.setdefault(key, len(key2id)))
            encs.append(bytes.fromhex(p[6]))
            vals.append(np.mean([float(t) for t in v.split(";")]))
            seeds.append(int(p[0]))
            ks.append(int(p[1] if deal else p[2]))
    x = np.frombuffer(b"".join(encs), np.uint8).reshape(-1, EXT)
    return x, np.array(vals, np.float32), np.array(gid), np.array(seeds), np.array(ks)


def groups_of(gid):
    order = np.argsort(gid, kind="stable")
    cuts = np.flatnonzero(np.diff(gid[order])) + 1
    return [g for g in np.split(order, cuts) if len(g) > 1]


@torch.no_grad()
def predict(net, x, dev, bs=4096):
    net.eval()
    out = []
    for i in range(0, len(x), bs):
        with torch.autocast("cuda", dtype=torch.bfloat16):
            out.append(net(torch.from_numpy(x[i : i + bs].copy()).to(dev)).float().cpu().numpy())
    net.train()
    return np.concatenate(out)


def policy_gain(pred, vals, groups, margins=(0.0, 0.01, 0.02, 0.04), seeds=None):
    """Mean over decisions of the value of the candidate picked (the one
    predicted best, if ahead of the first by the margin) less the first's,
    its standard error (decisions of one game, given `seeds`, are not
    independent: they share the hidden cards) and how often another than
    the first is picked."""
    out = {}
    for m in margins:
        gains = []
        for g in groups:
            j = int(np.argmax(pred[g]))
            gains.append(vals[g[j]] - vals[g[0]] if pred[g[j]] > pred[g[0]] + m else 0.0)
        gains = np.array(gains)
        if seeds is None:
            se = np.std(gains) / np.sqrt(len(gains))
        else:
            _, inv = np.unique([seeds[g[0]] for g in groups], return_inverse=True)
            sums = np.bincount(inv, gains - gains.mean())
            se = np.sqrt((sums**2).sum()) / len(gains)
        out[m] = (100 * np.mean(gains), 100 * se, np.mean(gains != 0))
    return out


def cmd_train(a, dev):
    torch.manual_seed(a.seed)
    x, vals, gid, seeds, ks = read(a.data)
    groups = groups_of(gid)
    is_val = lambda g: seeds[g[0]] % a.val_mod == 0
    tr = [g for g in groups if not is_val(g)]
    va = [g for g in groups if is_val(g)]
    print(json.dumps(dict(candidates=len(x), train_groups=len(tr), val_groups=len(va))), flush=True)
    net = AdvNet(a.d, a.layers, a.heads, a.ff).to(dev)
    if a.init:
        print(net.load_state_dict(torch.load(a.init, map_location=dev, weights_only=False)["model"], strict=False), flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=a.wd)
    steps = int(a.epochs * len(tr) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=steps, pct_start=0.05)
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    run = [0.0, 0.0]
    for step in range(1, steps + 1):
        pick = rng.integers(0, len(tr), a.batch)
        idx = np.concatenate([tr[i] for i in pick])
        grp = torch.from_numpy(np.concatenate([np.full(len(tr[i]), n) for n, i in enumerate(pick)])).to(dev)
        xb = torch.from_numpy(x[idx]).to(dev)
        y = torch.from_numpy(vals[idx]).to(dev)
        # The same column order for a decision's candidates.
        perm = torch.argsort(torch.rand(a.batch, NUM_COLS, device=dev), 1)[grp]
        with torch.autocast("cuda", dtype=torch.bfloat16):
            out = net(xb, perm).float()
        p = torch.sigmoid(out)
        ones = torch.ones_like(y)
        cnt = torch.zeros(a.batch, device=dev).index_add_(0, grp, ones)
        center = lambda t: t - (torch.zeros(a.batch, device=dev).index_add_(0, grp, t) / cnt)[grp]
        l_abs = F.binary_cross_entropy_with_logits(out, y)
        l_rel = ((center(p) - center(y)) ** 2).mean() * 1e2
        loss = a.abs * l_abs + l_rel
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        run = [0.99 * r + 0.01 * v if step > 1 else v for r, v in zip(run, (l_abs.item(), l_rel.item()))]
        if step % a.log_every == 0 or step == steps:
            vi = np.concatenate(va)
            pred = 1 / (1 + np.exp(-predict(net, x[vi], dev)))
            full = np.zeros(len(x), np.float32)
            full[vi] = pred
            pg = policy_gain(full, vals, va, seeds=seeds)
            cy = np.concatenate([vals[g] - vals[g].mean() for g in va])
            cp = np.concatenate([full[g] - full[g].mean() for g in va])
            print(
                json.dumps(
                    dict(step=step, of=steps, abs=round(run[0], 4), rel=round(run[1], 4), val_rel=round(float(((cp - cy) ** 2).mean() * 1e2), 4), val_rel0=round(float((cy**2).mean() * 1e2), 4),
                         corr=round(float(np.corrcoef(cp, cy)[0, 1]), 4), gain={str(m): [round(v[0], 3), round(v[1], 3), round(float(v[2]), 3)] for m, v in pg.items()}, secs=round(time.time() - t0))
                ),
                flush=True,
            )
            torch.save({"cfg": net.cfg, "model": net.state_dict()}, a.out)


def report(pred, vals, groups, ks, seeds):
    """Validation numbers of predictions (probabilities) on decisions."""
    out = {}
    for k in ["all", 5, 4, 3, 2, 1, 0]:
        gs = [g for g in groups if k == "all" or ks[g[0]] == k]
        if not gs:
            continue
        cy = np.concatenate([vals[g] - vals[g].mean() for g in gs])
        cp = np.concatenate([pred[g] - pred[g].mean() for g in gs])
        pg = policy_gain(pred, vals, gs, (0.0, 0.01, 0.02, 0.04, 0.08), seeds)
        out[k] = dict(n=len(gs), corr=round(float(np.corrcoef(cp, cy)[0, 1]), 4), gain={str(m): f"{v[0]:+.2f}+-{v[1]:.2f} ({100*v[2]:.0f}%)" for m, v in pg.items()})
    return out


def cmd_eval(a, dev):
    """A network's ranking against the contrasts of data files."""
    ck = torch.load(a.ckpt, map_location=dev, weights_only=False)
    net = AdvNet(**ck["cfg"]).to(dev)
    net.load_state_dict(ck["model"], strict=False)
    x, vals, gid, seeds, ks = read(a.data)
    groups = groups_of(gid)
    if a.val_mod:
        groups = [g for g in groups if seeds[g[0]] % a.val_mod == 0]
    pred = 1 / (1 + np.exp(-predict(net, x, dev)))
    for k, v in report(pred, vals, groups, ks, seeds).items():
        print(k, json.dumps(v))


def cmd_export(a, dev):
    """The weights for src/advnet.rs, and with --check the network's values
    of the first positions of a data file to compare."""
    import struct
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    net = AdvNet(**ck["cfg"])
    net.load_state_dict(ck["model"])
    with open(a.out, "wb") as f:
        tensors = {k: v for k, v in net.state_dict().items() if k not in ("rows", "cols")}
        tensors["heads"] = torch.tensor([float(ck["cfg"]["heads"])])
        for k, v in tensors.items():
            v = v.float().contiguous()
            f.write(struct.pack("<I", len(k)) + k.encode() + struct.pack("<I", v.dim()) + struct.pack(f"<{v.dim()}I", *v.shape) + v.numpy().astype("<f4").tobytes())
    if a.check:
        x = read([a.check])[0][:200]
        net.eval()
        with torch.no_grad():
            v = net(torch.from_numpy(x.copy()))
        for row, val in zip(x, v):
            print(bytes(row).hex(), f"{val.item():.5f}")


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
    t.add_argument("--batch", type=int, default=128, help="decisions per step")
    t.add_argument("--epochs", type=float, default=10)
    t.add_argument("--abs", type=float, default=0.2, help="weight of the loss on the value itself")
    t.add_argument("--val-mod", type=int, default=10)
    t.add_argument("--log-every", type=int, default=500)
    t.add_argument("--seed", type=int, default=0)
    v = sub.add_parser("eval")
    v.add_argument("--ckpt", required=True)
    v.add_argument("--data", nargs="+", required=True)
    v.add_argument("--val-mod", type=int, default=0)
    e = sub.add_parser("export")
    e.add_argument("--ckpt", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--check")
    a = ap.parse_args()
    {"train": cmd_train, "eval": cmd_eval, "export": cmd_export}[a.cmd](a, torch.device("cuda"))


if __name__ == "__main__":
    main()
