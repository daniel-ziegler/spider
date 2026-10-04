//! How much better than the line player's own choice its alternatives are:
//! at sampled decisions of the line player's games, every candidate of the
//! rollout player is played out `n` times in the same guessed worlds by the
//! rollout policy. Prints one row per sampled decision: seed, deals left,
//! candidates, the base choice's mean outcome and win rate, and the best
//! alternative's (by mean outcome).
//! Usage: regret suits first count n every   (SPIDER_P_*, SPIDER_L_*)
use spider::game::Game;
use spider::human::mask;
use spider::lines::{masked_hash, progress, Tempo};
use spider::pimc::{apply_cand, candidate_outcomes, candidates, PimcConfig};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize, d: u64| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let (suits, first, count, n, every) = (arg(1, 4) as u8, arg(2, 50001), arg(3, 50), arg(4, 64) as usize, arg(5, 4) as usize);
    let cfg = PimcConfig::from_env(suits);
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
                let mut visited = HashSet::new();
                let mut tempo = Tempo::default();
                let mut k = 0;
                while !g.is_won() && g.move_count() < 5000 {
                    let obs = mask(&g);
                    visited.insert(masked_hash(&obs));
                    let before = progress(&g);
                    let cands = candidates(&obs, g.deals_remaining(), &visited, &mut tempo, &cfg);
                    if cands.is_empty() {
                        break;
                    }
                    if cands.len() > 1 && k % every == 0 {
                        let v = candidate_outcomes(&obs, &cands, &visited, n, &cfg);
                        let mean = |x: &Vec<f64>| x.iter().sum::<f64>() / x.len() as f64;
                        let win = |x: &Vec<f64>| x.iter().filter(|&&y| y >= 8.0).count() as f64 / x.len() as f64;
                        let best = (1..v.len()).max_by(|&i, &j| mean(&v[i]).partial_cmp(&mean(&v[j])).unwrap()).unwrap();
                        let _l = out.lock().unwrap();
                        println!("{seed} {} {} {:.3} {:.3} {:.3} {:.3}", g.deals_remaining(), cands.len(), mean(&v[0]), win(&v[0]), mean(&v[best]), win(&v[best]));
                    }
                    k += 1;
                    apply_cand(&mut g, &cands[0]);
                    if progress(&g) != before {
                        tempo = Tempo::default();
                    }
                }
            });
        }
    });
}
