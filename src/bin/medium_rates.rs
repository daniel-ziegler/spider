//! Grades seeds for the medium daily challenges: deals that the web game's
//! computer wins, with the win rates on them of weaker players.
//! Usage: medium_rates suits first count   (one line per seed tried;
//! SPIDER_THREADS sets the threads, all cores by default; with
//! SPIDER_R_SEEDS, a file whose lines start with a seed, those seeds, the
//! ones at `first..first + count` in it counting from 1)
//!
//! The computer is the line player as the web game's analysis and its
//! compare mode play it (`web/static/lineplayer.js`'s `analysisConfig`: the
//! rollout player replanning every 4 steps with a beam of 150, every 8 with a
//! beam of 100 once the stock is gone), which always plays a deal the same
//! way. A seed it loses is dropped (`seed S comp 0`). The others are played
//! by `pick_seeds`' weak player (the default line player without expectimax
//! or replanning, lines of 4 steps, 3 with three suits, a beam of 50, no
//! splits when dealing, wavering by 2) SPIDER_M_RUNS (100) times; a seed is
//! dropped when it wins fewer than SPIDER_M_FIRST_MIN (6) of the first 20,
//! or, of them all, a share outside SPIDER_M_MIN (0.4) to SPIDER_M_MAX
//! (0.9). The seeds left are also played as often with lines of 2 steps and
//! of 8 (`w2`, `w8`), and SPIDER_M_SHIP (30) times by the computer wavering
//! by 2 (`ship`):
//! `seed S comp 1 weak a/n w2 b/n w8 c/n ship d/m`.
//! Those the wavering computer wins at least SPIDER_M_SHIP_MIN (27) times,
//! and the weak player a share from SPIDER_M_AGAIN_MIN to SPIDER_M_AGAIN_MAX
//! (0.5 to 0.8 with three suits, 0.47 to 0.77 with four), are played by the
//! weak player SPIDER_M_AGAIN (200) more times, with other salts
//! (`again e/200` at the line's end): these lines are the ones of
//! `web/tools/dailies/medium3.txt` and `medium4.txt`, of which `dailies
//! medium` takes the deals whose share of all the weak player's games is in a
//! narrower range.
//! With SPIDER_M_ALL set no seed is dropped: all of it is played on each.
use spider::game::Game;
use spider::lines::{play, LineConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// The analysis's player, wavering by `waver` with `salt`.
fn computer(suits: u8, waver: i32, salt: u64) -> LineConfig {
    let all = LineConfig { replan: 4, beam: 150, waver, salt, ..LineConfig::rollout(suits) };
    let mut staged = [all; 6];
    staged[0] = LineConfig { replan: 8, beam: 100, ..all };
    LineConfig { staged: Some(Box::leak(Box::new(staged))), ..all }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize, d: u64| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let (suits, first, count) = (arg(1, 4) as u8, arg(2, 1), arg(3, 100));
    let threads = get("SPIDER_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    let (runs, ship_runs): (u64, u64) = (get("SPIDER_M_RUNS", 100), get("SPIDER_M_SHIP", 30));
    let (first_min, min, max): (usize, f64, f64) = (get("SPIDER_M_FIRST_MIN", 6), get("SPIDER_M_MIN", 0.4), get("SPIDER_M_MAX", 0.9));
    let (ship_min, again): (usize, u64) = (get("SPIDER_M_SHIP_MIN", 27), get("SPIDER_M_AGAIN", 200));
    let (again_min, again_max): (f64, f64) = if suits == 3 { (0.5, 0.8) } else { (0.47, 0.77) };
    let (again_min, again_max): (f64, f64) = (get("SPIDER_M_AGAIN_MIN", again_min), get("SPIDER_M_AGAIN_MAX", again_max));
    let every = std::env::var_os("SPIDER_M_ALL").is_some();
    let comp = computer(suits, 0, 0);
    let ship: Vec<LineConfig> = (1..=ship_runs).map(|salt| computer(suits, 2, salt)).collect();
    let weak = LineConfig { max_steps: if suits == 3 { 3 } else { 4 }, expect_top: 0, replan: 0, beam: 50, deal_splits: 0, waver: 2, ..LineConfig::for_suits(suits) };
    let (w2, w8) = (LineConfig { max_steps: 2, ..weak }, LineConfig { max_steps: 8, ..weak });
    let wins = |g: &Game, cfg: &LineConfig, from: u64, to: u64| (from..to).filter(|&i| play(g, &LineConfig { salt: 1_000_000 + i, ..*cfg }).won).count();
    let within = |w: usize, min: f64, max: f64| w as f64 >= min * runs as f64 && w as f64 <= max * runs as f64;
    let listed: Option<Vec<u64>> = std::env::var("SPIDER_R_SEEDS").ok().map(|path| {
        let text = std::fs::read_to_string(&path).expect("SPIDER_R_SEEDS");
        text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.split_whitespace().next().unwrap().parse().unwrap()).collect()
    });
    let next = AtomicU64::new(first);
    let out = Mutex::new(std::io::stdout());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= first + count {
                    break;
                }
                let seed = match &listed {
                    Some(seeds) => match seeds.get(i as usize - 1) {
                        Some(&seed) => seed,
                        None => break,
                    },
                    None => i,
                };
                let g = Game::new(suits, seed);
                let won = play(&g, &comp).won;
                let mut line = format!("seed {seed} comp {}", won as u8);
                if won || every {
                    let head = runs.min(20);
                    let mut w = wins(&g, &weak, 0, head);
                    if w >= first_min || every {
                        w += wins(&g, &weak, head, runs);
                        line += &format!(" weak {w}/{runs}");
                        if every || within(w, min, max) {
                            line += &format!(" w2 {}/{runs} w8 {}/{runs}", wins(&g, &w2, 0, runs), wins(&g, &w8, 0, runs));
                            let s = ship.iter().filter(|cfg| play(&g, cfg).won).count();
                            line += &format!(" ship {s}/{ship_runs}");
                            if every || (s >= ship_min && within(w, again_min, again_max)) {
                                line += &format!(" again {}/{again}", wins(&g, &weak, 1_000_000, 1_000_000 + again));
                            }
                        }
                    } else {
                        line += &format!(" weak {w}/{head}");
                    }
                }
                use std::io::Write;
                let mut out = out.lock().unwrap();
                writeln!(out, "{line}").unwrap();
                out.flush().unwrap();
            });
        }
    });
}
