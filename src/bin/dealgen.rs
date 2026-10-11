//! Other arrangements to deal from, played on in the same worlds (see
//! `spider::contrast`).
//! Usage: dealgen suits games.txt first limit stages top random pool worlds
//! (games.txt from `stage dump`; stages like 5,3,1: deals left before the
//! deal; SPIDER_V_MODEL the fitted value). A line per arrangement:
//! seed,k,index,gain,values (one per world, `;` apart),features (`;`),encoding (hex)
use spider::game::{parse_moves, Game, Move};
use spider::human::mask;
use spider::lines::LineConfig;
use spider::contrast::{arrangements, outcomes};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let first: usize = a[3].parse().unwrap();
    let limit: usize = a[4].parse().unwrap();
    let stages: Vec<usize> = a[5].split(',').map(|s| s.parse().unwrap()).collect();
    let [top, random, pool, worlds]: [usize; 4] = std::array::from_fn(|i| a[6 + i].parse().unwrap());
    let cfg = LineConfig::from_env(suits);
    let games: Vec<(u64, Vec<Move>)> = std::io::BufReader::new(std::fs::File::open(&a[2]).expect("games file"))
        .lines()
        .skip(first)
        .take(limit)
        .map(|l| {
            let l = l.unwrap();
            let mut p = l.split(' ');
            (p.next().unwrap().parse().unwrap(), parse_moves(p.nth(1).unwrap_or("")).unwrap())
        })
        .collect();
    let out = Mutex::new(std::io::BufWriter::new(std::io::stdout()));
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= games.len() * stages.len() {
                    break;
                }
                let (seed, moves) = &games[i / stages.len()];
                let k = stages[i % stages.len()];
                let mut g = Game::new(suits, *seed);
                let mut reached = false;
                for &mv in moves {
                    if mv == Move::Deal && g.deals_remaining() == k {
                        reached = true;
                        break;
                    }
                    g.apply(mv).unwrap();
                }
                if !reached {
                    continue;
                }
                let arrs = arrangements(&mask(&g), k, &cfg, top, random, pool, *seed ^ (k as u64) << 40);
                let res = outcomes(&g, &arrs, worlds, &cfg, seed.wrapping_mul(0x9E37_79B9).wrapping_add(k as u64 * 1000));
                let mut o = out.lock().unwrap();
                for (j, (arr, (vals, feats))) in arrs.iter().zip(&res).enumerate() {
                    let join = |x: &[f64]| x.iter().map(|v| format!("{v:.5}")).collect::<Vec<_>>().join(";");
                    let hex: String = arr.enc.iter().map(|b| format!("{b:02x}")).collect();
                    writeln!(o, "{seed},{k},{j},{},{},{},{hex}", arr.gain, join(vals), join(feats)).unwrap();
                }
                o.flush().unwrap();
            });
        }
    });
}
