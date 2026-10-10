//! AlphaZero-style self-play over the line player's lines, with expectimax
//! over the cards that turn up.
//!
//! A move is a line of [`crate::lines`] (steps that end when a card turns
//! over, up to the line player's length) or the deal. A position offers
//! the lines that raise the line player's evaluation, normally or about to
//! deal, and every line that turns a card, the best `max_lines` of them by
//! that evaluation. A network (trained and run in Python on the GPU, see
//! `az/`) scores positions: a value (the expected outcome, `(completed
//! suits + 4 if won) / 12`) and a policy score; a decision's prior is the
//! softmax of the policy scores of the positions its moves lead to (with an
//! unknown card where one turns over).
//!
//! The search never looks at hidden cards. A move that turns a card leads
//! to a chance node with a child for every card that can come up, weighted
//! by how many of it are unseen, all valued by the network as soon as the
//! node is reached; its value is the weighted mean of its children's (an
//! expectimax). A deal turns ten cards at once, so it has `deal_samples`
//! sampled outcomes instead. A simulation goes down through the chance node
//! to the child furthest behind its share of visits. A decision node's
//! value is the mean of its own evaluation and its moves' current values,
//! weighted by visits; an unvisited move counts as the network's value of
//! the position it leads to. Positions the game has stood in, or that are
//! above in the tree, are not offered again, so lines cannot cycle.
//!
//! Many games run in lockstep (see [`Driver`]): each advances its search
//! until it needs positions evaluated, the requests of all games go to the
//! network as one batch, and the answers let every game go on.

use crate::game::{Game, Move, NUM_COLS};
use crate::human::{mask, BLANK};
use crate::lines::{decide_steps, line_to, lookahead_value, search_state, Choice, LineConfig, LOST};
use crate::solver::{mix, State, MAXC};
use std::cmp::Reverse;
use std::collections::HashSet;

/// Features per column (bytes; ranks and suits as indices, 0 for none).
pub const C: usize = 20;
/// Global features.
pub const G: usize = 16;
/// Bytes describing one position.
pub const POS: usize = NUM_COLS * C + G;

/// Outcome of a finished game (or one that cannot go on), in [0, 1].
fn outcome(completed: u8) -> f32 {
    (completed as f32 + if completed == 8 { 4.0 } else { 0.0 }) / 12.0
}

fn cards_on_table(s: &State) -> usize {
    s.len.iter().map(|&l| l as usize).sum()
}

/// With stock left, fewer than ten cards on the table can never deal again.
fn stranded(s: &State, deals_left: usize) -> bool {
    deals_left > 0 && cards_on_table(s) < NUM_COLS
}
/// Features of a position as small integers, from its visible cards
/// only. Per column: empty, hidden cards, face-up cards, top card (rank+1,
/// suit+1, unknown), bottom card of the top same-suit run and of the top
/// descending sequence (rank+1, suit+1), their lengths and the number of
/// suits in the sequence, same-suit links, off-suit links, breaks, longest
/// same-suit run, lowest face-up card (king flag, rank+1). Globally: deals
/// left (one-hot), completed suits, empty columns, hidden cards, cards on
/// the table, the deal flag (the deal is scored on the position it is made
/// from), stranded, unknown top cards, suit count (one-hot).
pub(crate) fn features(s: &State, deals_left: usize, suits: u8, deal: bool, out: &mut [u8]) {
    debug_assert_eq!(out.len(), POS);
    out.fill(0);
    let mut empties = 0;
    let mut hidden = 0;
    let mut unknown = 0;
    for c in 0..NUM_COLS {
        let f = &mut out[c * C..(c + 1) * C];
        let n = s.len[c] as usize;
        let d = s.down[c] as usize;
        if n == 0 {
            f[0] = 1;
            empties += 1;
            continue;
        }
        hidden += d;
        f[1] = d as u8;
        f[2] = (n - d) as u8;
        let col = &s.cols[c][..n];
        let top = col[n - 1];
        // Same-suit run and descending sequence at the top (an unknown top
        // card links to nothing).
        let mut run = n - 1;
        while top != BLANK.0 && run > d && col[run - 1] % 13 == col[run] % 13 + 1 && col[run - 1] / 13 == col[run] / 13 {
            run -= 1;
        }
        let mut seq = run;
        let mut pieces = 1;
        while top != BLANK.0 && seq > d && col[seq - 1] % 13 == col[seq] % 13 + 1 {
            if col[seq - 1] / 13 != col[seq] / 13 {
                pieces += 1;
            }
            seq -= 1;
        }
        if top == BLANK.0 {
            f[5] = 1;
            unknown += 1;
        } else {
            f[3] = top % 13 + 1;
            f[4] = top / 13 + 1;
            f[6] = col[run] % 13 + 1;
            f[7] = col[run] / 13 + 1;
            f[8] = col[seq] % 13 + 1;
            f[9] = col[seq] / 13 + 1;
        }
        f[10] = (n - run) as u8;
        f[11] = (n - seq) as u8;
        f[12] = pieces;
        let mut cur = 1;
        let mut best = 1;
        for i in d + 1..n {
            let (upper, lower) = (col[i - 1], col[i]);
            if lower == BLANK.0 {
                continue;
            }
            if upper % 13 == lower % 13 + 1 {
                if upper / 13 == lower / 13 {
                    f[13] += 1;
                    cur += 1;
                    best = best.max(cur);
                    continue;
                }
                f[14] += 1;
            } else {
                f[15] += 1;
            }
            cur = 1;
        }
        f[16] = best;
        if col[d] != BLANK.0 {
            f[17] = (col[d] % 13 == 12) as u8;
            f[18] = col[d] % 13 + 1;
        }
    }
    let g = &mut out[NUM_COLS * C..];
    g[deals_left.min(5)] = 1;
    g[6] = s.completed;
    g[7] = empties;
    g[8] = hidden as u8;
    g[9] = cards_on_table(s) as u8;
    g[10] = deal as u8;
    g[11] = stranded(s, deals_left) as u8;
    g[12] = unknown;
    g[13 + match suits {
        1 => 0,
        2 => 1,
        _ => 2,
    }] = 1;
}

