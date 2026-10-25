"""Print the games of an `azplay imitate` output file as `lines` prints them
(for comparing with it), and how many decisions were recorded and missed.
Usage: python az/games.py file..."""
import struct
import sys

POS = 10 * 20 + 29
rec = dec = missed = 0
for path in sys.argv[1:]:
    f = open(path, "rb", buffering=1 << 22)
    while True:
        t = f.read(1)
        if t == b"R":
            (k,) = struct.unpack("<I", f.read(4))
            f.seek(24 + (k + 1) * POS + 4 * k, 1)
            rec += 1
        elif t == b"G":
            seed, completed, won, decisions, miss = struct.unpack("<QBBII", f.read(18))
            dec += decisions
            missed += miss
            print(f"seed {seed:>5}: {'WIN' if won else 'loss'} suits {completed} decisions {decisions}")
        else:
            break
print(f"records {rec} decisions {dec} missed {missed}", file=sys.stderr)
