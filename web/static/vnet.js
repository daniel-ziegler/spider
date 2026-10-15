// The value network of the analysis (analysis-worker.js): the chance that the line
// player (lineplayer.js, rolloutConfig) goes on to win from a position, given
// only the cards that are face up. A small transformer over the cards, trained
// on that player's games (../tools/analysis/train.py: one network for all
// four numbers of suits, which it is told) and exported by
// ../tools/analysis/export.py; this is its forward pass, in plain typed
// arrays: the network is small enough (325,000 weights, about 14 ms a
// position) that nothing more is needed. test/vnet.mjs compares it with
// PyTorch.
//
// A position is encoded as in ../../src/vnet.rs: for each column ROWS codes
// from the bottom (0: no card, 1: face down, 2: face up but unknown, 3 +
// card), keeping the top ROWS cards of a longer column; then the deals left
// and the suits completed. Besides that the network is told the number of
// suits and what the cheap line player would do next in the position (see
// next below).

import { MAXC, LEN, DOWN, DONE, SIZE, fastConfig, nextKind } from './lineplayer.js';

export const ROWS = 32, COLS = 10, ENC = COLS * ROWS + 2;
const EMPTY_ID = 55, GLOBAL_ID = 56, UNKNOWN = 255;

// Encode columns of cards (bottom first; 255 for a face-up card that is not
// known) with their face-down counts.
export function encode(columns, faceDown, dealsLeft, completed, out = new Uint8Array(ENC)) {
  out.fill(0);
  for (let c = 0; c < COLS; c++) {
    const col = columns[c], n = col.length, start = Math.max(0, n - ROWS);
    for (let i = start; i < n; i++) out[c * ROWS + i - start] = i < faceDown[c] ? 1 : col[i] === UNKNOWN ? 2 : 3 + col[i];
  }
  out[COLS * ROWS] = dealsLeft;
  out[COLS * ROWS + 1] = completed;
  return out;
}

function float16(bytes, at, n) {
  const out = new Float32Array(n), view = new DataView(bytes, at, 2 * n);
  for (let i = 0; i < n; i++) {
    const h = view.getUint16(2 * i, true), e = (h >> 10) & 31, m = h & 1023;
    const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (m + 1024) * 2 ** (e - 25);
    out[i] = h & 0x8000 ? -v : v;
  }
  return out;
}

// out[t] = W in[t] + b for each of T rows; W is rows of `from` weights.
// Eight outputs at a time, each input read once for the eight: some three
// times as fast as an output at a time.
function linear(inp, T, from, W, b, to, out) {
  const to8 = to - to % 8;
  for (let t = 0; t < T; t++) {
    const xi = t * from, yo = t * to;
    for (let o = 0; o < to8; o += 8) {
      let s0 = b[o], s1 = b[o + 1], s2 = b[o + 2], s3 = b[o + 3], s4 = b[o + 4], s5 = b[o + 5], s6 = b[o + 6], s7 = b[o + 7];
      const w0 = o * from, w1 = w0 + from, w2 = w1 + from, w3 = w2 + from, w4 = w3 + from, w5 = w4 + from, w6 = w5 + from, w7 = w6 + from;
      for (let k = 0; k < from; k++) {
        const x = inp[xi + k];
        s0 += W[w0 + k] * x; s1 += W[w1 + k] * x; s2 += W[w2 + k] * x; s3 += W[w3 + k] * x;
        s4 += W[w4 + k] * x; s5 += W[w5 + k] * x; s6 += W[w6 + k] * x; s7 += W[w7 + k] * x;
      }
      out[yo + o] = s0; out[yo + o + 1] = s1; out[yo + o + 2] = s2; out[yo + o + 3] = s3;
      out[yo + o + 4] = s4; out[yo + o + 5] = s5; out[yo + o + 6] = s6; out[yo + o + 7] = s7;
    }
    for (let o = to8; o < to; o++) {
      let s = b[o];
      for (let k = 0, w = o * from; k < from; k++) s += W[w + k] * inp[xi + k];
      out[yo + o] = s;
    }
  }
}

function layerNorm(inp, T, d, w, b, out) {
  for (let t = 0; t < T; t++) {
    const o = t * d;
    let mean = 0, v = 0;
    for (let k = 0; k < d; k++) mean += inp[o + k];
    mean /= d;
    for (let k = 0; k < d; k++) { const x = inp[o + k] - mean; v += x * x; }
    const r = 1 / Math.sqrt(v / d + 1e-5);
    for (let k = 0; k < d; k++) out[o + k] = (inp[o + k] - mean) * r * w[k] + b[k];
  }
}

