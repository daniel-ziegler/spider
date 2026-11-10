"""What choosing between lines by games played out could gain the line player,
from the records of `strong`'s study (web/wasm/src/bin/strong.rs, S_STUDY: the
line player's games, with every choice on the way played in the same 512
worlds):

    python study.py HOLD FILE [FILE...]

A rule picks a line at each choice from the first HOLD worlds (as the
stronger player would: strong.rs's `choose`), and what it gains is the
picked line's worth less the line player's own in the other worlds, which the
rule did not see, summed over a game's choices: by how much the chance of
winning grows if every choice is made so, to first order. Prints for each
rule the gain in points of win rate a game (with its standard error over
the games), the share of choices changed and the games played on a game.
"""
import struct
import sys

import numpy as np

HOLD = int(sys.argv[1])  # the worlds from here on are for measuring only


def read(names):
    games = {}
    for name in names:
        buf = open(name, 'rb').read()
        at = 0
        while at < len(buf):
            seed, turn, deals, hidden, n = struct.unpack_from('<IHBBB', buf, at)
            at += 9
            cands = []
            for _ in range(n):
                kind, deal, k = struct.unpack_from('<BBH', buf, at)
                at += 4
                cands.append((kind, deal, np.frombuffer(buf, '<u2', k, at) / 65535.0))
                at += 2 * k
            games.setdefault(seed, []).append((turn, deals, hidden, cands))
    return games


def choose(vals, first, most, z_drop, z_keep, lam):
    """strong.rs's choose over the worlds before HOLD: the pick and the games played."""
    alive = list(range(len(vals)))
    done, upto, rolls = 0, min(first, most), 0
    while True:
        rolls += len(alive) * (upto - done)
        done = upto
        means = [vals[c][:done].mean() for c in alive]
        best = alive[int(np.argmax(means))]
        keep = []
        for c in alive:
            if c != best:
                d = vals[best][:done] - vals[c][:done]
                se = d.std(ddof=1) / np.sqrt(done)
                if se == 0 or d.mean() > z_drop * se:
                    continue
            keep.append(c)
        alive = keep
        if len(alive) == 1 or done >= most:
            break
        upto = min(2 * done, most)
    if best != 0 and 0 in alive:
        d = vals[best][:done] - vals[0][:done]
        se = d.std(ddof=1) / np.sqrt(done)
        # (lam: the line player's own unless ahead by lam * se^2 points, se in points)
        if d.mean() < z_keep * se or 100 * d.mean() < lam * (100 * se) ** 2:
            best = 0
    return best, rolls


def main():
    games = read(sys.argv[2:])
    n_choices = sum(len(g) for g in games.values())
    print(f'{len(games)} games, {n_choices} choices of more than one line, {n_choices / len(games):.1f} a game')
    # What there is to gain at all: each line's worth against the line player's, by kind.
    by_kind = {}
    for g in games.values():
        for turn, deals, hidden, cands in g:
            base = cands[0][2]
            for kind, deal, v in cands[1:]:
                d = v - base[:len(v)]
                by_kind.setdefault(min(kind, 6), []).append((d.mean(), d.std(ddof=1) / np.sqrt(len(v)), len(v)))
    for kind in sorted(by_kind):
        a = np.array(by_kind[kind])
        full = a[a[:, 2] > HOLD]
        # The spread of the true differences: that of the means less the noise's.
        true_var = max(0.0, full[:, 0].var() - (full[:, 1] ** 2).mean()) if len(full) > 1 else 0
        print(f'kind {kind}{"+" if kind == 6 else ""}: {len(a)} lines, mean {100 * a[:, 0].mean():+.2f}, played in every world {len(full)} (mean {100 * full[:, 0].mean():+.2f}, se {100 * full[:, 1].mean():.2f}, true sd about {100 * np.sqrt(true_var):.2f})')

    rules = []
    for kinds in (2, 4, 6, 12):
        for first, most in ((16, 32), (16, 64), (32, 128), (64, 256), (256, 256)):
            if most > HOLD:
                continue
            for z_keep, lam in ((0, 0), (1, 0), (2, 0), (3, 0), (0, 0.3), (0, 0.7), (0, 1.5)):
                rules.append((kinds, first, most, 2.0, z_keep, lam))
    print('lines first most zdrop zkeep lam: gain a game ± se, changed, games played on a game')
    out = []
    for kinds, first, most, z_drop, z_keep, lam in rules:
        gains, changed, rolls = [], 0, 0
        stage = np.zeros((6, 3))  # by the deals left: choices, changed, gain
        for g in games.values():
            total = 0.0
            for turn, deals, hidden, cands in g:
                stage[deals, 0] += 1
                before = (changed, total)
                use = [c for c in cands if c[0] < kinds]
                if len(use) < 2:
                    continue
                # (A line dropped early in the study is far behind: never picked.)
                vals = [c[2][:HOLD] if len(c[2]) > HOLD else np.concatenate([c[2], np.full(HOLD - len(c[2]), -1.0)]) for c in use]
                pick, r = choose(vals, first, most, z_drop, z_keep, lam)
                rolls += r
                if pick != 0:
                    changed += 1
                    v = use[pick][2]
                    if len(v) > HOLD:
                        total += (v[HOLD:] - use[0][2][HOLD:]).mean()
                    else:
                        total += (v - use[0][2][:len(v)]).mean()
                stage[deals, 1] += changed - before[0]
                stage[deals, 2] += total - before[1]
            gains.append(total)
        gains = np.array(gains)
        out.append((gains.mean(), f'{kinds:2d} {first:3d} {most:3d} {z_drop} {z_keep} {lam}: {100 * gains.mean():+.2f} ± {100 * gains.std(ddof=1) / np.sqrt(len(gains)):.2f}, {changed / len(games):.1f} changed, {rolls / len(games):.0f} games; by deals left 5..0: ' + ' '.join(f'{100 * stage[d, 2] / len(games):+.1f}' for d in range(5, -1, -1))))
    for _, line in out:
        print(line)


main()
