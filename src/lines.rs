//! A non-peeking player that chooses between short lines of human-sized
//! steps.
//!
//! Like [`crate::human`], it decides from a [`mask`]ed position only. The
//! unit of play is a *step*, a move a person thinks of as one: put a run,
//! or a mixed-suit sequence, from the top of a column onto a card one rank
//! higher or into an empty column, using the other empty columns as
//! temporary space when the sequence has several suits (with `e` free empty
//! columns, up to `2^e` same-suit pieces move at once). Digging out a card,
//! joining two same-suit runs and shifting a sequence aside are all steps.
//!
//! A *line* is up to `max_steps` steps, each after the first touching a
//! column an earlier one moved cards from or to; a line also ends when a
//! card turns over, since what comes up is unknown. With four suits the
//! lines are searched as a beam: at each depth only the best positions by
//! the evaluation are taken further. The player scores where every line
//! ends with a visible-only evaluation (a few of the best lines that turn
//! a card are scored instead by expectimax over the card that comes up,
//! `expect_top`) and plays the best line that raises
//! the value; failing that, it scores the same lines again "about to deal",
//! with a separate (lower) value for an empty column, since a deal needs
//! every column filled (and a line that turns a card can earn a bonus,
//! `deal_flip`), and plays the best line that raises that value. Once about
//! to deal it stays so until a card turns, a deal or a suit completes
//! (going back and forth between the two values could go on for ever
//! without repeating a position). If nothing raises the value it deals,
//! first filling the empty columns, splitting runs if it must; with the
//! stock gone it gives up. With `replan` it plays only the first few steps
//! of a line and searches again, keeping to the line unless the new search
//! finds one that ends better.
//!
//! The evaluation counts completed suits, face-down cards, empty columns,
//! same-suit links, off-suit links (with an amount per rank of the lower
//! card, so that links of high cards cost less), a bonus for a column whose
//! lowest face-up card is a king, the number of different ranks among the
//! top cards (aces aside: places to put things), and the squared length of
//! every same-suit run, among others. A position with stock left and fewer than ten cards
//! on the table can never deal again, so it is valued as lost. Positions
//! the player has already stood in are never returned to, so it cannot
//! cycle.

use crate::game::{Card, Game, Move, NUM_COLS};
use crate::human::{mask, show, PlayResult, BLANK};
use crate::solver::{col_hash, IdBuild, State, MAXC};
use std::collections::HashSet;

/// The value of a position that can no longer be won.
pub(crate) const LOST: i32 = i32::MIN / 2;

/// Evaluation weights.
#[derive(Clone, Copy, Debug)]
pub struct LineConfig {
    /// Most steps in a line.
    pub max_steps: usize,
    /// Each step after the first must touch a column an earlier one touched.
    pub touch: bool,
    /// Positions expanded at each depth of the line search, the best by
    /// the evaluation (half normally, half about to deal); 0: all.
    pub beam: usize,
    /// Lines that turn a card valued by expectimax: the best this many by
    /// the evaluation (in each mode) are valued instead at the mean, over
    /// the cards that can come up, of the best position a smaller search
    /// (`expect_steps`, `expect_beam`) reaches from there. 0: none.
    pub expect_top: usize,
    /// Splits allowed when about to deal (searched again if it differs
    /// from `splits`); 0: as `splits`.
    pub deal_splits: u8,
    pub expect_steps: usize,
    pub expect_beam: usize,
    /// Which splits of a same-suit run are considered: 0 none, 1 only onto
    /// a card of the same suit, 2 also into an empty column, 3 all.
    pub splits: u8,
    pub completed: i32,
    pub hidden: i32,
    pub empty: i32,
    /// Value of an empty column when about to deal.
    pub deal_empty: i32,
    /// Added, when about to deal or with the stock gone, for a line that
    /// turns a card.
    pub deal_flip: i32,
    /// Value of an empty column when nothing raises the value and the stock
    /// is gone (so that a card can be turned at the cost of an empty column).
    pub end_empty: i32,
    pub same: i32,
    /// An off-suit link (a card on one of another suit one rank higher).
    pub off: i32,
    /// Added per off-suit link, in quarters, per rank of the lower card.
    pub off_rank: i32,
    /// A column whose lowest face-up card is a king.
    pub king: i32,
    /// Per different rank among the top cards, aces aside.
    pub ranks: i32,
    /// Per same-suit run of length L: run_sq * L^2 / 16.
    pub run_sq: i32,
    /// A face-up card on one that is not one rank higher.
    pub wrong: i32,
    /// A non-empty column with nothing face down.
    pub clear: i32,
    /// Per column with d face-down cards: -hidden_sq * d^2 / 16.
    pub hidden_sq: i32,
    /// A column with cards face down whose face-up cards are one
    /// descending sequence (so that they can be moved off together).
    pub dig: i32,
    /// Such a column whose sequence has somewhere to go now (half of it for
    /// a card just turned, which is unknown).
    pub turnable: i32,
    /// A line is chosen at random among those within this much of the
    /// best (0: always the best).
    pub waver: i32,
    /// Seeds the random choice (a different salt, a different game).
    pub salt: u64,
    /// Play at most this many steps of the chosen line, then search again
    /// (0: the whole line).
    pub replan: usize,
    /// The configuration to play with for each number of deals left, if
    /// it differs from this one ([`play_until`] switches).
    pub staged: Option<&'static [LineConfig; 6]>,
}

