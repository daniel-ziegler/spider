//! Win rates of players of several strengths on each seed of a range, to
//! grade deals by difficulty (the survey behind the medium daily
//! challenges; `pick_seeds` does the picking).
//! Usage: seed_rates suits first count [runs] [salt0]   (one line per seed:
//! `seed S human h w2 a/n weak b/n w8 c/n mid d/n strong e/n`;
//! SPIDER_THREADS sets the threads, all cores by default)
//!
//! All but `human` (src/human.rs, which always plays the same and so wins
//! or loses) are the line player wavering by 2, with salts from `salt0`
//! (default 1) for `runs` (20) games each: `strong` is the default player
//! (`SPIDER_L_*`); `mid` the same without expectimax or replanning; `weak`
//! pick_seeds' weak player (lines of 4 steps, 3 with three suits and 2 with
//! two, beam 50, no splits when dealing); `w2` and `w8` the weak player with
//! lines of 2 and 8 steps. SPIDER_R_PLAYERS (a comma-separated list) plays
//! only some of them. With SPIDER_R_SEEDS (a file whose lines start with a
//! seed, `#` comments aside) those seeds are played instead of a range:
//! the ones at `first..first + count` in the file, counting from 1.
use spider::game::Game;
use spider::lines::{play, LineConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize, d: u64| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let suits = arg(1, 4) as u8;
    let (first, count, runs, salt0) = (arg(2, 1), arg(3, 100), arg(4, 20), arg(5, 1));
    let threads = get("SPIDER_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    let mut strong = LineConfig::from_env(suits);
    if std::env::var_os("SPIDER_L_WAVER").is_none() {
        strong.waver = 2;
    }
    let mid = LineConfig { expect_top: 0, replan: 0, ..strong };
    let weak = LineConfig { max_steps: match suits { 2 => 2, 3 => 3, _ => 4 }, beam: 50, deal_splits: 0, ..mid };
    let all = [("w2", LineConfig { max_steps: 2, ..weak }), ("weak", weak), ("w8", LineConfig { max_steps: 8, ..weak }), ("mid", mid), ("strong", strong)];
    let only: String = get("SPIDER_R_PLAYERS", String::new());
    let chosen = |name: &str| only.is_empty() || only.split(',').any(|p| p == name);
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
                let mut line = format!("seed {seed}");
                if chosen("human") {
                    let won = spider::human::play(&g, &spider::human::HumanConfig::for_suits(suits)).won;
                    line += &format!(" human {}", won as u8);
                }
                for (name, cfg) in all.iter().filter(|p| chosen(p.0)) {
                    let wins = (0..runs).filter(|&i| play(&g, &LineConfig { salt: salt0 + i, ..*cfg }).won).count();
                    line += &format!(" {name} {wins}/{runs}");
                }
                use std::io::Write;
                writeln!(out.lock().unwrap(), "{line}").unwrap();
            });
        }
    });
}
