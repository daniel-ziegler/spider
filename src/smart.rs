//! A stronger non-peeking player: rollouts over the human-style player.
//!
//! Like [`crate::human`], it decides from a [`mask`]ed position only. At each
//! decision it collects a few candidate plans from a larger lookahead: the
//! human player's own choice, the best way to turn over each column that can
//! be reached, the next-best improving lines, and the deal arrangement. Each
//! candidate is then judged by playing it out: the hidden cards are guessed
//! (a random assignment of the cards not visible, which is all the player
//! knows about them), the plan is applied in that guessed world and the
//! human player finishes the game. Every candidate is played in the same
//! guessed worlds, and sequential halving spends the rollouts on the
//! candidates still in contention. The candidate with the best mean outcome
//! is played, and the player looks again.
//!
//! This is the rollout method (policy improvement by simulation) that Yan,
//! Diaconis, Rusmevichientong and Van Roy used for Klondike: it plays at
//! least as well as the base player in expectation, and much better where
//! the base player's greedy choices go wrong.

use crate::game::{Card, Game, NUM_COLS};
use crate::human::{apply_decision, choose, line_to, mask, play_until, search, Decision, HumanConfig, PlayResult, BLANK};
use crate::solver::{mix, State};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug)]
pub struct SmartConfig {
    /// Lookahead that generates the candidates.
    pub search: HumanConfig,
    /// The player used inside rollouts.
    pub rollout: HumanConfig,
    /// Most candidates judged per decision.
    pub max_cands: usize,
    /// Improving lines kept besides the base choice.
    pub extra_improve: usize,
    /// Rollouts per decision (split over the candidates by sequential halving).
    pub rollouts: usize,
    /// Rollouts are scored when the stock is `horizon` deals below the
    /// decision's (0: at the end of the game), the same level for every
    /// candidate whether it deals or not: the evaluation ignores the stock,
    /// so a position just after a deal scores higher than one just before.
    pub horizon: usize,
    /// Play out the stage at the horizon (until the next deal) before
    /// scoring, instead of scoring straight after the deal.
    pub play_on: bool,
    /// Score rollouts that stop at the horizon with the learned value
    /// ([`learned_value`]) instead of the player's evaluation.
    pub learned: bool,
    /// Value of a win on top of its eight completed suits.
    pub win_bonus: f64,
    /// The human player's choice is only overruled by a candidate whose
    /// mean advantage over it, in the same worlds, exceeds this many
    /// standard errors.
    pub z: f64,
    pub threads: usize,
    pub seed: u64,
}

impl SmartConfig {
    pub fn for_suits(suits: u8) -> SmartConfig {
        let base = HumanConfig::for_suits(suits);
        SmartConfig {
            search: HumanConfig { nodes: 10_000, ..base },
            rollout: HumanConfig { nodes: 500, ..base },
            max_cands: 6,
            extra_improve: 2,
            rollouts: 64,
            horizon: 1,
            play_on: true,
            learned: false,
            win_bonus: 4.0,
            z: 1.0,
            threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
            seed: 0,
        }
    }

    /// [`SmartConfig::for_suits`] with `SPIDER_S_*` overrides (SEARCH_NODES,
    /// ROLLOUT_NODES, MAX_CANDS, EXTRA_IMPROVE, ROLLOUTS, HORIZON, PLAY_ON (0/1),
    /// WIN_BONUS, Z,
    /// THREADS, SEED); `SPIDER_H_*` set the weights of both players.
    pub fn from_env(suits: u8) -> SmartConfig {
        fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
            std::env::var(format!("SPIDER_S_{name}")).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        let d = SmartConfig::for_suits(suits);
        let base = HumanConfig::from_env(suits);
        SmartConfig {
            search: HumanConfig { nodes: get("SEARCH_NODES", d.search.nodes), ..base },
            rollout: HumanConfig { nodes: get("ROLLOUT_NODES", d.rollout.nodes), ..base },
            max_cands: get("MAX_CANDS", d.max_cands),
            extra_improve: get("EXTRA_IMPROVE", d.extra_improve),
            rollouts: get("ROLLOUTS", d.rollouts),
            horizon: get("HORIZON", d.horizon),
            play_on: get::<u8>("PLAY_ON", d.play_on as u8) != 0,
            learned: get::<u8>("LEARNED", d.learned as u8) != 0,
            win_bonus: get("WIN_BONUS", d.win_bonus),
            z: get("Z", d.z),
            threads: get("THREADS", d.threads),
            seed: get("SEED", d.seed),
        }
    }
}