impl LineConfig {
    /// Defaults (weights for four suits tuned on seeds 30001-34000, with
    /// expectimax and replanning 38.9% won on seeds 1-2000 and
    /// 20001-22000; three suits use the same: 54.3% of seeds 40001-41000
    /// and 42001-44000; two suits: 70% of seeds 10001-14000; one suit, with
    /// two-step lines: 88%).
    pub fn for_suits(suits: u8) -> LineConfig {
        let base = LineConfig {
            max_steps: 6,
            touch: true,
            beam: 0,
            expect_top: 0,
            deal_splits: 0,
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
            turnable: 0,
            waver: 0,
            salt: 0,
            replan: 0,
            staged: None,
        };
        match suits {
            1 => LineConfig {
                max_steps: 2,
                hidden: 20,
                empty: 60,
                deal_empty: -60,
                end_empty: 0,
                same: 11,
                off: -2,
                off_rank: 0,
                king: 11,
                ranks: 3,
                run_sq: 13,
                ..base
            },
            2 => LineConfig {
                max_steps: 14,
                beam: 300,
                expect_top: 4,
                replan: 4,
                hidden: 22,
                empty: 26,
                deal_empty: -28,
                end_empty: 5,
                same: 5,
                off: -8,
                off_rank: 4,
                king: -10,
                ranks: 8,
                run_sq: 1,
                ..base
            },
            _ => LineConfig {
                max_steps: 14,
                beam: 300,
                expect_top: 4,
                replan: 4,
                deal_splits: 3,
                hidden: 71,
                empty: 103,
                end_empty: 39,
                off: -10,
                run_sq: 7,
                wrong: -3,
                clear: 16,
                hidden_sq: -4,
                ..base
            },
        }
    }

    /// A much cheaper player for rollouts (the web game's analysis plays
    /// hundreds of games from a position with it, `web/static/lineplayer.js`
    /// being a port): six-step lines, a beam of 50, no expectimax, no
    /// replanning and no wider search before a deal. About 15,000 positions
    /// a game; of seeds 60001-60800 it wins 26% with four suits (the
    /// default: 37%, at 30 times the work), 44% with three and 63% with
    /// two. One suit plays as [`LineConfig::for_suits`] does.
    pub fn fast(suits: u8) -> LineConfig {
        let d = LineConfig::for_suits(suits);
        if suits == 1 {
            return d;
        }
        LineConfig { max_steps: 6, beam: 50, expect_top: 0, replan: 0, deal_splits: 0, ..d }
    }

    /// [`LineConfig::for_suits`] (with `SPIDER_L_FAST` set,
    /// [`LineConfig::fast`]) with `SPIDER_L_*` overrides (MAX_STEPS, TOUCH (0/1), BEAM, DEAL_SPLITS, EXPECT_TOP, EXPECT_STEPS, EXPECT_BEAM, SPLITS,
    /// COMPLETED, HIDDEN, EMPTY, DEAL_EMPTY, DEAL_FLIP, END_EMPTY, SAME, OFF, OFF_RANK,
    /// KING, RANKS, RUN_SQ, WRONG, CLEAR, HIDDEN_SQ, DIG, TURNABLE, WAVER, SALT, REPLAN).
    /// `SPIDER_L_K<n>_*` override them for the play with `n` deals left
    /// only (see [`LineConfig::staged`]).
    pub fn from_env(suits: u8) -> LineConfig {
        let mut cfg = LineConfig::from_env_stage(suits, None);
        if std::env::vars().any(|(k, _)| k.starts_with("SPIDER_L_K")) {
            let staged: Vec<LineConfig> = (0..=crate::game::NUM_DEALS).map(|k| LineConfig::from_env_stage(suits, Some(k))).collect();
            cfg.staged = Some(Box::leak(Box::new(<[LineConfig; 6]>::try_from(staged).unwrap())));
        }
        cfg
    }

