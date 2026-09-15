//! Alternate solver: beam search over equivalence classes, one beam per
//! stock level.
//!
//! The class solver explores depth-first with backtracking and budgets; this
//! one keeps, at each step, only the `width` best classes (by static
//! evaluation) among all children of the current frontier, and never
//! backtracks. Deal exits are not competed against card moves (they always
//! look worse): they are pooled, and when a stock level's beam runs dry the
//! best `width` pooled post-deal positions seed the next level. If every
//! level runs dry without a win the width doubles and the search restarts.
//!
//! Like the rollout solver it can only find wins, never prove
//! unsolvability.

use crate::game::{Game, Move, DEAL_SIZE};
use crate::solver::{decode_path, encode_path, enumerate_class, stock_deals, Compact, Config, SolveResult, Solver, State, Verdict, Weights};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct BeamParams {
    pub name: &'static str,
    pub weights: Weights,
    /// Beam width: classes kept per step.
    pub width: usize,
    /// Width multiplier per restart.
    pub growth: usize,
    pub class_cap: usize,
    /// Deal exits kept per class (best by post-deal evaluation).
    pub deals_per_class: usize,
    /// Card-move children kept per class (best by evaluation), for diversity.
    pub per_parent: usize,
    /// Wall-clock limit in seconds (0 = none).
    pub time_limit: f32,
    /// Work budget for the class solver on each endgame candidate once the
    /// stock is empty (0 = beam through the endgame too).
    pub end_dfs: u64,
    /// The beam gets this many times the budget it is given: its work is
    /// cheaper per unit than the class search's, and the hard deals it wins
    /// need 5-10M work.
    pub budget_mul: u64,
}

impl Default for BeamParams {
    fn default() -> BeamParams {
        BeamParams {
            name: "beam",
            weights: Weights::default(),
            width: 16,
            growth: 4,
            class_cap: 500,
            deals_per_class: 2,
            per_parent: 8,
            time_limit: 0.0,
            end_dfs: 100_000,
            budget_mul: 4,
        }
    }
}

impl BeamParams {
    pub fn from_env() -> BeamParams {
        let d = BeamParams::default();
        let w = d.weights;
        BeamParams {
            name: "beam-env",
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
            width: env_or("SPIDER_B_WIDTH", d.width),
            growth: env_or("SPIDER_B_GROWTH", d.growth),
            class_cap: env_or("SPIDER_B_CLASS_CAP", d.class_cap),
            deals_per_class: env_or("SPIDER_B_DEALS_PER_CLASS", d.deals_per_class),
            per_parent: env_or("SPIDER_B_PER_PARENT", d.per_parent),
            time_limit: env_or("SPIDER_B_TIME", d.time_limit),
            end_dfs: env_or("SPIDER_B_END_DFS", d.end_dfs),
            budget_mul: env_or("SPIDER_B_BUDGET_MUL", d.budget_mul),
        }
    }
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

struct Node {
    parent: u32,
    path: Box<[u8]>,
    state: Compact,
}

/// A child position waiting to be kept or dropped.
struct Cand {
    eval: i32,
    parent: u32,
    path: Box<[u8]>,
    state: Compact,
}

pub struct BeamSolver {
    deals: Vec<[u8; DEAL_SIZE]>,
    suits: u8,
    p: BeamParams,
    work: u64,
    classes: u64,
    budget: u64,
    pub cancel: Option<Arc<AtomicBool>>,
    pub work_counter: Option<Arc<AtomicU64>>,
    stop: bool,
    debug: bool,
    started: Instant,
    nodes: Vec<Node>,
    seen: HashSet<u64>,
    /// Deepest stock level reached in the current run.
    level_reached: usize,
}

impl BeamSolver {
    pub fn new(g: &Game, budget: u64, p: BeamParams) -> BeamSolver {
        BeamSolver {
            deals: stock_deals(g),
            suits: g.suits,
            work: 0,
            classes: 0,
            budget: budget.saturating_mul(p.budget_mul.max(1)),
            p,
            cancel: None,
            work_counter: None,
            stop: false,
            debug: std::env::var_os("SPIDER_DEBUG").is_some(),
            started: Instant::now(),
            nodes: Vec::new(),
            seen: HashSet::new(),
            level_reached: 0,
        }
    }

    pub fn solve(&mut self, g: &Game) -> SolveResult {
        let root = State::from_game(g);
        let mut width = self.p.width;
        let mut line = Vec::new();
        let mut verdict = Verdict::Unknown;
        while !self.stop {
            self.nodes.clear();
            self.seen.clear();
            if let Some(win) = self.run(&root, width) {
                line = win;
                verdict = Verdict::Solvable;
                break;
            }
            if self.debug {
                eprintln!(
                    "[beam] width {width} exhausted at level {} work {} classes {} {:.2}s",
                    self.level_reached,
                    self.work,
                    self.classes,
                    self.started.elapsed().as_secs_f64()
                );
            }
            width *= self.p.growth;
        }
        SolveResult {
            verdict,
            nodes: self.work,
            classes: self.classes,
            proof_pass: false,
            config: self.p.name,
            elapsed: self.started.elapsed(),
            line,
        }
    }