/// splitmix64.
pub(crate) struct Rng(pub(crate) u64);
impl Rng {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
}

/// A world consistent with the masked position `obs`: the cards not visible
/// (the deck minus the face-up cards and the completed suits) dealt at
/// random into the face-down slots and the stock.
pub fn determinize(obs: &Game, seed: u64) -> Game {
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
    let mut pool: Vec<Card> = (0..52u8).flat_map(|k| std::iter::repeat_n(Card(k), count[k as usize] as usize)).collect();
    let mut rng = Rng(seed);
    for i in (1..pool.len()).rev() {
        pool.swap(i, (rng.next() % (i as u64 + 1)) as usize);
    }
    let mut w = obs.clone();
    let slots = w.columns.iter_mut().flat_map(|col| col.iter_mut()).chain(w.stock.iter_mut()).filter(|c| **c == BLANK);
    for (slot, card) in slots.zip(pool.iter()) {
        *slot = *card;
    }
    debug_assert_eq!(pool.len(), w.stock.len() + obs.face_down.iter().sum::<usize>());
    w
}

/// Candidate decisions from a masked position, the human player's own
/// choice first.
pub(crate) fn candidates(obs: &Game, deals_left: usize, cfg: &SmartConfig) -> Vec<Decision> {
    let nodes = search(obs, &cfg.search);
    let base_choice = choose(&nodes, deals_left, &cfg.search);
    let mut out = vec![base_choice];
    let root = &nodes[0].state;
    let base = cfg.search.eval(root);
    let scored: Vec<(i32, usize)> = nodes.iter().enumerate().skip(1).map(|(k, n)| (cfg.search.eval(&n.state), k)).collect();

    // The best way to turn over each column (or set of columns).
    let flipped = |s: &State| (0..NUM_COLS).filter(|&c| s.down[c] < root.down[c]).fold(0u16, |m, c| m | 1 << c);
    let mut leaves: Vec<(i32, usize)> = Vec::new();
    let mut best_for: Vec<(u16, usize)> = Vec::new();
    for &(sc, k) in &scored {
        if !nodes[k].leaf {
            continue;
        }
        let key = flipped(&nodes[k].state);
        match best_for.iter_mut().find(|(m, _)| *m == key) {
            Some((_, i)) if leaves[*i].0 >= sc => {}
            Some((_, i)) => leaves[*i] = (sc, k),
            None => {
                best_for.push((key, leaves.len()));
                leaves.push((sc, k));
            }
        }
    }
    leaves.sort_by_key(|&(sc, _)| std::cmp::Reverse(sc));

    let mut improving: Vec<(i32, usize)> = scored.iter().copied().filter(|&(sc, k)| sc > base && !nodes[k].leaf).collect();
    improving.sort_by_key(|&(sc, _)| std::cmp::Reverse(sc));

    let mut push = |d: Decision| {
        if out.len() < cfg.max_cands && !out.contains(&d) {
            out.push(d);
        }
    };
    for &(_, k) in improving.iter().take(cfg.extra_improve + 1) {
        push(Decision::Play(line_to(&nodes, k)));
    }
    for &(_, k) in &leaves {
        push(Decision::Play(line_to(&nodes, k)));
    }
    if improving.is_empty() && deals_left > 0 {
        let filled = scored.iter().copied().chain([(base, 0)]).filter(|&(_, k)| nodes[k].state.len.iter().all(|&l| l > 0));
        if let Some((_, k)) = filled.max_by_key(|&(sc, k)| (sc, std::cmp::Reverse(k))) {
            push(Decision::Deal(line_to(&nodes, k)));
        }
    }
    out
}

/// Statistics of a decision.
#[derive(Clone, Copy, Debug, Default)]
pub struct DecideStats {
    pub candidates: usize,
    /// Index of the chosen candidate (0: the human player's own choice).
    pub chosen: usize,
    pub rollouts: usize,
    pub work: u64,
}

