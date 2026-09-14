//! Perfect-information ("peeking") solver.
//!
//! Given a game state including the face-down cards and the stock order, this
//! decides whether the game can still be won.
//!
//! # Approach
//!
//! The naive state graph of Spider is dominated by *reversible* shuffling: a
//! run sitting on a card one rank higher (of any suit) or in an empty column
//! can be moved to another such spot and back again for free. Searching over
//! individual positions therefore wastes almost all its effort permuting runs
//! among equivalent parents.
//!
//! Instead the search works over **equivalence classes** of positions that are
//! mutually reachable through reversible moves. A class is enumerated by a
//! breadth-first walk over reversible moves and is identified by the minimum
//! hash of its members, so however the search enters it, it is recognised as
//! the same node. Edges between classes are the *irreversible* moves:
//!
//! * turning over a face-down card,
//! * completing a K..A suit run (cards leave the tableau),
//! * detaching a run from a "wrong" parent (a card that is not one rank
//!   higher, which it can never return to),
//! * joining a run onto its same-suit predecessor (undoing that would need a
//!   split, see below),
//! * dealing from the stock.
//!
//! Within one stock stage every such edge increases the potential
//! (completed suits, then fewer hidden cards and wrong attachments, then more
//! same-suit adjacencies), so the class graph is a DAG and depth is bounded by
//! a few dozen edges. Between stages the search commits to a deal only from
//! classes that have no other progress, and falls back to other deal points
//! once a stage's space is exhausted (depth-first over stages, best-first
//! within a stage).
//!
//! Splitting a same-suit run is legal but almost never useful, so the first
//! pass never splits. If that pass exhausts its space without a win, a second
//! pass re-runs the search with split moves included (as extra edges), so an
//! `Unsolvable` verdict is a proof over the full move set. `Unknown` means the
//! work budget ran out first.
//!
//! Column order is treated as irrelevant (hashes are order-independent). That
//! is exact once the stock is empty; before then it ignores the obscure option
//! of permuting columns through an empty column to change which column a
//! dealt card lands on.

use crate::game::{Card, Game, Move, DEAL_SIZE, NUM_COLS};
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Solvable,
    Unsolvable,
    /// The work budget was exhausted (or the search was cancelled) before a
    /// conclusion was reached.
    Unknown,
}

#[derive(Clone, Debug)]
pub struct SolveResult {
    pub verdict: Verdict,
    /// Work performed: positions enumerated inside classes plus class nodes.
    pub nodes: u64,
    /// Number of equivalence classes expanded.
    pub classes: u64,
    /// Whether the second (split-inclusive) pass was needed.
    pub proof_pass: bool,
    /// Which configuration produced this result.
    pub config: &'static str,
    pub elapsed: Duration,
    /// A winning line, if one was found.
    pub line: Vec<Move>,
}

const MAXC: usize = 48;
/// Largest class enumerated in full. Bigger classes are still handled soundly
/// (they are just not merged with themselves when entered elsewhere).
const CLASS_CAP: usize = 20_000;

/// Compact fixed-size state for the search: no heap allocation per position.
#[derive(Clone)]
struct State {
    cols: [[u8; MAXC]; NUM_COLS],
    len: [u8; NUM_COLS],
    down: [u8; NUM_COLS],
    /// Per-column hashes, kept up to date by `apply`.
    colh: [u64; NUM_COLS],
    deals_done: u8,
    completed: u8,
}

impl State {
    fn from_game(g: &Game) -> State {
        let mut s = State {
            cols: [[0; MAXC]; NUM_COLS],
            len: [0; NUM_COLS],
            down: [0; NUM_COLS],
            colh: [0; NUM_COLS],
            deals_done: 0,
            completed: g.completed.len() as u8,
        };
        for c in 0..NUM_COLS {
            assert!(g.columns[c].len() <= MAXC);
            for (i, card) in g.columns[c].iter().enumerate() {
                s.cols[c][i] = card.0;
            }
            s.len[c] = g.columns[c].len() as u8;
            s.down[c] = g.face_down[c] as u8;
            s.rehash(c);
        }
        s
    }

    fn rehash(&mut self, c: usize) {
        let mut h = mix(0x51_7CC1_B727_220A, self.len[c] as u64 | (self.down[c] as u64) << 8);
        let col = &self.cols[c][..self.len[c] as usize];
        for chunk in col.chunks(8) {
            let mut w = [0u8; 8];
            w[..chunk.len()].copy_from_slice(chunk);
            h = mix(h, u64::from_le_bytes(w));
        }
        self.colh[c] = h;
    }

    #[inline]
    fn top(&self, c: usize) -> u8 {
        self.cols[c][self.len[c] as usize - 1]
    }

    #[inline]
    fn run_len(&self, c: usize) -> usize {
        let n = self.len[c] as usize;
        let d = self.down[c] as usize;
        if n == d {
            return 0;
        }
        let col = &self.cols[c];
        let mut k = 1;
        while n - k > d {
            let upper = col[n - k - 1];
            let lower = col[n - k];
            if upper / 13 == lower / 13 && upper % 13 == lower % 13 + 1 {
                k += 1;
            } else {
                break;
            }
        }
        k
    }

