# What a player's own games show of what a deal asked and what was missed, won
# against lost: python3 games.py DIR  (DIR/ps/stretches.jsonl from step 1 of the
# playstyle analysis, DIR/outcomes.json). A clean turn is a card turned without
# ending with fewer empty columns; `long` ones need a line of 4 moves or more.
# These are of the game as played, so they are not measures of the deal: a game
# that goes badly has other positions. Writes DIR/games.json.
import json, sys, collections, math
import numpy as np
D = sys.argv[1].rstrip('/') + '/'
out = {(r['user'], r['suits'], r['seed']): r for r in json.load(open(D + 'outcomes.json'))}
per = collections.defaultdict(list)
for l in open(D + 'ps/stretches.jsonl'):
    r = json.loads(l)
    per[(r['user'], r['suits'], r['seed'])].append(r)
found = lambda r: r['out']['human']['kind'] == 'turn' and r['out']['human']['empties'] >= 0
res = {}
print('found rate of a clean turn by the moves it needs (decisions not set aside):')
for u in ('dmz', 'amanda'):
    for s in (3, 4):
        rs = [r for k, v in per.items() if k[:2] == (u, s) for r in v if not r['cont'] and r['opp'].get('flip')]
        row = {}
        for name, lo, hi in (('1', 1, 1), ('2', 2, 2), ('3', 3, 3), ('4-5', 4, 5), ('6+', 6, 99)):
            x = [found(r) for r in rs if lo <= r['opp']['flip']['L'] <= hi]
            row[name] = (sum(x), len(x))
        res[f'found {u} {s}'] = row
        print(f'  {u} {s} suits:', '  '.join(f'{k}: {a}/{n} = {100 * a / max(n, 1):.0f}%' for k, (a, n) in row.items()))
print('\nper game, by result (means; early = before the second deal):')
for u in ('dmz', 'amanda'):
    for s in (3, 4):
        for want in ('won', 'lost'):
            gs = [(k, v) for k, v in per.items() if k[:2] == (u, s) and out.get(k, {}).get('res') == want]
            if not gs: continue
            def mean(f): return float(np.mean([f(v) for _, v in gs]))
            flip = lambda r: r['opp'].get('flip')
            row = dict(
                games=len(gs),
                decisions=mean(len),
                longNeeded=mean(lambda v: sum(1 for r in v if flip(r) and flip(r)['L'] >= 4)),
                longMissed=mean(lambda v: sum(1 for r in v if flip(r) and flip(r)['L'] >= 4 and not found(r))),
                shortMissed=mean(lambda v: sum(1 for r in v if flip(r) and flip(r)['L'] < 4 and not found(r))),
                noClean=mean(lambda v: sum(1 for r in v if not flip(r))),
                earlyLongMissed=mean(lambda v: sum(1 for r in v if r['dealsLeft'] >= 4 and flip(r) and flip(r)['L'] >= 4 and not found(r))),
                earlyNoClean=mean(lambda v: sum(1 for r in v if r['dealsLeft'] >= 4 and not flip(r))),
                emptyMissed=mean(lambda v: sum(1 for r in v if r['opp'].get('empty') and r['out']['human']['empties'] <= 0)),
                dealtWithClean=mean(lambda v: sum(1 for r in v if flip(r) and r['out']['human']['kind'] == 'deal')),
            )
            res[f'{u} {s} {want}'] = row
            print(f'  {u} {s} suits {want:4s}', '  '.join(f'{k} {v:.1f}' if k != 'games' else f'{v} games' for k, v in row.items()))
json.dump(res, open(D + 'games.json', 'w'), indent=1)