/// Decide from a masked position by rollouts.
pub fn decide(obs: &Game, deals_left: usize, cfg: &SmartConfig) -> (Decision, DecideStats) {
    let cands = candidates(obs, deals_left, cfg);
    let mut stats = DecideStats { candidates: cands.len(), ..Default::default() };
    if cands.len() == 1 || cfg.rollouts == 0 {
        return (cands.into_iter().next().unwrap(), stats);
    }
    let seed = mix(cfg.seed ^ 0x5EED, obs.move_count() as u64 ^ (obs.deals_remaining() as u64) << 32);
    let mut alive: Vec<usize> = (0..cands.len()).collect();
    // vals[c][j]: candidate c's outcome in world j.
    let mut vals: Vec<Vec<f64>> = vec![Vec::new(); cands.len()];
    let mut done = 0usize; // worlds every alive candidate has been played in
    let rounds = (usize::BITS - (cands.len() - 1).leading_zeros()) as usize;
    let work = AtomicUsize::new(0);
    while alive.len() > 1 {
        let per = (cfg.rollouts / (alive.len() * rounds)).max(1);
        let jobs: Vec<(usize, usize)> = alive.iter().flat_map(|&c| (done..done + per).map(move |j| (c, j))).collect();
        let res = run_jobs(obs, &cands, &jobs, seed, cfg, &work);
        let mut res = res;
        res.sort_unstable_by_key(|&(c, j, _)| (c, j));
        for (c, _, v) in res {
            vals[c].push(v);
        }
        stats.rollouts += jobs.len();
        done += per;
        // Keep the better half by mean; the human player's choice (index 0)
        // stays in to the end, as the reference.
        let mean = |c: usize| vals[c].iter().sum::<f64>() / vals[c].len() as f64;
        let mut others: Vec<usize> = alive.iter().copied().filter(|&c| c != 0).collect();
        others.sort_by(|&a, &b| mean(b).partial_cmp(&mean(a)).unwrap().then(a.cmp(&b)));
        others.truncate((alive.len() / 2).max(1));
        if others.len() == 1 {
            alive = vec![0, others[0]];
            break;
        }
        alive = std::iter::once(0).chain(others).collect();
    }
    // Final round: the best challenger against the human player's choice.
    let ch = alive[1];
    let extra = (cfg.rollouts.saturating_sub(stats.rollouts) / 2).max(1);
    let more: Vec<(usize, usize)> = [0, ch].iter().flat_map(|&c| (vals[c].len()..vals[c].len() + extra).map(move |j| (c, j))).collect();
    let mut res = run_jobs(obs, &cands, &more, seed, cfg, &work);
    res.sort_unstable_by_key(|&(c, j, _)| (c, j));
    for (c, _, v) in res {
        vals[c].push(v);
    }
    stats.rollouts += more.len();
    stats.work = work.into_inner() as u64;
    let diffs: Vec<f64> = vals[ch].iter().zip(&vals[0]).map(|(a, b)| a - b).collect();
    let n = diffs.len() as f64;
    let m = diffs.iter().sum::<f64>() / n;
    let var = diffs.iter().map(|d| (d - m) * (d - m)).sum::<f64>() / (n - 1.0).max(1.0);
    let se = (var / n).sqrt();
    stats.chosen = if m > cfg.z * se && m > 0.0 { ch } else { 0 };
    (cands[stats.chosen].clone(), stats)
}

/// Run rollouts `(candidate, world)` on the configured threads.
fn run_jobs(obs: &Game, cands: &[Decision], jobs: &[(usize, usize)], seed: u64, cfg: &SmartConfig, work: &AtomicUsize) -> Vec<(usize, usize, f64)> {
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::with_capacity(jobs.len()));
    let worker = || {
        let mut local = Vec::new();
        loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            let Some(&(c, j)) = jobs.get(i) else { break };
            let (v, w) = rollout(obs, &cands[c], mix(seed, j as u64), cfg);
            work.fetch_add(w as usize, Ordering::Relaxed);
            local.push((c, j, v));
        }
        results.lock().unwrap().extend(local);
    };
    let threads = cfg.threads.min(jobs.len());
    if threads <= 1 {
        worker();
    } else {
        std::thread::scope(|sc| {
            for _ in 0..threads {
                sc.spawn(worker);
            }
        });
    }
    results.into_inner().unwrap()
}