    #[inline]
    fn flip_if_needed(&mut self, c: usize) {
        if self.len[c] > 0 && self.down[c] == self.len[c] {
            self.down[c] -= 1;
        }
    }

    #[inline]
    fn remove_if_complete(&mut self, c: usize) {
        if self.len[c] >= 13 && self.top(c) % 13 == 0 && self.run_len(c) >= 13 {
            self.len[c] -= 13;
            self.completed += 1;
            self.flip_if_needed(c);
        }
    }

    /// Apply a move; returns false (leaving the state unspecified) only if a
    /// column would overflow the fixed buffer, which is treated as illegal.
    fn apply(&mut self, mv: Move, deals: &[[u8; DEAL_SIZE]]) -> bool {
        match mv {
            Move::Move { from, to, count } => {
                let fl = self.len[from] as usize;
                let tl = self.len[to] as usize;
                if tl + count > MAXC {
                    return false;
                }
                for i in 0..count {
                    self.cols[to][tl + i] = self.cols[from][fl - count + i];
                }
                self.len[from] -= count as u8;
                self.len[to] += count as u8;
                self.flip_if_needed(from);
                self.remove_if_complete(to);
                self.rehash(from);
                self.rehash(to);
            }
            Move::Deal => {
                let deal = &deals[self.deals_done as usize];
                if self.len.iter().any(|&l| l as usize >= MAXC) {
                    return false;
                }
                for c in 0..NUM_COLS {
                    self.cols[c][self.len[c] as usize] = deal[c];
                    self.len[c] += 1;
                }
                self.deals_done += 1;
                for c in 0..NUM_COLS {
                    self.remove_if_complete(c);
                    self.rehash(c);
                }
            }
        }
        true
    }

    /// Position hash, independent of column order.
    fn hash(&self) -> u64 {
        let mut hs = self.colh;
        hs.sort_unstable();
        let mut h: u64 = 0x9E3779B97F4A7C15 ^ (self.deals_done as u64) << 8 ^ self.completed as u64;
        for x in hs {
            h = mix(h, x);
        }
        h
    }

    /// Static evaluation: higher is closer to winning.
    fn eval(&self, w: &Weights) -> i32 {
        let mut score: i32 = w.completed * self.completed as i32;
        let mut empties = 0;
        for c in 0..NUM_COLS {
            let n = self.len[c] as usize;
            if n == 0 {
                empties += 1;
                continue;
            }
            let d = self.down[c] as usize;
            score -= w.hidden * d as i32;
            let col = &self.cols[c];
            let mut run = 1;
            for i in d.max(1)..n {
                let upper = col[i - 1];
                let lower = col[i];
                if upper % 13 == lower % 13 + 1 {
                    if upper / 13 == lower / 13 {
                        score += w.same;
                        run += 1;
                    } else {
                        score += w.diff;
                        score += w.run_sq * run * run / 16;
                        run = 1;
                    }
                } else {
                    score -= w.wrong;
                    score += w.run_sq * run * run / 16;
                    run = 1;
                }
            }
            score += w.run_sq * run * run / 16;
            if d == 0 && col[0] % 13 == 12 {
                score += w.king_base;
            }
        }
        score + w.empty * empties
    }
}

/// Evaluation weights.
#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub completed: i32,
    pub hidden: i32,
    pub same: i32,
    pub diff: i32,
    pub wrong: i32,
    pub empty: i32,
    pub king_base: i32,
    /// Bonus per same-suit run of length L: run_sq * L^2 / 16.
    pub run_sq: i32,
}

impl Default for Weights {
    fn default() -> Weights {
        Weights { completed: 1000, hidden: 12, same: 4, diff: 1, wrong: 2, empty: 30, king_base: 3, run_sq: 0 }
    }
}

/// Search parameters. `Config::from_env` applies SPIDER_* overrides, which is
/// how the defaults were tuned; `Config::portfolio` gives a set of diverse
/// configurations that solve different deals, for running in parallel.
#[derive(Clone, Debug)]
pub struct Config {
    pub name: &'static str,
    pub weights: Weights,
    /// Max deal points taken from one class (the best by post-deal score).
    pub deals_per_class: usize,
    /// Added to a deal candidate's key per stock stage already dealt.
    pub deal_bonus: i32,
    /// Penalty per failed sibling deal from the same stage exploration.
    pub sibling_tax: i32,
    /// Work cap per stage exploration; None = budget / STAGE_CAP_DIV.
    pub stage_cap: Option<u64>,
    /// Work cap for the final (stock-empty) stage; None = budget / END_CAP_DIV.
    pub end_cap: Option<u64>,
    /// Treat same-suit joins as reversible once the stock is empty.
    pub end_splits: bool,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            name: "base",
            weights: Weights::default(),
            deals_per_class: DEALS_PER_CLASS,
            deal_bonus: DEAL_BONUS,
            sibling_tax: SIBLING_TAX,
            stage_cap: None,
            end_cap: None,
            end_splits: false,
        }
    }
}

