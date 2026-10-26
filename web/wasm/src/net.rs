//! The analysis's value network: `Net` in `static/vnet.js` (which see),
//! ported line for line, rounding where it rounds. JavaScript sums in
//! doubles and stores in Float32Arrays, so this sums in f64 and stores in
//! f32, in the same order, and gives the same values.

pub const ROWS: usize = 32;
const COLS: usize = 10;
const EMPTY_ID: usize = 55;
const GLOBAL_ID: usize = 56;

struct Layer {
    in_w: Vec<f32>,
    in_b: Vec<f32>,
    out_w: Vec<f32>,
    out_b: Vec<f32>,
    w1: Vec<f32>,
    b1: Vec<f32>,
    w2: Vec<f32>,
    b2: Vec<f32>,
    n1w: Vec<f32>,
    n1b: Vec<f32>,
    n2w: Vec<f32>,
    n2b: Vec<f32>,
}

/// The embedding tables, in the file's order.
const TABLES: [usize; 12] = [57, ROWS, COLS, 6, 6, 13, 13, 2, 6, 9, 5, 7];
const CODE: usize = 0;
const ROW: usize = 1;
const COL: usize = 2;
const REL_ABOVE: usize = 3;
const REL_BELOW: usize = 4;
const RUN_ABOVE: usize = 5;
const RUN_BELOW: usize = 6;
const WHOLE: usize = 7;
const DEALS: usize = 8;
const COMPLETED: usize = 9;
const SUITS: usize = 10;
const NEXT: usize = 11;

pub struct Net {
    pub suits: u8,
    d: usize,
    ff: usize,
    heads: usize,
    emb: Vec<Vec<f32>>,
    layers: Vec<Layer>,
    norm_w: Vec<f32>,
    norm_b: Vec<f32>,
    head_w: Vec<f32>,
    head_b: Vec<f32>,
    x: Vec<f32>,
    n: Vec<f32>,
    qkv: Vec<f32>,
    att: Vec<f32>,
    proj: Vec<f32>,
    hid: Vec<f32>,
    score: Vec<f32>,
    mix: Vec<f64>,
}

fn float16(h: u16) -> f32 {
    let (e, m) = ((h >> 10) & 31, (h & 1023) as f32);
    let v = if e == 0 { m * 2f32.powi(-24) } else if e == 31 { if m != 0.0 { f32::NAN } else { f32::INFINITY } } else { (m + 1024.0) * 2f32.powi(e as i32 - 25) };
    if h & 0x8000 != 0 { -v } else { v }
}

/// out[t] = W in[t] + b for each of T rows; W is rows of `from` weights.
/// Eight outputs at a time, each input read once for the eight (as vnet.js
/// does; each output's sum is still taken in order).
fn linear(inp: &[f32], t_n: usize, from: usize, w: &[f32], b: &[f32], to: usize, out: &mut [f32]) {
    let to8 = to - to % 8;
    for t in 0..t_n {
        let x = &inp[t * from..(t + 1) * from];
        let y = &mut out[t * to..(t + 1) * to];
        for o in (0..to8).step_by(8) {
            let rows: [&[f32]; 8] = std::array::from_fn(|r| &w[(o + r) * from..(o + r + 1) * from]);
            let mut s: [f64; 8] = std::array::from_fn(|r| b[o + r] as f64);
            for k in 0..from {
                let xk = x[k] as f64;
                for r in 0..8 {
                    s[r] += rows[r][k] as f64 * xk;
                }
            }
            for r in 0..8 {
                y[o + r] = s[r] as f32;
            }
        }
        for o in to8..to {
            let row = &w[o * from..(o + 1) * from];
            let mut s = b[o] as f64;
            for k in 0..from {
                s += row[k] as f64 * x[k] as f64;
            }
            y[o] = s as f32;
        }
    }
}

fn layer_norm(inp: &[f32], t_n: usize, d: usize, w: &[f32], b: &[f32], out: &mut [f32]) {
    for t in 0..t_n {
        let o = t * d;
        let mut mean = 0.0f64;
        for k in 0..d {
            mean += inp[o + k] as f64;
        }
        mean /= d as f64;
        let mut v = 0.0f64;
        for k in 0..d {
            let x = inp[o + k] as f64 - mean;
            v += x * x;
        }
        let r = 1.0 / (v / d as f64 + 1e-5).sqrt();
        for k in 0..d {
            out[o + k] = ((inp[o + k] as f64 - mean) * r * w[k] as f64 + b[k] as f64) as f32;
        }
    }
}

