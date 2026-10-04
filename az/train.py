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
G = 16
POS = NUM_COLS * C + G

# Column fields (see `features` in src/az.rs): ranks (rank+1, 0 for none)
# and suits (suit+1) are embedded; the rest are counts and flags, divided
# down to about unit size.
RANK_FIELDS = [3, 6, 8, 18]
SUIT_FIELDS = [4, 7, 9]
NUM_FIELDS = [i for i in range(C) if i not in RANK_FIELDS + SUIT_FIELDS]
NUM_SCALE = np.array([{1: 5, 2: 13, 10: 13, 11: 13, 12: 4, 13: 8, 14: 8, 15: 8, 16: 13}.get(i, 1) for i in NUM_FIELDS], np.float32)
GLOB_SCALE = np.ones(G, np.float32)
for i, s in {6: 8, 7: 4, 8: 44, 9: 104, 12: 10}.items():
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
        """Least-squares fit z ~ a h + b over the buffer."""
        h = np.array([r[3] for r in self.recs], np.float64)
        z = np.array([r[2] for r in self.recs], np.float64)
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
                seed, completed, won, decisions = struct.unpack("<QBBI", self.read(14))
                yield "G", (seed, completed, won, decisions)
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
    net = Net(a.d, a.layers, a.heads).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    buf = Buffer(10**9)
    games, suits_done, wins = 0, 0, 0
    proc = Azplay("imitate", a.suits, a.first, a.games, az_env(a))
    for kind, m in proc.messages():
        if kind == "R":
            buf.add(*m)
        elif kind == "G":
            games += 1
            suits_done += m[1]
            wins += m[2]
    proc.close()
    a_, b_, r_ = buf.calibrate()
    calib = (a_, b_)
    log(phase="imitate-data", games=games, records=len(buf), suits=suits_done / max(games, 1), wins=wins / max(games, 1), calib=[round(a_, 4), round(b_, 4)], corr=round(r_, 3))
    steps = a.epochs * len(buf) // a.batch
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=steps)
    t0 = time.time()
    vl = pl = 0.0
    for s in range(1, steps + 1):
        v, p = train_step(net, opt, buf, a.batch, dev, calib, a.lam)
        sched.step()
        vl, pl = 0.98 * vl + 0.02 * v, 0.98 * pl + 0.02 * p
        if s % 200 == 0 or s == steps:
            log(phase="imitate", step=s, of=steps, vloss=round(vl, 4), pkl=round(pl, 4), secs=round(time.time() - t0))
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
    ap.add_argument("--first", type=int, default=1_000_001)
    ap.add_argument("--count", type=int, default=200)
    ap.add_argument("--games", type=int, default=2000)
    ap.add_argument("--epochs", type=int, default=3)
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