    /// The configuration from the environment for the play with `stage`
    /// deals left (`None`: for any).
    fn from_env_stage(suits: u8, stage: Option<usize>) -> LineConfig {
        let var = |name: &str| stage.and_then(|k| std::env::var(format!("SPIDER_L_K{k}_{name}")).ok()).or_else(|| std::env::var(format!("SPIDER_L_{name}")).ok());
        fn parse<T: std::str::FromStr>(v: Option<String>, d: T) -> T {
            v.and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        macro_rules! get {
            ($name:expr, $d:expr) => {
                parse(var($name), $d)
            };
        }
        let d = if std::env::var_os("SPIDER_L_FAST").is_some() { LineConfig::fast(suits) } else { LineConfig::for_suits(suits) };
        LineConfig {
            max_steps: get!("MAX_STEPS", d.max_steps),
            touch: get!("TOUCH", d.touch as u8) != 0,
            beam: get!("BEAM", d.beam),
            expect_top: get!("EXPECT_TOP", d.expect_top),
            deal_splits: get!("DEAL_SPLITS", d.deal_splits),
            expect_steps: get!("EXPECT_STEPS", d.expect_steps),
            expect_beam: get!("EXPECT_BEAM", d.expect_beam),
            splits: get!("SPLITS", d.splits),
            completed: get!("COMPLETED", d.completed),
            hidden: get!("HIDDEN", d.hidden),
            empty: get!("EMPTY", d.empty),
            deal_empty: get!("DEAL_EMPTY", d.deal_empty),
            deal_flip: get!("DEAL_FLIP", d.deal_flip),
            end_empty: get!("END_EMPTY", d.end_empty),
            same: get!("SAME", d.same),
            off: get!("OFF", d.off),
            off_rank: get!("OFF_RANK", d.off_rank),
            king: get!("KING", d.king),
            ranks: get!("RANKS", d.ranks),
            run_sq: get!("RUN_SQ", d.run_sq),
            wrong: get!("WRONG", d.wrong),
            clear: get!("CLEAR", d.clear),
            hidden_sq: get!("HIDDEN_SQ", d.hidden_sq),
            dig: get!("DIG", d.dig),
            turnable: get!("TURNABLE", d.turnable),
            waver: get!("WAVER", d.waver),
            salt: get!("SALT", d.salt),
            replan: get!("REPLAN", d.replan),
            staged: None,
        }
    }

    /// Score of a position from its visible cards only, valuing an empty
    /// column at `empty`.
    pub(crate) fn eval(&self, s: &State, deals_left: usize, empty: i32) -> i32 {
        Parts::of(s, self).value(deals_left, empty)
    }

    /// The evaluation apart from the empty columns.
    fn base_eval(&self, s: &State) -> i32 {
        let mut score = self.completed * s.completed as i32;
        let mut top_ranks = 0u16;
        let mut off_rank = 0;
        // Ranks a sequence can be put on (one below a top card), and whether
        // a column is empty.
        let mut accepts = 0u16;
        let mut any_empty = false;
        if self.turnable != 0 {
            for c in 0..NUM_COLS {
                let n = s.len[c] as usize;
                if n == 0 {
                    any_empty = true;
                } else if s.cols[c][n - 1] != BLANK.0 && s.cols[c][n - 1] % 13 > 0 {
                    accepts |= 1 << (s.cols[c][n - 1] % 13 - 1);
                }
            }
        }
        for c in 0..NUM_COLS {
            let n = s.len[c] as usize;
            if n == 0 {
                continue;
            }
            let d = s.down[c] as usize;
            score -= self.hidden * d as i32 + self.hidden_sq * (d * d) as i32 / 16;
            if d == 0 {
                score += self.clear;
            }
            let col = &s.cols[c];
            // A card just turned over is unknown (BLANK): it is no place to
            // put anything yet.
            if col[n - 1] != BLANK.0 && col[n - 1] % 13 != 0 {
                top_ranks |= 1 << (col[n - 1] % 13);
            }
            if col[d] != BLANK.0 && col[d] % 13 == 12 {
                score += self.king;
            }
            let mut run = 1;
            let mut seq = true;
            for i in d + 1..n {
                let (upper, lower) = (col[i - 1], col[i]);
                if upper % 13 == lower % 13 + 1 {
                    if upper / 13 == lower / 13 {
                        score += self.same;
                        run += 1;
                        continue;
                    }
                    score += self.off;
                    off_rank += (lower % 13) as i32;
                } else if upper != BLANK.0 && lower != BLANK.0 {
                    score += self.wrong;
                    seq = false;
                }
                score += self.run_sq * run * run / 16;
                run = 1;
            }
            score += self.run_sq * run * run / 16;
            if d > 0 && seq {
                score += self.dig;
                if col[d] == BLANK.0 {
                    score += self.turnable / 2;
                } else if any_empty || accepts & (1 << (col[d] % 13)) != 0 {
                    score += self.turnable;
                }
            }
        }
        score + self.off_rank * off_rank / 4 + self.ranks * top_ranks.count_ones() as i32
    }
}

/// A position's evaluation, kept in parts so that it can be had in either
/// mode without looking at the cards again.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Parts {
    base: i32,
    empties: u8,
    cards: u16,
}

impl Parts {
    pub(crate) fn of(s: &State, cfg: &LineConfig) -> Parts {
        Parts {
            base: cfg.base_eval(s),
            empties: s.len.iter().filter(|&&l| l == 0).count() as u8,
            cards: s.len.iter().map(|&l| l as u16).sum(),
        }
    }

    /// The evaluation, valuing an empty column at `empty`.
    pub(crate) fn value(&self, deals_left: usize, empty: i32) -> i32 {
        if deals_left > 0 && (self.cards as usize) < NUM_COLS {
            return LOST;
        }
        self.base + empty * self.empties as i32
    }
}

