//! The candidate-ranking network of `vnet/adv.py`, evaluated here on the
//! CPU: a small transformer over a position's cards (the encoding of
//! [`crate::vnet`]), whose value for the position after a candidate ranks
//! the candidates of a decision. The weights come from `adv.py export`.
use crate::vnet::{ENC, ROWS};
use crate::game::NUM_COLS;
use std::collections::HashMap;

struct Layer {
    in_w: Vec<f32>,
    in_b: Vec<f32>,
    out_w: Vec<f32>,
    out_b: Vec<f32>,
    l1_w: Vec<f32>,
    l1_b: Vec<f32>,
    l2_w: Vec<f32>,
    l2_b: Vec<f32>,
    n1: (Vec<f32>, Vec<f32>),
    n2: (Vec<f32>, Vec<f32>),
}

impl std::fmt::Debug for AdvNet {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "AdvNet({} wide, {} layers)", self.d, self.layers.len())
    }
}

pub struct AdvNet {
    d: usize,
    heads: usize,
    ff: usize,
    emb: HashMap<String, Vec<f32>>,
    layers: Vec<Layer>,
    norm: (Vec<f32>, Vec<f32>),
    head_w: Vec<f32>,
    head_b: f32,
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let (ca, cb) = (a.chunks_exact(8), b.chunks_exact(8));
    let tail: f32 = ca.remainder().iter().zip(cb.remainder()).map(|(x, y)| x * y).sum();
    for (x, y) in ca.zip(cb) {
        for i in 0..8 {
            acc[i] += x[i] * y[i];
        }
    }
    acc.iter().sum::<f32>() + tail
}

/// `out = w x + b`, `w` of `out.len()` rows.
fn linear(w: &[f32], b: &[f32], x: &[f32], out: &mut [f32]) {
    let n = x.len();
    for (i, o) in out.iter_mut().enumerate() {
        *o = b[i] + dot(&w[i * n..(i + 1) * n], x);
    }
}

fn layer_norm(p: &(Vec<f32>, Vec<f32>), x: &[f32], out: &mut [f32]) {
    let n = x.len() as f32;
    let mean = x.iter().sum::<f32>() / n;
    let var = x.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n;
    let inv = 1.0 / (var + 1e-5).sqrt();
    for i in 0..x.len() {
        out[i] = (x[i] - mean) * inv * p.0[i] + p.1[i];
    }
}

impl AdvNet {
    /// Read the weights: tensors as name length (u32), name, number of
    /// dimensions (u32), dimensions (u32 each), values (f32), all
    /// little-endian.
    pub fn load(path: &str) -> AdvNet {
        let raw = std::fs::read(path).expect("network file");
        let mut at = 0;
        let u32_at = |at: &mut usize| {
            let v = u32::from_le_bytes(raw[*at..*at + 4].try_into().unwrap()) as usize;
            *at += 4;
            v
        };
        let mut t: HashMap<String, Vec<f32>> = HashMap::new();
        while at < raw.len() {
            let n = u32_at(&mut at);
            let name = String::from_utf8(raw[at..at + n].to_vec()).unwrap();
            at += n;
            let nd = u32_at(&mut at);
            let size: usize = (0..nd).map(|_| u32_at(&mut at)).product();
            let vals = raw[at..at + 4 * size].chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
            at += 4 * size;
            t.insert(name, vals);
        }
        fn take(t: &mut HashMap<String, Vec<f32>>, name: &str) -> Vec<f32> {
            t.remove(name).unwrap_or_else(|| panic!("tensor {name}"))
        }
        let heads = take(&mut t, "heads")[0] as usize;
        let norm = (take(&mut t, "norm.weight"), take(&mut t, "norm.bias"));
        let d = norm.0.len();
        let mut layers = Vec::new();
        while t.contains_key(&format!("enc.layers.{}.linear1.bias", layers.len())) {
            let p = format!("enc.layers.{}.", layers.len());
            let mut g = |s: &str| take(&mut t, &format!("{p}{s}"));
            layers.push(Layer {
                in_w: g("self_attn.in_proj_weight"),
                in_b: g("self_attn.in_proj_bias"),
                out_w: g("self_attn.out_proj.weight"),
                out_b: g("self_attn.out_proj.bias"),
                l1_w: g("linear1.weight"),
                l1_b: g("linear1.bias"),
                l2_w: g("linear2.weight"),
                l2_b: g("linear2.bias"),
                n1: (g("norm1.weight"), g("norm1.bias")),
                n2: (g("norm2.weight"), g("norm2.bias")),
            });
        }
        let ff = layers[0].l1_b.len();
        let head_w = take(&mut t, "head.weight")[..d].to_vec();
        let head_b = take(&mut t, "head.bias")[0];
        AdvNet { d, heads, ff, emb: t, layers, norm, head_w, head_b }
    }