impl Config {
    pub fn from_env() -> Config {
        let d = Config::default();
        let w = d.weights;
        Config {
            name: "env",
            weights: Weights {
                completed: env_or("SPIDER_W_COMPLETED", w.completed),
                hidden: env_or("SPIDER_W_HIDDEN", w.hidden),
                same: env_or("SPIDER_W_SAME", w.same),
                diff: env_or("SPIDER_W_DIFF", w.diff),
                wrong: env_or("SPIDER_W_WRONG", w.wrong),
                empty: env_or("SPIDER_W_EMPTY", w.empty),
                king_base: env_or("SPIDER_W_KING", w.king_base),
                run_sq: env_or("SPIDER_W_RUNSQ", w.run_sq),
            },
            deals_per_class: env_or("SPIDER_DEALS_PER_CLASS", d.deals_per_class),
            deal_bonus: env_or("SPIDER_DEAL_BONUS", d.deal_bonus),
            sibling_tax: env_or("SPIDER_SIBLING_TAX", d.sibling_tax),
            stage_cap: std::env::var("SPIDER_STAGE_CAP").ok().and_then(|v| v.parse().ok()),
            end_cap: std::env::var("SPIDER_END_CAP").ok().and_then(|v| v.parse().ok()),
            end_splits: env_or::<u8>("SPIDER_END_SPLITS", 0) != 0,
        }
    }

    /// Diverse configurations; the first `n` are meant to run in parallel.
    pub fn portfolio(n: usize) -> Vec<Config> {
        let base = Config::default();
        let mut v = vec![
            base.clone(),
            Config { name: "runsq", weights: Weights { run_sq: 8, ..base.weights }, ..base.clone() },
            Config { name: "tax", sibling_tax: 3, ..base.clone() },
            Config { name: "hidden", weights: Weights { hidden: 20, ..base.weights }, ..base.clone() },
            Config { name: "dpc1", deals_per_class: 1, ..base.clone() },
            Config { name: "bonus", deal_bonus: 20, ..base.clone() },
            Config { name: "empty", weights: Weights { empty: 15, ..base.weights }, ..base.clone() },
            Config { name: "same", weights: Weights { same: 8, diff: 0, ..base.weights }, ..base.clone() },
        ];
        v.truncate(n.max(1));
        v
    }
}

#[inline]
fn mix(h: u64, v: u64) -> u64 {
    let x = (h ^ v).wrapping_mul(0xFF51AFD7ED558CCD);
    (x ^ (x >> 33)).rotate_left(23)
}

/// Identity hasher: keys are already well-mixed u64s.
#[derive(Default)]
struct IdHasher(u64);
impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, _: &[u8]) {
        unreachable!()
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = v;
    }
}
type IdBuild = BuildHasherDefault<IdHasher>;

/// Fully packed position: all tableau cards concatenated.
#[derive(Clone)]
struct Compact {
    cards: [u8; 104],
    len: [u8; NUM_COLS],
    down: [u8; NUM_COLS],
    deals_done: u8,
    completed: u8,
}

impl Compact {
    fn from_state(s: &State) -> Compact {
        let mut c = Compact {
            cards: [0; 104],
            len: s.len,
            down: s.down,
            deals_done: s.deals_done,
            completed: s.completed,
        };
        let mut at = 0;
        for col in 0..NUM_COLS {
            let n = s.len[col] as usize;
            c.cards[at..at + n].copy_from_slice(&s.cols[col][..n]);
            at += n;
        }
        c
    }
    fn to_state(&self) -> State {
        let mut s = State {
            cols: [[0; MAXC]; NUM_COLS],
            len: self.len,
            down: self.down,
            colh: [0; NUM_COLS],
            deals_done: self.deals_done,
            completed: self.completed,
        };
        let mut at = 0;
        for col in 0..NUM_COLS {
            let n = self.len[col] as usize;
            s.cols[col][..n].copy_from_slice(&self.cards[at..at + n]);
            at += n;
            s.rehash(col);
        }
        s
    }
}

/// A member of an equivalence class, with how it was reached from the entry.
struct Member {
    state: State,
    parent: u32,
    mv: Move,
}

/// An irreversible move out of a class.
struct Exit {
    member: u32,
    mv: Move,
    result: State,
}

struct Class {
    members: Vec<Member>,
    exits: Vec<Exit>,
    id: u64,
    /// Index into `exits` of a move that wins outright.
    win: Option<usize>,
}

/// An expanded class node: the position it was entered at, and the exit of
/// the parent class that led here (for reconstructing the winning line).
struct SNode {
    parent: u32,
    exit_idx: u32,
    state: Compact,
}

const NO_PARENT: u32 = u32::MAX;

