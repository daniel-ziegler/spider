//! A non-peeking player that improves the line player by rollouts.
//!
//! At a decision it takes the line player's own choice and a few
//! alternatives from the same line search: the next-best lines that raise
//! the value (normally and about to deal or to give up), the best line
//! that turns over each column, and the deal. Each is judged in worlds
//! guessed from the masked position (the cards not visible dealt at random
//! into the face-down slots and the stock, see [`determinize`]): the
//! candidate is played in the world and a cheaper line player plays on.
//! Every candidate is played in the same worlds, sequential halving spends
//! the rollouts on the candidates still in contention, and the line
//! player's choice is only overruled by a clear margin.
//!
//! By default it does this only once the stock is gone, where the rollouts
//! run to the end of the game and count wins: that is where it gains
//! (see the README). Before that it plays as the line player does.
//!
//! With a network ([`PimcConfig::net`]) there are no rollouts: the
//! network ranks the candidates, at a small fraction of the cost.

use crate::game::{Game, Move, NUM_COLS};
use crate::human::{mask, PlayResult};
use crate::lines::{line_to, play_until, search_state, Decision, LineConfig, Tempo, LOST};
use crate::smart::determinize;
use crate::solver::{mix, State, MAXC};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug)]
pub struct PimcConfig {
    /// The player whose choices are improved, and whose search gives the
    /// candidates.
    pub base: LineConfig,
    /// The player that finishes the rollouts.
    pub rollout: LineConfig,
    /// Most candidates per decision.
    pub max_cands: usize,
    /// Lines raising the normal value kept besides the base choice.
    pub extra_improve: usize,
    /// Lines raising the about-to-deal value kept.
    pub extra_deal: usize,
    /// Most lines that turn a card kept (the best for each set of columns).
    pub max_flips: usize,
    /// Decisions without progress after which only the base choice is played.
    pub max_idle: usize,
    /// Rollouts per contested decision.
    pub rollouts: usize,
    /// Rollouts stop when about to deal with `horizon` fewer deals left
    /// than at the decision, and are scored by the base player's
    /// evaluation there (0: play to the end).
    pub horizon: usize,
    /// Value of a win on top of its eight completed suits.
    pub win_bonus: f64,
    /// Standard errors by which a challenger must beat the base choice.
    pub z: f64,
    pub seed: u64,
    /// Rollouts stop where the rollout player is next about to deal and
    /// are scored by the fitted value there ([`crate::stagev`]); dealing
    /// is then no alternative to the line player's choice.
    pub stage: bool,
    /// Rollouts only with at most this many deals left; before that, the
    /// line player's choice.
    pub from: usize,
    /// With the stock gone, the lines raising the value the line player
    /// gives up by (`end_empty`) are candidates too, as those raising the
    /// about-to-deal value are before.
    pub end_lines: bool,
    /// Instead of rollouts, a network ranks the candidates by the position
    /// each leads to ([`crate::advnet`]; `SPIDER_P_NET`, the weights' file),
    /// and one is played instead of the line player's choice if its value
    /// (a probability) is higher by `net_margin`.
    pub net: Option<&'static crate::advnet::AdvNet>,
    pub net_margin: f32,
    /// The network overrules the line player once at most until a card
    /// turns, a deal or a suit completes.
    pub net_once: bool,
    /// With the stock gone, a guessed world is also given to the
    /// full-information solver after the candidate, with this much work
    /// (0: not), and the candidate's value there is `solve_weight` times
    /// whether it found a win and the rest the rollout's result (all of it
    /// if the solver does not know; a world it proves lost is not played
    /// out, nor is any with a weight of 1). `SPIDER_P_SOLVE`,
    /// `SPIDER_P_SOLVE_WEIGHT`.
    pub solve: u64,
    pub solve_weight: f64,
}

