//! Solve dumped stock-empty positions (see SPIDER_DUMP_END) with a large budget.
//! Usage: endgame <file> [suits] [budget] [start] [count]
use spider::game::Game;
use spider::solver::{eval_game, Config, Solver, Verdict};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&a[1]).expect("read file");
    let suits: u8 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let budget: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(30_000_000);
    let start: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let count: usize = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let (mut solv, mut unsolv, mut unk) = (0, 0, 0);
    for (i, line) in text.lines().enumerate().skip(start).take(count) {
        let mut it = line.splitn(3, ' ');
        let tag = it.next().unwrap();
        let work: u64 = it.next().unwrap().parse().unwrap();
        let mut g = Game::from_position_text(suits, it.next().unwrap()).expect("parse position");
        let mut cfg = Config::from_env();
        cfg.end_cap = Some(budget);
        cfg.stage_cap = Some(budget);
        let r = Solver::with_config(&g, budget, cfg).solve(&g);
        match r.verdict {
            Verdict::Solvable => {
                solv += 1;
                let trace = std::env::var_os("SPIDER_TRACE_LINE").is_some();
                let w = Config::from_env().weights;
                for mv in &r.line {
                    let before = (g.face_down.iter().sum::<usize>(), g.completed.len());
                    g.apply(*mv).expect("line legal");
                    if trace {
                        let after = (g.face_down.iter().sum::<usize>(), g.completed.len());
                        let mark = if after != before { "*" } else { " " };
                        println!("  {mark} {:<8} eval {:>5} hidden {:>2} done {} empty {}", mv.encode(), eval_game(&g, &w), after.0, after.1, g.columns.iter().filter(|c| c.is_empty()).count());
                    }
                }
                assert!(g.is_won(), "line does not win");
            }
            Verdict::Unsolvable => unsolv += 1,
            Verdict::Unknown => unk += 1,
        }
        println!("{i:>4} {tag:<4} orig {work:>7} -> {:<10?} work {:>9} classes {:>7} proof {} {:.2}s", r.verdict, r.nodes, r.classes, r.proof_pass, r.elapsed.as_secs_f64());
    }
    println!("solvable {solv} unsolvable {unsolv} unknown {unk}");
}
