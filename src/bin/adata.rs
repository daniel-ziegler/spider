//! Training data for the network of the web game's analysis: games of the
//! line player from positions it and a noisier player get into, each
//! position with the outcome (see `spider::vnet::record_for_analysis`).
//! Usage: adata suits first count out.bin [sample] [mid] [noise] [noisy]
//! (records of `spider::vnet::ANALYSIS_RECORD` bytes; the player is
//! `LineConfig::rollout` with the environment's SPIDER_L_* and
//! SPIDER_L_K<n>_*, so any line player's games can be had: web/README.md
//! has the one the network is of; SPIDER_THREADS sets the threads, all
//! cores by default)
use spider::game::Game;
use spider::lines::LineConfig;
use spider::vnet::{record_for_analysis, ANALYSIS_RECORD};
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let path = &a[4];
    let arg = |i: usize, d: f64| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let (sample, mid, noise, noisy) = (arg(5, 0.12), arg(6, 0.02), arg(7, 0.25), arg(8, 30.0) as usize);
    let cfg = LineConfig::rollout_from_env(suits);
    let out = Mutex::new(std::io::BufWriter::new(std::fs::File::create(path).unwrap()));
    let next = AtomicU64::new(first);
    let (wins, records, decisions) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
    let threads = std::env::var("SPIDER_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let report = |games: u64| format!("{games} games, {} won, {} records, {} decisions", wins.load(Ordering::Relaxed), records.load(Ordering::Relaxed), decisions.load(Ordering::Relaxed));
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let mut buf = Vec::new();
                let (won, _, n) = record_for_analysis(&Game::new(suits, seed), &cfg, noise, noisy, sample, mid, seed, &mut buf);
                wins.fetch_add(won as usize, Ordering::Relaxed);
                records.fetch_add(buf.len() / ANALYSIS_RECORD, Ordering::Relaxed);
                decisions.fetch_add(n, Ordering::Relaxed);
                out.lock().unwrap().write_all(&buf).unwrap();
                if (seed - first + 1) % 5000 == 0 {
                    eprintln!("{}", report(seed - first + 1));
                }
            });
        }
    });
    out.into_inner().unwrap().flush().unwrap();
    println!("{}", report(count));
}
