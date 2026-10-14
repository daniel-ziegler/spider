//! The web game's analysis (web/static/analysis*.js, vnet.js): its checks in
//! JavaScript must pass (web/test/analysis.mjs: the stretches of a game, the
//! shuffled worlds its games are played out in, their statistics;
//! web/test/vnet.mjs: the network's forward pass against PyTorch), and the
//! positions it encodes for the network must be encoded as src/vnet.rs does,
//! which the networks were trained on.
use spider::game::{parse_moves, Game};
use spider::vnet::encode_game;

fn node(script: &str) -> String {
    let out = std::process::Command::new("node").arg(script).output().expect("node is needed for this test");
    assert!(out.status.success(), "{script}: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn analysis_checks_pass_and_encodings_match() {
    let text = node("web/test/analysis.mjs");
    let mut count = 0;
    for line in text.lines().filter(|l| l.starts_with("enc ")) {
        let f: Vec<&str> = line.split(' ').collect();
        let mut g = Game::new(f[1].parse().unwrap(), f[2].parse().unwrap());
        for mv in parse_moves(f[3]).unwrap() {
            g.apply(mv).unwrap();
        }
        let ours: String = encode_game(&g).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(ours, f[4], "{}/{} after {} moves", f[1], f[2], f[3].split(',').count());
        count += 1;
    }
    assert!(count >= 60, "only {count} encodings compared");
    assert!(text.ends_with("ok\n"));
}

#[test]
fn network_matches_pytorch() {
    let text = node("web/test/vnet.mjs");
    assert_eq!(text.lines().count(), 4, "{text}");
}