/// What the player decided to do from a position.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Play this line (its last step may turn a card over), then look again.
    Play(Vec<Move>),
    /// Deal from the stock.
    Deal,
    /// Nothing to do: the game is over.
    Stuck,
}

pub(crate) struct Node {
    pub(crate) state: State,
    pub(crate) parent: u32,
    /// The step from the parent, as moves.
    pub(crate) step: Vec<Move>,
    /// Turned a card over: what lies beyond is unknown, so not expanded.
    pub(crate) leaf: bool,
    pub(crate) parts: Parts,
    /// Columns the line's steps moved cards from or to (a bit set).
    touched: u16,
}

/// Move the top `sizes.len()` pieces of `from` (same-suit runs, sizes given
/// bottom piece first) onto `to`, using the empty columns `free` as
/// temporary space. The pieces must form a descending sequence that `to`
/// accepts. Returns false, leaving `s` and `out` partly changed, if there
/// is not enough space.
fn move_pieces(s: &mut State, from: usize, to: usize, sizes: &[usize], free: &[usize], out: &mut Vec<Move>) -> bool {
    let k = sizes.len();
    if k == 0 {
        return true;
    }
    if k == 1 {
        let mv = Move::Move { from, to, count: sizes[0] };
        s.apply(mv, &[]);
        out.push(mv);
        return true;
    }
    let Some((&t, rest)) = free.split_first() else { return false };
    // Top half aside, bottom half across, top half back on top of it.
    let (bottom, top) = sizes.split_at(k - k / 2);
    move_pieces(s, from, t, top, rest, out) && move_pieces(s, from, to, bottom, rest, out) && move_pieces(s, t, to, top, rest, out)
}

/// Every step from `s`: the moves it takes, the position it leads to, and
/// its source and destination columns. With `require` non-zero, only steps
/// touching one of those columns (a bit set); only steps for whose
/// position's hash `accept` returns true.
pub(crate) fn steps(s: &State, splits: u8, require: u16, accept: &mut impl FnMut(u64) -> bool, out: &mut Vec<(Vec<Move>, State, [usize; 2])>) {
    out.clear();
    let mut empties = [0usize; NUM_COLS];
    let mut ne = 0;
    for c in 0..NUM_COLS {
        if s.len[c] == 0 {
            empties[ne] = c;
            ne += 1;
        }
    }
    let empties = &empties[..ne];
    for from in 0..NUM_COLS {
        let n = s.len[from] as usize;
        let d = s.down[from] as usize;
        if n == d {
            continue;
        }
        let col = &s.cols[from];
        // The descending sequence (any suits) at the top of the column.
        let mut start = n - 1;
        while start > d && col[start - 1] % 13 == col[start] % 13 + 1 {
            start -= 1;
        }
        for p in start..n {
            let bottom = col[p];
            // Cutting inside a same-suit run splits it.
            let split = p > start && col[p - 1] / 13 == bottom / 13;
            if split && splits == 0 {
                continue;
            }
            // Same-suit pieces of the moved part, bottom first.
            let mut size_buf = [0usize; MAXC];
            let mut k = 0;
            let mut i = p;
            while i < n {
                let mut j = i + 1;
                while j < n && col[j] / 13 == col[j - 1] / 13 {
                    j += 1;
                }
                size_buf[k] = j - i;
                k += 1;
                i = j;
            }
            let sizes = &size_buf[..k];
            let mut tried_empty = false;
            for to in 0..NUM_COLS {
                if to == from {
                    continue;
                }
                let tl = s.len[to] as usize;
                if tl == 0 {
                    // Empty columns are interchangeable; moving a whole
                    // column into one changes nothing.
                    if tried_empty || p == 0 || (split && splits < 2) {
                        continue;
                    }
                    tried_empty = true;
                } else {
                    let top = s.cols[to][tl - 1];
                    if top % 13 != bottom % 13 + 1 {
                        continue;
                    }
                    if split && splits < 3 && top / 13 != bottom / 13 {
                        continue;
                    }
                }
                if tl + n - p > MAXC {
                    continue;
                }
                let mut free_buf = [0usize; NUM_COLS];
                let mut nf = 0;
                for &c in empties {
                    if c != to {
                        free_buf[nf] = c;
                        nf += 1;
                    }
                }
                let free = &free_buf[..nf];
                if sizes.len() > 1usize << free.len().min(16) {
                    continue;
                }
                if require != 0 && require & (1 << from | 1 << to) == 0 {
                    continue;
                }
                // The position's hash before building it: only the two
                // columns change (unless a suit completes).
                let mut buf = [0u8; MAXC];
                buf[..tl].copy_from_slice(&s.cols[to][..tl]);
                buf[tl..tl + n - p].copy_from_slice(&col[p..n]);
                let nt = tl + n - p;
                let completes = nt >= 13 && buf[nt - 1] % 13 == 0 && {
                    let mut r = 1;
                    while r < 13 && buf[nt - r - 1] / 13 == buf[nt - r] / 13 && buf[nt - r - 1] % 13 == buf[nt - r] % 13 + 1 {
                        r += 1;
                    }
                    r == 13
                };
                if !completes {
                    let down_from = if p > 0 && p == d { d - 1 } else { d.min(p) };
                    let h = s.hash_with((from, col_hash(&col[..p], down_from as u8)), (to, col_hash(&buf[..nt], s.down[to])));
                    if !accept(h) {
                        continue;
                    }
                }
                let mut t = s.clone();
                let mut moves = Vec::with_capacity(sizes.len() * 2);
                if move_pieces(&mut t, from, to, sizes, free, &mut moves) {
                    if completes && !accept(t.hash()) {
                        continue;
                    }
                    debug_assert!(completes || t.hash() == s.hash_with((from, t.colh[from]), (to, t.colh[to])));
                    out.push((moves, t, [from, to]));
                }
            }
        }
    }
}