/// A child position waiting in a stage's priority queue. Ordered by score,
/// then most recently pushed first (keeps equal-score exploration depth-first).
struct Pending {
    key: i32,
    seq: u64,
    parent: u32,
    exit_idx: u32,
    state: Compact,
}
impl PartialEq for Pending {
    fn eq(&self, o: &Self) -> bool {
        self.key == o.key && self.seq == o.seq
    }
}
impl Eq for Pending {}
impl PartialOrd for Pending {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Pending {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (self.key, self.seq).cmp(&(o.key, o.seq))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Outcome {
    Solvable,
    Unsolvable,
    /// Exhausted what was searched without a win, but something was cut short.
    NotFound,
    Unknown,
}

/// Fraction of the budget spent enumerating one stage's classes before moving
/// on to deals (too large starves later stages, too small deals blindly).
const STAGE_CAP_DIV: u64 = 10;
const STAGE_CAP_MIN: u64 = 20_000;
const END_CAP_DIV: u64 = 10;
const DEALS_PER_CLASS: usize = 4;
const DEAL_BONUS: i32 = 0;
/// Score penalty applied to a deal candidate for every sibling (same parent
/// exploration) that has already been tried without success; spreads the
/// search across branches instead of exhausting one bad stage's deal points.
const SIBLING_TAX: i32 = 0;

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// A queued deal point, ordered by score then most recent first.
struct DealCand {
    key: i32,
    seq: u64,
    nid: u32,
    ei: u32,
    /// Stage exploration that produced this candidate.
    origin: u32,
    /// How many of `origin`'s failures have already been charged to `key`.
    charged: u32,
}
impl PartialEq for DealCand {
    fn eq(&self, o: &Self) -> bool {
        self.key == o.key && self.seq == o.seq
    }
}
impl Eq for DealCand {}
impl PartialOrd for DealCand {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for DealCand {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (self.key, self.seq).cmp(&(o.key, o.seq))
    }
}

pub struct Solver {
    deals: Vec<[u8; DEAL_SIZE]>,
    /// Class id -> id of the stage exploration that expanded it.
    seen: HashMap<u64, u32, IdBuild>,
    /// Whether each stage exploration enumerated its whole stage.
    search_complete: Vec<bool>,
    /// Position hash -> id of the (already expanded) class it belongs to.
    member_of: HashMap<u64, u64, IdBuild>,
    deal_queue: BinaryHeap<DealCand>,
    cfg: Config,
    /// Failed deal attempts per stage exploration id.
    failures: Vec<u32>,
    nodes: Vec<SNode>,
    work: u64,
    classes: u64,
    budget: u64,
    cancel: Option<Arc<AtomicBool>>,
    work_counter: Option<Arc<AtomicU64>>,
    aborted: bool,
    splits: bool,
    stage_cap: u64,
    /// Work cap for exploring the final (stock-empty) stage.
    end_cap: u64,
    seq: u64,
    win: Option<(u32, u32)>,
}

impl Solver {
    /// `budget` bounds the work: positions enumerated within classes plus
    /// class nodes created. Uses `Config::from_env()`.
    pub fn new(g: &Game, budget: u64) -> Solver {
        Solver::with_config(g, budget, Config::from_env())
    }

    pub fn with_config(g: &Game, budget: u64, cfg: Config) -> Solver {
        // Deals are taken from the end of the stock, ten at a time, column 0 first.
        let mut deals = Vec::new();
        let mut stock: Vec<Card> = g.stock.clone();
        while stock.len() >= DEAL_SIZE {
            let mut d = [0u8; DEAL_SIZE];
            for slot in d.iter_mut() {
                *slot = stock.pop().unwrap().0;
            }
            deals.push(d);
        }
        Solver {
            deals,
            seen: HashMap::default(),
            search_complete: Vec::new(),
            member_of: HashMap::default(),
            deal_queue: BinaryHeap::new(),
            stage_cap: cfg.stage_cap.unwrap_or((budget / STAGE_CAP_DIV).max(STAGE_CAP_MIN)),
            end_cap: cfg.end_cap.unwrap_or((budget / END_CAP_DIV).max(STAGE_CAP_MIN)),
            cfg,
            failures: Vec::new(),
            nodes: Vec::new(),
            work: 0,
            classes: 0,
            budget,
            cancel: None,
            work_counter: None,
            aborted: false,
            splits: false,
            seq: 0,
            win: None,
        }
    }