impl PimcConfig {
    pub fn for_suits(suits: u8) -> PimcConfig {
        let base = LineConfig::for_suits(suits);
        PimcConfig {
            base,
            rollout: LineConfig { max_steps: 6, beam: 100, expect_top: 0, replan: 0, ..base },
            max_cands: 8,
            extra_improve: 3,
            extra_deal: 2,
            max_flips: 5,
            max_idle: 12,
            rollouts: 128,
            horizon: 0,
            win_bonus: 4.0,
            z: 1.0,
            seed: 0,
            stage: true,
            from: 0,
            end_lines: true,
            net: None,
            net_margin: 0.0,
            net_once: false,
            solve: 0,
            solve_weight: 0.5,
        }
    }

    /// [`PimcConfig::for_suits`] with `SPIDER_P_*` overrides (ROLLOUT_STEPS, ROLLOUT_BEAM,
    /// ROLLOUT_EXPECT, ROLLOUT_REPLAN, ROLLOUT_DEAL_SPLITS, MAX_CANDS, EXTRA_IMPROVE, EXTRA_DEAL, MAX_FLIPS, MAX_IDLE,
    /// ROLLOUTS, HORIZON, WIN_BONUS, Z, SEED, STAGE, FROM, END_LINES, NET, NET_MARGIN, NET_ONCE); `SPIDER_L_*` set the weights of both
    /// players. The rollout player has no expectimax or replanning unless asked for.
    pub fn from_env(suits: u8) -> PimcConfig {
        fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
            std::env::var(format!("SPIDER_P_{name}")).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        let d = PimcConfig::for_suits(suits);
        let base = LineConfig::from_env(suits);
        PimcConfig {
            base,
            rollout: LineConfig {
                max_steps: get("ROLLOUT_STEPS", d.rollout.max_steps),
                beam: get("ROLLOUT_BEAM", d.rollout.beam),
                expect_top: get("ROLLOUT_EXPECT", 0),
                replan: get("ROLLOUT_REPLAN", 0),
                deal_splits: get("ROLLOUT_DEAL_SPLITS", base.deal_splits),
                ..base
            },
            max_cands: get("MAX_CANDS", d.max_cands),
            extra_improve: get("EXTRA_IMPROVE", d.extra_improve),
            extra_deal: get("EXTRA_DEAL", d.extra_deal),
            max_flips: get("MAX_FLIPS", d.max_flips),
            max_idle: get("MAX_IDLE", d.max_idle),
            rollouts: get("ROLLOUTS", d.rollouts),
            horizon: get("HORIZON", d.horizon),
            win_bonus: get("WIN_BONUS", d.win_bonus),
            z: get("Z", d.z),
            seed: get("SEED", d.seed),
            stage: get::<u8>("STAGE", d.stage as u8) != 0,
            from: get("FROM", d.from),
            end_lines: get::<u8>("END_LINES", d.end_lines as u8) != 0,
            net: std::env::var("SPIDER_P_NET").ok().map(|p| {
                static NET: std::sync::OnceLock<crate::advnet::AdvNet> = std::sync::OnceLock::new();
                NET.get_or_init(|| crate::advnet::AdvNet::load(&p))
            }),
            net_margin: get("NET_MARGIN", d.net_margin),
            net_once: get::<u8>("NET_ONCE", d.net_once as u8) != 0,
            solve: get("SOLVE", d.solve),
            solve_weight: get("SOLVE_WEIGHT", d.solve_weight),
        }
    }
}

/// A candidate decision.
#[derive(Clone, Debug, PartialEq)]
pub enum Cand {
    Line(Vec<Move>),
    Deal,
}

pub(crate) fn apply(g: &mut Game, c: &Cand) {
    match c {
        Cand::Line(moves) => {
            for &mv in moves {
                g.apply(mv).expect("candidate move is legal");
            }
        }
        Cand::Deal => g.apply(Move::Deal).expect("deal is legal"),
    }
}