/// Every line from the masked position `obs`: up to `cfg.max_steps` steps,
/// each after the first touching a column an earlier one touched. Node 0 is
/// `obs` itself; a position reached by several lines is kept once, with
/// the shortest.
fn search(obs: &Game, cfg: &LineConfig) -> Vec<Node> {
    search_state(State::from_game(obs), cfg)
}

/// [`search`] from a (masked) state.
pub(crate) fn search_state(root: State, cfg: &LineConfig) -> Vec<Node> {
    let mut seen: HashSet<u64, IdBuild> = HashSet::default();
    seen.insert(root.hash());
    let parts = Parts::of(&root, cfg);
    let mut nodes = vec![Node { state: root, parent: u32::MAX, step: Vec::new(), leaf: false, parts, touched: 0 }];
    let mut buf = Vec::new();
    // Positions to expand at the current depth.
    let mut frontier = vec![0usize];
    for depth in 0..cfg.max_steps {
        let first = nodes.len();
        for &i in &frontier {
            let touched = nodes[i].touched;
            let require = if cfg.touch && depth > 0 { touched } else { 0 };
            steps(&nodes[i].state, cfg.splits, require, &mut |h| seen.insert(h), &mut buf);
            for (moves, t, [from, to]) in buf.drain(..) {
                let cols = 1u16 << from | 1 << to;
                let flip = (0..NUM_COLS).any(|c| t.down[c] < nodes[i].state.down[c]);
                let parts = Parts::of(&t, cfg);
                nodes.push(Node { state: t, parent: i as u32, step: moves, leaf: flip, parts, touched: touched | cols });
            }
        }
        frontier = (first..nodes.len()).filter(|&k| !nodes[k].leaf).collect();
        if cfg.beam > 0 && frontier.len() > cfg.beam {
            let mut keep = HashSet::<usize>::new();
            for (empty, n) in [(cfg.empty, cfg.beam - cfg.beam / 2), (cfg.deal_empty, cfg.beam / 2)] {
                let mut scored: Vec<(i32, usize)> = frontier.iter().map(|&k| (nodes[k].parts.value(0, empty), k)).collect();
                scored.sort_unstable_by_key(|&(sc, k)| (std::cmp::Reverse(sc), k));
                keep.extend(scored.iter().take(n).map(|&(_, k)| k));
            }
            frontier.retain(|k| keep.contains(k));
        }
        if frontier.is_empty() {
            break;
        }
    }
    nodes
}

/// The steps of the line to node `k`.
pub(crate) fn line_to(nodes: &[Node], mut k: usize) -> Vec<Vec<Move>> {
    let mut steps = Vec::new();
    while k != 0 {
        steps.push(nodes[k].step.clone());
        k = nodes[k].parent as usize;
    }
    steps.reverse();
    steps
}

/// Decide from a masked position (see [`mask`]). `deals_left` is the number
/// of stock deals remaining; positions in `visited` are not returned to.
/// `tempo` carries what the player keeps between decisions (reset by the
/// caller when a card turns, a deal or a suit completes). Returns the
/// decision and the positions examined.
pub fn decide(obs: &Game, deals_left: usize, visited: &HashSet<u64>, tempo: &mut Tempo, cfg: &LineConfig) -> (Decision, usize) {
    let (d, n) = decide_steps(obs, deals_left, visited, tempo, cfg);
    let d = match d {
        Choice::Line(steps) if cfg.replan > 0 => {
            // A new line replaces the plan only if it ends better than the
            // plan does (in the same mode), so that replanning cannot
            // wander.
            if tempo.plan.is_empty() || tempo.dealing != tempo.plan_dealing || tempo.value > tempo.plan_value {
                tempo.plan = steps;
                tempo.plan_value = tempo.value;
                tempo.plan_dealing = tempo.dealing;
            }
            let n = cfg.replan.min(tempo.plan.len());
            Decision::Play(tempo.plan.drain(..n).flatten().collect())
        }
        Choice::Line(steps) => Decision::Play(steps.concat()),
        Choice::Deal => Decision::Deal,
        Choice::Stuck => Decision::Stuck,
    };
    (d, n)
}

