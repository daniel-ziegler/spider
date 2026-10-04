//! A non-peeking player that improves the line player by rollouts.
//!
//! At each decision it takes the line player's own choice and a few
//! alternatives from the same line search: the next-best lines that raise
//! the value (normally and about to deal), the best line that turns over
//! each column, and the deal. Each is judged in worlds guessed from the
//! masked position (the cards not visible dealt at random into the
//! face-down slots and the stock, see [`determinize`]): the candidate is
//! played in the world and a cheaper line player finishes the game. Every
//! candidate is played in the same worlds, sequential halving spends the
//! rollouts on the candidates still in contention, and the line player's
//! choice is only overruled by a clear margin.

use crate::game::{Game, Move, NUM_COLS};
use crate::human::{mask, PlayResult};
use crate::lines::{decide_steps, Tempo, line_to, play_until, search_state, Choice, LineConfig, LOST};
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
}

impl PimcConfig {
    pub fn for_suits(suits: u8) -> PimcConfig {
        let base = LineConfig::for_suits(suits);
        PimcConfig {
            base,
            rollout: LineConfig { max_steps: 3, ..base },
            max_cands: 6,
            extra_improve: 2,
            extra_deal: 1,
            max_flips: 3,
            max_idle: 6,
            rollouts: 48,
            horizon: 0,
            win_bonus: 4.0,
            z: 1.0,
            seed: 0,
        }
    }

    /// [`PimcConfig::for_suits`] with `SPIDER_P_*` overrides (ROLLOUT_STEPS, ROLLOUT_BEAM,
    /// MAX_CANDS, EXTRA_IMPROVE, EXTRA_DEAL, MAX_FLIPS, MAX_IDLE, ROLLOUTS, HORIZON, WIN_BONUS,
    /// Z, SEED); `SPIDER_L_*` set the weights of both players.
    pub fn from_env(suits: u8) -> PimcConfig {
        fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
            std::env::var(format!("SPIDER_P_{name}")).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        let d = PimcConfig::for_suits(suits);
        let base = LineConfig::from_env(suits);
        PimcConfig {
            base,
            rollout: LineConfig { max_steps: get("ROLLOUT_STEPS", d.rollout.max_steps), beam: get("ROLLOUT_BEAM", d.rollout.beam), ..base },
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
        }
    }
}

/// A candidate decision.
#[derive(Clone, Debug, PartialEq)]
pub enum Cand {
    Line(Vec<Move>),
    Deal,
}

fn apply(g: &mut Game, c: &Cand) {
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
    let first = match decide_steps(obs, deals_left, visited, tempo, &cfg.base).0 {
        Choice::Line(steps) => Cand::Line(steps.concat()),
        Choice::Deal => Cand::Deal,
        Choice::Stuck => return Vec::new(),
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
    if deals_left > 0 {
        for &(_, k) in ranked(cfg.base.deal_empty).iter().take(cfg.extra_deal + 1) {
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
    if deals_left > 0 && root.len.iter().all(|&l| l > 0) && !out.contains(&Cand::Deal) && out.len() < cfg.max_cands {
        out.push(Cand::Deal);
    }
    out
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
    let stop = (cfg.horizon > 0 && level >= cfg.horizon).then(|| level - cfg.horizon);
    let (work, stopped) = play_until(&mut world, &cfg.rollout, seen, stop);
    let v = if stopped {
        let s = State::from_game(&mask(&world));
        cfg.base.eval(&s, world.deals_remaining(), cfg.base.empty) as f64 / cfg.base.completed as f64
    } else {
        world.completed.len() as f64 + if world.is_won() { cfg.win_bonus } else { 0.0 }
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
    let mut cands = candidates(obs, deals_left, visited, tempo, cfg);
    if idle >= cfg.max_idle {
        cands.truncate(1);
    }
    let mut stats = DecideStats { candidates: cands.len(), ..Default::default() };
    if cands.len() <= 1 || cfg.rollouts == 0 {
        return (cands.into_iter().next(), stats);
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
        let cfg = PimcConfig { rollouts: 8, ..PimcConfig::for_suits(4) };
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
