//! Play a range of seeds with the non-peeking human-style player and report
//! wins. Usage: human [suits] [first_seed] [count]   (SPIDER_H_* tune it)
use spider::game::Game;
use spider::human::{play, HumanConfig};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    let quiet = std::env::var_os("SPIDER_H_QUIET").is_some();
    let cfg = HumanConfig::from_env(suits);
    let (mut wins, mut suits_done, mut work) = (0, 0, 0u64);
    let t0 = std::time::Instant::now();
    for seed in first..first + count {
        let g = Game::new(suits, seed);
        let r = play(&g, &cfg);
        // Replay to check the line is legal and gives the reported result.
        let mut check = g.clone();
        for &mv in &r.moves {
            check.apply(mv).expect("line legal");
        }
        assert_eq!(check.is_won(), r.won);
        wins += r.won as u32;
        suits_done += r.completed;
        work += r.work;
        if !quiet {
            println!(
                "seed {seed:>5}: {:<4} suits {} moves {:>4} work {:>8}",
                if r.won { "WIN" } else { "loss" },
                r.completed,
                r.moves.len(),
                r.work
            );
        }
    }
    println!(
        "suits {suits}: won {wins}/{count}, {:.2} suits/deal, {:.0} work/deal, {:.1} ms/deal",
        suits_done as f64 / count as f64,
        work as f64 / count as f64,
        t0.elapsed().as_secs_f64() * 1000.0 / count as f64
    );
}