    pub fn solve(&mut self, g: &Game) -> SolveResult {
        let start = Instant::now();
        let root = State::from_game(g);
        let mut outcome = if root.completed == 8 {
            Outcome::Solvable
        } else {
            let root_id = self.push_node(NO_PARENT, 0, &root);
            self.search(root_id)
        };
        let mut proof_pass = false;
        if outcome == Outcome::Unsolvable && root.completed < 8 {
            proof_pass = true;
            self.splits = true;
            self.seen.clear();
            self.member_of.clear();
            self.nodes.clear();
            self.search_complete.clear();
            self.deal_queue.clear();
            let root_id = self.push_node(NO_PARENT, 0, &root);
            outcome = self.search(root_id);
        }
        let verdict = match outcome {
            Outcome::Solvable => Verdict::Solvable,
            Outcome::Unsolvable => Verdict::Unsolvable,
            Outcome::NotFound | Outcome::Unknown => Verdict::Unknown,
        };
        let line = if verdict == Verdict::Solvable { self.build_line() } else { Vec::new() };
        SolveResult {
            verdict,
            nodes: self.work,
            classes: self.classes,
            proof_pass,
            config: self.cfg.name,
            elapsed: start.elapsed(),
            line,
        }
    }

    #[inline]
    fn stock_left(&self, s: &State) -> bool {
        (s.deals_done as usize) < self.deals.len()
    }

    fn push_node(&mut self, parent: u32, exit_idx: u32, s: &State) -> u32 {
        self.nodes.push(SNode { parent, exit_idx, state: Compact::from_state(s) });
        (self.nodes.len() - 1) as u32
    }

    fn tick(&mut self) -> bool {
        if let Some(c) = &self.work_counter {
            c.store(self.work, Ordering::Relaxed);
        }
        if let Some(c) = &self.cancel {
            if c.load(Ordering::Relaxed) {
                self.aborted = true;
            }
        }
        if self.work >= self.budget {
            self.aborted = true;
        }
        self.aborted
    }

    /// Every legal move except dealing. Empty columns are interchangeable, so
    /// only the first is ever targeted. Sub-runs of a same-suit run only move
    /// when `self.splits` is set.
    fn legal_moves(&self, s: &State, out: &mut Vec<Move>) {
        out.clear();
        let first_empty = s.len.iter().position(|&l| l == 0);
        let splits = self.splits || (self.cfg.end_splits && !self.stock_left(s));
        for from in 0..NUM_COLS {
            let fl = s.len[from] as usize;
            if fl == 0 {
                continue;
            }
            let run = s.run_len(from);
            let top_rank = (s.top(from) % 13) as i32;
            for to in 0..NUM_COLS {
                if to == from {
                    continue;
                }
                let tl = s.len[to] as usize;
                if tl == 0 {
                    if first_empty != Some(to) {
                        continue;
                    }
                    let lo = if splits { 1 } else { run };
                    for k in lo..=run {
                        if k == fl {
                            continue; // whole column onto another empty: no-op
                        }
                        out.push(Move::Move { from, to, count: k });
                    }
                } else {
                    let k = (s.cols[to][tl - 1] % 13) as i32 - top_rank;
                    if k >= 1 && k as usize <= run && (splits || k as usize == run) {
                        out.push(Move::Move { from, to, count: k as usize });
                    }
                }
            }
        }
    }

    /// A move is reversible when the moved run can immediately be moved back
    /// as a whole: nothing was turned over or removed, the card it left behind
    /// is one rank higher than the run's bottom (or the column was left
    /// empty), and it did not join a same-suit predecessor.
    #[inline]
    fn reversible(&self, s: &State, t: &State, mv: Move) -> bool {
        let (from, to, count) = match mv {
            Move::Deal => return false,
            Move::Move { from, to, count } => (from, to, count),
        };
        if t.completed != s.completed || t.down[from] != s.down[from] {
            return false;
        }
        let bottom = s.cols[from][s.len[from] as usize - count];
        let join_reversible = self.splits || (self.cfg.end_splits && !self.stock_left(s));
        if !join_reversible && s.len[to] > 0 && s.top(to) / 13 == bottom / 13 {
            return false; // same-suit join (cannot be undone without a split)
        }
        if t.len[from] == 0 {
            return true;
        }
        t.top(from) % 13 == bottom % 13 + 1
    }

    /// Enumerate the equivalence class of `entry` under reversible moves and
    /// collect its irreversible exits.
    fn expand_class(&mut self, entry: &State) -> Class {
        let stock_left = self.stock_left(entry);
        let mut members: Vec<Member> = vec![Member { state: entry.clone(), parent: 0, mv: Move::Deal }];
        let mut exits: Vec<Exit> = Vec::new();
        let mut local: HashMap<u64, u32, IdBuild> = HashMap::default();
        let mut min_hash = entry.hash();
        local.insert(min_hash, 0);
        let mut moves = Vec::with_capacity(48);
        let mut win = None;
        let mut i = 0;
        'bfs: while i < members.len() {
            let s = members[i].state.clone();
            self.legal_moves(&s, &mut moves);
            for &mv in &moves {
                let mut t = s.clone();
                if !t.apply(mv, &self.deals) {
                    continue;
                }
                if t.completed == 8 {
                    win = Some(exits.len());
                    exits.push(Exit { member: i as u32, mv, result: t });
                    break 'bfs;
                }
                if self.reversible(&s, &t, mv) {
                    if members.len() >= CLASS_CAP {
                        continue;
                    }
                    let h = t.hash();
                    if let std::collections::hash_map::Entry::Vacant(e) = local.entry(h) {
                        e.insert(members.len() as u32);
                        min_hash = min_hash.min(h);
                        members.push(Member { state: t, parent: i as u32, mv });
                    }
                } else {
                    exits.push(Exit { member: i as u32, mv, result: t });
                }
            }
            if stock_left && s.len.iter().all(|&l| l > 0) {
                let mut t = s.clone();
                if t.apply(Move::Deal, &self.deals) {
                    if t.completed == 8 {
                        win = Some(exits.len());
                    }
                    exits.push(Exit { member: i as u32, mv: Move::Deal, result: t });
                    if win.is_some() {
                        break 'bfs;
                    }
                }
            }
            i += 1;
        }
        self.work += members.len() as u64;
        self.classes += 1;
        let complete = members.len() < CLASS_CAP;
        let id = if complete { min_hash } else { entry.hash() };
        for (h, _) in local {
            self.member_of.insert(h, id);
        }
        Class { members, exits, id, win }
    }