/// Play `d` in a guessed world, then let the human player finish. Returns
/// the outcome's value and the positions examined.
fn rollout(obs: &Game, d: &Decision, seed: u64, cfg: &SmartConfig) -> (f64, u64) {
    let mut world = determinize(obs, seed);
    apply_decision(&mut world, d);
    let level = obs.deals_remaining();
    let r = if cfg.horizon == 0 || level == 0 {
        play_until(&world, &cfg.rollout, 0, true, false)
    } else {
        play_until(&world, &cfg.rollout, level.saturating_sub(cfg.horizon), cfg.play_on, false)
    };
    let mut end = world;
    for &mv in &r.moves {
        end.apply(mv).expect("rollout move is legal");
    }
    let finished = cfg.horizon == 0 || level == 0 || end.deals_remaining() > level.saturating_sub(cfg.horizon);
    let v = if cfg.learned && finished {
        end.completed.len() as f64 + if r.won { cfg.win_bonus } else { 0.0 }
    } else if cfg.learned && !cfg.play_on {
        learned_value(&end)
    } else {
        let v = cfg.rollout.eval(&State::from_game(&end)) as f64 / cfg.rollout.completed as f64;
        v + if r.won { cfg.win_bonus } else { 0.0 }
    };
    (v, r.work)
}

/// Predicted final completed suits (plus 4 for a win) of the human player
/// from a position just after a deal, by a linear model on [`features`]
/// fitted per suit count and stock level (`valuedata` output, 3,000 games
/// each; see the README).
pub fn learned_value(g: &Game) -> f64 {
    let table = match g.suits {
        1 => &VALUE_1,
        2 => &VALUE_2,
        _ => &VALUE_4,
    };
    let w = &table[g.deals_remaining().min(4)];
    features(g).iter().zip(w).map(|(f, w)| f * w).sum()
}

const VALUE_1: [[f64; 12]; 5] = [
    [20.27, 0.01212, -0.3272, -0.7419, -0.6607, -0.01296, 0.0, -0.478, 0.04141, 0.1827, 0.009593, 0.0],
    [19.79, 0.008796, -0.2749, -0.8206, -0.4068, 0.06231, 0.0, -0.3086, -0.1104, 0.09821, 0.1822, 0.0],
    [10.27, -0.05616, -0.2369, -0.785, -1.97, 0.0612, 0.0, -1.064, -0.1108, 0.9058, 0.1831, 0.0],
    [12.18, -0.02332, -0.1686, -0.6314, -0.8025, 0.1115, 0.0, -0.4423, -0.1581, 0.3602, 0.05492, 0.0],
    [-2.201, -0.1163, -0.126, -0.6058, -2.997, 0.1017, 0.0, -1.461, -0.1536, 1.536, 0.1887, 0.0],
];
const VALUE_2: [[f64; 12]; 5] = [
    [14.74, 0.01762, -0.2544, 0.05404, -0.6623, -0.09148, -0.2222, -0.3233, 0.102, 0.1168, 0.002493, 0.0],
    [8.824, -0.03259, -0.318, -0.4677, -2.541, -0.0413, -0.7958, -0.9617, 0.08535, 0.783, -0.05926, 0.0],
    [9.238, -0.01511, -0.2674, -0.3586, -1.4, 0.04839, -0.428, -0.5566, 0.0429, 0.4155, -0.1223, 0.0],
    [11.19, 0.008594, -0.2164, -0.3162, 0.0, 0.1351, 0.02508, -0.05553, -0.02066, -0.03045, -0.08225, 0.0],
    [8.237, -0.009501, -0.1065, -0.1313, 0.0, 0.2449, 0.1063, -0.1212, -0.1346, -0.01484, -0.3549, 0.0],
];
const VALUE_4: [[f64; 12]; 5] = [
    [26.32, 0.1077, -0.1942, 0.213, 2.6, -0.2138, 0.7944, 0.8126, 0.172, -0.9926, -0.005464, 0.0],
    [10.81, 0.0007998, -0.2104, 0.2238, -1.635, -0.2162, -0.6162, -0.6028, 0.2728, 0.4162, 0.002799, 0.0],
    [11.97, 0.03446, -0.1735, 0.3154, 0.0, -0.1654, -0.0519, -0.05716, 0.3104, -0.1091, -0.1101, 0.0],
    [16.71, 0.05119, -0.257, 0.2726, 0.0, -0.2429, -0.07177, -0.0938, 0.4363, -0.1656, -0.4089, 0.0],
    [15.79, 0.05032, -0.2745, 0.3184, 0.0, -0.2179, -0.07408, -0.08766, 0.3762, -0.1617, -0.2136, 0.0],
];