/// Candidates from a masked position, the line player's choice first
/// (none if the game is over).
pub fn candidates(obs: &Game, deals_left: usize, visited: &HashSet<u64>, tempo: &mut Tempo, cfg: &PimcConfig) -> Vec<Cand> {
    candidates_plan(obs, deals_left, visited, tempo, cfg).0
}

/// [`candidates`], the line player's choice being the whole line it plans,
/// and what it plays of that line now (with replanning, its first steps;
/// `None` if the game is over).
pub(crate) fn candidates_plan(obs: &Game, deals_left: usize, visited: &HashSet<u64>, tempo: &mut Tempo, cfg: &PimcConfig) -> (Vec<Cand>, Option<Cand>) {
    let (first, play) = match crate::lines::decide(obs, deals_left, visited, tempo, &cfg.base).0 {
        Decision::Play(moves) => {
            let mut line = moves.clone();
            line.extend(tempo.plan.iter().flatten().copied());
            (Cand::Line(line), Cand::Line(moves))
        }
        Decision::Deal => (Cand::Deal, Cand::Deal),
        Decision::Stuck => return (Vec::new(), None),
    };
    let nodes = search_state(State::from_game(obs), &cfg.base);
    let root = &nodes[0].state;
    let fresh: Vec<usize> = (1..nodes.len()).filter(|&k| !visited.contains(&nodes[k].state.hash())).collect();
    let mut out = vec![first];
    let mut ends: Vec<u64> = Vec::new();
    if let Cand::Line(moves) = &out[0] {
        let mut s = root.clone();
        for &mv in moves {
            s.apply(mv, &[]);
        }
        ends.push(s.hash());
    }
    let mut push = |out: &mut Vec<Cand>, k: usize| {
        let h = nodes[k].state.hash();
        if out.len() < cfg.max_cands && !ends.contains(&h) {
            ends.push(h);
            out.push(Cand::Line(line_to(&nodes, k).concat()));
        }
    };
    let ranked = |empty: i32| {
        let base = nodes[0].parts.value(deals_left, empty);
        let mut v: Vec<(i32, usize)> = fresh.iter().map(|&k| (nodes[k].parts.value(deals_left, empty), k)).filter(|&(sc, _)| sc > base).collect();
        v.sort_by_key(|&(sc, k)| (std::cmp::Reverse(sc), k));
        v
    };
    for &(_, k) in ranked(cfg.base.empty).iter().take(cfg.extra_improve + 1) {
        push(&mut out, k);
    }
    if deals_left > 0 || cfg.end_lines {
        let empty = if deals_left > 0 { cfg.base.deal_empty } else { cfg.base.end_empty };
        for &(_, k) in ranked(empty).iter().take(cfg.extra_deal + 1) {
            push(&mut out, k);
        }
    }
    // The best way to turn over each set of columns.
    let flipped = |s: &State| (0..NUM_COLS).filter(|&c| s.down[c] < root.down[c]).fold(0u16, |m, c| m | 1 << c);
    let mut best: Vec<(u16, i32, usize)> = Vec::new();
    for &k in &fresh {
        if !nodes[k].leaf {
            continue;
        }
        let sc = nodes[k].parts.value(deals_left, cfg.base.empty);
        if sc <= LOST {
            continue;
        }
        let key = flipped(&nodes[k].state);
        match best.iter_mut().find(|b| b.0 == key) {
            Some(b) if b.1 >= sc => {}
            Some(b) => *b = (key, sc, k),
            None => best.push((key, sc, k)),
        }
    }
    best.sort_by_key(|&(_, sc, k)| (std::cmp::Reverse(sc), k));
    for &(_, _, k) in best.iter().take(cfg.max_flips) {
        push(&mut out, k);
    }
    if !cfg.stage && deals_left > 0 && root.len.iter().all(|&l| l > 0) && !out.contains(&Cand::Deal) && out.len() < cfg.max_cands {
        out.push(Cand::Deal);
    }
    (out, Some(play))
}

