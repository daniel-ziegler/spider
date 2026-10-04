//! Play a range of seeds with the non-peeking rollout player (src/pimc.rs) and report
//! wins. Usage: lines [suits] [first_seed] [count]   (SPIDER_P_* and SPIDER_L_* tune it;
//! SPIDER_THREADS sets the threads, all cores by default)
use spider::game::Game;
use spider::pimc::{play, PimcConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    let quiet = std::env::var_os("SPIDER_P_QUIET").is_some();
    let threads = std::env::var("SPIDER_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let cfg = PimcConfig::from_env(suits);
    let next = AtomicU64::new(first);
    let results = Mutex::new(Vec::new());
    let t0 = std::time::Instant::now();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let g = Game::new(suits, seed);
                let (r, st) = play(&g, &cfg);
                // Replay to check the line is legal and gives the reported result.
                let mut check = g.clone();
                for &mv in &r.moves {
                    check.apply(mv).expect("line legal");
                }
                assert_eq!(check.is_won(), r.won);
                if !quiet { eprintln!("seed {seed}: {} suits {} decisions {} contested {} overruled {} rollouts {}", if r.won { "WIN" } else { "loss" }, r.completed, st.decisions, st.contested, st.overruled, st.rollouts); }
                results.lock().unwrap().push((seed, r.won, r.completed, r.moves.len(), r.work));
            });
        }
    });
    let mut results = results.into_inner().unwrap();
    results.sort();
    let (mut wins, mut suits_done, mut work) = (0, 0, 0u64);
    for &(seed, won, completed, moves, w) in &results {
        wins += won as u32;
        suits_done += completed;
        work += w;
        if !quiet {
            println!("seed {seed:>5}: {:<4} suits {completed} moves {moves:>4} work {w:>8}", if won { "WIN" } else { "loss" });
        }
    }
    println!(
        "suits {suits}: won {wins}/{count}, {:.2} suits/deal, {:.0} work/deal, {:.1} ms/deal",
        suits_done as f64 / count as f64,
        work as f64 / count as f64,
        t0.elapsed().as_secs_f64() * 1000.0 * threads as f64 / count as f64
    );
}