/// Statistics of a whole game.
#[derive(Clone, Debug, Default)]
pub struct SmartStats {
    pub decisions: usize,
    /// Decisions with more than one candidate.
    pub contested: usize,
    /// Decisions where the rollouts overruled the human player.
    pub overruled: usize,
    pub rollouts: usize,
}

/// Play `g` to the end, deciding every move from the masked position only.
pub fn play(g: &Game, cfg: &SmartConfig) -> (PlayResult, SmartStats) {
    let trace = std::env::var_os("SPIDER_S_TRACE").is_some();
    let mut g = g.clone();
    let mut st = SmartStats::default();
    let mut work = 0;
    let start = g.move_count();
    while !g.is_won() && g.move_count() - start < 5000 {
        let obs = mask(&g);
        let (d, ds) = decide(&obs, g.deals_remaining(), cfg);
        st.decisions += 1;
        st.rollouts += ds.rollouts;
        work += ds.work;
        if ds.candidates > 1 {
            st.contested += 1;
        }
        if ds.chosen != 0 {
            st.overruled += 1;
        }
        if trace {
            eprintln!("{}\n{d:?} ({} candidates, chose #{})", crate::human::show(&g), ds.candidates, ds.chosen);
        }
        if !apply_decision(&mut g, &d) {
            break;
        }
    }
    let moves = g.history()[start..].iter().map(|r| r.mv).collect();
    (PlayResult { won: g.is_won(), moves, completed: g.completed.len(), work }, st)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn determinize_keeps_visible_cards_and_the_deck() {
        let mut g = Game::new(4, 5);
        for _ in 0..2 {
            g.apply(crate::game::Move::Deal).unwrap();
        }
        let w = determinize(&mask(&g), 99);
        assert_eq!(w.stock.len(), g.stock.len());
        let mut a: Vec<Card> = w.columns.iter().flatten().chain(&w.stock).copied().collect();
        let mut b: Vec<Card> = g.columns.iter().flatten().chain(&g.stock).copied().collect();
        a.sort();
        b.sort();
        assert_eq!(a, b);
        for c in 0..NUM_COLS {
            assert_eq!(w.face_down[c], g.face_down[c]);
            assert_eq!(w.columns[c][g.face_down[c]..], g.columns[c][g.face_down[c]..]);
        }
    }

    #[test]
    fn decisions_ignore_hidden_cards() {
        let a = Game::new(2, 11);
        let mut b = a.clone();
        b.columns[0][0] = Card::new(1, 5);
        b.stock.reverse();
        let cfg = SmartConfig { rollouts: 16, threads: 2, ..SmartConfig::for_suits(2) };
        assert_eq!(decide(&mask(&a), 5, &cfg).0, decide(&mask(&b), 5, &cfg).0);
    }
}

/// Names of [`features`], in order.
pub const FEATURES: [&str; 12] =
    ["const", "completed", "hidden", "clear", "empty", "same", "diff", "wrong", "run_sq", "runs", "king_base", "face_up"];

/// Visible features of a position, for the learned value of a rollout's end.
pub fn features(g: &Game) -> [f64; 12] {
    let mut f = [0f64; 12];
    f[0] = 1.0;
    f[1] = g.completed.len() as f64;
    for c in 0..NUM_COLS {
        let col = &g.columns[c];
        let d = g.face_down[c];
        if col.is_empty() {
            f[4] += 1.0;
            continue;
        }
        f[2] += d as f64;
        if d == 0 {
            f[3] += 1.0;
            if col[0].rank() == 12 {
                f[10] += 1.0;
            }
        }
        f[11] += (col.len() - d) as f64;
        let mut run = 1.0;
        for i in d + 1..col.len() {
            let (upper, lower) = (col[i - 1], col[i]);
            if upper.rank() == lower.rank() + 1 && upper.suit() == lower.suit() {
                f[5] += 1.0;
                run += 1.0;
                continue;
            }
            if upper.rank() == lower.rank() + 1 {
                f[6] += 1.0;
            } else {
                f[7] += 1.0;
            }
            f[8] += run * run / 16.0;
            f[9] += 1.0;
            run = 1.0;
        }
        f[8] += run * run / 16.0;
        f[9] += 1.0;
    }
    f
}
