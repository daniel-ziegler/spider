//! Scratch experiments on unwinnable positions.
//!   lab gen suits first count          checkpoints of line-player games: "suits seed left won moves"
//!   lab stage budget < checkpoints     size of the space reachable without dealing
//!   lab solve budget < checkpoints     the solver's verdict
use spider::game::{encode_moves, parse_moves, Game, Move};
use spider::lines::{play_until, LineConfig};
use spider::solver::{Solver, Verdict};
use std::collections::HashSet;
use std::io::BufRead;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a[1].as_str() {
        "gen" => {
            let suits: u8 = a[2].parse().unwrap();
            let first: u64 = a[3].parse().unwrap();
            let count: u64 = a[4].parse().unwrap();
            let cfg = LineConfig::from_env(suits);
            for seed in first..first + count {
                let mut g = Game::new(suits, seed);
                let mut rows = Vec::new();
                for left in (1..=5usize).rev() {
                    let (_, stopped) = play_until(&mut g, &cfg, HashSet::new(), Some(left));
                    if !stopped {
                        break;
                    }
                    rows.push((left as i32, encode_moves(g.history().iter().map(|r| r.mv))));
                    g.apply(Move::Deal).expect("deal");
                    if left == 1 {
                        rows.push((0, encode_moves(g.history().iter().map(|r| r.mv))));
                    }
                }
                if !g.is_won() {
                    play_until(&mut g, &cfg, HashSet::new(), None);
                }
                rows.push((if g.is_won() { -2 } else { -1 }, encode_moves(g.history().iter().map(|r| r.mv))));
                for (left, moves) in rows {
                    println!("{suits} {seed} {left} {} {moves}", g.is_won() as u8);
                }
            }
        }
        mode => {
            let budget: u64 = a[2].parse().unwrap();
            for line in std::io::stdin().lock().lines() {
                let line = line.unwrap();
                let f: Vec<&str> = line.split(' ').collect();
                if mode == "cert" {
                    // Along the game every `step` moves: the solver's verdict, and under it whether
                    // the first-event certificate fires (D), does not (.), or does not apply (e).
                    let step: usize = a[3].parse().unwrap();
                    let moves = parse_moves(f[4]).unwrap();
                    let mut g = Game::new(f[0].parse().unwrap(), f[1].parse().unwrap());
                    let (mut out, mut cert) = (String::new(), String::new());
                    let mut t = std::time::Duration::ZERO;
                    let mut t2 = std::time::Duration::ZERO;
                    for (i, mv) in moves.iter().chain(std::iter::once(&Move::Deal)).enumerate() {
                        if i % step == 0 || i == moves.len() {
                            let r = Solver::new(&g, budget).solve(&g);
                            out.push(match r.verdict {
                                Verdict::Solvable => 'W',
                                Verdict::Unsolvable => 'L',
                                Verdict::Unknown => '?',
                            });
                            let t0 = std::time::Instant::now();
                            let dead = spider::certify::first_event_certificate(&g);
                            t += t0.elapsed();
                            let t0 = std::time::Instant::now();
                            let dead2 = spider::certify::top_rank_certificate(&g);
                            t2 += t0.elapsed();
                            cert.push(match (dead, dead2) {
                                (true, true) => 'X',
                                (true, false) => 'D',
                                (false, true) => 'T',
                                _ if g.columns.iter().any(|c| c.is_empty()) => 'e',
                                _ => '.',
                            });
                            if (dead || dead2) && r.verdict == Verdict::Solvable {
                                println!("UNSOUND {} {} after {i} moves", f[0], f[1]);
                            }
                        }
                        if i == moves.len() {
                            break;
                        }
                        if *mv == Move::Deal {
                            out.push('|');
                            cert.push('|');
                        }
                        g.apply(*mv).unwrap();
                    }
                    println!("{} {} left {} won {} : {out}\n{} {} cert {}+{} ms    : {cert}", f[0], f[1], f[2], f[3], f[0], f[1], t.as_millis(), t2.as_millis());
                    continue;
                }
                if mode == "sound" {
                    // Every position of the game where the top-rank certificate applies: how many,
                    // how many it calls lost, and (the game being one that was won) any such is a bug.
                    let moves = parse_moves(f[4]).unwrap();
                    let mut g = Game::new(f[0].parse().unwrap(), f[1].parse().unwrap());
                    let (mut applies, mut fires, mut first) = (0, 0, None);
                    for (i, mv) in moves.iter().chain(std::iter::once(&Move::Deal)).enumerate() {
                        if g.stock.is_empty() && g.columns.iter().all(|c| !c.is_empty()) {
                            applies += 1;
                            if spider::certify::top_rank_certificate(&g) {
                                fires += 1;
                                first.get_or_insert(i);
                                if f[3] == "1" {
                                    println!("UNSOUND {} {} after {i} moves: {}", f[0], f[1], g.to_position_text());
                                }
                            }
                        }
                        if i < moves.len() {
                            g.apply(*mv).unwrap();
                        }
                    }
                    let last_deal = moves.iter().rposition(|m| *m == Move::Deal).map_or(0, |i| i + 1);
                    println!("{} {} won {} : moves {} last deal at {last_deal} applies {applies} fires {fires} first {}", f[0], f[1], f[3], moves.len(), first.map_or(-1, |i| i as i64));
                    continue;
                }
                if mode == "trace" || mode == "ptrace" {
                    // The verdict every `step` moves along the game, with the deals left
                    // (ptrace: of the portfolio of four).
                    let step: usize = a[3].parse().unwrap();
                    let moves = parse_moves(f[4]).unwrap();
                    let mut g = Game::new(f[0].parse().unwrap(), f[1].parse().unwrap());
                    let mut out = String::new();
                    for (i, mv) in moves.iter().enumerate() {
                        if i % step == 0 {
                            let r = if mode == "ptrace" {
                                spider::solver::solve_portfolio(&g, budget, spider::solver::Config::portfolio(4))
                            } else {
                                Solver::new(&g, budget).solve(&g)
                            };
                            out.push(match r.verdict {
                                Verdict::Solvable => 'W',
                                Verdict::Unsolvable => 'L',
                                Verdict::Unknown => '?',
                            });
                        }
                        if *mv == Move::Deal {
                            out.push('|');
                        }
                        g.apply(*mv).unwrap();
                    }
                    println!("{} {} left {} won {} : {out}", f[0], f[1], f[2], f[3]);
                    continue;
                }
                let mut g = Game::new(f[0].parse().unwrap(), f[1].parse().unwrap());
                for mv in parse_moves(f[4]).unwrap() {
                    g.apply(mv).unwrap();
                }
                if mode == "cert1" {
                    println!("{} {} left {}: {} {}", f[0], f[1], f[2], spider::certify::first_event_certificate(&g), spider::certify::top_rank_certificate(&g));
                    continue;
                }
                if mode == "show" {
                    println!("{} {} left {}: {}", f[0], f[1], f[2], g.to_position_text());
                    continue;
                }
                if mode == "stage" {
                    g.stock.clear();
                }
                let r = Solver::new(&g, budget).solve(&g);
                let v = match r.verdict {
                    Verdict::Solvable => 'W',
                    Verdict::Unsolvable => 'L',
                    Verdict::Unknown => '?',
                };
                let hidden: usize = g.face_down.iter().sum();
                let empty = g.columns.iter().filter(|c| c.is_empty()).count();
                println!("{} {} left {} won {} : {v} work {} classes {} hidden {hidden} empty {empty} done {}", f[0], f[1], f[2], f[3], r.nodes, r.classes, g.completed.len());
            }
        }
    }
}
