//! The analysis's line player: `static/lineplayer.js` over again, function
//! for function (which see for what each does; it is itself a port of
//! `src/lines.rs`, made to play the same games in much less time: a position
//! a step on is hashed and evaluated from its two changed columns, the
//! places a sequence can go are looked up by rank, and the search's
//! positions lie in one array that is never freed). It plays move for move
//! what the JavaScript plays, with the same count of positions looked at
//! (`web/test/wasm.mjs`).

use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

pub const NUM_COLS: usize = 10;
pub const MAXC: usize = 48;
const BLANK: u8 = 255;
pub const LEN: usize = NUM_COLS * MAXC;
pub const DOWN: usize = LEN + NUM_COLS;
pub const DONE: usize = DOWN + NUM_COLS;
pub const SIZE: usize = DONE + 1;
const LOST: i32 = -1073741824;

/// lineplayer.js's configurations (`fastConfig`, `rolloutConfig`,
/// `analysisConfig`), less the weights that are zero in all.
#[derive(Clone, Copy)]
pub struct Config {
    max_steps: usize,
    touch: bool,
    beam: usize,
    replan: usize,
    expect_top: usize,
    expect_steps: usize,
    expect_beam: usize,
    splits: u8,
    completed: i32,
    hidden: i32,
    empty: i32,
    deal_empty: i32,
    deal_flip: i32,
    end_empty: i32,
    same: i32,
    off: i32,
    off_rank: i32,
    king: i32,
    ranks: i32,
    run_sq: i32,
    wrong: i32,
    clear: i32,
    hidden_sq: i32,
    dig: i32,
}

impl Config {
    pub fn fast(suits: u8) -> Config {
        let base = Config {
            max_steps: 6,
            touch: true,
            beam: 0,
            replan: 0,
            expect_top: 0,
            expect_steps: 4,
            expect_beam: 20,
            splits: if suits == 1 { 2 } else { 1 },
            completed: 1000,
            hidden: 47,
            empty: 53,
            deal_empty: -72,
            deal_flip: 0,
            end_empty: 3,
            same: 0,
            off: -6,
            off_rank: 3,
            king: 0,
            ranks: 9,
            run_sq: 13,
            wrong: 0,
            clear: 0,
            hidden_sq: 0,
            dig: 0,
        };
        match suits {
            1 => Config { max_steps: 2, hidden: 20, empty: 60, deal_empty: -60, end_empty: 0, same: 11, off: -2, off_rank: 0, king: 11, ranks: 3, run_sq: 13, ..base },
            2 => Config { beam: 50, hidden: 22, empty: 26, deal_empty: -28, end_empty: 5, same: 5, off: -8, off_rank: 4, king: -10, ranks: 8, run_sq: 1, ..base },
            _ => Config { beam: 50, hidden: 71, empty: 103, end_empty: 39, off: -10, run_sq: 7, wrong: -3, clear: 16, hidden_sq: -4, ..base },
        }
    }

    pub fn rollout(suits: u8) -> Config {
        let fast = Config::fast(suits);
        if suits == 1 {
            Config { expect_top: 4, expect_steps: 1, ..fast }
        } else {
            Config { max_steps: 14, beam: 100, expect_top: 4, expect_steps: 1, ..fast }
        }
    }

    /// `analysisConfig`: the configuration for each number of deals left
    /// (lineplayer.js's ANALYSIS).
    pub fn analysis(suits: u8) -> [Config; 6] {
        let rollout = Config::rollout(suits);
        if suits == 1 {
            let mut stages = [rollout; 6];
            stages[0] = Config { max_steps: 4, expect_steps: 2, ..rollout };
            stages
        } else {
            let mut stages = [Config { replan: 4, beam: 150, ..rollout }; 6];
            stages[0] = Config { replan: 8, beam: 100, ..rollout };
            stages
        }
    }
}

// ---------------------------------------------------------------- hashing

/// A column's hash (two 32-bit numbers) from its `n` cards, `d` face down.
#[inline]
fn col_hash(col: &[u8], n: usize, d: usize) -> (u32, u32) {
    let mut a = (n as u32 + 1).wrapping_mul(0x01000193) ^ (d as u32 + 1).wrapping_mul(0x7FEB352D);
    let mut b = (n as u32 + 0x51).wrapping_mul(0x2C1B3C6D).wrapping_add(d as u32);
    for &card in &col[d..n] {
        let x = card as u32 + 1;
        a = (a ^ x).wrapping_mul(0x01000193);
        b = b.wrapping_add(x).wrapping_mul(0xCC9E2D51).rotate_left(15);
    }
    a ^= a >> 16;
    a = a.wrapping_mul(0x85EBCA6B);
    a ^= a >> 13;
    a = a.wrapping_mul(0xC2B2AE35);
    a ^= a >> 16;
    b ^= b >> 15;
    b = b.wrapping_mul(0x2C1B3C6D);
    b ^= b >> 12;
    b = b.wrapping_mul(0x297A2D39);
    b ^= b >> 15;
    (a, b)
}

