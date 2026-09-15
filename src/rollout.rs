//! Alternate solver: nested rollout policy adaptation (NRPA) with a
//! heuristic prior.
//!
//! Where the class solver (`solver.rs`) searches a graph of equivalence
//! classes with a budgeted best-first/depth-first scheme, this one never
//! builds a graph at all. It plays complete randomised games ("rollouts")
//! from the position, sampling each move from a softmax policy
//! `P(m) ∝ exp(w[code(m)] + beta * h(m))`, where `h` is the change in the static evaluation the move causes (the
//! prior) and `w` are learned weights over move codes (moved card × card it
//! lands on). NRPA nests: a level-`l` search runs `iters` level-`l-1`
//! searches, keeps the best rollout seen and shifts the policy toward its
//! moves (Rosin 2011; the heuristic bias follows Cazenave's GNRPA).
//!
//! Moves can be single card moves, or (`classes`) exits of the equivalence
//! class under reversible moves, as in the class solver: then each rollout
//! step is a productive move (flip, join, detach, deal) reached through any
//! number of reversible shuffles, which is what winning lines are made of.
//!
//! It can only find wins, never prove unsolvability. Its point is speed on
//! solvable deals: a rollout costs a few hundred position evaluations, so an
//! easy deal is solved in a handful of rollouts.

