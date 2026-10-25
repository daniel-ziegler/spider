//! The browser's port of the line player (web/static/lineplayer.js), which
//! the web game's analysis rolls games out with, must play as lines.rs does
//! with the analysis's player (`LineConfig::rollout` with the settings of
//! lineplayer.js's ANALYSIS, given here as the environment gives them), with
//! `LineConfig::rollout` and with `LineConfig::fast`:
//! web/test/lineplayer.mjs plays deals in JavaScript and prints each one's
//! result, work and moves; playing them here must give the same. (With
//! GAMES, CONFIG, EXPECT_TOP, ... in the environment, see there, other
//! deals and settings are compared: SPIDER_L_* must then say the same.)
use spider::game::{encode_moves, Game};
use spider::lines::{play, LineConfig};

#[test]
fn javascript_port_matches() {
    let out = std::process::Command::new("node").arg("web/test/lineplayer.mjs").output().expect("node is needed for this test");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    let mut won = [0; 2];
    let mut analysis = 0;
    for line in text.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        let (suits, seed): (u8, u64) = (f[1].parse().unwrap(), f[2].parse().unwrap());
        for name in ["SPIDER_L_FAST", "SPIDER_L_REPLAN", "SPIDER_L_BEAM", "SPIDER_L_K0_MAX_STEPS", "SPIDER_L_K0_EXPECT_STEPS", "SPIDER_L_K0_REPLAN", "SPIDER_L_K0_BEAM"] {
            std::env::remove_var(name);
        }
        std::env::set_var("SPIDER_L_ROLLOUT", "1");
        match (f[0], suits) {
            ("fast", _) => std::env::set_var("SPIDER_L_FAST", "1"),
            ("analysis", 1) => {
                std::env::set_var("SPIDER_L_K0_MAX_STEPS", "4");
                std::env::set_var("SPIDER_L_K0_EXPECT_STEPS", "2");
            }
            ("analysis", _) => {
                std::env::set_var("SPIDER_L_REPLAN", "4");
                std::env::set_var("SPIDER_L_BEAM", "150");
                std::env::set_var("SPIDER_L_K0_REPLAN", "8");
                std::env::set_var("SPIDER_L_K0_BEAM", "100");
            }
            _ => {}
        }
        let r = play(&Game::new(suits, seed), &LineConfig::from_env(suits));
        let moves = encode_moves(r.moves.iter().copied());
        let ours = format!("{} {} {} {}", r.won, r.completed, r.work, if moves.is_empty() { "-" } else { &moves });
        assert_eq!(ours, f[3..].join(" "), "{} {suits}/{seed}", f[0]);
        won[r.won as usize] += 1;
        analysis += (f[0] == "analysis") as usize;
    }
    assert!(won.iter().all(|&n| n >= 20), "too few games won or lost: {won:?}");
    assert!(analysis >= 48, "only {analysis} games of the analysis's player");
}
