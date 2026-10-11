"""Judge a change to the line player stage by stage. Usage:
ev.py K|all LIMIT NAME=VALUE...
K is the number of deals left in the stage played, LIMIT the number of
reference games used; NAME=VALUE sets SPIDER_L_NAME (e.g. HIDDEN=80), and
P_NAME=VALUE sets SPIDER_P_NAME and plays the stage with the rollout player.
Prints, per stage, the mean fitted value where the changed player is about
to deal against the reference player's, from the same positions (in the last
stage, the game's result). Files are in runs/stage (STAGE_DIR): ref.txt from
`stage dump`, v.json and v.txt from fit.py."""
import io, json, os, subprocess, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.environ.get("STAGE_DIR", ROOT + "/runs/stage")
REF = os.environ.get("STAGE_REF", HERE + "/ref.txt")
MODEL = json.load(open(HERE + "/v.json"))
BIN = ROOT + "/target/release/stage"


def run(k, limit, over, cache=None):
    if cache and os.path.exists(cache):
        txt = open(cache).read()
    else:
        env = dict(os.environ)
        mode = "eval"
        env["SPIDER_V_MODEL"] = HERE + "/v.txt"  # for the rollout player
        for kv in over:
            n, v = kv.split("=")
            if n.startswith("P_"):
                env["SPIDER_" + n] = v
                mode = "evalp"
            else:
                env["SPIDER_L_" + n] = v
        txt = subprocess.run([BIN, mode, "4", REF, str(k), str(limit)], env=env, capture_output=True, text=True, check=True).stdout
        if cache:
            open(cache, "w").write(txt)
    rows = {}
    lines = txt.strip().split("\n")
    for l in lines[1:]:
        p = l.split(",")
        seed, kk, status = int(p[0]), int(p[1]), p[2]
        if status == "won":
            v = 1.0
        elif status == "dead" or kk == 0:
            v = 0.0
        else:
            m = MODEL[str(kk)]
            x = (np.array([float(t) for t in p[3:]]) - np.array(m["mu"])) / np.array(m["sd"])
            v = 1 / (1 + np.exp(-(m["w"][0] + x @ np.array(m["w"][1:]))))
        rows[(seed, kk)] = (v, float(p[4]))
    return rows


def compare(k, limit, over, quiet=False):
    base = run(k, limit, [], cache=f"{HERE}/base_{os.path.basename(os.path.realpath(REF))}_{k}_{limit}.csv")
    new = run(k, limit, over)
    total, var, res = 0.0, 0.0, {}
    for kk in [5, 4, 3, 2, 1, 0]:
        keys = [key for key in base if key[1] == kk and key in new]
        if not keys:
            continue
        dv = np.array([new[key][0] - base[key][0] for key in keys])
        dh = np.array([new[key][1] - base[key][1] for key in keys])
        b = np.mean([base[key][0] for key in keys])
        # Weighted by the share of games that reach the stage.
        share = len(keys) / limit
        m, se = dv.mean() * share, dv.std() / np.sqrt(len(dv)) * share
        total += m
        var += se * se
        res[kk] = (m, se)
        if not quiet:
            print(f"  k={kk}: n={len(keys)} base {b:.4f} dV {m * 100:+.3f}% +-{se * 100:.3f}  dhidden {dh.mean():+.3f}")
    if not quiet:
        print(f"  total dV {total * 100:+.3f}% +-{np.sqrt(var) * 100:.3f}")
    return total, np.sqrt(var), res


if __name__ == "__main__":
    k, limit = sys.argv[1], int(sys.argv[2])
    print(" ".join(sys.argv[3:]) or "(reference)")
    compare(k, limit, sys.argv[3:])