thread_local! {
    /// Diagnostic (`SPIDER_P_CHEAT`): the real game, which the rollouts then
    /// play in instead of guessed worlds.
    static TRUTH: std::cell::RefCell<Option<Game>> = const { std::cell::RefCell::new(None) };
}

/// Play candidate `c` in a world guessed from `obs`, then let the rollout
/// player finish. Returns the outcome's value and the positions examined.
fn rollout(obs: &Game, c: &Cand, visited: &HashSet<u64>, world_seed: u64, cfg: &PimcConfig) -> (f64, u64) {
    let mut world = TRUTH.with(|t| t.borrow().clone()).unwrap_or_else(|| determinize(obs, world_seed));
    apply(&mut world, c);
    let mut seen = visited.clone();
    seen.insert(State::from_game(&mask(&world)).hash());
    let level = obs.deals_remaining();
    let mut solved = None;
    if cfg.solve > 0 && level == 0 && !world.is_won() {
        use crate::solver::{Solver, Verdict};
        solved = match Solver::new(&world, cfg.solve).solve(&world).verdict {
            Verdict::Solvable => Some(1.0),
            Verdict::Unsolvable => Some(0.0),
            Verdict::Unknown => None,
        };
        if cfg.solve_weight >= 1.0 || solved == Some(0.0) {
            if let Some(v) = solved {
                return (v * if cfg.stage { 1.0 } else { 8.0 + cfg.win_bonus }, 0);
            }
        }
    }
    let stop = if cfg.stage { (level > 0).then_some(level) } else { (cfg.horizon > 0 && level >= cfg.horizon).then(|| level - cfg.horizon) };
    let (work, stopped) = play_until(&mut world, &cfg.rollout, seen, stop);
    let v = if cfg.stage {
        if world.is_won() {
            1.0
        } else if stopped {
            crate::stagev::deal_value(&world)
        } else {
            0.0
        }
    } else if stopped {
        let s = State::from_game(&mask(&world));
        cfg.base.eval(&s, world.deals_remaining(), cfg.base.empty) as f64 / cfg.base.completed as f64
    } else {
        world.completed.len() as f64 + if world.is_won() { cfg.win_bonus } else { 0.0 }
    };
    let v = match solved {
        Some(sv) => cfg.solve_weight * sv * if cfg.stage { 1.0 } else { 8.0 + cfg.win_bonus } + (1.0 - cfg.solve_weight) * v,
        None => v,
    };
    (v, work)
}

/// Statistics of a decision.
#[derive(Clone, Copy, Debug, Default)]
pub struct DecideStats {
    pub candidates: usize,
    /// Index of the chosen candidate (0: the line player's own choice).
    pub chosen: usize,
    pub rollouts: usize,
    pub work: u64,
}