/// What the player keeps from one decision to the next until a card turns,
/// a deal or a suit completes.
#[derive(Clone, Debug, Default)]
pub struct Tempo {
    /// It is about to deal (it played a line for that), so it does not go
    /// back to raising the normal value: going back and forth between the
    /// two could go on for ever without repeating a position.
    pub dealing: bool,
    /// The value (in its mode) of where the line chosen last ends.
    pub value: i32,
    /// With [`LineConfig::replan`]: the rest of the line being played, the
    /// value where it ends, and whether that is about to deal.
    pub plan: Vec<Vec<Move>>,
    pub plan_value: i32,
    pub plan_dealing: bool,
    /// For the rollout player's network: it has overruled the line player
    /// since the last card turned, deal or completed suit.
    pub overruled: bool,
}

/// A decision with the line split into its steps.
pub(crate) enum Choice {
    Line(Vec<Vec<Move>>),
    Deal,
    Stuck,
}

/// [`decide`], keeping the line's steps apart.
pub(crate) fn decide_steps(obs: &Game, deals_left: usize, visited: &HashSet<u64>, tempo: &mut Tempo, cfg: &LineConfig) -> (Choice, usize) {
    if obs.is_won() {
        return (Choice::Stuck, 0);
    }
    let nodes = search(obs, cfg);
    let fresh = |k: usize| !visited.contains(&nodes[k].state.hash());
    let empty = if deals_left > 0 { cfg.deal_empty } else { cfg.end_empty };
    let expected = if cfg.expect_top > 0 { expect_flips(obs, &nodes, deals_left, visited, cfg, [cfg.empty, empty]) } else { Vec::new() };
    let value = |k: usize, mode: usize, empty: i32| match expected.iter().find(|e| e.0 == k) {
        Some(e) => e.1[mode],
        None => nodes[k].parts.value(deals_left, empty),
    };
    let best_raising = |mode: usize, empty: i32| {
        let base = nodes[0].parts.value(deals_left, empty);
        let mut best = None;
        let mut best_score = base;
        for k in 1..nodes.len() {
            let sc = value(k, mode, empty);
            if sc > best_score && fresh(k) {
                best = Some(k);
                best_score = sc;
            }
        }
        if cfg.waver > 0 && best.is_some() {
            let near: Vec<usize> = (1..nodes.len()).filter(|&k| fresh(k) && value(k, mode, empty) > base.max(best_score - cfg.waver - 1)).collect();
            best = Some(near[waver_pick(&nodes[0].state, cfg, near.len())]);
        }
        best
    };
    if !tempo.dealing {
        if let Some(k) = best_raising(0, cfg.empty) {
            tempo.value = value(k, 0, cfg.empty);
            return (Choice::Line(line_to(&nodes, k)), nodes.len());
        }
    }
    // About to deal (or, with the stock gone, about to give up): a line
    // that turns a card earns `deal_flip` besides.
    let widen = cfg.deal_splits != 0 && cfg.deal_splits != cfg.splits;
    let wide;
    let dn: &[Node] = if widen {
        wide = search_state(nodes[0].state.clone(), &LineConfig { splits: cfg.deal_splits, ..*cfg });
        &wide
    } else {
        &nodes
    };
    let deal_value = |k: usize| {
        let v = if widen { dn[k].parts.value(deals_left, empty) } else { value(k, 1, empty) };
        if v > LOST && dn[k].leaf { v + cfg.deal_flip } else { v }
    };
    let base = dn[0].parts.value(deals_left, empty);
    let mut best = (1..dn.len())
        .filter(|&k| !visited.contains(&dn[k].state.hash()))
        .map(|k| (deal_value(k), k))
        .filter(|&(v, _)| v > base)
        .max_by_key(|&(v, k)| (v, std::cmp::Reverse(k)));
    if let (true, Some((top, _))) = (cfg.waver > 0, best) {
        let near: Vec<(i32, usize)> = (1..dn.len())
            .filter(|&k| !visited.contains(&dn[k].state.hash()))
            .map(|k| (deal_value(k), k))
            .filter(|&(v, _)| v > base && v >= top - cfg.waver)
            .collect();
        best = Some(near[waver_pick(&dn[0].state, cfg, near.len())]);
    }
    let work = if widen { nodes.len() + dn.len() } else { nodes.len() };
    if let Some((v, k)) = best {
        tempo.dealing = true;
        tempo.value = v;
        return (Choice::Line(line_to(dn, k)), work);
    }
    if deals_left == 0 {
        return (Choice::Stuck, nodes.len());
    }
    if nodes[0].state.len.iter().all(|&l| l > 0) {
        return (Choice::Deal, nodes.len());
    }
    // An empty column is left that no line fills profitably: fill it as
    // cheaply as possible, so the deal can go ahead, splitting runs if
    // there is no other way.
    tempo.dealing = true;
    let fill = |nodes: &[Node]| {
        (1..nodes.len())
            .filter(|&k| nodes[k].state.len.iter().all(|&l| l > 0) && !visited.contains(&nodes[k].state.hash()))
            .max_by_key(|&k| (nodes[k].parts.value(deals_left, empty), std::cmp::Reverse(k)))
            .filter(|&k| nodes[k].parts.value(deals_left, empty) > LOST)
    };
    if let Some(k) = fill(&nodes) {
        tempo.value = nodes[k].parts.value(deals_left, empty);
        return (Choice::Line(line_to(&nodes, k)), nodes.len());
    }
    let wide = search_state(nodes[0].state.clone(), &LineConfig { splits: 3, beam: cfg.beam.max(100), ..*cfg });
    match fill(&wide) {
        Some(k) => {
            tempo.value = wide[k].parts.value(deals_left, empty);
            (Choice::Line(line_to(&wide, k)), nodes.len() + wide.len())
        }
        None => (Choice::Stuck, nodes.len() + wide.len()),
    }
}