use crate::game::{Game, Move, DEAL_SIZE, NUM_COLS};
use crate::solver::{decode_path, encode_path, enumerate_class, stock_deals, SolveResult, State, Verdict, Weights};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Move codes: moved card (52) × card landed on (52, or 52 for an empty
/// column), plus one code per stock deal.
const N_CODES: usize = 52 * 53 + 8;
const DEAL_CODE: usize = 52 * 53;
const WIN: i64 = 1 << 40;

#[derive(Clone, Debug)]
pub struct RolloutParams {
    pub name: &'static str,
    pub weights: Weights,
    /// Prior scale: nats per evaluation point.
    pub beta: f32,
    /// Evaluation delta assigned to a deal (the true delta is large and
    /// negative, which would never let the policy deal).
    pub deal_h: i32,
    /// Nesting depth. 0 is plain repeated rollouts.
    pub level: u8,
    /// Rollouts (or sub-searches) per level.
    pub iters: u32,
    /// Policy learning rate.
    pub alpha: f32,
    /// Maximum rollout length in moves.
    pub max_len: usize,
    /// When a deal is offered: 0 always, 1 only when no move improves the
    /// evaluation, 2 only when every move worsens it.
    pub deal_rule: u8,
    /// Roll out over class exits instead of single moves.
    pub classes: bool,
    /// Class enumeration cap in class mode.
    pub class_cap: usize,
    /// Deal exits kept per class (best by post-deal evaluation).
    pub deals_per_class: usize,
    /// Wall-clock limit in seconds (0 = none); the work budget still applies.
    pub time_limit: f32,
    pub seed: u64,
}

impl Default for RolloutParams {
    fn default() -> RolloutParams {
        RolloutParams {
            name: "nrpa",
            weights: Weights::default(),
            beta: 0.25,
            deal_h: -4,
            level: 2,
            iters: 40,
            alpha: 1.0,
            max_len: 800,
            deal_rule: 1,
            classes: true,
            class_cap: 2000,
            deals_per_class: 2,
            time_limit: 0.0,
            seed: 1,
        }
    }
}

impl RolloutParams {
    pub fn from_env() -> RolloutParams {
        let d = RolloutParams::default();
        let w = d.weights;
        RolloutParams {
            name: "nrpa-env",
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
            beta: env_or("SPIDER_R_BETA", d.beta),
            deal_h: env_or("SPIDER_R_DEAL_H", d.deal_h),
            level: env_or("SPIDER_R_LEVEL", d.level),
            iters: env_or("SPIDER_R_ITERS", d.iters),
            alpha: env_or("SPIDER_R_ALPHA", d.alpha),
            max_len: env_or("SPIDER_R_MAX_LEN", d.max_len),
            deal_rule: env_or("SPIDER_R_DEAL_RULE", d.deal_rule),
            classes: env_or::<u8>("SPIDER_R_CLASSES", d.classes as u8) != 0,
            class_cap: env_or("SPIDER_R_CLASS_CAP", d.class_cap),
            deals_per_class: env_or("SPIDER_R_DEALS_PER_CLASS", d.deals_per_class),
            time_limit: env_or("SPIDER_R_TIME", d.time_limit),
            seed: env_or("SPIDER_R_SEED", d.seed),
        }
    }
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// One legal move at some step of a rollout, as the policy saw it.
#[derive(Clone, Copy)]
struct Option_ {
    code: u16,
    h: i16,
}

struct Step {
    options: Vec<Option_>,
    chosen: u16,
}

struct Rollout {
    score: i64,
    moves: Vec<Move>,
    steps: Vec<Step>,
}

type Policy = Vec<f32>;

pub struct RolloutSolver {
    deals: Vec<[u8; DEAL_SIZE]>,
    p: RolloutParams,
    rng: u64,
    /// Work: positions evaluated.
    work: u64,
    budget: u64,
    rollouts: u64,
    pub cancel: Option<Arc<AtomicBool>>,
    pub work_counter: Option<Arc<AtomicU64>>,
    stop: bool,
    win: Option<Vec<Move>>,
    best_score: i64,
    /// How rollouts ended: won, stuck with stock left, stuck with none, cut at max_len.
    ends: [u64; 4],
    /// Class mode statistics: classes enumerated, exits seen, exits kept.
    stats: [u64; 3],
    debug: bool,
    started: Instant,
    // Scratch buffers reused across steps.
    children: Vec<State>,
    cand: Vec<(Move, Option_)>,
    /// Class mode: the moves from the current position to each candidate.
    paths: Vec<Box<[u8]>>,
    logits: Vec<f32>,
}

impl RolloutSolver {
    pub fn new(g: &Game, budget: u64, p: RolloutParams) -> RolloutSolver {
        RolloutSolver {
            deals: stock_deals(g),
            rng: p.seed.wrapping_mul(0x9E3779B97F4A7C15) | 1,
            p,
            work: 0,
            budget,
            rollouts: 0,
            cancel: None,
            work_counter: None,
            stop: false,
            win: None,
            best_score: i64::MIN,
            ends: [0; 4],
            stats: [0; 3],
            debug: std::env::var_os("SPIDER_DEBUG").is_some(),
            started: Instant::now(),
            children: Vec::new(),
            cand: Vec::new(),
            paths: Vec::new(),
            logits: Vec::new(),
        }
    }

    pub fn solve(&mut self, g: &Game) -> SolveResult {
        let root = State::from_game(g);
        let mut restarts = 0u32;
        while !self.stop {
            let mut pol: Policy = vec![0.0; N_CODES];
            self.nrpa(&root, self.p.level, &mut pol);
            restarts += 1;
            if self.debug && !self.stop {
                eprintln!("[nrpa] restart {restarts} at work {} rollouts {}", self.work, self.rollouts);
            }
        }
        if self.debug {
            eprintln!(
                "[nrpa] rollouts {} ends: won {} stuck-with-stock {} stuck {} cut {}",
                self.rollouts, self.ends[0], self.ends[1], self.ends[2], self.ends[3]
            );
            eprintln!(
                "[nrpa] classes {} members/class {:.1} exits/class {:.1} kept/class {:.1}",
                self.stats[0],
                self.work as f64 / self.stats[0].max(1) as f64,
                self.stats[1] as f64 / self.stats[0].max(1) as f64,
                self.stats[2] as f64 / self.stats[0].max(1) as f64
            );
        }
        let verdict = if self.win.is_some() { Verdict::Solvable } else { Verdict::Unknown };
        SolveResult {
            verdict,
            nodes: self.work,
            classes: self.rollouts,
            proof_pass: false,
            config: self.p.name,
            elapsed: self.started.elapsed(),
            line: self.win.take().unwrap_or_default(),
        }
    }

    fn check_stop(&mut self) {
        if self.win.is_some() || self.work >= self.budget {
            self.stop = true;
        }
        if self.p.time_limit > 0.0 && self.started.elapsed().as_secs_f32() >= self.p.time_limit {
            self.stop = true;
        }
        if let Some(c) = &self.cancel {
            if c.load(Ordering::Relaxed) {
                self.stop = true;
            }
        }
        if let Some(w) = &self.work_counter {
            w.store(self.work, Ordering::Relaxed);
        }
    }

    fn nrpa(&mut self, root: &State, level: u8, pol: &mut Policy) -> Option<Rollout> {
        if level == 0 {
            let r = self.playout(root, pol);
            self.check_stop();
            return Some(r);
        }
        let mut best: Option<Rollout> = None;
        for _ in 0..self.p.iters {
            let mut sub = pol.clone();
            let r = self.nrpa(root, level - 1, &mut sub);
            if let Some(r) = r {
                if best.as_ref().is_none_or(|b| r.score >= b.score) {
                    if self.debug && r.score > self.best_score {
                        self.best_score = r.score;
                        eprintln!(
                            "[nrpa] L{level} best {} len {} work {} rollouts {} {:.2}s",
                            r.score,
                            r.moves.len(),
                            self.work,
                            self.rollouts,
                            self.started.elapsed().as_secs_f64()
                        );
                    }
                    best = Some(r);
                }
            }
            if self.stop {
                break;
            }
            if let Some(b) = &best {
                self.adapt(pol, b);
            }
        }
        best
    }

    /// Shift the policy toward the rollout's moves (standard NRPA update,
    /// with the prior included in the probabilities).
    fn adapt(&self, pol: &mut Policy, r: &Rollout) {
        let alpha = self.p.alpha;
        let beta = self.p.beta;
        let mut probs: Vec<f32> = Vec::new();
        for step in &r.steps {
            probs.clear();
            let mut max = f32::MIN;
            for o in &step.options {
                let l = pol[o.code as usize] + beta * o.h as f32;
                probs.push(l);
                max = max.max(l);
            }
            let mut z = 0.0;
            for p in probs.iter_mut() {
                *p = (*p - max).exp();
                z += *p;
            }
            for (o, p) in step.options.iter().zip(&probs) {
                pol[o.code as usize] -= alpha * p / z;
            }
            pol[step.options[step.chosen as usize].code as usize] += alpha;
        }
    }

    fn rand(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    fn rand_f32(&mut self) -> f32 {
        (self.rand() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Play one game with the policy from `root`. Terminates at a win, when
    /// no move leads to an unvisited position, or at `max_len`.
    fn playout(&mut self, root: &State, pol: &Policy) -> Rollout {
        self.rollouts += 1;
        let w = self.p.weights;
        let beta = self.p.beta;
        let mut s = root.clone();
        let mut visited: HashSet<u64> = HashSet::with_capacity(2048);
        visited.insert(s.hash());
        let mut moves = Vec::new();
        let mut steps = Vec::new();
        let mut cur_eval = s.eval(&w);
        let score;
        loop {
            if s.completed == 8 {
                score = WIN - moves.len() as i64;
                self.ends[0] += 1;
                break;
            }
            if moves.len() >= self.p.max_len {
                score = cur_eval as i64;
                self.ends[3] += 1;
                break;
            }
            if self.p.classes {
                if self.gen_exits(&s, cur_eval, &mut moves) {
                    score = WIN - moves.len() as i64;
                    self.ends[0] += 1;
                    break;
                }
            } else {
                self.gen_children(&s, &mut visited, cur_eval);
            }
            if self.cand.is_empty() {
                score = cur_eval as i64;
                self.ends[if (s.deals_done as usize) < self.deals.len() { 1 } else { 2 }] += 1;
                break;
            }
            // Softmax sample.
            let mut max = f32::MIN;
            self.logits.clear();
            for (_, o) in &self.cand {
                let l = pol[o.code as usize] + beta * o.h as f32;
                self.logits.push(l);
                max = max.max(l);
            }
            let mut z = 0.0f32;
            for l in self.logits.iter_mut() {
                *l = (*l - max).exp();
                z += *l;
            }
            let mut r = self.rand_f32() * z;
            let mut pick = self.cand.len() - 1;
            for (i, l) in self.logits.iter().enumerate() {
                if r < *l {
                    pick = i;
                    break;
                }
                r -= *l;
            }
            let (mv, o) = self.cand[pick];
            steps.push(Step { options: self.cand.iter().map(|c| c.1).collect(), chosen: pick as u16 });
            if self.p.classes {
                decode_path(&self.paths[pick], &mut moves);
            } else {
                moves.push(mv);
            }
            std::mem::swap(&mut s, &mut self.children[pick]);
            if !self.p.classes {
                visited.insert(s.hash());
            }
            cur_eval = if mv == Move::Deal { s.eval(&w) } else { cur_eval + o.h as i32 };
        }
        if score >= WIN - self.p.max_len as i64 && self.win.is_none() {
            self.win = Some(moves.clone());
        }
        Rollout { score, moves, steps }
    }

    /// Class mode: fill `cand`/`children`/`paths` with the exits of the class
    /// of `s`, one per distinct resulting position. Appends the moves to a
    /// win onto `moves` and returns true if the class has a winning exit.
    fn gen_exits(&mut self, s: &State, cur_eval: i32, moves: &mut Vec<Move>) -> bool {
        let w = self.p.weights;
        self.cand.clear();
        self.paths.clear();
        let (cls, _) = enumerate_class(s, &self.deals, self.p.class_cap, false, None);
        self.work += cls.members.len() as u64;
        self.stats[0] += 1;
        self.stats[1] += cls.exits.len() as u64;
        if let Some(ei) = cls.win {
            decode_path(&encode_path(&cls, ei), moves);
            return true;
        }
        let mut seen: HashSet<u64> = HashSet::with_capacity(cls.exits.len());
        let mut deals: Vec<(i32, usize)> = Vec::new();
        let mut best_h = i16::MIN;
        for (ei, ex) in cls.exits.iter().enumerate() {
            if !seen.insert(ex.result.hash()) {
                continue;
            }
            let e = ex.result.eval(&w);
            if ex.mv == Move::Deal {
                deals.push((e, ei));
                continue;
            }
            let h = (e - cur_eval).clamp(-30000, 30000) as i16;
            best_h = best_h.max(h);
            let m = &cls.members[ex.member as usize].state;
            let (from, to, count) = match ex.mv {
                Move::Move { from, to, count } => (from, to, count),
                Move::Deal => unreachable!(),
            };
            let card = m.cols[from][m.len[from] as usize - count] as usize;
            let dest = if m.len[to] == 0 { 52 } else { m.top(to) as usize };
            let ci = self.cand.len();
            if self.children.len() <= ci {
                self.children.push(ex.result.clone());
            } else {
                self.children[ci].clone_from(&ex.result);
            }
            self.cand.push((ex.mv, Option_ { code: (card * 53 + dest) as u16, h }));
            self.paths.push(encode_path(&cls, ei));
        }
        self.stats[2] += self.cand.len() as u64;
        let allowed = match self.p.deal_rule {
            0 => true,
            1 => best_h <= 0,
            _ => best_h < 0,
        };
        if allowed && !deals.is_empty() {
            deals.sort_unstable_by(|a, b| b.0.cmp(&a.0));
            let top = deals[0].0;
            for &(e, ei) in deals.iter().take(self.p.deals_per_class) {
                let ex = &cls.exits[ei];
                let ci = self.cand.len();
                if self.children.len() <= ci {
                    self.children.push(ex.result.clone());
                } else {
                    self.children[ci].clone_from(&ex.result);
                }
                let h = (self.p.deal_h + e - top).clamp(-30000, 30000) as i16;
                self.cand.push((Move::Deal, Option_ { code: (DEAL_CODE + s.deals_done as usize) as u16, h }));
                self.paths.push(encode_path(&cls, ei));
            }
        }
        false
    }

    /// Fill `cand`/`children` with the legal moves from `s` that lead to
    /// positions not in `visited`.
    fn gen_children(&mut self, s: &State, visited: &mut HashSet<u64>, cur_eval: i32) {
        let w = self.p.weights;
        self.cand.clear();
        let mut ci = 0;
        let first_empty = (0..NUM_COLS).find(|&c| s.len[c] == 0);
        let mut try_move = |this: &mut Self, mv: Move, code: usize, deal: bool| {
            if this.children.len() <= ci {
                this.children.push(s.clone());
            } else {
                this.children[ci].clone_from(s);
            }
            if !this.children[ci].apply(mv, &this.deals) {
                return;
            }
            this.work += 1;
            let hh = this.children[ci].hash();
            if visited.contains(&hh) {
                return;
            }
            let h = if deal { this.p.deal_h } else { this.children[ci].eval(&w) - cur_eval };
            this.cand.push((mv, Option_ { code: code as u16, h: h.clamp(-30000, 30000) as i16 }));
            ci += 1;
        };
        for from in 0..NUM_COLS {
            let run = s.run_len(from);
            if run == 0 {
                continue;
            }
            let n = s.len[from] as usize;
            for to in 0..NUM_COLS {
                if to == from {
                    continue;
                }
                if s.len[to] == 0 {
                    if Some(to) != first_empty {
                        continue;
                    }
                    for count in 1..=run {
                        if count == n {
                            continue; // relabels the empty column
                        }
                        let card = s.cols[from][n - count] as usize;
                        try_move(self, Move::Move { from, to, count }, card * 53 + 52, false);
                    }
                } else {
                    let top = s.top(to);
                    let k = (top % 13) as i32 - (s.top(from) % 13) as i32;
                    if k >= 1 && k as usize <= run {
                        let count = k as usize;
                        let card = s.cols[from][n - count] as usize;
                        try_move(self, Move::Move { from, to, count }, card * 53 + top as usize, false);
                    }
                }
            }
        }
        if (s.deals_done as usize) < self.deals.len() && first_empty.is_none() {
            let best_h = self.cand.iter().map(|c| c.1.h).max().unwrap_or(i16::MIN);
            let allowed = match self.p.deal_rule {
                0 => true,
                1 => best_h <= 0,
                _ => best_h < 0,
            };
            if allowed {
                try_move(self, Move::Deal, DEAL_CODE + s.deals_done as usize, true);
            }
        }
    }
}

/// Convenience: solve with parameters from the environment.
pub fn solve_rollout(g: &Game, budget: u64) -> SolveResult {
    RolloutSolver::new(g, budget, RolloutParams::from_env()).solve(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_suit_rollout_wins() {
        let mut g = Game::new(1, 1);
        let r = RolloutSolver::new(&g, 2_000_000, RolloutParams::default()).solve(&g);
        assert_eq!(r.verdict, Verdict::Solvable, "work {}", r.nodes);
        for mv in &r.line {
            g.apply(*mv).expect("line legal");
        }
        assert!(g.is_won());
    }
}