    /// Explore one stock stage from class node `entry`: best-first over all
    /// classes reachable without dealing, up to a per-stage work cap. Deal
    /// exits are pushed onto the global candidate queue. Returns whether the
    /// stage was enumerated completely (needed for an Unsolvable proof).
    fn explore_stage(&mut self, entry: u32) -> Outcome {
        let search_id = self.search_complete.len() as u32;
        self.search_complete.push(false);
        self.failures.push(0);
        let mut heap: BinaryHeap<Pending> = BinaryHeap::new();
        let mut complete = true;
        let entry_node = &self.nodes[entry as usize];
        let entry_state = entry_node.state.to_state();
        let w = self.cfg.weights;
        heap.push(Pending {
            key: entry_state.eval(&w),
            seq: 0,
            parent: entry_node.parent,
            exit_idx: entry_node.exit_idx,
            state: entry_node.state.clone(),
        });
        let debug = std::env::var_os("SPIDER_DEBUG").is_some();
        let (mut dup, start_work) = (0u64, self.work);
        let (mut classes, mut members_total, mut biggest, mut deals) = (0u64, 0u64, 0usize, 0u64);
        let indent = "  ".repeat(entry_state.deals_done as usize);

        while let Some(p) = heap.pop() {
            if self.tick() {
                return Outcome::Unknown;
            }
            let cap = if self.stock_left(&entry_state) { self.stage_cap } else { self.end_cap };
            if self.work - start_work > cap {
                complete = false;
                break;
            }
            let s = p.state.to_state();
            let known = self.member_of.get(&s.hash()).copied();
            let status = known.and_then(|id| self.seen.get(&id).copied());
            match status {
                Some(id) if id == search_id => {
                    dup += 1;
                    continue;
                }
                Some(id) => {
                    if !self.search_complete[id as usize] {
                        complete = false;
                    }
                    continue;
                }
                None => {}
            }
            let cls = self.expand_class(&s);
            classes += 1;
            members_total += cls.members.len() as u64;
            biggest = biggest.max(cls.members.len());
            if let Some(&st) = self.seen.get(&cls.id) {
                // Entered a known class through a position not yet recorded.
                if st == search_id {
                    dup += 1;
                } else if !self.search_complete[st as usize] {
                    complete = false;
                }
                continue;
            }
            self.seen.insert(cls.id, search_id);
            let nid = if p.seq == 0 { entry } else { self.push_node(p.parent, p.exit_idx, &s) };
            if let Some(w) = cls.win {
                self.win = Some((nid, w as u32));
                return Outcome::Solvable;
            }
            let mut class_deals: Vec<(i32, u32)> = Vec::new();
            for (ei, ex) in cls.exits.iter().enumerate() {
                let k = ex.result.eval(&w);
                if ex.mv == Move::Deal {
                    class_deals.push((k, ei as u32));
                } else {
                    self.seq += 1;
                    self.work += 1;
                    heap.push(Pending {
                        key: k,
                        seq: self.seq,
                        parent: nid,
                        exit_idx: ei as u32,
                        state: Compact::from_state(&ex.result),
                    });
                }
            }
            if class_deals.len() > self.cfg.deals_per_class {
                class_deals.sort_unstable_by(|a, b| b.cmp(a));
                class_deals.truncate(self.cfg.deals_per_class);
                complete = false;
            }
            for (k, ei) in class_deals {
                self.seq += 1;
                deals += 1;
                self.deal_queue.push(DealCand {
                    key: k + self.cfg.deal_bonus * (entry_state.deals_done as i32 + 1),
                    seq: self.seq,
                    nid,
                    ei,
                    origin: search_id,
                    charged: 0,
                });
            }
        }
        if debug {
            eprintln!(
                "{indent}stage {} entry eval {}: classes {classes} dup {dup} members {members_total} biggest {biggest} deals {deals} work {} complete {complete}",
                entry_state.deals_done, entry_state.eval(&w), self.work - start_work
            );
        }
        self.search_complete[search_id as usize] = complete;
        if complete {
            Outcome::Unsolvable
        } else {
            Outcome::NotFound
        }
    }

