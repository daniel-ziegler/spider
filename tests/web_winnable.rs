//! The browser's port of the solver (web/static/winnable.js) must search the
//! way solver.rs does: web/test/winnable.mjs solves positions from play in
//! JavaScript and prints each one's verdict, work, classes and winning line;
//! solving them here must give the same.
use spider::game::{encode_moves, parse_moves, Game};
use spider::solver::{Solver, Verdict};

#[test]
fn javascript_port_matches() {
    let out = std::process::Command::new("node").arg("web/test/winnable.mjs").output().expect("node is needed for this test");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    let mut verdicts = [0; 3];
    for line in text.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        let (suits, seed): (u8, u64) = (f[0].parse().unwrap(), f[1].parse().unwrap());
        let mut g = Game::new(suits, seed);
        for mv in parse_moves(f[2].trim_matches('-')).unwrap() {
            g.apply(mv).unwrap();
        }
        let r = Solver::new(&g, f[3].parse().unwrap()).solve(&g);
        let (i, verdict) = match r.verdict {
            Verdict::Solvable => (0, "solvable"),
            Verdict::Unsolvable => (1, "unsolvable"),
            Verdict::Unknown => (2, "unknown"),
        };
        verdicts[i] += 1;
        let line = encode_moves(r.line.iter().copied());
        let ours = format!("{verdict} {} {} {}", r.nodes, r.classes, if line.is_empty() { "-" } else { &line });
        assert_eq!(ours, f[4..].join(" "), "{suits}/{seed} after {} moves", f[2].split(',').count());
    }
    assert!(verdicts.iter().all(|&n| n >= 5), "too few of some verdict: {verdicts:?}");
}
