//! Solve a range of seeds and report verdicts, node counts and timing.
//! Usage: bench [suits] [first_seed] [count] [budget]
use spider::game::Game;
use spider::solver::{solve_portfolio, Config, Solver, Verdict};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let first: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
    let budget: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(2_000_000);
    let (mut solv, mut unsolv, mut unk) = (0, 0, 0);
    let mut total_nodes = 0u64;
    let mut total_time = 0f64;
    for seed in first..first + count {
        let mut g = Game::new(suits, seed);
        let portfolio: usize = std::env::var("SPIDER_PORTFOLIO").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let rollout = std::env::var_os("SPIDER_ROLLOUT").is_some();
        let r = if rollout {
            spider::rollout::solve_rollout(&g, budget)
        } else if std::env::var_os("SPIDER_BEAM").is_some() {
            spider::beam::solve_beam(&g, budget)
        } else if portfolio > 0 {
            solve_portfolio(&g, budget, Config::portfolio(portfolio))
        } else {
            Solver::new(&g, budget).solve(&g)
        };
        total_nodes += r.nodes;
        total_time += r.elapsed.as_secs_f64();
        match r.verdict {
            Verdict::Solvable => {
                solv += 1;
                for mv in &r.line {
                    g.apply(*mv).expect("line legal");
                }
                assert!(g.is_won(), "line does not win");
            }
            Verdict::Unsolvable => unsolv += 1,
            Verdict::Unknown => unk += 1,
        }
        println!(
            "seed {seed:>5}: {:<10?} work {:>9} classes {:>6} line {:>4} {:>7.3}s {}",
            r.verdict, r.nodes, r.classes, r.line.len(), r.elapsed.as_secs_f64(), r.config
        );
    }
    println!(
        "suits {suits}: solvable {solv} unsolvable {unsolv} unknown {unk}; {:.2} Mnodes/s",
        total_nodes as f64 / total_time.max(1e-9) / 1e6
    );
}