/// Unseen cards (face down or in the stock) by card byte.
type Unseen = [u8; 52];

/// The cards a masked game has not shown.
fn unseen_of(g: &Game) -> Unseen {
    let mut count = [0u8; 52];
    for set in 0..8u8 {
        let suit = match g.suits {
            1 => 0,
            2 => set % 2,
            3 => set % 3,
            _ => set % 4,
        };
        for rank in 0..13 {
            count[(suit * 13 + rank) as usize] += 1;
        }
    }
    for &suit in &g.completed {
        for rank in 0..13 {
            count[(suit * 13 + rank) as usize] -= 1;
        }
    }
    for c in 0..NUM_COLS {
        for card in &g.columns[c][g.face_down[c]..] {
            if *card != BLANK {
                count[card.0 as usize] -= 1;
            }
        }
    }
    count
}

/// A move at a decision: a line (its moves) or the deal.
#[derive(Clone)]
pub struct Action {
    pub moves: Vec<Move>,
    pub deal: bool,
    /// Turns a card over (or deals): leads to a chance node.
    pub reveals: bool,
    /// The position it leads to, new cards unknown.
    after: State,
    /// How much it raises the line player's evaluation (the more of normal
    /// and about to deal); 0 for the deal.
    gain: i32,
}

/// The moves from the masked position `obs`: lines that raise the line
/// player's evaluation (normal or about to deal) or turn a card, best
/// `max_lines` first, then the deal if it is allowed. Lines to positions in
/// `avoid` or `passed` (by [`State::hash`]) are left out.
pub(crate) fn actions(obs: &State, deals_left: usize, avoid: &HashSet<u64>, passed: &[u64], cfg: &LineConfig, max_lines: usize) -> Vec<Action> {
    let nodes = search_state(obs.clone(), cfg);
    let end_empty = if deals_left > 0 { cfg.deal_empty } else { cfg.end_empty };
    let base_n = cfg.eval(obs, deals_left, cfg.empty);
    let base_d = cfg.eval(obs, deals_left, end_empty);
    let mut cands = Vec::new();
    for k in 1..nodes.len() {
        let t = &nodes[k].state;
        let en = cfg.eval(t, deals_left, cfg.empty);
        if en == LOST {
            continue;
        }
        let gain = (en - base_n).max(cfg.eval(t, deals_left, end_empty) - base_d);
        if !nodes[k].leaf && gain <= 0 {
            continue;
        }
        let h = t.hash();
        if avoid.contains(&h) || passed.contains(&h) {
            continue;
        }
        cands.push((Reverse(gain), k));
    }
    cands.sort_unstable();
    cands.truncate(max_lines);
    let mut out: Vec<Action> = cands
        .into_iter()
        .map(|(Reverse(gain), k)| Action { moves: line_to(&nodes, k).concat(), deal: false, reveals: nodes[k].leaf, after: nodes[k].state.clone(), gain })
        .collect();
    if deals_left > 0 && obs.len.iter().all(|&l| l > 0 && (l as usize) < MAXC) {
        // After a deal every column has an unknown card on top.
        let mut after = obs.clone();
        for c in 0..NUM_COLS {
            after.cols[c][after.len[c] as usize] = BLANK.0;
            after.len[c] += 1;
            after.rehash(c);
        }
        after.deals_done += 1;
        out.push(Action { moves: Vec::new(), deal: true, reveals: true, after, gain: 0 });
    }
    out
}

/// Features of a decision: the position, then every move's afterstate.
fn decision_features(obs: &State, acts: &[Action], deals_left: usize, suits: u8) -> Vec<u8> {
    let mut f = vec![0u8; POS * (acts.len() + 1)];
    features(obs, deals_left, suits, false, &mut f[..POS]);
    for (i, a) in acts.iter().enumerate() {
        features(&a.after, deals_left - a.deal as usize, suits, a.deal, &mut f[POS * (i + 1)..POS * (i + 2)]);
    }
    f
}

/// One way the unknown face-up cards of a position can come out.
struct Outcome {
    state: State,
    unseen: Unseen,
    p: f32,
    /// Network value of `state`.
    v: f32,
    n: u32,
    /// Decision node at `state`, once expanded.
    child: u32,
}