    /// Global best-first search over deal points: explore the root stage, then
    /// repeatedly take the most promising queued deal and explore the stage
    /// after it.
    fn search(&mut self, root: u32) -> Outcome {
        let mut complete = true;
        match self.explore_stage(root) {
            Outcome::Solvable => return Outcome::Solvable,
            Outcome::Unknown => return Outcome::Unknown,
            Outcome::NotFound => complete = false,
            Outcome::Unsolvable => {}
        }
        while let Some(mut c) = self.deal_queue.pop() {
            if self.tick() {
                return Outcome::Unknown;
            }
            let f = self.failures[c.origin as usize];
            if c.charged < f {
                // Siblings failed since this was queued: demote and requeue.
                c.key -= self.cfg.sibling_tax * (f - c.charged) as i32;
                c.charged = f;
                self.deal_queue.push(c);
                continue;
            }
            let s = self.nodes[c.nid as usize].state.to_state();
            let cls = self.expand_class(&s);
            let child = self.push_node(c.nid, c.ei, &cls.exits[c.ei as usize].result);
            match self.explore_stage(child) {
                Outcome::Solvable => return Outcome::Solvable,
                Outcome::Unknown => return Outcome::Unknown,
                Outcome::NotFound => complete = false,
                Outcome::Unsolvable => {}
            }
            self.failures[c.origin as usize] += 1;
        }
        if complete {
            Outcome::Unsolvable
        } else {
            Outcome::NotFound
        }
    }

