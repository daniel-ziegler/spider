//! Play the hint policy (best-ranked visible move, deal when nothing else)
//! from a range of seeds and dump stock-empty positions along the way, in
//! the `endgame` file format. Usage: greedy suits first count [every]
use spider::game::{Game, Move};
use std::collections::HashSet;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
    let every: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(8);
    for seed in first..first + count {
        let mut g = Game::new(suits, seed);
        let mut since = 0;
        let mut seen: HashSet<String> = HashSet::new();
        for _ in 0..600 {
            if g.is_won() {
                break;
            }
            // Best-ranked move that reaches a position not seen before,
            // else deal (the ranking puts the deal last anyway).
            let hints = g.hint_moves();
            let mut chosen = None;
            for &mv in &hints {
                let mut t = g.clone();
                if t.apply(mv).is_ok() && seen.insert(t.to_position_text()) {
                    chosen = Some(mv);
                    break;
                }
            }
            let Some(mv) = chosen else { break };
            if mv == Move::Deal {
                since = 0;
            }
            if g.apply(mv).is_err() {
                break;
            }
            if g.stock.is_empty() && !g.is_won() {
                if since % every == 0 {
                    println!("s{seed}m{} 0 {}", g.move_count(), g.to_position_text());
                }
                since += 1;
            }
        }
    }
}
