"""Export the analysis's value network (train.py here) for the web game.

    .venv/bin/python web/tools/analysis/export.py --ckpt runs/analysis2/net.pt --data runs/analysis2/a?.bin

writes web/static/nets/value.bin, which web/static/vnet.js reads: "SPV2",
then d, layers, heads and ff as u32, then every tensor as little-endian
float16 in the order of `tensors` below. With --data it also writes
web/test/vnet.json: positions from the data of each number of suits (as
base64 of their encoding, with what the line player does next there by
src/vnet.rs) with the win probability PyTorch gives each, here
with the weights rounded to float16 as the browser has them, which
web/test/vnet.mjs compares the JavaScript with.
"""
import argparse, base64, json, os, struct, sys

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import ENC, NEXT, SUITS, SuitsNet, read  # noqa: E402


def tensors(cfg):
    names = ["code", "row", "col", "rel_above", "rel_below", "run_above", "run_below", "whole", "deals", "completed", "suits", "next"]
    out = [f"{n}.weight" for n in names]
    for i in range(cfg["layers"]):
        p = f"enc.layers.{i}."
        out += [p + n for n in ["self_attn.in_proj_weight", "self_attn.in_proj_bias", "self_attn.out_proj.weight", "self_attn.out_proj.bias",
                                "linear1.weight", "linear1.bias", "linear2.weight", "linear2.bias",
                                "norm1.weight", "norm1.bias", "norm2.weight", "norm2.bias"]]
    return out + ["norm.weight", "norm.bias", "head.weight", "head.bias"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--data", nargs="*", help="records to take test positions from")
    ap.add_argument("--samples", type=int, default=24, help="for each number of suits")
    a = ap.parse_args()
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    cfg, sd = ck["cfg"], ck["model"]
    out = os.path.join(ROOT, "web", "static", "nets", "value.bin")
    with open(out, "wb") as f:
        f.write(b"SPV2" + struct.pack("<4I", cfg["d"], cfg["layers"], cfg["heads"], cfg["ff"]))
        for name in tensors(cfg):
            f.write(sd[name].numpy().astype("<f2").tobytes())
    print(f"{out}: {os.path.getsize(out)} bytes")
    if not a.data:
        return
    # What the browser computes with: the weights rounded to float16.
    net = SuitsNet(**cfg)
    net.load_state_dict({k: (v.half().float() if k in set(tensors(cfg)) else v) for k, v in sd.items()})
    net.eval()
    out = []
    for path in a.data:
        data, _, va = read([path])
        rec = torch.from_numpy(data[va[np.linspace(0, len(va) - 1, a.samples).astype(np.int64)]])
        with torch.no_grad():
            p = torch.sigmoid(net(rec[:, :ENC], None, rec[:, SUITS], rec[:, NEXT])[0].double()).numpy()
        out += [{"suits": int(rec[i, SUITS]), "next": int(rec[i, NEXT]), "enc": base64.b64encode(bytes(rec[i, :ENC].numpy())).decode(), "p": round(float(p[i]), 6)} for i in range(len(rec))]
    path = os.path.join(ROOT, "web", "test", "vnet.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=0)
    print(f"{path}: {len(out)} positions, p from {min(o['p'] for o in out):.3f} to {max(o['p'] for o in out):.3f}")


if __name__ == "__main__":
    main()
