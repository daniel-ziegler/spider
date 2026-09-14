use spider::game::Game;
use spider::solver::{Solver, Verdict};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let seed: u64 = a[2].parse().unwrap();
    let mut g = Game::new(suits, seed);
    let r = Solver::new(&g, 3_000_000).solve(&g);
    println!("{:?} work {} line {}", r.verdict, r.nodes, r.line.len());
    if r.verdict == Verdict::Solvable {
        for (i, mv) in r.line.iter().enumerate() {
            if let Err(e) = g.apply(*mv) {
                println!("move {i} {:?} illegal: {e}", mv);
                println!("{}", g.to_position_text());
                break;
            }
        }
        println!("won {}", g.is_won());
    }
}