/// The outcomes of the unknown face-up cards of `s` (cards just turned or
/// dealt): every card that can come up if there is one, else `samples`
/// random draws.
fn outcomes(s: &State, unseen: &Unseen, samples: usize, rng: &mut Rng) -> Vec<Outcome> {
    let blanks = |s: &State| -> Vec<(usize, usize)> {
        (0..NUM_COLS).flat_map(|c| (s.down[c] as usize..s.len[c] as usize).filter(move |&i| s.cols[c][i] == BLANK.0).map(move |i| (c, i))).collect()
    };
    let spots = blanks(s);
    let total: u32 = unseen.iter().map(|&x| x as u32).sum();
    let mut out = Vec::new();
    if spots.len() == 1 {
        let (c, i) = spots[0];
        for card in 0..52 {
            if unseen[card] == 0 {
                continue;
            }
            let mut t = s.clone();
            t.cols[c][i] = card as u8;
            t.rehash(c);
            let mut u = *unseen;
            u[card] -= 1;
            out.push(Outcome { state: t, unseen: u, p: unseen[card] as f32 / total as f32, v: 0.0, n: 0, child: NONE });
        }
        return out;
    }
    for _ in 0..samples {
        let mut t = s.clone();
        let mut u = *unseen;
        let mut left = total;
        loop {
            let spots = blanks(&t);
            if spots.is_empty() {
                break;
            }
            for (c, i) in spots {
                let mut r = (rng.next() % left as u64) as u32;
                let card = (0..52).find(|&k| {
                    if r < u[k] as u32 {
                        return true;
                    }
                    r -= u[k] as u32;
                    false
                });
                let card = card.expect("an unseen card");
                u[card] -= 1;
                left -= 1;
                t.cols[c][i] = card as u8;
            }
            // Dealt cards can complete a run (and turn the card under it).
            for c in 0..NUM_COLS {
                t.remove_if_complete(c);
                t.rehash(c);
            }
        }
        out.push(Outcome { state: t, unseen: u, p: 1.0 / samples as f32, v: 0.0, n: 0, child: NONE });
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct AzParams {
    pub suits: u8,
    /// Simulations per decision.
    pub sims: usize,
    pub c_puct: f32,
    /// Root Dirichlet noise (self-play only): concentration and weight.
    pub alpha: f32,
    pub eps: f32,
    /// Moves are sampled in proportion to visits for this many decisions,
    /// then the most visited is played.
    pub temp_moves: usize,
    /// Decisions per game at most.
    pub max_moves: usize,
    /// Moves a simulation may take below the root at most.
    pub max_depth: usize,
    /// Lines offered at a decision at most (besides the deal).
    pub max_lines: usize,
    /// Sampled outcomes of a deal.
    pub deal_samples: usize,
    pub seed: u64,
    /// The line search and the evaluation that ranks lines.
    pub lines: LineConfig,
}

impl AzParams {
    pub fn for_suits(suits: u8) -> AzParams {
        AzParams {
            suits,
            sims: 64,
            c_puct: 1.5,
            alpha: 0.3,
            eps: 0.25,
            temp_moves: 15,
            max_moves: 400,
            max_depth: 30,
            max_lines: 24,
            deal_samples: 6,
            seed: 0,
            lines: LineConfig::for_suits(suits),
        }
    }
}

/// splitmix64 with the few distributions self-play needs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let (a, b) = (self.unit().max(1e-300), self.unit());
        (-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()
    }
    /// Gamma(shape, 1) by Marsaglia and Tsang.
    fn gamma(&mut self, shape: f64) -> f64 {
        if shape < 1.0 {
            return self.gamma(shape + 1.0) * self.unit().max(1e-300).powf(1.0 / shape);
        }
        let d = shape - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        loop {
            let x = self.normal();
            let v = (1.0 + c * x).powi(3);
            if v <= 0.0 {
                continue;
            }
            let u = self.unit();
            if u.ln() < 0.5 * x * x + d - d * v + d * v.ln() {
                return d * v;
            }
        }
    }
}

const NONE: u32 = u32::MAX;

/// Where a move leads in the tree.
#[derive(Clone, Copy)]
enum Child {
    None,
    Dec(u32),
    Chance(u32),
}

struct Dec {
    /// [`State::hash`] of `state`.
    hash: u64,
    unseen: Unseen,
    deals_left: usize,
    /// Won, stuck or stranded: `value` is the outcome.
    terminal: bool,
    actions: Vec<Action>,
    prior: Vec<f32>,
    /// Network value of each move's afterstate.
    q0: Vec<f32>,
    n: Vec<u32>,
    child: Vec<Child>,
    /// Network value of the position.
    v0: f32,
    value: f32,
}

struct Chance {
    outcomes: Vec<Outcome>,
    n: u32,
    value: f32,
}

/// One move down a simulation's path: the decision node, the move, and the
/// outcome taken below it if it reveals cards.
#[derive(Clone, Copy)]
struct Hop {
    dec: u32,
    a: usize,
    out: Option<usize>,
}

/// A node waiting for the network: a decision node, or with `outcomes`, a
/// chance node (below the last hop of `path`) whose outcomes need values.
struct Pending {
    /// Hops from the root to the node's parent (empty for the root).
    path: Vec<Hop>,
    outcomes: Option<Vec<Outcome>>,
    state: State,
    unseen: Unseen,
    deals_left: usize,
    actions: Vec<Action>,
    /// `POS` bytes per position to evaluate.
    features: Vec<u8>,
    /// The same positions and their deals left, for heuristic evaluation.
    rows: Vec<(State, usize)>,
}

/// A finished decision, for training.
pub struct Record {
    /// Position then afterstates, `POS` bytes each.
    pub features: Vec<u8>,
    /// Visit distribution over the actions.
    pub pi: Vec<f32>,
    pub z: f32,
    /// The line player's lookahead value of the position (evaluation units
    /// / 1000), a dense signal the trainer calibrates against `z`.
    pub h: f32,
    /// The move played, and `h` of the next decision's position (NaN after
    /// the last): the value target of the move's afterstate.
    pub played: u32,
    pub h_next: f32,
    /// The search's value of the position, and of the next decision's (NaN
    /// where there was no search).
    pub q: f32,
    pub q_next: f32,
}

/// What a finished game reports.
pub struct GameResult {
    pub seed: u64,
    pub completed: u8,
    pub won: bool,
    pub decisions: usize,
}

/// One game and its search.
struct Slot {
    seed: u64,
    game: Game,
    /// Positions stood in, by [`State::hash`].
    history: HashSet<u64>,
    records: Vec<Record>,
    decs: Vec<Dec>,
    chances: Vec<Chance>,
    /// A search is under way (node 0 is its root once evaluated).
    searching: bool,
    sims: usize,
    pending: Option<Pending>,
    decisions: usize,
    rng: Rng,
    /// The line player's lookahead value of the current root.
    root_h: f32,
    /// Smallest and largest values in the current tree: Q is normalised to
    /// [0, 1] by them in the selection rule (as in MuZero), since the
    /// differences between moves are small on the outcome scale.
    qmin: f32,
    qmax: f32,
}

/// Runs games in lockstep, producing batches of positions to evaluate.
pub struct Driver {
    pub p: AzParams,
    slots: Vec<Option<Slot>>,
    next_seed: u64,
    last_seed: u64,
    /// Finished games and their training records.
    pub finished: Vec<(GameResult, Vec<Record>)>,
    /// Self-play (noise, sampling) or evaluation (greedy).
    train: bool,
}

/// Value and policy logits of one position.
#[derive(Clone, Copy, Default)]
pub struct Eval {
    pub v: f32,
    pub p: f32,
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

impl Driver {
    /// `concurrent` games at a time over seeds `first..first + count`.
    pub fn new(p: AzParams, concurrent: usize, first: u64, count: u64, train: bool) -> Driver {
        let mut d = Driver { p, slots: Vec::new(), next_seed: first, last_seed: first + count, finished: Vec::new(), train };
        for _ in 0..concurrent {
            let s = d.new_slot();
            d.slots.push(s);
        }
        d
    }

    fn new_slot(&mut self) -> Option<Slot> {
        if self.next_seed >= self.last_seed {
            return None;
        }
        let seed = self.next_seed;
        self.next_seed += 1;
        Some(Slot {
            seed,
            game: Game::new(self.p.suits, seed),
            history: HashSet::new(),
            records: Vec::new(),
            decs: Vec::new(),
            chances: Vec::new(),
            searching: false,
            sims: 0,
            pending: None,
            decisions: 0,
            rng: Rng(mix(self.p.seed, seed)),
            root_h: 0.0,
            qmin: f32::MAX,
            qmax: f32::MIN,
        })
    }

    pub fn done(&self) -> bool {
        self.slots.iter().all(|s| s.is_none())
    }

    /// Advance every game until it needs an evaluation; returns the
    /// positions to evaluate (`POS` bytes each), in slot order.
    pub fn requests(&mut self, threads: usize) -> Vec<u8> {
        let p = self.p;
        let train = self.train;
        // Threads take games one at a time: searches differ a lot in cost.
        let finished = std::sync::Mutex::new(Vec::new());
        let queue = std::sync::Mutex::new(self.slots.iter_mut().flatten());
        std::thread::scope(|sc| {
            for _ in 0..threads.max(1) {
                sc.spawn(|| loop {
                    let Some(slot) = queue.lock().unwrap().next() else { break };
                    if let Some(done) = advance(slot, &p, train) {
                        finished.lock().unwrap().push(done);
                    }
                });
            }
        });
        // Replace finished games with new ones and advance those too.
        let mut fin = finished.into_inner().unwrap();
        while !fin.is_empty() {
            let mut more = Vec::new();
            for (seed, result, records) in fin {
                self.finished.push((result, records));
                let i = self.slots.iter().position(|s| s.as_ref().is_some_and(|s| s.seed == seed)).unwrap();
                self.slots[i] = self.new_slot();
                if let Some(slot) = self.slots[i].as_mut() {
                    if let Some(done) = advance(slot, &p, train) {
                        more.push(done);
                    }
                }
            }
            fin = more;
        }
        let mut out = Vec::new();
        for slot in self.slots.iter().flatten() {
            if let Some(pd) = &slot.pending {
                out.extend_from_slice(&pd.features);
            }
        }
        out
    }

    /// Evaluations of the pending requests by the line player's evaluation
    /// instead of a network: value `a * eval / 1000 + b` (as a logit), and
    /// policy logit `eval / tau` (0 if `tau` is 0).
    pub fn heuristic_evals(&self, a: f32, b: f32, tau: f32) -> Vec<Eval> {
        let cfg = &self.p.lines;
        let logit = |x: f32| {
            let x = x.clamp(1e-4, 1.0 - 1e-4);
            (x / (1.0 - x)).ln()
        };
        let mut out = Vec::new();
        for slot in self.slots.iter().flatten() {
            let Some(pd) = &slot.pending else { continue };
            for (s, deals_left) in &pd.rows {
                let e = cfg.eval(s, *deals_left, cfg.empty).max(-1_000_000) as f32;
                out.push(Eval { v: logit(a * e / 1000.0 + b), p: if tau > 0.0 { e / tau } else { 0.0 } });
            }
        }
        out
    }

    /// Feed the evaluations of the last [`Driver::requests`] batch.
    pub fn feed(&mut self, evals: &[Eval]) {
        let mut at = 0;
        let p = self.p;
        let train = self.train;
        for slot in self.slots.iter_mut().flatten() {
            let Some(pd) = slot.pending.take() else { continue };
            let e = &evals[at..at + pd.rows.len()];
            at += pd.rows.len();
            let is_root = pd.path.is_empty();
            if let Some(mut outcomes) = pd.outcomes {
                for (o, x) in outcomes.iter_mut().zip(e) {
                    o.v = sigmoid(x.v);
                    slot.qmin = slot.qmin.min(o.v);
                    slot.qmax = slot.qmax.max(o.v);
                }
                let value = outcomes.iter().map(|o| o.p * o.v).sum();
                let hop = *pd.path.last().unwrap();
                slot.chances.push(Chance { outcomes, n: 0, value });
                slot.decs[hop.dec as usize].child[hop.a] = Child::Chance(slot.chances.len() as u32 - 1);
                backup(slot, &pd.path);
                slot.sims += 1;
                continue;
            }
            let Pending { path, state, unseen, deals_left, actions, features, .. } = pd;
            let k = actions.len();
            let v0 = sigmoid(e[0].v);
            let q0: Vec<f32> = e[1..].iter().map(|x| sigmoid(x.v)).collect();
            let mx = e[1..].iter().map(|x| x.p).fold(f32::MIN, f32::max);
            let mut prior: Vec<f32> = e[1..].iter().map(|x| (x.p - mx).exp()).collect();
            let s: f32 = prior.iter().sum();
            prior.iter_mut().for_each(|x| *x /= s);
            if is_root && train && p.eps > 0.0 && k > 1 {
                let noise: Vec<f64> = (0..k).map(|_| slot.rng.gamma(p.alpha as f64)).collect();
                let ns: f64 = noise.iter().sum();
                for (pr, nz) in prior.iter_mut().zip(&noise) {
                    *pr = (1.0 - p.eps) * *pr + p.eps * (*nz / ns) as f32;
                }
            }
            if is_root {
                let h = slot.root_h;
                slot.records.push(Record { features, pi: Vec::new(), z: 0.0, h, played: 0, h_next: f32::NAN, q: f32::NAN, q_next: f32::NAN });
            }
            for &x in q0.iter().chain([v0].iter()) {
                slot.qmin = slot.qmin.min(x);
                slot.qmax = slot.qmax.max(x);
            }
            let hash = state.hash();
            let dec = Dec { hash, unseen, deals_left, terminal: false, n: vec![0; k], child: vec![Child::None; k], actions, prior, q0, v0, value: v0 };
            attach_dec(slot, &path, dec);
            if !is_root {
                backup(slot, &path);
                slot.sims += 1;
            }
        }
        debug_assert_eq!(at, evals.len());
    }
}
/// Add a decision node below the end of `path` (or as the root).
fn attach_dec(slot: &mut Slot, path: &[Hop], dec: Dec) {
    let i = slot.decs.len() as u32;
    slot.decs.push(dec);
    if let Some(hop) = path.last() {
        match (hop.out, slot.decs[hop.dec as usize].child[hop.a]) {
            (None, _) => slot.decs[hop.dec as usize].child[hop.a] = Child::Dec(i),
            (Some(o), Child::Chance(c)) => slot.chances[c as usize].outcomes[o].child = i,
            _ => unreachable!("outcome below a move without a chance node"),
        }
    }
}

/// Current value of move `a` at decision `d`.
fn q(slot: &Slot, d: &Dec, a: usize) -> f32 {
    match d.child[a] {
        Child::None => d.q0[a],
        Child::Dec(i) => slot.decs[i as usize].value,
        Child::Chance(c) => slot.chances[c as usize].value,
    }
}

/// Count a simulation along `path` and recompute the values on it, from
/// the bottom up.
fn backup(slot: &mut Slot, path: &[Hop]) {
    for hop in path.iter().rev() {
        let di = hop.dec as usize;
        if let (Some(o), Child::Chance(c)) = (hop.out, slot.decs[di].child[hop.a]) {
            let decs = &slot.decs;
            let ch = &mut slot.chances[c as usize];
            ch.outcomes[o].n += 1;
            ch.n += 1;
            ch.value = ch.outcomes.iter().map(|x| x.p * if x.child == NONE { x.v } else { decs[x.child as usize].value }).sum();
        }
        slot.decs[di].n[hop.a] += 1;
        let d = &slot.decs[di];
        let (mut num, mut den) = (d.v0, 1.0);
        for a in 0..d.actions.len() {
            if d.n[a] > 0 {
                num += d.n[a] as f32 * q(slot, d, a);
                den += d.n[a] as f32;
            }
        }
        let v = num / den;
        slot.decs[di].value = v;
        slot.qmin = slot.qmin.min(v);
        slot.qmax = slot.qmax.max(v);
    }
}

/// PUCT choice at decision `d`.
fn select(slot: &Slot, d: &Dec, c_puct: f32) -> Option<usize> {
    let total: u32 = d.n.iter().sum();
    let sq = (total as f32).sqrt().max(1.0);
    let (lo, hi) = (slot.qmin, slot.qmax);
    let norm = |x: f32| if hi > lo { (x - lo) / (hi - lo) } else { 0.5 };
    (0..d.actions.len()).max_by(|&a, &b| {
        let score = |a: usize| norm(q(slot, d, a)) + c_puct * d.prior[a] * sq / (1.0 + d.n[a] as f32);
        score(a).total_cmp(&score(b)).then(b.cmp(&a))
    })
}

/// Start evaluating a decision node at `state` below `path`, or add it at
/// once if the game is over there (then backing up and returning false).
fn expand(slot: &mut Slot, p: &AzParams, path: Vec<Hop>, state: State, unseen: Unseen, deals_left: usize, passed: &[u64]) -> bool {
    let acts = if state.completed == 8 || stranded(&state, deals_left) {
        Vec::new()
    } else {
        actions(&state, deals_left, &slot.history, passed, &p.lines, p.max_lines)
    };
    if acts.is_empty() {
        let v = outcome(state.completed);
        let hash = state.hash();
        let dec = Dec { hash, unseen, deals_left, terminal: true, actions: Vec::new(), prior: Vec::new(), q0: Vec::new(), n: Vec::new(), child: Vec::new(), v0: v, value: v };
        attach_dec(slot, &path, dec);
        backup(slot, &path);
        slot.sims += 1;
        return false;
    }
    let features = decision_features(&state, &acts, deals_left, p.suits);
    let mut rows = vec![(state.clone(), deals_left)];
    rows.extend(acts.iter().map(|a| (a.after.clone(), deals_left - a.deal as usize)));
    slot.pending = Some(Pending { path, outcomes: None, state, unseen, deals_left, actions: acts, features, rows });
    true
}

/// One simulation from the root. Returns true if it stopped at a node that
/// needs evaluating (left in `slot.pending`).
fn simulate(slot: &mut Slot, p: &AzParams) -> bool {
    let mut d = 0usize;
    let mut path: Vec<Hop> = Vec::new();
    let mut passed: Vec<u64> = Vec::new();
    loop {
        let dec = &slot.decs[d];
        passed.push(dec.hash);
        if dec.terminal || path.len() >= p.max_depth {
            break;
        }
        let Some(a) = select(slot, dec, p.c_puct) else { break };
        match dec.child[a] {
            Child::Dec(i) => {
                path.push(Hop { dec: d as u32, a, out: None });
                d = i as usize;
            }
            Child::None => {
                path.push(Hop { dec: d as u32, a, out: None });
                let act = &dec.actions[a];
                let deals_left = dec.deals_left - act.deal as usize;
                if !act.reveals {
                    let (state, unseen) = (act.after.clone(), dec.unseen);
                    return expand(slot, p, path, state, unseen, deals_left, &passed);
                }
                // A chance node: every outcome is valued at once.
                let outs = outcomes(&act.after, &dec.unseen, p.deal_samples, &mut slot.rng);
                let mut features = vec![0u8; POS * outs.len()];
                for (o, f) in outs.iter().zip(features.chunks_exact_mut(POS)) {
                    self::features(&o.state, deals_left, p.suits, false, f);
                }
                let rows = outs.iter().map(|o| (o.state.clone(), deals_left)).collect();
                let (state, unseen) = (act.after.clone(), dec.unseen);
                slot.pending = Some(Pending { path, outcomes: Some(outs), state, unseen, deals_left, actions: Vec::new(), features, rows });
                return true;
            }
            Child::Chance(c) => {
                let ch = &slot.chances[c as usize];
                // The outcome furthest behind its share of the visits.
                let o = (0..ch.outcomes.len())
                    .max_by(|&i, &j| {
                        let lag = |k: usize| ch.outcomes[k].p * (ch.n + 1) as f32 - ch.outcomes[k].n as f32;
                        lag(i).total_cmp(&lag(j)).then(j.cmp(&i))
                    })
                    .unwrap();
                path.push(Hop { dec: d as u32, a, out: Some(o) });
                let out = &ch.outcomes[o];
                if out.child == NONE {
                    let deals_left = dec.deals_left - dec.actions[a].deal as usize;
                    let (state, unseen) = (out.state.clone(), out.unseen);
                    return expand(slot, p, path, state, unseen, deals_left, &passed);
                }
                d = out.child as usize;
            }
        }
    }
    backup(slot, &path);
    slot.sims += 1;
    false
}

/// Run `slot`'s searches and game until it needs an evaluation (left in
/// `slot.pending`) or the game ends (returned).
fn advance(slot: &mut Slot, p: &AzParams, train: bool) -> Option<(u64, GameResult, Vec<Record>)> {
    loop {
        if !slot.searching {
            // A new decision.
            let obs = mask(&slot.game);
            let os = State::from_game(&obs);
            let deals_left = slot.game.deals_remaining();
            slot.history.insert(os.hash());
            let acts = if slot.game.is_won() || slot.decisions >= p.max_moves {
                Vec::new()
            } else {
                actions(&os, deals_left, &slot.history, &[], &p.lines, p.max_lines)
            };
            if acts.is_empty() {
                if std::env::var_os("AZ_DEBUG").is_some() {
                    eprintln!("seed {} ends after {} decisions\n{}", slot.seed, slot.decisions, crate::human::show(&slot.game));
                }
                return Some(finish(slot));
            }
            slot.root_h = lookahead_value(&obs, deals_left, &slot.history, &p.lines) as f32 / 1000.0;
            if acts.len() == 1 {
                // Nothing to choose.
                let features = decision_features(&os, &acts, deals_left, p.suits);
                slot.records.push(Record { features, pi: vec![1.0], z: 0.0, h: slot.root_h, played: 0, h_next: f32::NAN, q: f32::NAN, q_next: f32::NAN });
                play(slot, &acts[0]);
                continue;
            }
            slot.decs.clear();
            slot.chances.clear();
            slot.sims = 0;
            slot.qmin = f32::MAX;
            slot.qmax = f32::MIN;
            slot.searching = true;
            let features = decision_features(&os, &acts, deals_left, p.suits);
            let mut rows = vec![(os.clone(), deals_left)];
            rows.extend(acts.iter().map(|a| (a.after.clone(), deals_left - a.deal as usize)));
            let unseen = unseen_of(&obs);
            slot.pending = Some(Pending { path: Vec::new(), outcomes: None, state: os, unseen, deals_left, actions: acts, features, rows });
            return None;
        }
        if slot.sims >= p.sims {
            play_decision(slot, p, train);
            continue;
        }
        if simulate(slot, p) {
            return None;
        }
    }
}

/// Play a move in the real game.
fn play(slot: &mut Slot, act: &Action) {
    if act.deal {
        slot.game.apply(Move::Deal).expect("deal is legal");
    } else {
        for &mv in &act.moves {
            slot.game.apply(mv).expect("line is legal");
        }
    }
    slot.decisions += 1;
}

/// Choose the root's move from its visits, record the decision, play it.
fn play_decision(slot: &mut Slot, p: &AzParams, train: bool) {
    slot.searching = false;
    let root = &slot.decs[0];
    let k = root.actions.len();
    let total: u32 = root.n.iter().sum();
    let pi: Vec<f32> = if total > 0 { root.n.iter().map(|&n| n as f32 / total as f32).collect() } else { root.prior.clone() };
    let a = if train && slot.decisions < p.temp_moves {
        let mut r = slot.rng.unit() as f32;
        let mut pick = k - 1;
        for (i, &x) in pi.iter().enumerate() {
            if r < x {
                pick = i;
                break;
            }
            r -= x;
        }
        pick
    } else {
        (0..k).max_by(|&i, &j| pi[i].total_cmp(&pi[j]).then_with(|| q(slot, root, i).total_cmp(&q(slot, root, j)))).unwrap()
    };
    let act = root.actions[a].clone();
    if std::env::var_os("AZ_TRACE").is_some() {
        let mut ranked: Vec<usize> = (0..k).collect();
        ranked.sort_by(|&i, &j| root.n[j].cmp(&root.n[i]));
        let desc = |i: usize| {
            let a = &root.actions[i];
            if a.deal { "deal".to_string() } else { format!("{:?}", a.moves.iter().map(|m| m.encode()).collect::<Vec<_>>()) }
        };
        let top: Vec<String> =
            ranked.iter().take(5).map(|&i| format!("{} gain={} p={:.2} q0={:.3} q={:.3} n={}", desc(i), root.actions[i].gain, root.prior[i], root.q0[i], q(slot, root, i), root.n[i])).collect();
        eprintln!("{}\nvalue {:.3} (net {:.3}) chose {}\n  {}", crate::human::show(&slot.game), root.value, root.v0, desc(a), top.join("\n  "));
    }
    if let Some(r) = slot.records.last_mut() {
        r.pi = pi;
        r.played = a as u32;
        r.q = root.value;
    }
    play(slot, &act);
}

/// Give every record the next one's lookahead and search values.
fn link_next(records: &mut [Record]) {
    for i in 0..records.len() {
        records[i].h_next = records.get(i + 1).map_or(f32::NAN, |r| r.h);
        records[i].q_next = records.get(i + 1).map_or(f32::NAN, |r| r.q);
    }
}

fn finish(slot: &mut Slot) -> (u64, GameResult, Vec<Record>) {
    let completed = slot.game.completed.len() as u8;
    let z = outcome(completed);
    let mut records = std::mem::take(&mut slot.records);
    records.retain(|r| !r.pi.is_empty());
    for r in records.iter_mut() {
        r.z = z;
    }
    link_next(&mut records);
    let result = GameResult { seed: slot.seed, completed, won: slot.game.is_won(), decisions: slot.decisions };
    (slot.seed, result, records)
}

/// Play the line player on `seed` and record its decisions among this
/// player's moves, for training the network to imitate it. The policy
/// target is half the move played and half a softmax, at temperature `tau`
/// (evaluation units), of every move's value in the mode the line player
/// decided in (the deal valued as the position itself).
pub fn imitate(p: &AzParams, seed: u64, tau: f32) -> (GameResult, Vec<Record>) {
    let cfg = &p.lines;
    let mut g = Game::new(p.suits, seed);
    let mut visited = HashSet::new();
    let mut records = Vec::new();
    let mut decisions = 0;
    while !g.is_won() && decisions < p.max_moves {
        let obs = mask(&g);
        let os = State::from_game(&obs);
        let deals_left = g.deals_remaining();
        visited.insert(os.hash());
        let (choice, _) = decide_steps(&obs, deals_left, &visited, &mut Default::default(), cfg);
        let line: Option<Vec<Move>> = match choice {
            Choice::Line(steps) => Some(steps.concat()),
            Choice::Deal => None,
            Choice::Stuck => break,
        };
        let acts = actions(&os, deals_left, &visited, &[], cfg, p.max_lines);
        let played = match &line {
            None => acts.iter().position(|a| a.deal),
            Some(moves) => {
                let mut t = os.clone();
                for &mv in moves {
                    t.apply(mv, &[]);
                }
                let h = t.hash();
                acts.iter().position(|a| !a.deal && a.after.hash() == h)
            }
        };
        if let Some(played) = played.filter(|_| acts.len() > 1) {
            let base = cfg.eval(&os, deals_left, cfg.empty);
            let raises = acts.iter().any(|a| !a.deal && cfg.eval(&a.after, deals_left, cfg.empty) > base);
            let empty = if raises {
                cfg.empty
            } else if deals_left > 0 {
                cfg.deal_empty
            } else {
                cfg.end_empty
            };
            let vals: Vec<f32> = acts.iter().map(|a| cfg.eval(if a.deal { &os } else { &a.after }, deals_left, empty) as f32).collect();
            let mx = vals.iter().copied().fold(f32::MIN, f32::max);
            let mut pi: Vec<f32> = vals.iter().map(|v| ((v - mx) / tau).exp()).collect();
            let s: f32 = pi.iter().sum();
            pi.iter_mut().for_each(|x| *x *= 0.5 / s);
            pi[played] += 0.5;
            let h = lookahead_value(&obs, deals_left, &visited, cfg) as f32 / 1000.0;
            records.push(Record { features: decision_features(&os, &acts, deals_left, p.suits), pi, z: 0.0, h, played: played as u32, h_next: f32::NAN, q: f32::NAN, q_next: f32::NAN });
        }
        match line {
            None => g.apply(Move::Deal).expect("deal is legal"),
            Some(moves) => {
                for mv in moves {
                    g.apply(mv).expect("line is legal");
                }
            }
        }
        decisions += 1;
    }
    let completed = g.completed.len() as u8;
    for r in records.iter_mut() {
        r.z = outcome(completed);
    }
    link_next(&mut records);
    (GameResult { seed, completed, won: g.is_won(), decisions }, records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn features_ignore_hidden_cards() {
        let a = Game::new(4, 3);
        let mut b = a.clone();
        b.columns[0][0] = crate::game::Card::new(1, 5);
        let (sa, sb) = (State::from_game(&a), State::from_game(&b));
        let (mut fa, mut fb) = (vec![0u8; POS], vec![0u8; POS]);
        features(&sa, 5, 4, false, &mut fa);
        features(&sb, 5, 4, false, &mut fb);
        assert_eq!(fa, fb);
    }

    #[test]
    fn outcomes_cover_the_unseen_cards() {
        let g = mask(&Game::new(2, 7));
        let s = State::from_game(&g);
        let u = unseen_of(&g);
        assert_eq!(u.iter().map(|&x| x as usize).sum::<usize>(), 104 - 10);
        let acts = actions(&s, 5, &HashSet::new(), &[], &LineConfig::for_suits(2), 24);
        let mut rng = Rng(1);
        for a in acts.iter().filter(|a| a.reveals) {
            let outs = outcomes(&a.after, &u, 4, &mut rng);
            let total: f32 = outs.iter().map(|o| o.p).sum();
            assert!((total - 1.0).abs() < 1e-4);
            for o in &outs {
                assert!((0..NUM_COLS).all(|c| (o.state.down[c]..o.state.len[c]).all(|i| o.state.cols[c][i as usize] != BLANK.0)));
                assert_eq!(o.unseen.iter().map(|&x| x as usize).sum::<usize>(), 94 - if a.deal { 10 } else { 1 });
            }
        }
    }

    #[test]
    fn lockstep_games_finish_with_uniform_network() {
        let mut p = AzParams::for_suits(2);
        p.sims = 8;
        p.max_moves = 30;
        let mut d = Driver::new(p, 3, 1, 4, true);
        let mut rounds = 0;
        while !d.done() {
            let req = d.requests(2);
            let n = req.len() / POS;
            d.feed(&vec![Eval::default(); n]);
            rounds += 1;
            assert!(rounds < 100_000);
        }
        assert_eq!(d.finished.len(), 4);
        for (r, recs) in &d.finished {
            assert_eq!(recs.len(), r.decisions);
            for rec in recs {
                assert_eq!(rec.features.len(), POS * (rec.pi.len() + 1));
                assert!((rec.pi.iter().sum::<f32>() - 1.0).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn imitation_records_the_line_players_lines() {
        let p = AzParams::for_suits(2);
        let (r, recs) = imitate(&p, 5, 10.0);
        assert!(!recs.is_empty());
        assert!(recs.len() <= r.decisions);
    }
}
