//! Where the line player loses winnable games: plays each seed and, each
//! time it is about to deal (and at the end), asks the full-information
//! solver whether the real game can still be won. Usage: winnable [suits]
//! [first_seed] [count] [budget]
use spider::game::{Game, Move};
use spider::lines::{play_until, LineConfig};
use spider::solver::{Solver, Verdict};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(4);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    let budget: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(2_000_000);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let cfg = LineConfig::from_env(suits);
    let next = AtomicU64::new(first);
    // Per checkpoint (deals left before the deal: 5..1, then 6 = the end):
    // [solvable, unsolvable, unknown]. Also per game: the line player's result.
    let rows = Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let mut g = Game::new(suits, seed);
                let solve = |g: &Game| match Solver::new(g, budget).solve(g).verdict {
                    Verdict::Solvable => 'W',
                    Verdict::Unsolvable => 'L',
                    Verdict::Unknown => '?',
                };
                let mut marks = String::new();
                marks.push(solve(&g));
                for left in (1..=5).rev() {
                    let (_, stopped) = play_until(&mut g, &cfg, HashSet::new(), Some(left));
                    if !stopped {
                        break;
                    }
                    marks.push(solve(&g));
                    g.apply(Move::Deal).expect("deal");
                    if left == 1 {
                        marks.push(solve(&g));
                    }
                }
                if !g.is_won() {
                    play_until(&mut g, &cfg, HashSet::new(), None);
                }
                let line = format!("seed {seed}: {} {marks}", if g.is_won() { "WIN " } else { "loss" });
                println!("{line}");
                rows.lock().unwrap().push((g.is_won(), marks));
            });
        }
    });
    let rows = rows.into_inner().unwrap();
    let won = rows.iter().filter(|r| r.0).count();
    println!("line player won {won}/{}", rows.len());
    for i in 0..7 {
        let at: Vec<&(bool, String)> = rows.iter().filter(|r| r.1.len() > i).collect();
        let c = |ch| at.iter().filter(|r| r.1.as_bytes()[i] == ch).count();
        let lost_w = at.iter().filter(|r| !r.0 && r.1.as_bytes()[i] == b'W').count();
        println!(
            "{}: winnable {} unwinnable {} unknown {} of {}; line player then lost {} winnable",
            match i {
                0 => "start".to_string(),
                6 => "after the last deal".to_string(),
                _ => format!("before deal {i}"),
            },
            c(b'W'),
            c(b'L'),
            c(b'?'),
            at.len(),
            lost_w
        );
    }
}