export class Net {
  // From the bytes of a file written by export.py, for games of this many suits.
  constructor(buffer, suits) {
    const head = new DataView(buffer, 0, 20);
    if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'SPV2') throw new Error('not a network');
    if (!(suits >= 1 && suits <= 4)) throw new Error('a network for how many suits?');
    this.suits = suits;
    const d = this.d = head.getUint32(4, true), ff = this.ff = head.getUint32(16, true);
    this.heads = head.getUint32(12, true);
    let at = 20;
    const take = n => { const a = float16(buffer, at, n); at += 2 * n; return a; };
    this.emb = {};
    for (const [name, n] of [['code', 57], ['row', ROWS], ['col', COLS], ['relAbove', 6], ['relBelow', 6], ['runAbove', 13], ['runBelow', 13], ['whole', 2], ['deals', 6], ['completed', 9], ['suits', 5], ['next', 7]]) {
      this.emb[name] = take(n * d);
    }
    this.layers = Array.from({ length: head.getUint32(8, true) }, () => ({
      inW: take(3 * d * d), inB: take(3 * d), outW: take(d * d), outB: take(d),
      w1: take(ff * d), b1: take(ff), w2: take(d * ff), b2: take(d),
      n1w: take(d), n1b: take(d), n2w: take(d), n2b: take(d),
    }));
    this.normW = take(d);
    this.normB = take(d);
    this.headW = take(2 * d);
    this.headB = take(2);
    if (at !== buffer.byteLength) throw new Error('a network of the wrong size');
    const T = COLS * ROWS + 1;
    this.x = new Float32Array(T * d);
    this.n = new Float32Array(T * d);
    this.qkv = new Float32Array(T * 3 * d);
    this.att = new Float32Array(T * d);
    this.proj = new Float32Array(T * d);
    this.hid = new Float32Array(T * ff);
    this.score = new Float32Array(T);
  }

  // What the cheap line player would do next in an encoded position (see
  // nextKind in lineplayer.js; 0 if a face-up card is unknown or the game
  // is won): the network is told, since it cannot see it. As next_kind in
  // ../../src/vnet.rs, which the network was trained with.
  next(enc) {
    const s = this.state ??= new Uint8Array(SIZE);
    if (enc[COLS * ROWS + 1] >= 8) return 0;
    for (let c = 0; c < COLS; c++) {
      let n = 0, down = 0;
      for (; n < ROWS && enc[c * ROWS + n]; n++) {
        const code = enc[c * ROWS + n];
        if (code === 2) return 0;
        if (code === 1) down++;
        else s[c * MAXC + n] = code - 3;
      }
      s[LEN + c] = n;
      s[DOWN + c] = down;
    }
    s[DONE] = enc[COLS * ROWS + 1];
    return nextKind(s, enc[COLS * ROWS], this.cheap ??= fastConfig(this.suits));
  }

  // The tokens of an encoded position, into this.x; returns how many. (As
  // card_features and Net.forward in train.py.)
  tokens(enc) {
    const { d, x, emb } = this;
    const add = (t, table, i) => { for (let k = 0, o = t * d, e = i * d; k < d; k++) x[o + k] += table[e + k]; };
    x.fill(0, 0, d);
    add(0, emb.code, GLOBAL_ID);
    add(0, emb.deals, Math.min(enc[COLS * ROWS], 5));
    add(0, emb.completed, Math.min(enc[COLS * ROWS + 1], 8));
    add(0, emb.suits, this.suits);
    add(0, emb.next, this.next(enc));
    let T = 1;
    const rel = new Uint8Array(ROWS + 1), above = new Uint8Array(ROWS + 1), below = new Uint8Array(ROWS + 1);
    for (let c = 0; c < COLS; c++) {
      const o = c * ROWS;
      let n = 0;
      while (n < ROWS && enc[o + n]) n++;
      if (n === 0) {
        x.fill(0, T * d, (T + 1) * d);
        for (const [table, i] of [[emb.code, EMPTY_ID], [emb.row, 0], [emb.col, c], [emb.relAbove, 0], [emb.relBelow, 0], [emb.runAbove, 0], [emb.runBelow, 0], [emb.whole, 0]]) add(T, table, i);
        T++;
        continue;
      }
      // rel[r]: how the card in row r and the one on it go together.
      let faceUp = 0;
      for (let r = 0; r < n; r++) {
        const a = enc[o + r], b = r + 1 < n ? enc[o + r + 1] : 0;
        if (a !== 1) faceUp++;
        if (!b) rel[r] = 0;
        else if (a === 1 || b === 1) rel[r] = 1;
        else if (a === 2 || b === 2) rel[r] = 5;
        else if ((a - 3) % 13 !== (b - 3) % 13 + 1) rel[r] = 4;
        else rel[r] = Math.floor((a - 3) / 13) === Math.floor((b - 3) / 13) ? 2 : 3;
      }
      above[0] = 0;
      for (let r = 1; r < n; r++) above[r] = rel[r - 1] === 2 ? above[r - 1] + 1 : 0;
      below[n - 1] = 0;
      for (let r = n - 2; r >= 0; r--) below[r] = rel[r] === 2 ? below[r + 1] + 1 : 0;
      const whole = enc[o + n - 1] >= 3 && above[n - 1] + 1 === faceUp ? 1 : 0;
      for (let r = 0; r < n; r++, T++) {
        x.fill(0, T * d, (T + 1) * d);
        add(T, emb.code, enc[o + r]);
        add(T, emb.row, r);
        add(T, emb.col, c);
        add(T, emb.relAbove, r ? rel[r - 1] : 0);
        add(T, emb.relBelow, rel[r]);
        add(T, emb.runAbove, Math.min(above[r], 12));
        add(T, emb.runBelow, Math.min(below[r], 12));
        add(T, emb.whole, whole);
      }
    }
    return T;
  }

  // One layer over the T tokens in this.x, for the first Q of them only
  // (the last layer is wanted for the first token alone).
  layer(L, T, Q) {
    const { d, ff, heads, x, n, qkv, att, proj, hid, score } = this, dh = d / heads, dh2 = dh - dh % 2, scale = 1 / Math.sqrt(dh), mix = this.mix ??= new Float64Array(dh);
    layerNorm(x, T, d, L.n1w, L.n1b, n);
    linear(n, T, d, L.inW, L.inB, 3 * d, qkv);
    for (let h = 0; h < heads; h++) {
      const qo = h * dh, ko = d + h * dh, vo = 2 * d + h * dh;
      for (let i = 0; i < Q; i++) {
        const q = i * 3 * d + qo;
        let max = -Infinity;
        for (let j = 0; j < T; j++) {
          const key = j * 3 * d + ko;
          let s = 0, r = 0;
          for (let k = 0; k < dh2; k += 2) {
            s += qkv[q + k] * qkv[key + k];
            r += qkv[q + k + 1] * qkv[key + k + 1];
          }
          if (dh2 < dh) s += qkv[q + dh2] * qkv[key + dh2];
          score[j] = s = (s + r) * scale;
          if (s > max) max = s;
        }
        let sum = 0;
        for (let j = 0; j < T; j++) sum += score[j] = Math.exp(score[j] - max);
        mix.fill(0, 0, dh);
        for (let j = 0; j < T; j++) {
          const a = score[j] / sum, v = j * 3 * d + vo;
          for (let k = 0; k < dh; k++) mix[k] += a * qkv[v + k];
        }
        att.set(mix, i * d + qo);
      }
    }
    linear(att, Q, d, L.outW, L.outB, d, proj);
    for (let i = 0; i < Q * d; i++) x[i] += proj[i];
    layerNorm(x, Q, d, L.n2w, L.n2b, n);
    linear(n, Q, d, L.w1, L.b1, ff, hid);
    for (let i = 0; i < Q * ff; i++) if (hid[i] < 0) hid[i] = 0;
    linear(hid, Q, ff, L.w2, L.b2, d, proj);
    for (let i = 0; i < Q * d; i++) x[i] += proj[i];
  }

  // The chance of winning from an encoded position.
  winProb(enc) {
    const T = this.tokens(enc), last = this.layers.length - 1;
    this.layers.forEach((L, i) => this.layer(L, T, i === last ? 1 : T));
    layerNorm(this.x, 1, this.d, this.normW, this.normB, this.n);
    let z = this.headB[0];
    for (let k = 0; k < this.d; k++) z += this.headW[k] * this.n[k];
    return 1 / (1 + Math.exp(-z));
  }
}
