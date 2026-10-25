"""AlphaZero trainer for the non-peeking Spider player (see src/az.rs).

The Rust process `azplay` runs the games and the tree search; this process
owns the network on the GPU: it answers azplay's evaluation batches, keeps a
replay buffer of the records azplay sends back, and trains between batches.

    python az/train.py imitate --suits 4 --games 2000 --out runs/s4
    python az/train.py selfplay --suits 4 --out runs/s4 [--init runs/s4/imitate.pt]
    python az/train.py eval --suits 4 --ckpt runs/s4/latest.pt --first 1 --count 200
"""

import argparse
import json
import os
import random
import struct
import subprocess
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AZPLAY = os.environ.get("AZPLAY", os.path.join(ROOT, "target", "release", "azplay"))
NUM_COLS = 10
C = 20
G = 29
POS = NUM_COLS * C + G

# Column fields (see `features` in src/az.rs): ranks (rank+1, 0 for none)
# and suits (suit+1) are embedded; the rest are counts and flags, divided
# down to about unit size.
RANK_FIELDS = [3, 6, 8, 18]
SUIT_FIELDS = [4, 7, 9]
NUM_FIELDS = [i for i in range(C) if i not in RANK_FIELDS + SUIT_FIELDS]
NUM_SCALE = np.array([{1: 5, 2: 13, 10: 13, 11: 13, 12: 4, 13: 8, 14: 8, 15: 8, 16: 13}.get(i, 1) for i in NUM_FIELDS], np.float32)
GLOB_SCALE = np.ones(G, np.float32)
for i, s in {6: 8, 7: 4, 8: 44, 9: 104, 12: 10, **{i: 8 for i in range(16, 29)}}.items():
    GLOB_SCALE[i] = s