    fn check_stop(&mut self) -> bool {
        if self.work >= self.budget {
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
        self.stop
    }

    /// One beam search of the given width. Returns the winning line if found.
    fn run(&mut self, root: &State, width: usize) -> Option<Vec<Move>> {
        let w = self.p.weights;
        let levels = self.deals.len() + 1;
        self.nodes.push(Node { parent: u32::MAX, path: Box::new([]), state: Compact::from_state(root) });
        // Post-deal candidates per stock level, kept bounded to `width`.
        let mut pools: Vec<Vec<Cand>> = (0..levels).map(|_| Vec::new()).collect();
        let mut frontier: Vec<u32> = vec![0];
        for level in 0..levels {
            self.level_reached = level;
            if level > 0 {
                let pool = &mut pools[level];
                pool.sort_unstable_by_key(|c| std::cmp::Reverse(c.eval));
                pool.truncate(width);
                frontier = pool.drain(..).map(|c| self.push(c)).collect();
            }
            if level + 1 == levels && self.p.end_dfs > 0 && level > 0 {
                // Endgame: the class solver, which backtracks, does better
                // than a beam here.
                for &nid in &frontier {
                    let s = self.nodes[nid as usize].state.to_state();
                    let game = Game::from_position_text(self.suits, &s.to_text()).expect("valid position");
                    let mut solver = Solver::with_config(&game, self.p.end_dfs, Config::default());
                    solver.cancel = self.cancel.clone();
                    let r = solver.solve(&game);
                    self.work += r.nodes;
                    self.classes += r.classes;
                    if r.verdict == Verdict::Solvable {
                        let mut line = self.line_to(nid);
                        line.extend(r.line);
                        return Some(line);
                    }
                    if self.check_stop() {
                        return None;
                    }
                }
                return None;
            }
            let mut depth = 0;
            while !frontier.is_empty() {
                let mut next: Vec<Cand> = Vec::new();
                for &nid in &frontier {
                    let s = self.nodes[nid as usize].state.to_state();
                    let (cls, local) = enumerate_class(&s, &self.deals, self.p.class_cap, false, None);
                    self.work += cls.members.len() as u64;
                    self.classes += 1;
                    if let Some(ei) = cls.win {
                        let mut line = self.line_to(nid);
                        decode_path(&encode_path(&cls, ei), &mut line);
                        return Some(line);
                    }
                    for (h, _) in local {
                        self.seen.insert(h);
                    }
                    let mut deals: Vec<(i32, usize)> = Vec::new();
                    let mut kids: Vec<(i32, usize)> = Vec::new();
                    for (ei, ex) in cls.exits.iter().enumerate() {
                        let h = ex.result.hash();
                        if !self.seen.insert(h) {
                            continue;
                        }
                        let eval = ex.result.eval(&w);
                        if ex.mv == Move::Deal {
                            deals.push((eval, ei));
                        } else {
                            kids.push((eval, ei));
                        }
                    }
                    kids.sort_unstable_by_key(|k| std::cmp::Reverse(k.0));
                    for &(eval, ei) in kids.iter().take(self.p.per_parent) {
                        let ex = &cls.exits[ei];
                        next.push(Cand { eval, parent: nid, path: encode_path(&cls, ei), state: Compact::from_state(&ex.result) });
                    }
                    if !deals.is_empty() {
                        deals.sort_unstable_by_key(|d| std::cmp::Reverse(d.0));
                        for &(eval, ei) in deals.iter().take(self.p.deals_per_class) {
                            let ex = &cls.exits[ei];
                            let pool = &mut pools[level + 1];
                            pool.push(Cand { eval, parent: nid, path: encode_path(&cls, ei), state: Compact::from_state(&ex.result) });
                            if pool.len() >= 4 * width {
                                pool.sort_unstable_by_key(|c| std::cmp::Reverse(c.eval));
                                pool.truncate(width);
                            }
                        }
                    }
                    if self.check_stop() {
                        return None;
                    }
                }
                next.sort_unstable_by_key(|c| std::cmp::Reverse(c.eval));
                next.truncate(width);
                if self.debug && depth % 10 == 0 {
                    eprintln!(
                        "[beam] level {level} depth {depth} frontier {} best {} work {} {:.2}s",
                        next.len(),
                        next.first().map_or(0, |c| c.eval),
                        self.work,
                        self.started.elapsed().as_secs_f64()
                    );
                }
                frontier = next.into_iter().map(|c| self.push(c)).collect();
                depth += 1;
            }
        }
        None
    }

    fn push(&mut self, c: Cand) -> u32 {
        self.nodes.push(Node { parent: c.parent, path: c.path, state: c.state });
        (self.nodes.len() - 1) as u32
    }

    fn line_to(&self, nid: u32) -> Vec<Move> {
        let mut chain = Vec::new();
        let mut n = nid;
        while n != u32::MAX {
            chain.push(n);
            n = self.nodes[n as usize].parent;
        }
        let mut line = Vec::new();
        for &n in chain.iter().rev() {
            decode_path(&self.nodes[n as usize].path, &mut line);
        }
        line
    }
}

/// Convenience: solve with parameters from the environment.
pub fn solve_beam(g: &Game, budget: u64) -> SolveResult {
    BeamSolver::new(g, budget, BeamParams::from_env()).solve(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_suit_beam_wins() {
        let mut g = Game::new(2, 2);
        let r = BeamSolver::new(&g, 3_000_000, BeamParams::default()).solve(&g);
        assert_eq!(r.verdict, Verdict::Solvable, "work {}", r.nodes);
        for mv in &r.line {
            g.apply(*mv).expect("line legal");
        }
        assert!(g.is_won());
    }
}
