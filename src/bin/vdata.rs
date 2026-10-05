//! Training data for the value network: line player games with some
//! exploration, sampled positions and line ends with each game's outcome.
//! Usage: vdata suits first count out.bin [eps] [sample]
//! (records of `spider::vnet::RECORD` bytes; SPIDER_L_* tune the player)
use spider::game::Game;
use spider::lines::LineConfig;
use spider::vnet::record_game;
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let path = &a[4];
    let eps: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.05);
    let sample: f64 = a.get(6).and_then(|s| s.parse().ok()).unwrap_or(0.3);
    let cfg = LineConfig::from_env(suits);
    let out = Mutex::new(std::io::BufWriter::new(std::fs::File::create(path).unwrap()));
    let next = AtomicU64::new(first);
    let wins = AtomicUsize::new(0);
    let records = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let mut buf = Vec::new();
                let (won, _) = record_game(&Game::new(suits, seed), &cfg, eps, sample, seed, &mut buf);
                wins.fetch_add(won as usize, Ordering::Relaxed);
                records.fetch_add(buf.len() / spider::vnet::RECORD, Ordering::Relaxed);
                out.lock().unwrap().write_all(&buf).unwrap();
                if (seed - first + 1) % 1000 == 0 {
                    eprintln!("{} games, {} won, {} records", seed - first + 1, wins.load(Ordering::Relaxed), records.load(Ordering::Relaxed));
                }
            });
        }
    });
    out.into_inner().unwrap().flush().unwrap();
    println!("{count} games, {} won, {} records", wins.load(Ordering::Relaxed), records.load(Ordering::Relaxed));
}