/// Decide from a masked position by rollouts. `None`: the game is over.
/// `idle` is the number of decisions since the last card turned, deal or
/// completed suit: from `max_idle` on, only the base choice is played, so
/// that alternating between the alternatives cannot go on for ever.
pub fn decide(obs: &Game, deals_left: usize, visited: &HashSet<u64>, idle: usize, tempo: &mut Tempo, cfg: &PimcConfig) -> (Option<Cand>, DecideStats) {
    // A line the player is part way through was judged when it was chosen.
    let planned: Vec<Move> = tempo.plan.iter().flatten().copied().collect();
    let (mut cands, play) = candidates_plan(obs, deals_left, visited, tempo, cfg);
    let continuing = !planned.is_empty() && cands.first() == Some(&Cand::Line(planned));
    if idle >= cfg.max_idle || deals_left > cfg.from || continuing || (cfg.net_once && tempo.overruled) {
        cands.truncate(1);
    }
    let mut stats = DecideStats { candidates: cands.len(), ..Default::default() };
    if cands.len() <= 1 || cfg.rollouts == 0 {
        return (play, stats);
    }
    if let Some(net) = cfg.net {
        let mut first: Option<State> = None;
        let v: Vec<f32> = cands
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut after = obs.clone();
                if let Cand::Line(_) = c {
                    apply(&mut after, c);
                }
                if after.columns.iter().any(|col| col.len() > MAXC) {
                    return f32::MIN;
                }
                let st = State::from_game(&after);
                let mut enc = vec![0; crate::vnet::ENC];
                crate::vnet::encode(&st, deals_left, &mut enc);
                if *c == Cand::Deal {
                    enc[crate::vnet::ENC - 2] += 16;
                }
                let f = first.get_or_insert_with(|| st.clone());
                enc.extend_from_slice(&crate::contrast::extras(&st, f, i == 0, deals_left, &cfg.base));
                1.0 / (1.0 + (-net.value(&enc)).exp())
            })
            .collect();
        let best = (1..cands.len()).max_by(|&a, &b| v[a].total_cmp(&v[b]).then(b.cmp(&a))).unwrap();
        if v[best] > v[0] + cfg.net_margin {
            stats.chosen = best;
            if std::env::var_os("SPIDER_P_NET_TRACE").is_some() {
                let flips = |c: &Cand| {
                    let mut after = obs.clone();
                    if let Cand::Line(_) = c {
                        apply(&mut after, c);
                    }
                    after.face_down.iter().sum::<usize>() < obs.face_down.iter().sum::<usize>()
                };
                eprintln!("overrule k={deals_left} idle={idle} cands={} best={best} dv={:.3} base_flips={} cand_flips={} base_deal={}", cands.len(), v[best] - v[0], flips(&cands[0]), flips(&cands[best]), cands[0] == Cand::Deal);
            }
            // As in the network's training data: the line player goes on
            // from the candidate afresh.
            *tempo = Tempo { overruled: true, ..Tempo::default() };
            return (Some(cands[best].clone()), stats);
        }
        return (play, stats);
    }
    let seed = mix(cfg.seed ^ 0x5EED, State::from_game(obs).hash());
    let mut alive: Vec<usize> = (0..cands.len()).collect();
    // vals[c][j]: candidate c's outcome in world j.
    let mut vals: Vec<Vec<f64>> = vec![Vec::new(); cands.len()];
    let rounds = (usize::BITS - (cands.len() - 1).leading_zeros()) as usize;
    let run = |c: usize, n: usize, vals: &mut Vec<Vec<f64>>, stats: &mut DecideStats| {
        for _ in 0..n {
            let j = vals[c].len();
            let (v, w) = rollout(obs, &cands[c], visited, mix(seed, j as u64), cfg);
            vals[c].push(v);
            stats.rollouts += 1;
            stats.work += w;
        }
    };
    let mean = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
    while alive.len() > 2 {
        let per = (cfg.rollouts / (alive.len() * rounds)).max(1);
        for &c in &alive {
            run(c, per, &mut vals, &mut stats);
        }
        // Keep the better half by mean; the base choice stays in as the
        // reference.
        let mut others: Vec<usize> = alive.iter().copied().filter(|&c| c != 0).collect();
        others.sort_by(|&a, &b| mean(&vals[b]).partial_cmp(&mean(&vals[a])).unwrap().then(a.cmp(&b)));
        others.truncate((alive.len() / 2).max(1));
        alive = std::iter::once(0).chain(others).collect();
    }
    let ch = alive[1];
    let extra = (cfg.rollouts.saturating_sub(stats.rollouts) / 2).max(1);
    let target = vals[0].len().max(vals[ch].len()) + extra;
    for c in [0, ch] {
        let n = target - vals[c].len();
        run(c, n, &mut vals, &mut stats);
    }
    let diffs: Vec<f64> = vals[ch].iter().zip(&vals[0]).map(|(a, b)| a - b).collect();
    let n = diffs.len() as f64;
    let m = diffs.iter().sum::<f64>() / n;
    let var = diffs.iter().map(|d| (d - m) * (d - m)).sum::<f64>() / (n - 1.0).max(1.0);
    let se = (var / n).sqrt();
    stats.chosen = if m > 0.0 && m > cfg.z * se { ch } else { 0 };
    if stats.chosen == 0 {
        return (play, stats);
    }
    tempo.plan.clear();
    (Some(cands[stats.chosen].clone()), stats)
}