impl Net {
    /// From the bytes of a file written by export.py, for games of this many
    /// suits (None if it is not one).
    pub fn new(buf: &[u8], suits: u8) -> Option<Net> {
        if buf.len() < 20 || &buf[..4] != b"SPV3" || !(1..=4).contains(&suits) {
            return None;
        }
        let word = |i: usize| u32::from_le_bytes(buf[4 * i..4 * i + 4].try_into().unwrap()) as usize;
        let (d, layers, heads, ff) = (word(1), word(2), word(3), word(4));
        let mut at = 20;
        let mut take = |n: usize| -> Option<Vec<f32>> {
            let bytes = buf.get(at..at + 2 * n)?;
            at += 2 * n;
            Some(bytes.chunks_exact(2).map(|h| float16(u16::from_le_bytes([h[0], h[1]]))).collect())
        };
        let emb = TABLES.iter().map(|&n| take(n * d)).collect::<Option<Vec<_>>>()?;
        let layers = (0..layers)
            .map(|_| {
                Some(Layer {
                    in_w: take(3 * d * d)?,
                    in_b: take(3 * d)?,
                    out_w: take(d * d)?,
                    out_b: take(d)?,
                    w1: take(ff * d)?,
                    b1: take(ff)?,
                    w2: take(d * ff)?,
                    b2: take(d)?,
                    n1w: take(d)?,
                    n1b: take(d)?,
                    n2w: take(d)?,
                    n2b: take(d)?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let (norm_w, norm_b, head_w, head_b) = (take(d)?, take(d)?, take(2 * d)?, take(2)?);
        if at != buf.len() || d % heads != 0 {
            return None;
        }
        let t = COLS * ROWS + 1;
        Some(Net {
            suits,
            d,
            ff,
            heads,
            emb,
            layers,
            norm_w,
            norm_b,
            head_w,
            head_b,
            x: vec![0.0; t * d],
            n: vec![0.0; t * d],
            qkv: vec![0.0; t * 3 * d],
            att: vec![0.0; t * d],
            proj: vec![0.0; t * d],
            hid: vec![0.0; t * ff],
            score: vec![0.0; t],
            mix: vec![0.0; d / heads],
        })
    }

    fn add(&mut self, t: usize, table: usize, i: usize) {
        let d = self.d;
        let (x, e) = (&mut self.x[t * d..(t + 1) * d], &self.emb[table][i * d..(i + 1) * d]);
        for k in 0..d {
            x[k] += e[k];
        }
    }

    /// The tokens of an encoded position into x, `next` being what the cheap
    /// line player would do next there; returns how many.
    fn tokens(&mut self, enc: &[u8], next: u8) -> usize {
        let d = self.d;
        self.x[..d].fill(0.0);
        self.add(0, CODE, GLOBAL_ID);
        self.add(0, DEALS, (enc[COLS * ROWS] as usize).min(5));
        self.add(0, COMPLETED, (enc[COLS * ROWS + 1] as usize).min(8));
        self.add(0, SUITS, self.suits as usize);
        self.add(0, NEXT, next as usize);
        let mut t = 1;
        let (mut rel, mut above, mut below) = ([0u8; ROWS + 1], [0u8; ROWS + 1], [0u8; ROWS + 1]);
        for c in 0..COLS {
            let o = c * ROWS;
            let n = enc[o..o + ROWS].iter().take_while(|&&x| x != 0).count();
            if n == 0 {
                self.x[t * d..(t + 1) * d].fill(0.0);
                for (table, i) in [(CODE, EMPTY_ID), (ROW, 0), (COL, c), (REL_ABOVE, 0), (REL_BELOW, 0), (RUN_ABOVE, 0), (RUN_BELOW, 0), (WHOLE, 0)] {
                    self.add(t, table, i);
                }
                t += 1;
                continue;
            }
            // rel[r]: how the card in row r and the one on it go together.
            let mut face_up = 0;
            for r in 0..n {
                let a = enc[o + r] as i32;
                let b = if r + 1 < n { enc[o + r + 1] as i32 } else { 0 };
                if a != 1 {
                    face_up += 1;
                }
                rel[r] = if b == 0 {
                    0
                } else if a == 1 || b == 1 {
                    1
                } else if a == 2 || b == 2 {
                    5
                } else if (a - 3) % 13 != (b - 3) % 13 + 1 {
                    4
                } else if (a - 3) / 13 == (b - 3) / 13 {
                    2
                } else {
                    3
                };
            }
            above[0] = 0;
            for r in 1..n {
                above[r] = if rel[r - 1] == 2 { above[r - 1] + 1 } else { 0 };
            }
            below[n - 1] = 0;
            for r in (0..n - 1).rev() {
                below[r] = if rel[r] == 2 { below[r + 1] + 1 } else { 0 };
            }
            let whole = (enc[o + n - 1] >= 3 && above[n - 1] as usize + 1 == face_up) as usize;
            for r in 0..n {
                if enc[o + r] == 1 {
                    continue; // a face-down card is no token
                }
                self.x[t * d..(t + 1) * d].fill(0.0);
                self.add(t, CODE, enc[o + r] as usize);
                self.add(t, ROW, r);
                self.add(t, COL, c);
                self.add(t, REL_ABOVE, if r > 0 { rel[r - 1] as usize } else { 0 });
                self.add(t, REL_BELOW, rel[r] as usize);
                self.add(t, RUN_ABOVE, above[r].min(12) as usize);
                self.add(t, RUN_BELOW, below[r].min(12) as usize);
                self.add(t, WHOLE, whole);
                t += 1;
            }
        }
        t
    }

    /// One layer over the T tokens in x, for the first Q of them only.
    fn layer(&mut self, l: usize, t_n: usize, q_n: usize) {
        let (d, ff, heads) = (self.d, self.ff, self.heads);
        let lw = &self.layers[l];
        let dh = d / heads;
        let dh2 = dh - dh % 2;
        let scale = 1.0 / (dh as f64).sqrt();
        layer_norm(&self.x, t_n, d, &lw.n1w, &lw.n1b, &mut self.n);
        linear(&self.n, t_n, d, &lw.in_w, &lw.in_b, 3 * d, &mut self.qkv);
        let (qkv, score, mix) = (&self.qkv, &mut self.score, &mut self.mix);
        for h in 0..heads {
            let (qo, ko, vo) = (h * dh, d + h * dh, 2 * d + h * dh);
            for i in 0..q_n {
                let q = i * 3 * d + qo;
                let mut max = f64::NEG_INFINITY;
                for j in 0..t_n {
                    let key = j * 3 * d + ko;
                    let (mut s, mut r) = (0.0f64, 0.0f64);
                    let mut k = 0;
                    while k < dh2 {
                        s += qkv[q + k] as f64 * qkv[key + k] as f64;
                        r += qkv[q + k + 1] as f64 * qkv[key + k + 1] as f64;
                        k += 2;
                    }
                    if dh2 < dh {
                        s += qkv[q + dh2] as f64 * qkv[key + dh2] as f64;
                    }
                    let s = (s + r) * scale;
                    score[j] = s as f32;
                    if s > max {
                        max = s;
                    }
                }
                let mut sum = 0.0f64;
                for j in 0..t_n {
                    let e = (score[j] as f64 - max).exp();
                    score[j] = e as f32;
                    sum += e;
                }
                mix.fill(0.0);
                for j in 0..t_n {
                    let a = score[j] as f64 / sum;
                    let v = j * 3 * d + vo;
                    for k in 0..dh {
                        mix[k] += a * qkv[v + k] as f64;
                    }
                }
                for k in 0..dh {
                    self.att[i * d + qo + k] = mix[k] as f32;
                }
            }
        }
        linear(&self.att, q_n, d, &lw.out_w, &lw.out_b, d, &mut self.proj);
        for i in 0..q_n * d {
            self.x[i] += self.proj[i];
        }
        layer_norm(&self.x, q_n, d, &lw.n2w, &lw.n2b, &mut self.n);
        linear(&self.n, q_n, d, &lw.w1, &lw.b1, ff, &mut self.hid);
        for v in &mut self.hid[..q_n * ff] {
            if *v < 0.0 {
                *v = 0.0;
            }
        }
        linear(&self.hid, q_n, ff, &lw.w2, &lw.b2, d, &mut self.proj);
        for i in 0..q_n * d {
            self.x[i] += self.proj[i];
        }
    }

    /// The chance of winning from an encoded position.
    pub fn win_prob(&mut self, enc: &[u8], next: u8) -> f64 {
        let t_n = self.tokens(enc, next);
        let last = self.layers.len() - 1;
        for l in 0..self.layers.len() {
            self.layer(l, t_n, if l == last { 1 } else { t_n });
        }
        layer_norm(&self.x, 1, self.d, &self.norm_w, &self.norm_b, &mut self.n);
        let mut z = self.head_b[0] as f64;
        for k in 0..self.d {
            z += self.head_w[k] as f64 * self.n[k] as f64;
        }
        1.0 / (1.0 + (-z).exp())
    }
}
