//! Play the human-style player and print, at every position right after a
//! deal, the deals left, the visible features and the game's final outcome
//! (completed suits, won). Usage: valuedata suits first count > data.csv
use spider::game::{Game, Move};
use spider::human::{apply_decision, decide, mask, HumanConfig};
use spider::smart::{features, FEATURES};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(4);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let cfg = HumanConfig::from_env(suits);
    println!("seed,level,{},final_completed,won", FEATURES.join(","));
    let next = AtomicU64::new(first);
    let out = Mutex::new(());
    std::thread::scope(|sc| {
        for _ in 0..std::thread::available_parallelism().map_or(1, |n| n.get()) {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let mut g = Game::new(suits, seed);
                let mut rows = Vec::new();
                while !g.is_won() && g.move_count() < 5000 {
                    let (d, _) = decide(&mask(&g), g.deals_remaining(), &cfg);
                    let before = g.deals_remaining();
                    if !apply_decision(&mut g, &d) {
                        break;
                    }
                    if g.deals_remaining() < before && g.last_move() == Some(Move::Deal) {
                        let f = features(&g);
                        rows.push((g.deals_remaining(), f));
                    }
                }
                let _lock = out.lock().unwrap();
                for (lvl, f) in rows {
                    let fs: Vec<String> = f.iter().map(|x| format!("{x}")).collect();
                    println!("{seed},{lvl},{},{},{}", fs.join(","), g.completed.len(), g.is_won() as u8);
                }
            });
        }
    });
}
