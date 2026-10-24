"""Coordinate search on whole games' wins over the line player's weights,
optionally for one stage only (the play with so many deals left).

    python stage/coord.py --suits 2 --stage 0 --base SPIDER_L_ROLLOUT=1 --first 300001 --count 8000

Each weight in turn is tried up and down by a step (a third of its value,
at least 2); a change is kept if it wins more of the tuning seeds than the
best so far by --margin standard errors of the paired difference. Prints
every trial and at the end the overrides found, as environment settings.
"""

import argparse
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINES = os.path.join(ROOT, "target", "release", "lines")
WEIGHTS = ["HIDDEN", "EMPTY", "END_EMPTY", "DEAL_EMPTY", "SAME", "OFF", "OFF_RANK", "KING", "RANKS", "RUN_SQ", "WRONG", "CLEAR", "HIDDEN_SQ", "DIG", "TURNABLE"]


def play(a, over):
    env = dict(os.environ)
    for kv in a.base:
        k, v = kv.split("=")
        env[k] = v
    for k, v in over.items():
        env[k] = str(v)
    out = subprocess.run([LINES, str(a.suits), str(a.first), str(a.count)], env=env, capture_output=True, text=True).stdout
    return [line.split()[2] == "WIN" for line in out.splitlines() if line.startswith("seed")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suits", type=int, required=True)
    ap.add_argument("--stage", type=int, default=-1, help="deals left of the stage tuned (-1: all)")
    ap.add_argument("--base", nargs="*", default=[], help="environment settings of the player tuned")
    ap.add_argument("--start", nargs="*", default=[], help="NAME=value: the weights' values to start from (all must be given once, see lines.rs)")
    ap.add_argument("--first", type=int, default=300001)
    ap.add_argument("--count", type=int, default=8000)
    ap.add_argument("--passes", type=int, default=2)
    ap.add_argument("--margin", type=float, default=1.0)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    prefix = f"SPIDER_L_K{a.stage}_" if a.stage >= 0 else "SPIDER_L_"
    cur = {kv.split("=")[0]: int(kv.split("=")[1]) for kv in a.start}
    names = [w for w in (a.only or WEIGHTS) if w in cur]
    over = {}
    best = play(a, over)
    print(f"start: {sum(best)}/{len(best)}", flush=True)
    for p in range(a.passes):
        changed = False
        for w in names:
            step = max(2, abs(cur[w]) // 3)
            for v in (cur[w] + step, cur[w] - step):
                trial = dict(over)
                trial[prefix + w] = v
                r = play(a, trial)
                d = [int(x) - int(y) for x, y in zip(r, best)]
                n = len(d)
                mean = sum(d) / n
                se = (sum((x - mean) ** 2 for x in d) / n / n) ** 0.5
                keep = mean > a.margin * se and mean > 0
                print(f"pass {p} {w} {cur[w]} -> {v}: {sum(r)}/{n} ({100 * mean:+.2f} +- {100 * se:.2f}){' kept' if keep else ''}", flush=True)
                if keep:
                    over, best, cur[w], changed = trial, r, v, True
                    break
        if not changed:
            break
    print("result:", sum(best), "/", len(best), " ".join(f"{k}={v}" for k, v in over.items()), flush=True)


if __name__ == "__main__":
    main()