/// A random index below `n` for the wavering choice in `root`, the same
/// every time for the same position and salt.
fn waver_pick(root: &State, cfg: &LineConfig, n: usize) -> usize {
    let mut x = root.hash() ^ cfg.salt.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    (x % n as u64) as usize
}

/// The cards not visible in the masked position `obs`, by card.
pub(crate) fn unseen_counts(obs: &Game) -> [u8; 52] {
    let mut count = [0u8; 52];
    for set in 0..8u8 {
        let suit = match obs.suits {
            1 => 0,
            2 => set % 2,
            3 => set % 3,
            _ => set % 4,
        };
        for rank in 0..13 {
            count[Card::new(suit, rank).0 as usize] += 1;
        }
    }
    for &suit in &obs.completed {
        for rank in 0..13 {
            count[Card::new(suit, rank).0 as usize] -= 1;
        }
    }
    for c in 0..NUM_COLS {
        for card in &obs.columns[c][obs.face_down[c]..] {
            count[card.0 as usize] -= 1;
        }
    }
    count
}

/// Expectimax values, in each of the modes `empties` (the value of an empty
/// column), of the best `cfg.expect_top` lines in each mode that turn a
/// card: for each card that can come up, weighted by how many of it are
/// unseen, the best value a smaller search reaches.
fn expect_flips(obs: &Game, nodes: &[Node], deals_left: usize, visited: &HashSet<u64>, cfg: &LineConfig, empties: [i32; 2]) -> Vec<(usize, [i32; 2])> {
    let mut picked: Vec<usize> = Vec::new();
    for &empty in &empties {
        let mut leaves: Vec<(i32, usize)> = (1..nodes.len())
            .filter(|&k| nodes[k].leaf && !visited.contains(&nodes[k].state.hash()))
            .map(|k| (nodes[k].parts.value(deals_left, empty), k))
            .filter(|&(v, _)| v > LOST)
            .collect();
        leaves.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
        for &(_, k) in leaves.iter().take(cfg.expect_top) {
            if !picked.contains(&k) {
                picked.push(k);
            }
        }
    }
    if picked.is_empty() {
        return Vec::new();
    }
    let count = unseen_counts(obs);
    let total: i64 = count.iter().map(|&c| c as i64).sum();
    let small = LineConfig { max_steps: cfg.expect_steps, beam: cfg.expect_beam, expect_top: 0, ..*cfg };
    picked
        .into_iter()
        .map(|k| {
            let s = &nodes[k].state;
            let c = (0..NUM_COLS).find(|&c| s.len[c] > 0 && s.down[c] + 1 == s.len[c] && s.top(c) == BLANK.0).expect("a turned card");
            let mut sum = [0i64; 2];
            for (card, &n) in count.iter().enumerate() {
                if n == 0 {
                    continue;
                }
                let mut t = s.clone();
                t.cols[c][t.len[c] as usize - 1] = card as u8;
                t.rehash(c);
                let sub = search_state(t, &small);
                for m in 0..2 {
                    let best = sub.iter().map(|x| x.parts.value(deals_left, empties[m])).max().unwrap();
                    sum[m] += n as i64 * best.max(LOST / 2) as i64;
                }
            }
            (k, [(sum[0] / total) as i32, (sum[1] / total) as i32])
        })
        .collect()
}

/// The best value (normal mode) of the position or of any line from it
/// that does not return to a visited position: what the player's lookahead
/// expects to reach.
pub(crate) fn lookahead_value(obs: &Game, deals_left: usize, visited: &HashSet<u64>, cfg: &LineConfig) -> i32 {
    let nodes = search(obs, cfg);
    let mut best = nodes[0].parts.value(deals_left, cfg.empty);
    for n in &nodes[1..] {
        if !visited.contains(&n.state.hash()) {
            best = best.max(n.parts.value(deals_left, cfg.empty));
        }
    }
    best
}

/// The hash the player keeps of a masked position it has stood in.
pub fn masked_hash(obs: &Game) -> u64 {
    State::from_game(obs).hash()
}

