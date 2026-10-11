//! Stage-wise evaluation of the line player: a stage is the play between
//! two deals. A change to the player is judged one stage at a time, from
//! the positions a reference player's games stood in at the start of the
//! stage, by a fitted value of the position it is about to deal from (far
//! less noisy than the game's result).
//!
//!   stage dump suits first count        reference games: `seed W|L moves`
//!   stage feat suits file               features before every deal of those games
//!   stage eval suits file k [limit]     play stage k (deals left; `all`: every stage)
//!                                       with SPIDER_L_* from each game's position at
//!                                       its start; features where it is about to deal
use spider::game::{encode_moves, parse_moves, Game, Move};
use spider::lines::{play, play_until, LineConfig};
use spider::stagev::{features, FEATURES};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Play on with the rollout player until it is about to deal with `k`
/// deals left (true) or the game ends (false).
fn play_stage_pimc(g: &mut Game, cfg: &spider::pimc::PimcConfig, k: usize) -> bool {
    use spider::pimc::{apply_cand, decide, Cand};
    let mut visited = HashSet::new();
    let mut tempo = spider::lines::Tempo::default();
    let mut idle = 0;
    let start = g.move_count();
    while !g.is_won() && g.move_count() - start < 5000 {
        let obs = spider::human::mask(g);
        visited.insert(spider::lines::masked_hash(&obs));
        let before = spider::lines::progress(g);
        match decide(&obs, g.deals_remaining(), &visited, idle, &mut tempo, cfg).0 {
            None => return false,
            Some(Cand::Deal) if k > 0 && g.deals_remaining() <= k => return true,
            Some(c) => apply_cand(g, &c),
        }
        idle = if spider::lines::progress(g) == before { idle + 1 } else { 0 };
        if idle == 0 {
            tempo = spider::lines::Tempo::default();
        }
    }
    false
}

fn row(f: &[f64; 24]) -> String {
    f.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(",")
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(String::as_str).unwrap_or("");
    let suits: u8 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let cfg = LineConfig::from_env(suits);
    let out = Mutex::new(std::io::BufWriter::new(std::io::stdout()));
    if mode == "dump" {
        let first: usize = a[3].parse().unwrap();
        let count: usize = a[4].parse().unwrap();
        let next = AtomicUsize::new(first);
        std::thread::scope(|sc| {
            for _ in 0..threads {
                sc.spawn(|| loop {
                    let seed = next.fetch_add(1, Ordering::Relaxed);
                    if seed >= first + count {
                        break;
                    }
                    let r = play(&Game::new(suits, seed as u64), &cfg);
                    let mut o = out.lock().unwrap();
                    writeln!(o, "{seed} {} {}", if r.won { "W" } else { "L" }, encode_moves(r.moves)).unwrap();
                    o.flush().unwrap();
                });
            }
        });
        return;
    }
    let games: Vec<(u64, bool, Vec<Move>)> = std::io::BufReader::new(std::fs::File::open(&a[3]).expect("games file"))
        .lines()
        .map(|l| {
            let l = l.unwrap();
            let mut p = l.split(' ');
            (p.next().unwrap().parse().unwrap(), p.next().unwrap() == "W", parse_moves(p.next().unwrap_or("")).unwrap())
        })
        .collect();
    if mode == "feat" {
        let mut o = out.lock().unwrap();
        writeln!(o, "seed,k,won,{}", FEATURES.join(",")).unwrap();
        for (seed, won, moves) in &games {
            let mut g = Game::new(suits, *seed);
            for &mv in moves {
                if mv == Move::Deal {
                    writeln!(o, "{seed},{},{},{}", g.deals_remaining(), *won as u8, row(&features(&g))).unwrap();
                }
                g.apply(mv).unwrap();
            }
        }
        return;
    }
    assert!(mode == "eval" || mode == "evalp");
    let pcfg = spider::pimc::PimcConfig::from_env(suits);
    let stages: Vec<usize> = if a[4] == "all" { vec![5, 4, 3, 2, 1, 0] } else { vec![a[4].parse().unwrap()] };
    let limit: usize = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let games = &games[..games.len().min(limit)];
    writeln!(out.lock().unwrap(), "seed,k,status,{}", FEATURES.join(",")).unwrap();
    let next = AtomicUsize::new(0);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= games.len() * stages.len() {
                    break;
                }
                let (seed, _, moves) = &games[i / stages.len()];
                let k = stages[i % stages.len()];
                // The position at the start of stage k.
                let mut g = Game::new(suits, *seed);
                let mut reached = g.deals_remaining() == k;
                for &mv in moves {
                    if reached {
                        break;
                    }
                    g.apply(mv).unwrap();
                    reached = mv == Move::Deal && g.deals_remaining() == k;
                }
                if !reached {
                    continue;
                }
                let stopped = if mode == "evalp" {
                    play_stage_pimc(&mut g, &pcfg, k)
                } else {
                    play_until(&mut g, &cfg, HashSet::new(), if k > 0 { Some(k) } else { None }).1
                };
                let status = if g.is_won() {
                    "won"
                } else if stopped {
                    "deal"
                } else {
                    "dead"
                };
                let mut o = out.lock().unwrap();
                writeln!(o, "{seed},{k},{status},{}", row(&features(&g))).unwrap();
            });
        }
    });
}