/// Statistics of a whole game.
#[derive(Clone, Debug, Default)]
pub struct PimcStats {
    pub decisions: usize,
    /// Decisions with more than one candidate.
    pub contested: usize,
    /// Decisions where the rollouts overruled the line player.
    pub overruled: usize,
    pub rollouts: usize,
}

/// Play `g` to the end, deciding every move from the masked position only.
pub fn play(g: &Game, cfg: &PimcConfig) -> (PlayResult, PimcStats) {
    let trace = std::env::var_os("SPIDER_P_TRACE").is_some();
    let mut g = g.clone();
    let mut st = PimcStats::default();
    let mut work = 0;
    let start = g.move_count();
    let mut visited = HashSet::new();
    let mut idle = 0;
    let mut tempo = Tempo::default();
    let cheat = std::env::var_os("SPIDER_P_CHEAT").is_some();
    while !g.is_won() && g.move_count() - start < 5000 && g.columns.iter().all(|c| c.len() <= MAXC) {
        let obs = mask(&g);
        visited.insert(State::from_game(&obs).hash());
        if cheat {
            TRUTH.with(|t| *t.borrow_mut() = Some(g.clone()));
        }
        let (d, ds) = decide(&obs, g.deals_remaining(), &visited, idle, &mut tempo, cfg);
        let before = (g.face_down, g.deals_remaining(), g.completed.len());
        st.decisions += 1;
        st.rollouts += ds.rollouts;
        work += ds.work;
        st.contested += (ds.candidates > 1) as usize;
        st.overruled += (ds.chosen != 0) as usize;
        if trace {
            eprintln!("{}\n{d:?} ({} candidates, chose #{})", crate::human::show(&g), ds.candidates, ds.chosen);
        }
        match d {
            Some(c) => apply(&mut g, &c),
            None => break,
        }
        idle = if (g.face_down, g.deals_remaining(), g.completed.len()) == before { idle + 1 } else { 0 };
        if idle == 0 {
            tempo = Tempo::default();
        }
    }
    let moves = g.history()[start..].iter().map(|r| r.mv).collect();
    (PlayResult { won: g.is_won(), moves, completed: g.completed.len(), work }, st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Card;

    #[test]
    fn decisions_ignore_hidden_cards() {
        let a = Game::new(4, 11);
        let mut b = a.clone();
        b.columns[0][0] = Card::new(1, 5);
        b.stock.reverse();
        let cfg = PimcConfig { rollouts: 8, stage: false, from: 5, ..PimcConfig::for_suits(4) };
        let v = HashSet::new();
        assert_eq!(decide(&mask(&a), 5, &v, 0, &mut Tempo::default(), &cfg).0, decide(&mask(&b), 5, &v, 0, &mut Tempo::default(), &cfg).0);
    }
}

/// Outcomes of `n` rollouts of every candidate from a masked position, in
/// the same guessed worlds (for measuring how much better than the base
/// choice the alternatives are).
pub fn candidate_outcomes(obs: &Game, cands: &[Cand], visited: &HashSet<u64>, n: usize, cfg: &PimcConfig) -> Vec<Vec<f64>> {
    let seed = mix(cfg.seed ^ 0x5EED, State::from_game(obs).hash());
    cands.iter().map(|c| (0..n).map(|j| rollout(obs, c, visited, mix(seed, j as u64), cfg).0).collect()).collect()
}

/// Apply a candidate to a game.
pub fn apply_cand(g: &mut Game, c: &Cand) {
    apply(g, c);
}
