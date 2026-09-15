//! Replay winning lines from the class solver and histogram the evaluation
//! delta of each move: how much of a winning line is "non-improving"?
use spider::game::{Game, Move};
use spider::solver::{eval_game, Solver, Verdict, Weights};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
    let w = Weights::default();
    for seed in first..first + count {
        let mut g = Game::new(suits, seed);
        let r = Solver::new(&g, 3_000_000).solve(&g);
        if r.verdict != Verdict::Solvable {
            println!("seed {seed}: {:?}", r.verdict);
            continue;
        }
        let (mut up, mut zero, mut down, mut deals) = (0, 0, 0, 0);
        let mut line = String::new();
        for mv in &r.line {
            let before = eval_game(&g, &w);
            g.apply(*mv).unwrap();
            let after = eval_game(&g, &w);
            match mv {
                Move::Deal => {
                    deals += 1;
                    line.push('D');
                }
                _ => {
                    let d = after - before;
                    if d > 0 {
                        up += 1;
                        line.push('+');
                    } else if d == 0 {
                        zero += 1;
                        line.push('0');
                    } else {
                        down += 1;
                        line.push('-');
                    }
                }
            }
        }
        println!("seed {seed}: len {} up {up} zero {zero} down {down} deals {deals}\n  {line}", r.line.len());
    }
}
