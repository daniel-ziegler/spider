//! Find seeds the line player usually wins but a weak one usually loses.
//! Usage: pick_seeds suits first count   (prints one line per seed tried;
//! SPIDER_THREADS sets the threads, all cores by default)
//!
//! Both players waver (`SPIDER_L_WAVER`, default 2: a random line among
//! those within that much of the best), so each has a win rate on a seed,
//! estimated over runs with different salts. The strong player is the
//! default line player (`SPIDER_L_*`); the weak one the same without
//! expectimax or replanning, with SPIDER_W_STEPS (default 4; 2 with two
//! suits) steps per line, a beam of SPIDER_W_BEAM (50) and
//! SPIDER_W_DEAL_SPLITS (0). A seed is kept when the weak player wins
//! fewer than SPIDER_W_MAX (40%) of SPIDER_W_RUNS (20) runs and the strong
//! one more than SPIDER_S_MIN (70%) of SPIDER_S_RUNS (20); the weak runs go
//! first, then 5 strong runs (stopping if fewer than 3 are won), then the
//! rest.
use spider::game::Game;
use spider::lines::{play, LineConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Wins in `runs` games of `seed`, salts `salt0..`.
fn wins(g: &Game, cfg: &LineConfig, salt0: u64, runs: usize) -> usize {
    (0..runs).filter(|&i| play(g, &LineConfig { salt: salt0 + i as u64, ..*cfg }).won).count()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(4);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    let threads = get("SPIDER_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    let mut strong = LineConfig::from_env(suits);
    if std::env::var_os("SPIDER_L_WAVER").is_none() {
        strong.waver = 2;
    }
    let weak = LineConfig {
        max_steps: get("SPIDER_W_STEPS", if suits == 2 { 2 } else { 4 }),
        expect_top: 0,
        replan: 0,
        beam: get("SPIDER_W_BEAM", 50),
        deal_splits: get("SPIDER_W_DEAL_SPLITS", 0),
        ..strong
    };
    let (w_runs, s_runs): (usize, usize) = (get("SPIDER_W_RUNS", 20), get("SPIDER_S_RUNS", 20));
    let (w_max, s_min): (f64, f64) = (get("SPIDER_W_MAX", 0.4), get("SPIDER_S_MIN", 0.7));
    let next = AtomicU64::new(first);
    let out = Mutex::new(std::io::stdout());
    let kept = AtomicU64::new(0);
    let t0 = std::time::Instant::now();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let g = Game::new(suits, seed);
                let w = wins(&g, &weak, 1_000_000, w_runs);
                let (mut s, mut s_done) = (0, 0);
                if (w as f64) < w_max * w_runs as f64 {
                    s_done = 5.min(s_runs);
                    s = wins(&g, &strong, 1, s_done);
                    if s >= 3 {
                        s += wins(&g, &strong, 1 + s_done as u64, s_runs - s_done);
                        s_done = s_runs;
                    }
                }
                let keep = s_done == s_runs && s as f64 > s_min * s_runs as f64;
                kept.fetch_add(keep as u64, Ordering::Relaxed);
                use std::io::Write;
                writeln!(out.lock().unwrap(), "seed {seed} weak {w}/{w_runs} strong {s}/{s_done}{}", if keep { " KEEP" } else { "" }).unwrap();
            });
        }
    });
    eprintln!("kept {}/{count} in {:.0} s", kept.load(Ordering::Relaxed), t0.elapsed().as_secs_f64());
}