    /// The tokens of an encoded candidate ([`crate::contrast::EXT`] bytes),
    /// the global one first.
    fn tokens(&self, enc: &[u8]) -> Vec<f32> {
        let d = self.d;
        let e = |name: &str, i: usize| &self.emb[name][i * d..(i + 1) * d];
        let add = |x: &mut [f32], y: &[f32]| x.iter_mut().zip(y).for_each(|(a, b)| *a += b);
        let mut out: Vec<f32> = e("code.weight", 56).to_vec();
        let deals = enc[ENC - 2] as usize;
        add(&mut out, e("deals.weight", (deals & 15).min(5)));
        add(&mut out, e("dealt.weight", deals >> 4));
        add(&mut out, e("completed.weight", (enc[ENC - 1] as usize).min(8)));
        // The line player's view of the candidate (`contrast::extras`).
        let x = [enc[ENC] as f32, (enc[ENC + 1] as f32 - 128.0) / 32.0, (enc[ENC + 2] as f32 - 128.0) / 32.0];
        for i in 0..d {
            out[i] += self.emb["ext.bias"][i] + (0..3).map(|j| self.emb["ext.weight"][i * 3 + j] * x[j]).sum::<f32>();
        }
        for c in 0..NUM_COLS {
            let code = &enc[c * ROWS..(c + 1) * ROWS];
            let n = code.iter().filter(|&&x| x > 0).count();
            let at = out.len();
            if n == 0 {
                out.extend_from_slice(e("code.weight", 55));
                add(&mut out[at..], e("row.weight", 0));
                add(&mut out[at..], e("col.weight", c));
                for name in ["rel_above.weight", "rel_below.weight", "run_above.weight", "run_below.weight", "whole.weight"] {
                    add(&mut out[at..], e(name, 0));
                }
                continue;
            }
            // rel[r]: how slot r and the one above it are linked.
            let mut rel = [0usize; ROWS];
            for r in 0..n - 1 {
                let (a, b) = (code[r], code[r + 1]);
                let (ca, cb) = (a.saturating_sub(3), b.saturating_sub(3));
                let seq = ca % 13 == cb % 13 + 1;
                let same = ca / 13 == cb / 13;
                rel[r] = if a == 1 || b == 1 {
                    1
                } else if a == 2 || b == 2 {
                    5
                } else if seq && same {
                    2
                } else if seq {
                    3
                } else {
                    4
                };
            }
            let mut above = [0usize; ROWS];
            for r in 1..n {
                above[r] = if rel[r - 1] == 2 { above[r - 1] + 1 } else { 0 };
            }
            let mut below = [0usize; ROWS];
            for r in (0..n - 1).rev() {
                below[r] = if rel[r] == 2 { below[r + 1] + 1 } else { 0 };
            }
            let faceup = code[..n].iter().filter(|&&x| x != 1).count();
            let whole = (code[n - 1] >= 3 && above[n - 1] + 1 == faceup) as usize;
            for r in 0..n {
                let at = out.len();
                out.extend_from_slice(e("code.weight", code[r] as usize));
                add(&mut out[at..], e("row.weight", r));
                add(&mut out[at..], e("col.weight", c));
                add(&mut out[at..], e("rel_above.weight", if r > 0 { rel[r - 1] } else { 0 }));
                add(&mut out[at..], e("rel_below.weight", rel[r]));
                add(&mut out[at..], e("run_above.weight", above[r].min(12)));
                add(&mut out[at..], e("run_below.weight", below[r].min(12)));
                add(&mut out[at..], e("whole.weight", whole));
            }
        }
        out
    }

    /// The network's value (a logit) of an encoded position.
    pub fn value(&self, enc: &[u8]) -> f32 {
        let (d, heads, ff) = (self.d, self.heads, self.ff);
        let dh = d / heads;
        let scale = 1.0 / (dh as f32).sqrt();
        let mut x = self.tokens(enc);
        let t = x.len() / d;
        let mut h = vec![0f32; t * d];
        let mut qkv = vec![0f32; t * 3 * d];
        let mut att = vec![0f32; d];
        let mut proj = vec![0f32; d];
        let mut mid = vec![0f32; ff];
        let mut w = vec![0f32; t];
        for (li, l) in self.layers.iter().enumerate() {
            // Only the global token's output of the last layer is used.
            let outs = if li + 1 == self.layers.len() { 1 } else { t };
            for i in 0..t {
                layer_norm(&l.n1, &x[i * d..(i + 1) * d], &mut h[i * d..(i + 1) * d]);
                linear(&l.in_w, &l.in_b, &h[i * d..(i + 1) * d], &mut qkv[i * 3 * d..(i + 1) * 3 * d]);
            }
            let mut delta = vec![0f32; outs * d];
            for i in 0..outs {
                for hd in 0..heads {
                    let q = &qkv[i * 3 * d + hd * dh..i * 3 * d + (hd + 1) * dh];
                    let mut max = f32::MIN;
                    for j in 0..t {
                        w[j] = scale * dot(q, &qkv[j * 3 * d + d + hd * dh..j * 3 * d + d + (hd + 1) * dh]);
                        max = max.max(w[j]);
                    }
                    let mut sum = 0.0;
                    for wj in w.iter_mut() {
                        *wj = (*wj - max).exp();
                        sum += *wj;
                    }
                    let o = &mut att[hd * dh..(hd + 1) * dh];
                    o.fill(0.0);
                    for j in 0..t {
                        let a = w[j] / sum;
                        let v = &qkv[j * 3 * d + 2 * d + hd * dh..j * 3 * d + 2 * d + (hd + 1) * dh];
                        for (ok, vk) in o.iter_mut().zip(v) {
                            *ok += a * vk;
                        }
                    }
                }
                linear(&l.out_w, &l.out_b, &att, &mut delta[i * d..(i + 1) * d]);
            }
            for i in 0..outs {
                let xi = &mut x[i * d..(i + 1) * d];
                xi.iter_mut().zip(&delta[i * d..(i + 1) * d]).for_each(|(a, b)| *a += b);
                layer_norm(&l.n2, xi, &mut h[..d]);
                linear(&l.l1_w, &l.l1_b, &h[..d], &mut mid);
                mid.iter_mut().for_each(|v| *v = v.max(0.0));
                linear(&l.l2_w, &l.l2_b, &mid, &mut proj);
                xi.iter_mut().zip(&proj).for_each(|(a, b)| *a += b);
            }
        }
        layer_norm(&self.norm, &x[..d], &mut h[..d]);
        self.head_b + dot(&self.head_w, &h[..d])
    }
}