/// Play `g` to the end, deciding every move from the masked position only.
pub fn play(g: &Game, cfg: &LineConfig) -> PlayResult {
    play_from(g, cfg, HashSet::new())
}

/// [`play`], never returning to a position in `visited` (hashes of masked
/// states) either.
pub(crate) fn play_from(g: &Game, cfg: &LineConfig, visited: HashSet<u64>) -> PlayResult {
    let mut g = g.clone();
    let start = g.move_count();
    let (work, _) = play_until(&mut g, cfg, visited, None);
    let moves = g.history()[start..].iter().map(|r| r.mv).collect();
    PlayResult { won: g.is_won(), moves, completed: g.completed.len(), work }
}

/// Play `g` on, never returning to a position in `visited`, until the game
/// ends or, with `stop` given, until the player is about to deal with no
/// more than `stop` deals left. Returns the positions examined and whether
/// it stopped before a deal.
pub fn play_until(g: &mut Game, cfg: &LineConfig, mut visited: HashSet<u64>, stop: Option<usize>) -> (u64, bool) {
    let trace = std::env::var_os("SPIDER_L_TRACE").is_some();
    let mut work = 0;
    let start = g.move_count();
    // A column too long for the search's fixed buffer ends the game (it
    // can only happen by dealing onto very long columns).
    let mut tempo = Tempo::default();
    while !g.is_won() && g.move_count() - start < 5000 && g.columns.iter().all(|c| c.len() <= MAXC) {
        let obs = mask(g);
        visited.insert(State::from_game(&obs).hash());
        let before = progress(g);
        let cfg = cfg.staged.map_or(cfg, |s| &s[g.deals_remaining()]);
        let (d, w) = decide(&obs, g.deals_remaining(), &visited, &mut tempo, cfg);
        work += w as u64;
        if trace {
            eprintln!("{}\n{d:?} ({w} positions)", show(g));
        }
        match d {
            Decision::Play(line) => {
                for mv in line {
                    g.apply(mv).expect("planned move is legal");
                }
            }
            Decision::Deal if stop.is_some_and(|s| g.deals_remaining() <= s) => return (work, true),
            Decision::Deal => g.apply(Move::Deal).expect("deal is legal"),
            Decision::Stuck => break,
        }
        if progress(g) != before {
            tempo = Tempo::default();
        }
    }
    (work, false)
}

/// What changes only by something irreversible: a card turned, a deal or a
/// completed suit.
pub fn progress(g: &Game) -> (usize, usize, usize) {
    (g.face_down.iter().sum(), g.deals_remaining(), g.completed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Card;

    fn empty_game() -> Game {
        let mut g = Game::new(4, 0);
        for c in g.columns.iter_mut() {
            c.clear();
        }
        g.face_down = [0; NUM_COLS];
        g.stock.clear();
        g
    }

    #[test]
    fn mixed_sequence_moves_through_empty_columns() {
        // 9♠ 8♥ 7♠ 6♥ onto a 10, with two empty columns: four pieces.
        let mut g = empty_game();
        g.columns[0] = vec![Card::new(3, 0), Card::new(0, 8), Card::new(1, 7), Card::new(0, 6), Card::new(1, 5)];
        g.face_down[0] = 1;
        g.columns[1] = vec![Card::new(2, 9)];
        for c in 2..8 {
            g.columns[c] = vec![Card::new(3, 12)];
        }
        let s = State::from_game(&g);
        let mut out = Vec::new();
        steps(&s, 1, 0, &mut |_| true, &mut out);
        let (moves, t, _) = out.iter().find(|(_, t, _)| t.len[1] == 5).expect("whole sequence onto the 10");
        assert_eq!(t.len[0], 1);
        assert_eq!(t.down[0], 0);
        let mut h = g.clone();
        for &mv in moves {
            h.apply(mv).unwrap();
        }
        assert_eq!(h.columns[1].len(), 5);
        // With one empty column only two pieces can move.
        g.columns[8] = vec![Card::new(3, 12)];
        let s = State::from_game(&g);
        steps(&s, 1, 0, &mut |_| true, &mut out);
        assert!(!out.iter().any(|(_, t, _)| t.len[1] == 5));
    }

    #[test]
    fn stranded_positions_are_lost() {
        let mut g = empty_game();
        g.columns[0] = vec![Card::new(0, 3); 9];
        let cfg = LineConfig::for_suits(4);
        assert_eq!(cfg.eval(&State::from_game(&g), 1, 0), LOST);
        assert!(cfg.eval(&State::from_game(&g), 0, 0) > LOST);
    }

    #[test]
    fn decisions_ignore_hidden_cards() {
        let a = Game::new(2, 11);
        let mut b = a.clone();
        b.columns[0][0] = Card::new(1, 5);
        b.stock.reverse();
        let cfg = LineConfig::for_suits(2);
        let v = HashSet::new();
        assert_eq!(decide(&mask(&a), 5, &v, &mut Tempo::default(), &cfg).0, decide(&mask(&b), 5, &v, &mut Tempo::default(), &cfg).0);
    }
}