class Net(nn.Module):
    """A transformer over a global token and the ten column tokens (no
    positional encoding: column order does not matter)."""

    def __init__(self, d=128, layers=3, heads=4):
        super().__init__()
        self.cfg = dict(d=d, layers=layers, heads=heads)
        self.col_in = nn.Linear(len(NUM_FIELDS), d)
        self.rank_emb = nn.ModuleList(nn.Embedding(14, d) for _ in RANK_FIELDS)
        self.suit_emb = nn.ModuleList(nn.Embedding(5, d) for _ in SUIT_FIELDS)
        self.glob_in = nn.Linear(G, d)
        layer = nn.TransformerEncoderLayer(d, heads, 2 * d, dropout=0.0, batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.v = nn.Sequential(nn.Linear(d, d), nn.ReLU(), nn.Linear(d, 1))
        self.p = nn.Sequential(nn.Linear(d, d), nn.ReLU(), nn.Linear(d, 1))
        self.register_buffer("num_scale", torch.from_numpy(1.0 / NUM_SCALE))
        self.register_buffer("glob_scale", torch.from_numpy(1.0 / GLOB_SCALE))
        self.register_buffer("num_idx", torch.tensor(NUM_FIELDS))

    def forward(self, x):
        """x: uint8 (B, POS). Returns value logits and policy logits (B,)."""
        b = x.shape[0]
        cols = x[:, : NUM_COLS * C].view(b, NUM_COLS, C)
        tok = self.col_in(cols[:, :, self.num_idx].float() * self.num_scale)
        for emb, f in zip(self.rank_emb, RANK_FIELDS):
            tok = tok + emb(cols[:, :, f].long())
        for emb, f in zip(self.suit_emb, SUIT_FIELDS):
            tok = tok + emb(cols[:, :, f].long())
        glob = x[:, NUM_COLS * C :].float() * self.glob_scale
        t = torch.cat([self.glob_in(glob)[:, None], tok], 1)
        h = self.norm(self.enc(t)[:, 0])
        return self.v(h).squeeze(1), self.p(h).squeeze(1)


def save(net, opt, path, extra):
    tmp = path + ".tmp"
    torch.save({"cfg": net.cfg, "model": net.state_dict(), "opt": opt.state_dict() if opt else None, **extra}, tmp)
    os.replace(tmp, path)


def load(path, dev):
    ck = torch.load(path, map_location=dev, weights_only=False)
    net = Net(**ck["cfg"]).to(dev)
    net.load_state_dict(ck["model"])
    return net, ck


class Buffer:
    """Replay buffer of decision records: features (position + afterstates),
    visit distribution, outcome."""

    def __init__(self, cap):
        self.cap = cap
        self.recs = []
        self.at = 0
        self.added = 0

    def add(self, feats, pi, z, h, played, h_next, q, q_next):
        r = (feats, pi, z, h, played, h_next, q, q_next)
        if len(self.recs) < self.cap:
            self.recs.append(r)
        else:
            self.recs[self.at] = r
            self.at = (self.at + 1) % self.cap
        self.added += 1

    def __len__(self):
        return len(self.recs)

    def batch(self, n, dev):
        rs = random.sample(self.recs, min(n, len(self.recs)))
        ks = [len(r[1]) for r in rs]
        x = torch.from_numpy(np.concatenate([r[0] for r in rs]).reshape(-1, POS)).to(dev, non_blocking=True)
        kmax = max(ks)
        pi = np.zeros((len(rs), kmax), np.float32)
        mask = np.zeros((len(rs), kmax), bool)
        for i, r in enumerate(rs):
            pi[i, : ks[i]] = r[1]
            mask[i, : ks[i]] = True
        z = torch.tensor([r[2] for r in rs], device=dev)
        h = torch.tensor([r[3] for r in rs], device=dev)
        played = torch.tensor([r[4] for r in rs], device=dev)
        h_next = torch.tensor([r[5] for r in rs], device=dev)
        q = torch.tensor([r[6] for r in rs], device=dev)
        q_next = torch.tensor([r[7] for r in rs], device=dev)
        starts = np.cumsum([0] + [k + 1 for k in ks[:-1]])
        return x, torch.from_numpy(pi).to(dev), torch.from_numpy(mask).to(dev), z, h, played, h_next, q, q_next, torch.from_numpy(starts).to(dev), ks

    def calibrate(self):
        """Least-squares fit z ~ a h + b over the buffer (nothing to fit
        where the records have no lookahead value)."""
        h = np.array([r[3] for r in self.recs], np.float64)
        z = np.array([r[2] for r in self.recs], np.float64)
        if np.isnan(h).any():
            return 0.0, 0.0, 0.0
        a, b = np.polyfit(h, z, 1)
        r = np.corrcoef(h, z)[0, 1]
        return float(a), float(b), float(r)


def train_step(net, opt, buf, batch, dev, calib, lam, vw=1.0):
    """One step. The value target blends the outcome z with the search's
    value q of the position, or where there was no search, the calibrated
    lookahead value of the line player: lam * z + (1 - lam) * (a h + b)."""
    net.train()
    x, pi, mask, z0, h, played, h_next, q, q_next, starts, ks = buf.batch(batch, dev)
    a, b = calib

    def boot(q, h):
        est = torch.where(torch.isnan(q), (a * torch.nan_to_num(h) + b).clamp(0, 1), torch.nan_to_num(q))
        return torch.where(torch.isnan(q) & torch.isnan(h), z0, lam * z0 + (1 - lam) * est)

    z = boot(q, h)
    # The played move's afterstate: the next position's value (or just the
    # outcome after the last decision).
    zn = boot(q_next, h_next)
    with torch.autocast("cuda", dtype=torch.bfloat16):
        v, p = net(x)
    v = v.float()
    p = p.float()
    vloss = F.binary_cross_entropy_with_logits(v[starts], z)
    # Policy logits of every record's afterstates, padded.
    kmax = pi.shape[1]
    idx = starts[:, None] + 1 + torch.arange(kmax, device=dev)[None]
    idx = torch.where(mask, idx, torch.zeros_like(idx))
    logits = torch.where(mask, p[idx], torch.full_like(pi, -1e9))
    logp = F.log_softmax(logits, 1)
    ploss = -(pi * torch.where(mask, logp, torch.zeros_like(logp))).sum(1).mean()
    # The search values positions that revealing moves lead to (new cards
    # unknown) with the same head, so the played move's afterstate is a
    # value example too.
    aloss = F.binary_cross_entropy_with_logits(v[starts + 1 + played], zn)
    vloss = 0.5 * (vloss + aloss)
    ent = -(pi * torch.where(pi > 0, pi.clamp_min(1e-12).log(), torch.zeros_like(pi))).sum(1).mean()
    loss = vw * vloss + ploss
    opt.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
    opt.step()
    return vloss.item(), ploss.item() - ent.item()


class Azplay:
    """An azplay process and its message stream."""

    def __init__(self, mode, suits, first, count, env):
        e = dict(os.environ)
        e.update({k: str(v) for k, v in env.items()})
        self.p = subprocess.Popen([AZPLAY, mode, str(suits), str(first), str(count)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=e)
        self.out = self.p.stdout
        self.inp = self.p.stdin

    def read(self, n):
        b = self.out.read(n)
        if len(b) != n:
            raise EOFError("azplay ended")
        return b

    def messages(self):
        while True:
            t = self.read(1)
            if t == b"E":
                (n,) = struct.unpack("<I", self.read(4))
                yield "E", np.frombuffer(bytearray(self.read(n * POS)), np.uint8).reshape(n, POS)
            elif t == b"R":
                k, z, h, played, h_next, q, q_next = struct.unpack("<IffIfff", self.read(28))
                feats = np.frombuffer(bytearray(self.read((k + 1) * POS)), np.uint8)
                pi = np.frombuffer(self.read(4 * k), np.float32)
                yield "R", (feats, pi, z, h, played, h_next, q, q_next)
            elif t == b"G":
                seed, completed, won, decisions, overrides = struct.unpack("<QBBII", self.read(18))
                yield "G", (seed, completed, won, decisions, overrides)
            elif t == b"Q":
                return
            else:
                raise ValueError(f"bad message {t!r}")

    def answer(self, v, p):
        out = np.stack([v, p], 1).astype("<f4")
        self.inp.write(out.tobytes())
        self.inp.flush()

    def close(self):
        try:
            self.inp.close()
        except Exception:
            pass
        self.p.wait()


@torch.no_grad()
def evaluate(net, x, dev, chunk=32768):
    net.eval()
    vs, ps = [], []
    for i in range(0, len(x), chunk):
        t = torch.from_numpy(x[i : i + chunk]).to(dev, non_blocking=True)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            v, p = net(t)
        vs.append(v.float().cpu().numpy())
        ps.append(p.float().cpu().numpy())
    return np.concatenate(vs), np.concatenate(ps)


class Stream(Azplay):
    """The messages of an azplay run kept in a file (`azplay imitate ... > file`)."""

    def __init__(self, path):
        self.out = open(path, "rb", buffering=1 << 22)

    def close(self):
        self.out.close()


@torch.no_grad()
def validate(net, buf, dev, n=20000):
    """On records held out: the value's log loss against the outcome (and
    what a constant would get), how often the policy's first move is the
    one played, and the mean outcome by tenths of the value."""
    net.eval()
    recs = buf.recs[:n]
    vs, zs, hit = [], [], 0
    for i in range(0, len(recs), 512):
        rs = recs[i : i + 512]
        x = torch.from_numpy(np.concatenate([r[0] for r in rs]).reshape(-1, POS)).to(dev)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            v, p = net(x)
        v, p = torch.sigmoid(v.float()).cpu().numpy(), p.float().cpu().numpy()
        at = 0
        for r in rs:
            k = len(r[1])
            vs.append(v[at])
            zs.append(r[2])
            hit += int(np.argmax(p[at + 1 : at + 1 + k]) == r[4])
            at += k + 1
    vs, zs = np.clip(np.array(vs, np.float64), 1e-6, 1 - 1e-6), np.array(zs, np.float64)
    ll = lambda q: float(-(zs * np.log(q) + (1 - zs) * np.log(1 - q)).mean())
    bins = [[round(float(zs[(vs >= a / 10) & (vs < (a + 1) / 10)].mean()), 3), int(((vs >= a / 10) & (vs < (a + 1) / 10)).sum())] for a in range(10) if ((vs >= a / 10) & (vs < (a + 1) / 10)).any()]
    return dict(n=len(recs), vloss=round(ll(vs), 4), vloss_const=round(ll(np.full_like(zs, zs.mean())), 4), corr=round(float(np.corrcoef(vs, zs)[0, 1]), 3), top1=round(hit / len(recs), 4), calib=bins)


class Log:
    def __init__(self, path):
        self.f = open(path, "a")

    def __call__(self, **kw):
        kw["time"] = round(time.time(), 1)
        line = json.dumps(kw)
        print(line, flush=True)
        self.f.write(line + "\n")
        self.f.flush()


def az_env(a):
    return {
        "AZ_SIMS": a.sims,
        "AZ_CONCURRENT": a.concurrent,
        "AZ_CPUCT": a.cpuct,
        "AZ_MAX_MOVES": a.max_moves,
        "AZ_MAX_DEPTH": a.max_depth,
        "AZ_TEMP_MOVES": a.temp_moves,
        "AZ_SEED": a.seed,
        "AZ_MAX_LINES": a.max_lines,
        "AZ_DEAL_SAMPLES": a.deal_samples,
    }


def cmd_imitate(a, dev):
    os.makedirs(a.out, exist_ok=True)
    log = Log(os.path.join(a.out, "log.jsonl"))
    if a.init:
        net, _ = load(a.init, dev)
    else:
        net = Net(a.d, a.layers, a.heads).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    buf, val = Buffer(10**9), Buffer(10**9)
    games, suits_done, wins, missed, decisions = 0, 0, 0, 0, 0
    # Games of the line player: played now, or kept in files by `azplay
    # imitate ... > file`. One game in fifty is held out.
    procs = [Stream(f) for f in a.data] if a.data else [Azplay("imitate", a.suits, a.first, a.games, az_env(a))]
    for proc in procs:
        recs = []
        for kind, m in proc.messages():
            if kind == "R":
                recs.append(m)
            elif kind == "G":
                for r in recs:
                    (val if m[0] % 50 == 0 else buf).add(*r)
                recs = []
                games += 1
                suits_done += m[1]
                wins += m[2]
                decisions += m[3]
                missed += m[4]
        proc.close()
    a_, b_, r_ = buf.calibrate()
    calib = (a_, b_)
    log(phase="imitate-data", games=games, records=len(buf), held_out=len(val), decisions=decisions, missed=missed, suits=suits_done / max(games, 1), wins=wins / max(games, 1), calib=[round(a_, 4), round(b_, 4)], corr=round(r_, 3))
    steps = int(a.epochs * len(buf)) // a.batch
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=steps)
    t0 = time.time()
    vl = pl = 0.0
    for s in range(1, steps + 1):
        v, p = train_step(net, opt, buf, a.batch, dev, calib, a.lam)
        sched.step()
        vl, pl = 0.98 * vl + 0.02 * v, 0.98 * pl + 0.02 * p
        if s % 500 == 0 or s == steps:
            log(phase="imitate", step=s, of=steps, vloss=round(vl, 4), pkl=round(pl, 4), secs=round(time.time() - t0))
        if (s % 5000 == 0 or s == steps) and len(val):
            log(phase="held-out", step=s, **validate(net, val, dev))
    save(net, opt, os.path.join(a.out, "imitate.pt"), {"suits": a.suits, "calib": calib})
    save(net, opt, os.path.join(a.out, "latest.pt"), {"suits": a.suits, "games": 0, "calib": calib})


def cmd_selfplay(a, dev):
    os.makedirs(a.out, exist_ok=True)
    log = Log(os.path.join(a.out, "log.jsonl"))
    latest = os.path.join(a.out, "latest.pt")
    init = a.init or (latest if os.path.exists(latest) else None)
    if init:
        net, ck = load(init, dev)
        games_total = ck.get("games", 0)
    else:
        net, ck, games_total = Net(a.d, a.layers, a.heads).to(dev), {}, 0
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    if ck.get("opt") and not a.init:
        opt.load_state_dict(ck["opt"])
        for g in opt.param_groups:
            g["lr"] = a.lr
    calib = tuple(ck.get("calib", (0.0, 0.0)))
    lam = a.lam if "calib" in ck else 1.0
    buf = Buffer(a.buffer)
    if a.prefill:
        # Games of the line player to begin with (kept in a file by `azplay
        # imitate`), which the games played here push out as they come.
        st = Stream(a.prefill)
        for kind, m in st.messages():
            if kind == "R":
                buf.add(*m)
                if len(buf) >= a.prefill_n:
                    break
        st.close()
        buf.trained_at = buf.added
    first = a.first + games_total
    proc = Azplay("selfplay", a.suits, first, 10**9, az_env(a))
    since, it = 0, 0
    stats = []
    t0 = time.time()
    evals = 0
    for kind, m in proc.messages():
        if kind == "E":
            v, p = evaluate(net, m, dev)
            evals += len(m)
            proc.answer(v, p)
        elif kind == "R":
            buf.add(*m)
        elif kind == "G":
            games_total += 1
            since += 1
            stats.append(m)
            if since >= a.games_per_iter and len(buf) >= a.min_buffer:
                it += 1
                n_steps = max(1, int(a.reuse * (buf.added - getattr(buf, "trained_at", 0)) / a.batch))
                buf.trained_at = buf.added
                vl = pl = 0.0
                ts = time.time()
                for _ in range(n_steps):
                    v_, p_ = train_step(net, opt, buf, a.batch, dev, calib, lam)
                    vl += v_ / n_steps
                    pl += p_ / n_steps
                comp = [s[1] for s in stats]
                log(
                    phase="selfplay",
                    iter=it,
                    games=games_total,
                    suits=round(float(np.mean(comp)), 3),
                    wins=round(float(np.mean([s[2] for s in stats])), 4),
                    decisions=round(float(np.mean([s[3] for s in stats])), 1),
                    overrides=round(float(np.mean([s[4] for s in stats])), 2),
                    buffer=len(buf),
                    steps=n_steps,
                    vloss=round(vl, 4),
                    pkl=round(pl, 4),
                    evals_per_s=round(evals / (time.time() - t0)),
                    train_secs=round(time.time() - ts, 1),
                )
                save(net, opt, latest, {"suits": a.suits, "games": games_total, "calib": calib})
                if it % a.keep_every == 0:
                    save(net, None, os.path.join(a.out, f"iter{it:04d}.pt"), {"suits": a.suits, "games": games_total, "calib": calib})
                since, stats, evals, t0 = 0, [], 0, time.time()
            if a.max_games and games_total >= a.max_games:
                break
    proc.close()


def cmd_eval(a, dev):
    net, ck = load(a.ckpt, dev)
    env = az_env(a)
    proc = Azplay("eval", a.suits, a.first, a.count, env)
    res = []
    t0 = time.time()
    for kind, m in proc.messages():
        if kind == "E":
            proc.answer(*evaluate(net, m, dev))
        elif kind == "G":
            res.append(m)
    proc.close()
    if a.results:
        with open(a.results, "w") as f:
            for seed, completed, won, decisions, overrides in sorted(res):
                f.write(f"seed {seed:>5}: {'WIN' if won else 'loss'} suits {completed} decisions {decisions} overrides {overrides}\n")
    comp = [r[1] for r in res]
    print(
        json.dumps(
            dict(
                ckpt=a.ckpt,
                suits=a.suits,
                sims=a.sims,
                games=len(res),
                wins=sum(r[2] for r in res),
                win_rate=round(float(np.mean([r[2] for r in res])), 4),
                completed=round(float(np.mean(comp)), 3),
                overrides=round(float(np.mean([r[4] for r in res])), 2),
                secs_per_game=round((time.time() - t0) / max(len(res), 1), 2),
            )
        ),
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["imitate", "selfplay", "eval"])
    ap.add_argument("--suits", type=int, default=4)
    ap.add_argument("--out", default="runs/s4")
    ap.add_argument("--init")
    ap.add_argument("--ckpt")
    ap.add_argument("--data", nargs="*", help="imitate: files of `azplay imitate` output instead of playing")
    ap.add_argument("--prefill", help="selfplay: a file of `azplay imitate` output to fill the buffer from first")
    ap.add_argument("--prefill-n", type=int, default=500_000)
    ap.add_argument("--results", help="eval: write every seed's result here")
    ap.add_argument("--first", type=int, default=1_000_001)
    ap.add_argument("--count", type=int, default=200)
    ap.add_argument("--games", type=int, default=2000)
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--d", type=int, default=128)
    ap.add_argument("--layers", type=int, default=3)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--lam", type=float, default=0.3, help="weight of the outcome in the value target (the rest: calibrated lookahead value)")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--buffer", type=int, default=100_000)
    ap.add_argument("--min-buffer", type=int, default=5_000)
    ap.add_argument("--games-per-iter", type=int, default=64)
    ap.add_argument("--reuse", type=float, default=4.0, help="times each record is trained on, on average")
    ap.add_argument("--keep-every", type=int, default=20)
    ap.add_argument("--max-games", type=int, default=0)
    ap.add_argument("--sims", type=int, default=64)
    ap.add_argument("--concurrent", type=int, default=256)
    ap.add_argument("--cpuct", type=float, default=1.5)
    ap.add_argument("--max-moves", type=int, default=400)
    ap.add_argument("--max-depth", type=int, default=30)
    ap.add_argument("--temp-moves", type=int, default=15)
    ap.add_argument("--max-lines", type=int, default=24)
    ap.add_argument("--deal-samples", type=int, default=6)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    dev = torch.device("cuda")
    torch.backends.cuda.matmul.allow_tf32 = True
    {"imitate": cmd_imitate, "selfplay": cmd_selfplay, "eval": cmd_eval}[a.cmd](a, dev)


if __name__ == "__main__":
    main()