    /// Reconstruct the winning line by re-expanding each class on the path.
    fn build_line(&mut self) -> Vec<Move> {
        let (mut nid, mut exit_idx) = match self.win {
            Some(w) => w,
            None => return Vec::new(),
        };
        let mut segments: Vec<Vec<Move>> = Vec::new();
        loop {
            let s = self.nodes[nid as usize].state.to_state();
            let cls = self.expand_class(&s);
            let ex = &cls.exits[exit_idx as usize];
            let mut seg = vec![ex.mv];
            let mut m = ex.member;
            while m != 0 {
                seg.push(cls.members[m as usize].mv);
                m = cls.members[m as usize].parent;
            }
            seg.reverse();
            segments.push(seg);
            let n = &self.nodes[nid as usize];
            if n.parent == NO_PARENT {
                break;
            }
            exit_idx = n.exit_idx;
            nid = n.parent;
        }
        segments.reverse();
        segments.concat()
    }
}

/// Run several configurations in parallel; the first win (or proof) ends it.
/// Reports the winning result, else a proof of unsolvability if any thread
/// produced one, else the Unknown result that did the most work.
pub fn solve_portfolio(game: &Game, budget: u64, configs: Vec<Config>) -> SolveResult {
    let h = SolverHandle::spawn_with(game, budget, configs);
    loop {
        if let Some(r) = h.result() {
            return r;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

/// Background solver: one thread per configuration, with cancellation and
/// progress reporting.
pub struct SolverHandle {
    cancel: Arc<AtomicBool>,
    work: Vec<Arc<AtomicU64>>,
    shared: Arc<Mutex<Portfolio>>,
    started: Instant,
}

struct Portfolio {
    pending: usize,
    /// Best result so far: a win beats a proof beats an Unknown.
    best: Option<SolveResult>,
    done: bool,
}

impl SolverHandle {
    pub fn spawn(game: &Game, budget: u64) -> SolverHandle {
        SolverHandle::spawn_with(game, budget, vec![Config::from_env()])
    }

    pub fn spawn_with(game: &Game, budget: u64, configs: Vec<Config>) -> SolverHandle {
        let cancel = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Portfolio { pending: configs.len(), best: None, done: false }));
        let mut work = Vec::new();
        for cfg in configs {
            let counter = Arc::new(AtomicU64::new(0));
            work.push(counter.clone());
            let game = game.clone();
            let (c2, s2) = (cancel.clone(), shared.clone());
            thread::Builder::new()
                .name(format!("spider-solver-{}", cfg.name))
                .spawn(move || {
                    let mut solver = Solver::with_config(&game, budget, cfg);
                    solver.cancel = Some(c2.clone());
                    solver.work_counter = Some(counter.clone());
                    let res = solver.solve(&game);
                    counter.store(res.nodes, Ordering::Relaxed);
                    let mut p = s2.lock().unwrap();
                    p.pending -= 1;
                    let better = match (&p.best, res.verdict) {
                        (_, Verdict::Solvable) => true,
                        (None, _) => true,
                        (Some(b), Verdict::Unsolvable) => b.verdict == Verdict::Unknown,
                        (Some(b), Verdict::Unknown) => b.verdict == Verdict::Unknown && res.nodes > b.nodes,
                    };
                    if better && !(res.verdict == Verdict::Unknown && c2.load(Ordering::Relaxed) && p.best.is_some()) {
                        p.best = Some(res);
                    }
                    let decided = matches!(p.best.as_ref().map(|b| b.verdict), Some(Verdict::Solvable | Verdict::Unsolvable));
                    if decided || p.pending == 0 {
                        p.done = true;
                        c2.store(true, Ordering::Relaxed);
                    }
                })
                .expect("spawn solver thread");
        }
        SolverHandle { cancel, work, shared, started: Instant::now() }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
    /// Total work across all threads.
    pub fn work(&self) -> u64 {
        self.work.iter().map(|w| w.load(Ordering::Relaxed)).sum()
    }
    pub fn threads(&self) -> usize {
        self.work.len()
    }
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub fn result(&self) -> Option<SolveResult> {
        let p = self.shared.lock().unwrap();
        if p.done {
            p.best.clone()
        } else {
            None
        }
    }
}

impl Drop for SolverHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank(suits: u8) -> Game {
        let mut g = Game::new(suits, 3);
        for c in g.columns.iter_mut() {
            c.clear();
        }
        g.face_down = [0; NUM_COLS];
        g.stock.clear();
        g
    }

    #[test]
    fn won_game_is_solvable() {
        let mut g = Game::new(1, 3);
        g.completed = vec![0; 8];
        let r = Solver::new(&g, 1000).solve(&g);
        assert_eq!(r.verdict, Verdict::Solvable);
    }

    #[test]
    fn stuck_game_is_unsolvable() {
        let mut g = blank(4);
        // Two kings blocking each other on a queen of another suit; nothing else.
        g.columns[0] = vec![Card::new(0, 11), Card::new(1, 12)];
        g.columns[1] = vec![Card::new(2, 12)];
        let r = Solver::new(&g, 100_000).solve(&g);
        assert_eq!(r.verdict, Verdict::Unsolvable);
    }

    #[test]
    fn needs_reversible_shuffle_then_wins() {
        // Seven suits done. The last: K♠..9♠ in col 0; 8♠..2♠ sitting on a
        // wrong parent (10♥) in col 1; A♠ hidden under 9♥ in col 2.
        let mut g = blank(2);
        g.completed = vec![0; 7];
        g.columns[0] = (8..13).rev().map(|r| Card::new(0, r)).collect();
        g.columns[1] = vec![Card::new(1, 9)];
        g.columns[1].extend((1..8).rev().map(|r| Card::new(0, r)));
        g.columns[2] = vec![Card::new(0, 0), Card::new(1, 8)];
        g.face_down[2] = 1;
        let r = Solver::new(&g, 100_000).solve(&g);
        assert_eq!(r.verdict, Verdict::Solvable);
        let mut g2 = g.clone();
        for mv in &r.line {
            g2.apply(*mv).expect("solver line must be legal");
        }
        assert!(g2.is_won());
    }

    #[test]
    fn one_suit_game_solvable_and_line_replays() {
        let mut g = Game::new(1, 1);
        let r = Solver::new(&g, 500_000).solve(&g);
        assert_eq!(r.verdict, Verdict::Solvable, "seed 1 one-suit should be solvable");
        for mv in &r.line {
            g.apply(*mv).expect("solver line must be legal");
        }
        assert!(g.is_won());
    }

    #[test]
    fn budget_yields_unknown() {
        let g = Game::new(4, 5);
        let r = Solver::new(&g, 50).solve(&g);
        assert_eq!(r.verdict, Verdict::Unknown);
    }
}

#[cfg(test)]
mod replay_tests {
    use super::*;

    fn check(suits: u8, seed: u64, budget: u64) -> Verdict {
        let mut g = Game::new(suits, seed);
        let r = Solver::new(&g, budget).solve(&g);
        if r.verdict == Verdict::Solvable {
            for mv in &r.line {
                g.apply(*mv).expect("solver line must be legal");
            }
            assert!(g.is_won(), "line did not win");
        }
        r.verdict
    }

    #[test]
    fn two_suit_lines_replay() {
        for seed in 1..=3 {
            assert_eq!(check(2, seed, 3_000_000), Verdict::Solvable, "seed {seed}");
        }
    }

    #[test]
    fn four_suit_line_replays() {
        assert_eq!(check(4, 3, 3_000_000), Verdict::Solvable);
    }

    #[test]
    fn endgame_proof_is_exact() {
        // Stock empty, no empty columns, every top is an ace of a suit whose
        // king is buried: nothing can ever move.
        let mut g = Game::new(4, 1);
        for c in g.columns.iter_mut() {
            c.clear();
        }
        g.stock.clear();
        g.face_down = [0; NUM_COLS];
        g.completed = vec![0; 6];
        for c in 0..NUM_COLS {
            g.columns[c] = vec![Card::new((c % 2) as u8, 12), Card::new(((c + 1) % 2) as u8, 0)];
        }
        let r = Solver::new(&g, 100_000).solve(&g);
        assert_eq!(r.verdict, Verdict::Unsolvable);
        assert!(r.proof_pass);
    }
}
