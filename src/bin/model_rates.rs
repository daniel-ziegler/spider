//! Win rates on listed deals of line players made to play as a person was
//! found to (web/tools/playstyle), to see whether such a player says which
//! deals that person finds hard (web/tools/hardness; it did not).
//! Usage: model_rates suits runs   (SPIDER_R_SEEDS: a file whose lines start
//! with a seed; SPIDER_THREADS; one line per seed, `seed S name wins/runs
//! down ...` for each player, `down` the cards still face down at the end of
//! its games, on average, times 100)
//!
//! All of them waver by 2 with a salt per game. `weak` is `pick_seeds`'
//! weak player (lines of 4 steps, 3 with three suits, beam 50, no
//! expectimax, replanning or splits when dealing) and `comp` the web game's
//! computer. `capNN` is the weak player with lines of up to 14 steps of
//! which it sees only so many, drawn anew whenever a card turns, a deal is
//! made or a suit completes: one step always, and each further one with
//! probability NN% (so `cap80` sees a line of 4 steps half the time), which
//! is the playstyle analysis's found rate falling with a line's length.
//! `comp` plays half as many games. `lowNN` is `capNN` valuing an empty column at three tenths (it turns a
//! card where a column could be emptied).
use spider::game::{Game, Move};
use spider::human::mask;
use spider::lines::{decide, masked_hash, play, progress, Decision, LineConfig, Tempo};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn computer(suits: u8, salt: u64) -> LineConfig {
    let all = LineConfig { replan: 4, beam: 150, waver: 2, salt, ..LineConfig::rollout(suits) };
    let mut staged = [all; 6];
    staged[0] = LineConfig { replan: 8, beam: 100, ..all };
    LineConfig { staged: Some(Box::leak(Box::new(staged))), ..all }
}

fn mix(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// A game of `base` seeing lines of a length drawn anew at each progress
/// (each further step with probability `q`); returns whether it won and
/// the cards left face down.
fn play_capped(g: &Game, base: &LineConfig, q: f64, salt: u64) -> (bool, usize) {
    let mut g = g.clone();
    let mut visited = HashSet::new();
    let mut tempo = Tempo::default();
    let (mut epoch, mut cap) = (0u64, 0usize);
    // (48: the search's longest column, as in `lines::play_until`.)
    while !g.is_won() && g.move_count() < 5000 && g.columns.iter().all(|c| c.len() <= 48) {
        if cap == 0 {
            cap = 1;
            let mut x = mix(salt.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ epoch);
            while cap < 14 {
                x = mix(x);
                if (x >> 11) as f64 / (1u64 << 53) as f64 >= q {
                    break;
                }
                cap += 1;
            }
        }
        let obs = mask(&g);
        visited.insert(masked_hash(&obs));
        let before = progress(&g);
        let cfg = LineConfig { max_steps: cap, salt, ..*base };
        match decide(&obs, g.deals_remaining(), &visited, &mut tempo, &cfg).0 {
            Decision::Play(line) => {
                for mv in line {
                    g.apply(mv).expect("planned move is legal");
                }
            }
            Decision::Deal => g.apply(Move::Deal).expect("deal is legal"),
            Decision::Stuck => break,
        }
        if progress(&g) != before {
            tempo = Tempo::default();
            epoch += 1;
            cap = 0;
        }
    }
    (g.is_won(), g.face_down.iter().sum())
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(4);
    let runs: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);
    let threads = get("SPIDER_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    let text = std::fs::read_to_string(std::env::var("SPIDER_R_SEEDS").expect("SPIDER_R_SEEDS")).expect("SPIDER_R_SEEDS");
    let seeds: Vec<u64> = text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.split_whitespace().next().unwrap().parse().unwrap()).collect();
    let weak = LineConfig { max_steps: if suits == 3 { 3 } else { 4 }, expect_top: 0, replan: 0, beam: 50, deal_splits: 0, waver: 2, ..LineConfig::for_suits(suits) };
    let low = LineConfig { empty: weak.empty * 3 / 10, end_empty: weak.end_empty * 3 / 10, ..weak };
    let comps: Vec<LineConfig> = (0..runs).map(|i| computer(suits, 2_000_000 + i)).collect();
    let only: String = get("SPIDER_R_PLAYERS", String::new());
    let chosen = |name: &str| only.is_empty() || only.split(',').any(|p| p == name);
    let next = AtomicUsize::new(0);
    let out = Mutex::new(std::io::stdout());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let Some(&seed) = seeds.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                let g = Game::new(suits, seed);
                let mut line = format!("seed {seed}");
                let mut add = |name: &str, f: &dyn Fn(u64) -> (bool, usize)| {
                    if !chosen(name) {
                        return;
                    }
                    // (The computer is slow: half the games.)
                    let runs = if name == "comp" { runs.div_ceil(2) } else { runs };
                    let (mut wins, mut down) = (0, 0);
                    for i in 0..runs {
                        let (won, d) = f(2_000_000 + i);
                        wins += won as u64;
                        down += d;
                    }
                    line += &format!(" {name} {wins}/{runs} {}", down * 100 / runs as usize);
                };
                let whole = |cfg: LineConfig| {
                    let r = play(&g, &cfg);
                    let mut h = g.clone();
                    for &mv in &r.moves {
                        h.apply(mv).unwrap();
                    }
                    (r.won, h.face_down.iter().sum())
                };
                add("weak", &|salt| whole(LineConfig { salt, ..weak }));
                for (name, q) in [("cap65", 0.65), ("cap80", 0.8), ("cap90", 0.9), ("cap95", 0.95)] {
                    add(name, &|salt| play_capped(&g, &weak, q, salt));
                }
                for (name, q) in [("low80", 0.8), ("low90", 0.9)] {
                    add(name, &|salt| play_capped(&g, &low, q, salt));
                }
                add("comp", &|salt| whole(comps[(salt - 2_000_000) as usize]));
                use std::io::Write;
                let mut out = out.lock().unwrap();
                writeln!(out, "{line}").unwrap();
                out.flush().unwrap();
            });
        }
    });
}
