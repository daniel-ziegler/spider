"""Coordinate search over SPIDER_L_ weights for one stage, on the fitted
value where the player is about to deal (see ev.py). Usage:
tune.py K LIMIT [NAME=VALUE ...] -- NAME:STEP ...
starting from the given values. A step is taken when it gains more than
TUNE_Z (2) standard errors, paired."""
import hashlib, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ev

Z = float(os.environ.get("TUNE_Z", "2"))
CACHE = ev.HERE + "/cache"
os.makedirs(CACHE, exist_ok=True)


def values(k, limit, over):
    key = hashlib.md5(repr((os.path.basename(os.path.realpath(ev.REF)), k, limit, sorted(over.items()))).encode()).hexdigest()[:16]
    rows = ev.run(k, limit, [f"{n}={v}" for n, v in over.items()], cache=f"{CACHE}/{key}.csv")
    return rows


def diff(a, b, limit):
    keys = [x for x in a if x in b]
    d = np.array([a[x][0] - b[x][0] for x in keys])
    return d.sum() / limit, d.std() * np.sqrt(len(d)) / limit


if __name__ == "__main__":
    k, limit = sys.argv[1], int(sys.argv[2])
    sep = sys.argv.index("--")
    cur = dict(kv.split("=") for kv in sys.argv[3:sep])
    cur = {n: int(v) for n, v in cur.items()}
    steps = {s.split(":")[0]: int(s.split(":")[1]) for s in sys.argv[sep + 1:]}
    defaults = dict(HIDDEN=71, EMPTY=103, DEAL_EMPTY=-72, END_EMPTY=39, SAME=0, OFF=-10, OFF_RANK=3, KING=0, RANKS=9, RUN_SQ=7, WRONG=-3, CLEAR=16, HIDDEN_SQ=-4, DIG=0, TURNABLE=0, COMPLETED=1000)
    ref = values(k, limit, {})
    best = values(k, limit, cur)
    m, se = diff(best, ref, limit)
    print(f"start {cur}: {m * 100:+.3f}% +-{se * 100:.3f} against the reference", flush=True)
    improved = True
    while improved:
        improved = False
        for name, step in steps.items():
            at = cur.get(name, defaults[name])
            for sign in (1, -1):
                moved = False
                while True:
                    trial = dict(cur)
                    trial[name] = at + sign * step
                    v = values(k, limit, trial)
                    m, se = diff(v, best, limit)
                    mr, _ = diff(v, ref, limit)
                    ok = m > Z * se
                    print(f"  {name}={trial[name]}: {m * 100:+.3f}% +-{se * 100:.3f} (ref {mr * 100:+.3f}%) {'TAKEN' if ok else ''}", flush=True)
                    if not ok:
                        break
                    cur, best, at, moved, improved = trial, v, trial[name], True, True
                if moved:
                    break
        print(f"now {cur}", flush=True)