#[inline]
fn key_of(a: u32, b: u32) -> u64 {
    ((b & 0x1FFFFF) as u64) << 32 | a as u64
}

/// The keys of the positions a game has stood in (they are hashes already).
#[derive(Default)]
pub struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, _: &[u8]) {
        unreachable!("keys are u64")
    }
    fn write_u64(&mut self, x: u64) {
        self.0 = x.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

type Keys = HashSet<u64, BuildHasherDefault<KeyHasher>>;

/// The positions a search has reached: an open-addressed table, emptied by
/// moving on to the next generation.
struct Seen {
    cap: usize,
    table: Vec<[u32; 3]>,
    gen: u32,
    count: usize,
}

impl Seen {
    fn reset(&mut self) {
        self.gen += 1;
        self.count = 0;
    }

    /// Add a position; false if it was there.
    #[inline]
    fn insert(&mut self, a: u32, b: u32) -> bool {
        let mask = self.cap - 1;
        let mut i = (a ^ b.wrapping_mul(0x9E3779B1)) as usize & mask;
        while self.table[i][0] == self.gen {
            if self.table[i][1] == a && self.table[i][2] == b {
                return false;
            }
            i = (i + 1) & mask;
        }
        self.table[i] = [self.gen, a, b];
        self.count += 1;
        if self.count * 2 > self.cap {
            self.grow();
        }
        true
    }

    fn grow(&mut self) {
        let old = std::mem::take(&mut self.table);
        let ogen = self.gen;
        self.cap *= 2;
        self.table = vec![[0; 3]; self.cap];
        self.gen = 1;
        let mask = self.cap - 1;
        for e in old {
            if e[0] != ogen {
                continue;
            }
            let mut i = (e[1] ^ e[2].wrapping_mul(0x9E3779B1)) as usize & mask;
            while self.table[i][0] == self.gen {
                i = (i + 1) & mask;
            }
            self.table[i] = [self.gen, e[1], e[2]];
        }
    }
}

// ---------------------------------------------------------------- the search's positions

/// A node of a search: its position, its columns' hashes and their sums,
/// the node it was reached from and by which moves (a stretch of
/// `Search::steps`), whether that turned a card over, the columns its line
/// has touched, and its evaluation in parts (with what each column adds by
/// itself, and the ranks of the lower cards of its off-suit links).
#[derive(Clone, Copy)]
struct Node {
    s: [u8; SIZE],
    leaf: bool,
    ev_empties: u8,
    touched: u16,
    ev_cards: u16,
    parent: u32,
    pa: u32,
    pb: u32,
    ev_base: i32,
    step: (u32, u32),
    ca: [u32; NUM_COLS],
    cb: [u32; NUM_COLS],
    col_score: [i32; NUM_COLS],
    col_off: [i32; NUM_COLS],
}

const BLANK_NODE: Node = Node { s: [0; SIZE], leaf: false, ev_empties: 0, touched: 0, ev_cards: 0, parent: 0, pa: 0, pb: 0, ev_base: 0, step: (0, 0), ca: [0; NUM_COLS], cb: [0; NUM_COLS], col_score: [0; NUM_COLS], col_off: [0; NUM_COLS] };

impl Node {
    fn rehash_col(&mut self, c: usize) {
        let (a, b) = col_hash(&self.s[c * MAXC..(c + 1) * MAXC], self.s[LEN + c] as usize, self.s[DOWN + c] as usize);
        self.ca[c] = a;
        self.cb[c] = b;
    }

    fn sum_hash(&mut self) {
        let done = self.s[DONE] as u32;
        let (mut a, mut b) = (done.wrapping_mul(0x9E3779B1), done.wrapping_mul(0x85EBCA77));
        for c in 0..NUM_COLS {
            a = a.wrapping_add(self.ca[c]);
            b = b.wrapping_add(self.cb[c]);
        }
        self.pa = a;
        self.pb = b;
    }

    fn evaluate(&mut self, cfg: &Config) {
        for c in 0..NUM_COLS {
            self.evaluate_col(c, cfg);
        }
        self.evaluate_sum(cfg);
    }

    fn evaluate_col(&mut self, c: usize, cfg: &Config) {
        let n = self.s[LEN + c] as usize;
        let (mut score, mut off_rank) = (0i32, 0i32);
        if n != 0 {
            let d = self.s[DOWN + c] as usize;
            let col = &self.s[c * MAXC..c * MAXC + n];
            let di = d as i32;
            score = -(cfg.hidden * di + cfg.hidden_sq * di * di / 16);
            if d == 0 {
                score += cfg.clear;
            }
            let low = col[d];
            if low != BLANK && low % 13 == 12 {
                score += cfg.king;
            }
            let (mut run, mut seq) = (1i32, true);
            for i in d + 1..n {
                let (upper, lower) = (col[i - 1], col[i]);
                if upper % 13 == lower % 13 + 1 {
                    if upper / 13 == lower / 13 {
                        score += cfg.same;
                        run += 1;
                        continue;
                    }
                    score += cfg.off;
                    off_rank += (lower % 13) as i32;
                } else if upper != BLANK && lower != BLANK {
                    score += cfg.wrong;
                    seq = false;
                }
                score += cfg.run_sq * run * run / 16;
                run = 1;
            }
            score += cfg.run_sq * run * run / 16;
            if d > 0 && seq {
                score += cfg.dig;
            }
        }
        self.col_score[c] = score;
        self.col_off[c] = off_rank;
    }

    fn evaluate_sum(&mut self, cfg: &Config) {
        let mut score = cfg.completed * self.s[DONE] as i32;
        let (mut off_rank, mut top_ranks, mut empties, mut cards) = (0i32, 0u32, 0u8, 0u16);
        for c in 0..NUM_COLS {
            let n = self.s[LEN + c] as usize;
            if n == 0 {
                empties += 1;
                continue;
            }
            cards += n as u16;
            score += self.col_score[c];
            off_rank += self.col_off[c];
            // A card just turned over is unknown (BLANK): no place to put anything yet.
            let top = self.s[c * MAXC + n - 1];
            if top != BLANK && top % 13 != 0 {
                top_ranks |= 1 << (top % 13);
            }
        }
        self.ev_base = score + cfg.off_rank * off_rank / 4 + cfg.ranks * top_ranks.count_ones() as i32;
        self.ev_empties = empties;
        self.ev_cards = cards;
    }

    #[inline]
    fn value(&self, deals_left: usize, empty: i32) -> i32 {
        if deals_left > 0 && (self.ev_cards as usize) < NUM_COLS {
            LOST
        } else {
            self.ev_base + empty * self.ev_empties as i32
        }
    }
}

/// Length of the same-suit run at the top of a column.
fn run_len(s: &[u8], c: usize) -> usize {
    let (n, d) = (s[LEN + c] as usize, s[DOWN + c] as usize);
    if n == d {
        return 0;
    }
    let col = &s[c * MAXC..];
    let mut k = 1;
    while n - k > d {
        let (upper, lower) = (col[n - k - 1], col[n - k]);
        if upper.wrapping_sub(lower) == 1 && upper % 13 != 0 && upper > lower {
            k += 1; // same suit, one rank higher
        } else {
            break;
        }
    }
    k
}

/// Move `n` cards; a card turned over becomes `turned` if one is given (the
/// search does not know it). Returns whether a card turned.
pub fn apply_move(s: &mut [u8], from: usize, to: usize, n: usize, turned: Option<u8>) -> bool {
    let (fl, tl) = (s[LEN + from] as usize, s[LEN + to] as usize);
    let (fo, t) = (from * MAXC + fl - n, to * MAXC + tl);
    s.copy_within(fo..fo + n, t);
    s[LEN + from] = (fl - n) as u8;
    s[LEN + to] = (tl + n) as u8;
    let mut flipped = false;
    if fl - n > 0 && s[DOWN + from] as usize == fl - n {
        s[DOWN + from] -= 1;
        if let Some(x) = turned {
            s[fo - 1] = x;
        }
        flipped = true;
    }
    remove_if_complete(s, to, turned) || flipped
}

pub fn remove_if_complete(s: &mut [u8], c: usize, turned: Option<u8>) -> bool {
    let n = s[LEN + c] as usize;
    if n < 13 || s[c * MAXC + n - 1] % 13 != 0 || run_len(s, c) < 13 {
        return false;
    }
    s[LEN + c] = (n - 13) as u8;
    s[DONE] += 1;
    if n - 13 > 0 && s[DOWN + c] as usize == n - 13 {
        s[DOWN + c] -= 1;
        if let Some(x) = turned {
            s[c * MAXC + n - 14] = x;
        }
        return true;
    }
    false
}

/// Move the top pieces of `from` (same-suit runs, `sizes[lo..hi]` from the
/// bottom piece up) onto `to` by way of the empty columns `free[f..]`: the
/// top half aside, the bottom half across, the top half back on it. The
/// moves go to `out` if one is given.
#[allow(clippy::too_many_arguments)]
fn move_pieces(s: &mut [u8], from: usize, to: usize, sizes: &[u8], lo: usize, hi: usize, free: &[u8], f: usize, out: &mut Option<&mut Vec<u8>>, flip: &mut bool) {
    let k = hi - lo;
    if k == 0 {
        return;
    }
    if k == 1 {
        if apply_move(s, from, to, sizes[lo] as usize, Some(BLANK)) {
            *flip = true;
        }
        if let Some(out) = out {
            out.extend([from as u8, to as u8, sizes[lo]]);
        }
        return;
    }
    let (t, mid) = (free[f] as usize, lo + k - (k >> 1));
    move_pieces(s, from, t, sizes, mid, hi, free, f + 1, out, flip);
    move_pieces(s, from, to, sizes, lo, mid, free, f + 1, out, flip);
    move_pieces(s, t, to, sizes, mid, hi, free, f + 1, out, flip);
}

/// What expand does with the positions a step away.
enum Mode {
    /// Makes them nodes.
    Nodes,
    /// Only keeps their best scores, with an empty column worth
    /// `cfg.empty` and worth `empty`; `deals` deals are left.
    Peek { empty: i32, deals: usize, best: [i32; 2] },
}

pub struct Search {
    seen: Seen,
    nodes: Vec<Node>,
    count: usize,
    /// The nodes' steps, as (from, to, count) bytes.
    steps: Vec<u8>,
    frontier: Vec<u32>,
    keys: Vec<u64>,
    keep: Vec<bool>,
}

impl Default for Search {
    fn default() -> Search {
        Search { seen: Seen { cap: 1 << 14, table: vec![[0; 3]; 1 << 14], gen: 0, count: 0 }, nodes: vec![BLANK_NODE; 4096], count: 0, steps: Vec::new(), frontier: Vec::new(), keys: Vec::new(), keep: Vec::new() }
    }
}

pub enum Decision<L> {
    /// A line: its steps, each its moves as (from, to, count) bytes
    /// (`decide`), or the moves to play now (`choose`).
    Line(L),
    Deal,
    Stuck,
}

/// What the player keeps between decisions: whether it is about to deal,
/// whether the line chosen last turns a card and what it is worth where it
/// ends, the positions looked at, and with `replan` what is left of the line
/// being played, what that is worth where it ends and whether it is about to
/// deal.
#[derive(Default)]
pub struct Tempo {
    pub dealing: bool,
    pub turns: bool,
    pub value: i32,
    pub work: u64,
    pub plan: Vec<Vec<u8>>,
    pub plan_value: i32,
    pub plan_dealing: bool,
}

impl Search {
    fn room(&mut self, k: usize) {
        if k >= self.nodes.len() {
            let n = self.nodes.len();
            self.nodes.resize(2 * n, BLANK_NODE);
        }
    }

    /// Every step from node i as new nodes (or, peeking, their scores):
    /// with `require` not zero, only steps touching one of those columns.
    fn expand(&mut self, i: usize, splits: u8, require: u16, cfg: &Config, mode: &mut Mode) {
        let p0 = self.nodes[i];
        let s = &p0.s;
        // The empty columns, and for each rank the columns whose top card
        // has it (a bit a column; an unknown card counts by its code's).
        let mut empty_cols = [0u8; NUM_COLS];
        let mut ne = 0;
        let mut on_rank = [0u16; 14];
        for c in 0..NUM_COLS {
            let n = s[LEN + c] as usize;
            if n == 0 {
                empty_cols[ne] = c as u8;
                ne += 1;
            } else {
                on_rank[(s[c * MAXC + n - 1] % 13) as usize] |= 1 << c;
            }
        }
        let mut sizes = [0u8; MAXC];
        let mut free = [0u8; NUM_COLS];
        let mut tmp = [0u8; 2 * MAXC];
        for from in 0..NUM_COLS {
            let (n, d) = (s[LEN + from] as usize, s[DOWN + from] as usize);
            if n == d {
                continue;
            }
            let col = &s[from * MAXC..(from + 1) * MAXC];
            // The descending sequence (of any suits) at the top of the column.
            let mut start = n - 1;
            while start > d && col[start - 1] % 13 == col[start] % 13 + 1 {
                start -= 1;
            }
            for p in start..n {
                let bottom = col[p];
                let suit = bottom / 13;
                // Cutting inside a same-suit run splits it.
                let split = p > start && col[p - 1] / 13 == suit;
                if split && splits == 0 {
                    continue;
                }
                // Where it can go: onto a card one rank higher, or into the
                // first empty column, in the order of the columns.
                let mut places = on_rank[(bottom % 13 + 1) as usize] & !(1 << from);
                if ne > 0 && p != 0 && !(split && splits < 2) {
                    places |= 1 << empty_cols[0];
                }
                if places == 0 {
                    continue;
                }
                // The same-suit pieces of what moves, bottom first.
                let mut np = 0;
                let mut a = p;
                while a < n {
                    let mut b = a + 1;
                    while b < n && col[b] / 13 == col[b - 1] / 13 {
                        b += 1;
                    }
                    sizes[np] = (b - a) as u8;
                    np += 1;
                    a = b;
                }
                while places != 0 {
                    let to = places.trailing_zeros() as usize;
                    places &= places - 1;
                    let tl = s[LEN + to] as usize;
                    let tcol = &s[to * MAXC..(to + 1) * MAXC];
                    if tl != 0 && split && splits < 3 && tcol[tl - 1] / 13 != suit {
                        continue;
                    }
                    if tl + n - p > MAXC {
                        continue;
                    }
                    let mut nf = 0;
                    for &e in &empty_cols[..ne] {
                        if e as usize != to {
                            free[nf] = e;
                            nf += 1;
                        }
                    }
                    if np > 1 << nf {
                        continue;
                    }
                    if require != 0 && require & (1 << from | 1 << to) == 0 {
                        continue;
                    }
                    let k = self.count;
                    self.room(k);
                    if let Mode::Peek { empty, deals, best } = mode {
                        // (A position reached twice has the same score both times.)
                        let node = &mut self.nodes[k];
                        *node = p0;
                        move_pieces(&mut node.s, from, to, &sizes, 0, np, &free, 0, &mut None, &mut false);
                        node.evaluate_col(from, cfg);
                        node.evaluate_col(to, cfg);
                        node.evaluate_sum(cfg);
                        if *deals > 0 && (node.ev_cards as usize) < NUM_COLS {
                            continue; // (lost)
                        }
                        best[0] = best[0].max(node.ev_base + cfg.empty * node.ev_empties as i32);
                        best[1] = best[1].max(node.ev_base + *empty * node.ev_empties as i32);
                        continue;
                    }
                    // The position's hash before building it: only two
                    // columns change, unless a suit completes.
                    let (td, nt) = (s[DOWN + to] as usize, tl + n - p);
                    let mut completes = false;
                    if nt - td >= 13 && col[n - 1] % 13 == 0 {
                        // The run at the top of the new column, through the join.
                        let (mut r, mut x) = (1, col[n - 1]);
                        while r < 13 {
                            if nt < r + 1 || nt - r - 1 < td {
                                break;
                            }
                            let j = nt - r - 1; // the card under the run so far
                            let y = if j >= tl { col[p + j - tl] } else { tcol[j] };
                            if y != x.wrapping_add(1) || y % 13 == 0 {
                                break;
                            }
                            x = y;
                            r += 1;
                        }
                        completes = r == 13;
                    }
                    let (mut ha, mut hb, mut fh, mut th) = (0, 0, (0, 0), (0, 0));
                    if !completes {
                        // (the card turned will be BLANK)
                        if p > 0 && p == d {
                            tmp[d - 1] = BLANK;
                            fh = col_hash(&tmp, p, d - 1);
                        } else {
                            fh = col_hash(col, p, d);
                        }
                        tmp[td..tl].copy_from_slice(&tcol[td..tl]);
                        tmp[tl..nt].copy_from_slice(&col[p..n]);
                        th = col_hash(&tmp, nt, td);
                        ha = p0.pa.wrapping_sub(p0.ca[from]).wrapping_sub(p0.ca[to]).wrapping_add(fh.0).wrapping_add(th.0);
                        hb = p0.pb.wrapping_sub(p0.cb[from]).wrapping_sub(p0.cb[to]).wrapping_add(fh.1).wrapping_add(th.1);
                        if !self.seen.insert(ha, hb) {
                            continue;
                        }
                    }
                    let node = &mut self.nodes[k];
                    *node = p0;
                    let at = self.steps.len();
                    let mut flip = false;
                    move_pieces(&mut node.s, from, to, &sizes, 0, np, &free, 0, &mut Some(&mut self.steps), &mut flip);
                    if completes {
                        node.rehash_col(from);
                        node.rehash_col(to);
                        node.sum_hash();
                        if !self.seen.insert(node.pa, node.pb) {
                            self.steps.truncate(at);
                            continue;
                        }
                    } else {
                        // The two columns as hashed above (the columns the pieces went by are empty again).
                        node.ca[from] = fh.0;
                        node.cb[from] = fh.1;
                        node.ca[to] = th.0;
                        node.cb[to] = th.1;
                        node.pa = ha;
                        node.pb = hb;
                    }
                    self.count += 1;
                    node.parent = i as u32;
                    node.step = (at as u32, self.steps.len() as u32);
                    node.leaf = flip;
                    node.touched = p0.touched | 1 << from | 1 << to;
                    node.evaluate_col(from, cfg);
                    node.evaluate_col(to, cfg);
                    node.evaluate_sum(cfg);
                }
            }
        }
    }

    /// Every line from the position `root`: the nodes 0 (the root) to
    /// count - 1.
    fn search(&mut self, root: &[u8], cfg: &Config, splits: u8, beam: usize) {
        self.nodes[0].s.copy_from_slice(root);
        self.steps.clear();
        self.search_from(0, cfg, splits, cfg.max_steps, beam);
    }

    /// The same from the position already in place as node r: the nodes r
    /// to count - 1 (those below r are left alone, but for the table of
    /// positions reached, which is this search's from here on).
    fn search_from(&mut self, r: usize, cfg: &Config, splits: u8, max_steps: usize, beam: usize) {
        self.count = r + 1;
        self.room(self.count);
        let root = &mut self.nodes[r];
        for c in 0..NUM_COLS {
            root.rehash_col(c);
        }
        root.sum_hash();
        self.seen.reset();
        self.seen.insert(root.pa, root.pb);
        root.parent = u32::MAX;
        root.leaf = false;
        root.touched = 0;
        root.evaluate(cfg);
        let mut frontier = std::mem::take(&mut self.frontier);
        frontier.clear();
        frontier.push(r as u32);
        for depth in 0..max_steps {
            let first = self.count;
            for &i in &frontier {
                let require = if cfg.touch && depth > 0 { self.nodes[i as usize].touched } else { 0 };
                self.expand(i as usize, splits, require, cfg, &mut Mode::Nodes);
            }
            frontier.clear();
            frontier.extend((first..self.count).filter(|&k| !self.nodes[k].leaf).map(|k| k as u32));
            if beam > 0 && frontier.len() > beam {
                // The best by each score, the earlier of two that score the
                // same: by one number for both.
                let m = frontier.len();
                self.keep.clear();
                self.keep.resize(self.count - first, false);
                for (empty, n) in [(cfg.empty, beam - (beam >> 1)), (cfg.deal_empty, beam >> 1)] {
                    self.keys.clear();
                    self.keys.extend(frontier.iter().map(|&k| {
                        let node = &self.nodes[k as usize];
                        ((node.ev_base + empty * node.ev_empties as i32 + 1073741824) as u64) << 21 | (2097151 - k as u64)
                    }));
                    if n < m {
                        self.keys.select_nth_unstable(m - n);
                    }
                    for &key in &self.keys[m - n..] {
                        self.keep[2097151 - (key & 2097151) as usize - first] = true;
                    }
                }
                frontier.retain(|&k| self.keep[k as usize - first]);
            }
            if frontier.is_empty() {
                break;
            }
        }
        self.frontier = frontier;
    }

    /// Expectimax for the best `cfg.expect_top` lines that turn a card, by
    /// the normal score and by the other (an empty column worth `empty`):
    /// (node, [normal, other]), each the mean, over the cards `unseen` that
    /// can come up, of the best score a smaller search reaches with that
    /// card there. The smaller searches use the nodes above the search's own.
    fn expect_flips(&mut self, deals_left: usize, visited: &Keys, cfg: &Config, empty: i32, unseen: &[u8; 52]) -> Vec<(usize, [i32; 2])> {
        let n = self.count;
        let mut picked: Vec<usize> = Vec::new();
        for e in [cfg.empty, empty] {
            let mut leaves: Vec<(i32, usize)> = (1..n)
                .filter(|&k| self.nodes[k].leaf)
                .map(|k| (self.nodes[k].value(deals_left, e), k))
                .filter(|&(v, k)| v > LOST && !visited.contains(&key_of(self.nodes[k].pa, self.nodes[k].pb)))
                .collect();
            leaves.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
            for &(_, k) in leaves.iter().take(cfg.expect_top) {
                if !picked.contains(&k) {
                    picked.push(k);
                }
            }
        }
        let mut out = Vec::new();
        if picked.is_empty() {
            return out;
        }
        let total: i64 = unseen.iter().map(|&x| x as i64).sum();
        let steps = self.steps.len();
        for k in picked {
            // The card turned: the only face-up card of its column.
            let s = &self.nodes[k].s;
            let at = (0..NUM_COLS)
                .find_map(|c| {
                    let len = s[LEN + c] as usize;
                    (len > 0 && s[DOWN + c] as usize + 1 == len && s[c * MAXC + len - 1] == BLANK).then(|| c * MAXC + len - 1)
                })
                .expect("a turned card");
            let mut sum = [0i64; 2];
            for card in 0..52 {
                if unseen[card] == 0 {
                    continue;
                }
                self.room(n);
                self.nodes[n] = self.nodes[k];
                self.nodes[n].s[at] = card as u8;
                let mut best = [LOST; 2];
                if cfg.expect_steps == 1 {
                    // One step deep: the scores are all that is wanted of the positions.
                    self.count = n + 1;
                    let node = &mut self.nodes[n];
                    node.evaluate(cfg);
                    if !(deals_left > 0 && (node.ev_cards as usize) < NUM_COLS) {
                        best = [node.ev_base + cfg.empty * node.ev_empties as i32, node.ev_base + empty * node.ev_empties as i32];
                    }
                    let mut mode = Mode::Peek { empty, deals: deals_left, best };
                    self.expand(n, cfg.splits, 0, cfg, &mut mode);
                    if let Mode::Peek { best: b, .. } = mode {
                        best = b;
                    }
                } else {
                    self.search_from(n, cfg, cfg.splits, cfg.expect_steps, cfg.expect_beam);
                    for node in &self.nodes[n..self.count] {
                        if deals_left > 0 && (node.ev_cards as usize) < NUM_COLS {
                            continue; // (lost)
                        }
                        best[0] = best[0].max(node.ev_base + cfg.empty * node.ev_empties as i32);
                        best[1] = best[1].max(node.ev_base + empty * node.ev_empties as i32);
                    }
                    self.steps.truncate(steps);
                }
                for m in 0..2 {
                    sum[m] += unseen[card] as i64 * best[m].max(LOST / 2) as i64;
                }
            }
            out.push((k, [(sum[0] / total) as i32, (sum[1] / total) as i32]));
        }
        self.count = n;
        out
    }

    /// The steps of the line to node k.
    fn line_to(&self, mut k: usize) -> Vec<Vec<u8>> {
        let mut steps = Vec::new();
        while k != 0 {
            let (a, b) = self.nodes[k].step;
            steps.push(self.steps[a as usize..b as usize].to_vec());
            k = self.nodes[k].parent as usize;
        }
        steps.reverse();
        steps
    }

    /// What to do in the position `root` with this many deals left.
    /// `visited` has the keys of the positions never to return to; `unseen`
    /// gives how many of each card the player has not seen.
    pub fn decide(&mut self, root: &[u8], deals_left: usize, visited: &Keys, tempo: &mut Tempo, cfg: &Config, unseen: impl FnOnce() -> [u8; 52]) -> Decision<Vec<Vec<u8>>> {
        self.search(root, cfg, cfg.splits, cfg.beam);
        tempo.work += self.count as u64;
        let empty = if deals_left > 0 { cfg.deal_empty } else { cfg.end_empty };
        let expected = if cfg.expect_top > 0 { self.expect_flips(deals_left, visited, cfg, empty, &unseen()) } else { Vec::new() };
        let count = self.count;
        let nodes = &self.nodes;
        let fresh = |k: usize| !visited.contains(&key_of(nodes[k].pa, nodes[k].pb));
        let scored = |k: usize, mode: usize, e: i32| match expected.iter().find(|x| x.0 == k) {
            Some(x) => x.1[mode],
            None => nodes[k].value(deals_left, e),
        };
        let best_by = |mode: usize, e: i32, flip: i32| {
            let (mut best, mut best_score) = (0, nodes[0].value(deals_left, e));
            for k in 1..count {
                let mut sc = scored(k, mode, e);
                if sc > LOST && nodes[k].leaf {
                    sc += flip;
                }
                if sc > best_score && fresh(k) {
                    best = k;
                    best_score = sc;
                }
            }
            (best, best_score)
        };
        if !tempo.dealing {
            let (best, score) = best_by(0, cfg.empty, 0);
            if best != 0 {
                tempo.turns = nodes[best].leaf;
                tempo.value = score;
                return Decision::Line(self.line_to(best));
            }
        }
        // About to deal or, with the stock gone, to give up.
        let (best, score) = best_by(1, empty, cfg.deal_flip);
        if best != 0 {
            tempo.dealing = true;
            tempo.turns = nodes[best].leaf;
            tempo.value = score;
            return Decision::Line(self.line_to(best));
        }
        if deals_left == 0 {
            return Decision::Stuck;
        }
        if nodes[0].ev_empties == 0 {
            return Decision::Deal;
        }
        // An empty column that no line fills at a profit: fill it as cheaply
        // as can be, splitting runs if there is no other way.
        tempo.dealing = true;
        let fill = |s: &Search| {
            let (mut at, mut most) = (0, 0);
            for k in 1..s.count {
                let node = &s.nodes[k];
                if node.ev_empties != 0 || visited.contains(&key_of(node.pa, node.pb)) {
                    continue;
                }
                let v = node.value(deals_left, empty);
                if at == 0 || v > most {
                    at = k;
                    most = v;
                }
            }
            if at != 0 && most > LOST { at } else { 0 }
        };
        let mut k = fill(self);
        if k == 0 {
            self.search(root, cfg, 3, cfg.beam.max(100));
            tempo.work += self.count as u64;
            k = fill(self);
            if k == 0 {
                return Decision::Stuck;
            }
        }
        tempo.turns = self.nodes[k].leaf;
        tempo.value = self.nodes[k].value(deals_left, empty);
        Decision::Line(self.line_to(k))
    }

    /// The moves to play now: the line decided on or, with `cfg.replan`, its
    /// first steps only, what is left of it being kept and played on from
    /// unless the line decided on next ends better (or in the other mode).
    fn choose(&mut self, root: &[u8], deals_left: usize, visited: &Keys, tempo: &mut Tempo, cfg: &Config, unseen: impl FnOnce() -> [u8; 52]) -> Decision<Vec<u8>> {
        let line = match self.decide(root, deals_left, visited, tempo, cfg, unseen) {
            Decision::Line(line) => line,
            Decision::Deal => return Decision::Deal,
            Decision::Stuck => return Decision::Stuck,
        };
        if cfg.replan == 0 {
            return Decision::Line(line.concat());
        }
        if tempo.plan.is_empty() || tempo.dealing != tempo.plan_dealing || tempo.value > tempo.plan_value {
            tempo.plan = line;
            tempo.plan_value = tempo.value;
            tempo.plan_dealing = tempo.dealing;
        }
        let n = cfg.replan.min(tempo.plan.len());
        Decision::Line(tempo.plan.drain(..n).flatten().collect())
    }

    /// Play the game on from the position `s`, changing it, with the stock
    /// (dealt from the end, a card for each column from the first) until it
    /// is won or the player gives up. With `moves` the moves go there, three
    /// bytes each (255s for a deal); with `to_show` it stops right after the
    /// first move that turns a card or deals. Returns whether it stopped at
    /// a card turned, and the positions looked at. `cfg` has the
    /// configuration for each number of deals left.
    pub fn play_out(&mut self, s: &mut [u8], stock: &[u8], cfg: &[Config; 6], mut moves: Option<&mut Vec<u8>>, to_show: bool) -> (bool, u64) {
        let mut visited = Keys::default();
        let mut tempo = Tempo::default();
        let (mut left, mut played) = (stock.len(), 0);
        let progress = |s: &[u8], left: usize| (s[DOWN..DOWN + NUM_COLS].iter().map(|&d| d as usize).sum::<usize>(), left, s[DONE]);
        while s[DONE] < 8 && played < 5000 {
            let before = progress(s, left);
            // How many of each card are face down or in the stock.
            let unseen = || {
                let mut counts = [0u8; 52];
                for c in 0..NUM_COLS {
                    for &card in &s[c * MAXC..c * MAXC + s[DOWN + c] as usize] {
                        counts[card as usize] += 1;
                    }
                }
                for &card in &stock[..left] {
                    counts[card as usize] += 1;
                }
                counts
            };
            let d = self.choose(s, left / NUM_COLS, &visited, &mut tempo, &cfg[left / NUM_COLS], unseen);
            visited.insert(key_of(self.nodes[0].pa, self.nodes[0].pb)); // (the position it stood in, as the search hashed it)
            match d {
                Decision::Stuck => break,
                Decision::Deal => {
                    played += 1;
                    if let Some(moves) = &mut moves {
                        moves.extend([255, 255, 255]);
                    }
                    if (0..NUM_COLS).any(|c| s[LEN + c] as usize >= MAXC) {
                        break; // a column too long for the search ends the game
                    }
                    for c in 0..NUM_COLS {
                        left -= 1;
                        s[c * MAXC + s[LEN + c] as usize] = stock[left];
                        s[LEN + c] += 1;
                    }
                    for c in 0..NUM_COLS {
                        remove_if_complete(s, c, None);
                    }
                }
                Decision::Line(line) => {
                    for mv in line.chunks_exact(3) {
                        let turned = apply_move(s, mv[0] as usize, mv[1] as usize, mv[2] as usize, None);
                        if let Some(moves) = &mut moves {
                            moves.extend_from_slice(mv);
                        }
                        if turned && to_show {
                            return (true, tempo.work); // (a step may go on after its card turns: the rest is left out)
                        }
                    }
                    played += line.len() / 3;
                }
            }
            let after = progress(s, left);
            if after != before {
                tempo.dealing = false;
                tempo.plan.clear();
                if to_show && (after.0, after.1) != (before.0, before.1) {
                    break;
                }
            }
        }
        (false, tempo.work)
    }
}
