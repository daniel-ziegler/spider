"""Export a value network (vnet/train.py) for the web game's analysis.

    .venv/bin/python web/tools/analysis/export.py --ckpt runs/analysis/w4.pt --suits 4 --data runs/analysis/d4.bin

writes web/static/nets/v4.bin, which web/static/vnet.js reads: "SPV1", then
d, layers, heads and ff as u32, then every tensor as little-endian float16 in
the order of `tensors` below. With --data it also writes
web/test/vnet-4.json: positions from the data (as base64 of their encoding)
with the win probability PyTorch gives each, here with the weights rounded
to float16 as the browser has them, which web/test/vnet.mjs compares the
JavaScript with.
"""
import argparse, base64, json, os, struct, sys

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "vnet"))
from train import ENC, RECORD, Net  # noqa: E402


def tensors(cfg):
    names = ["code", "row", "col", "rel_above", "rel_below", "run_above", "run_below", "whole", "deals", "completed"]
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
    ap.add_argument("--suits", type=int, required=True)
    ap.add_argument("--data", help="records to take test positions from")
    ap.add_argument("--samples", type=int, default=48)
    a = ap.parse_args()
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=False)
    cfg, sd = ck["cfg"], ck["model"]
    out = os.path.join(ROOT, "web", "static", "nets", f"v{a.suits}.bin")
    with open(out, "wb") as f:
        f.write(b"SPV1" + struct.pack("<4I", cfg["d"], cfg["layers"], cfg["heads"], cfg["ff"]))
        for name in tensors(cfg):
            f.write(sd[name].numpy().astype("<f2").tobytes())
    print(f"{out}: {os.path.getsize(out)} bytes")
    if not a.data:
        return
    # What the browser computes with: the weights rounded to float16.
    net = Net(**cfg)
    net.load_state_dict({k: (v.half().float() if k in set(tensors(cfg)) else v) for k, v in sd.items()})
    net.eval()
    n = os.path.getsize(a.data) // RECORD
    idx = np.linspace(0, n - 1, a.samples).astype(np.int64)
    data = np.memmap(a.data, np.uint8, "r", shape=(n, RECORD))
    x = torch.from_numpy(np.stack([data[i, :ENC] for i in idx]))
    with torch.no_grad():
        p = torch.sigmoid(net(x)[0].double()).numpy()
    path = os.path.join(ROOT, "web", "test", f"vnet-{a.suits}.json")
    with open(path, "w") as f:
        json.dump([{"enc": base64.b64encode(bytes(x[i].numpy())).decode(), "p": round(float(p[i]), 6)} for i in range(len(idx))], f, indent=0)
    print(f"{path}: {len(idx)} positions, p from {p.min():.3f} to {p.max():.3f}")


if __name__ == "__main__":
    main()
