//! Play a range of seeds with the non-peeking rollout player and report
//! wins. Usage: smart [suits] [first_seed] [count]   (SPIDER_S_* tune it;
//! SPIDER_S_PAR=n plays n seeds at once, one thread each)
use spider::game::Game;
use spider::smart::{play, SmartConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
    let quiet = std::env::var_os("SPIDER_S_QUIET").is_some();
    let par: usize = std::env::var("SPIDER_S_PAR").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut cfg = SmartConfig::from_env(suits);
    if par > 1 {
        cfg.threads = 1;
    }
    let totals = Mutex::new((0u32, 0usize, 0f64));
    let next = AtomicU64::new(first);
    let t0 = std::time::Instant::now();
    std::thread::scope(|sc| {
        for _ in 0..par {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let g = Game::new(suits, seed);
                let t = std::time::Instant::now();
                let (r, st) = play(&g, &cfg);
                let mut check = g.clone();
                for &mv in &r.moves {
                    check.apply(mv).expect("line legal");
                }
                assert_eq!(check.is_won(), r.won);
                let secs = t.elapsed().as_secs_f64();
                let mut tot = totals.lock().unwrap();
                tot.0 += r.won as u32;
                tot.1 += r.completed;
                tot.2 += secs;
                if !quiet {
                    println!(
                        "seed {seed:>5}: {:<4} suits {} moves {:>4} decisions {:>3} contested {:>3} overruled {:>3} rollouts {:>6} {:>6.2}s",
                        if r.won { "WIN" } else { "loss" },
                        r.completed,
                        r.moves.len(),
                        st.decisions,
                        st.contested,
                        st.overruled,
                        st.rollouts,
                        secs
                    );
                }
            });
        }
    });
    let (wins, suits_done, secs) = totals.into_inner().unwrap();
    println!(
        "suits {suits}: won {wins}/{count}, {:.2} suits/deal, {:.2} s/deal ({:.1} s wall)",
        suits_done as f64 / count as f64,
        secs / count as f64,
        t0.elapsed().as_secs_f64()
    );
}
