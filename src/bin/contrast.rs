//! Decisions of the line player with their alternatives played on in the
//! same worlds (see `spider::contrast::contrasts`).
//! Usage: contrast suits first count worlds sample [most deals left] [least]
//! (SPIDER_V_MODEL the fitted value; SPIDER_P_* the candidates, dealing among
//! them only with SPIDER_P_STAGE=0, and the
//! player that plays on). A line per candidate:
//! seed,decision,deals left,index,deal (0/1),values (`;` apart),encoding (hex)
//! `contrast suits annotate` adds the extras to the encodings of such lines
//! written before there were any (stdin to stdout).
use spider::game::Game;
use spider::pimc::PimcConfig;
use spider::contrast::contrasts;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    if a[2] == "annotate" {
        use std::io::BufRead;
        let cfg = spider::lines::LineConfig::from_env(suits);
        let mut o = std::io::BufWriter::new(std::io::stdout());
        let mut group: Vec<(String, Vec<u8>)> = Vec::new();
        let mut key = String::new();
        let mut flush = |group: &mut Vec<(String, Vec<u8>)>| {
            if !group.is_empty() {
                let encs: Vec<Vec<u8>> = group.iter().map(|g| g.1.clone()).collect();
                for ((head, enc), x) in group.iter().zip(spider::contrast::extras_of(&encs, &cfg)) {
                    let hex: String = enc.iter().chain(&x).map(|b| format!("{b:02x}")).collect();
                    writeln!(o, "{head},{hex}").unwrap();
                }
                group.clear();
            }
        };
        for l in std::io::stdin().lock().lines() {
            let l = l.unwrap();
            let Some((head, hex)) = l.rsplit_once(',') else { continue };
            if hex.len() != 2 * spider::vnet::ENC || head.split(',').count() != 6 {
                continue;
            }
            let k: String = head.split(',').take(2).collect::<Vec<_>>().join(",");
            if k != key {
                flush(&mut group);
                key = k;
            }
            group.push((head.to_string(), (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()));
        }
        flush(&mut group);
        return;
    }
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let worlds: usize = a[4].parse().unwrap();
    let sample: f64 = a[5].parse().unwrap();
    let max_level: usize = a.get(6).and_then(|s| s.parse().ok()).unwrap_or(5);
    let min_level: usize = a.get(7).and_then(|s| s.parse().ok()).unwrap_or(0);
    let cfg = PimcConfig::from_env(suits);
    let out = Mutex::new(std::io::BufWriter::new(std::io::stdout()));
    let next = AtomicU64::new(first);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let cs = contrasts(&Game::new(suits, seed), &cfg, worlds, sample, (min_level, max_level), seed);
                let mut o = out.lock().unwrap();
                for (d, c) in cs.iter().enumerate() {
                    for (j, (deal, enc, vals)) in c.cands.iter().enumerate() {
                        let v = vals.iter().map(|v| format!("{v:.5}")).collect::<Vec<_>>().join(";");
                        let hex: String = enc.iter().map(|b| format!("{b:02x}")).collect();
                        writeln!(o, "{seed},{d},{},{j},{},{v},{hex}", c.deals_left, *deal as u8).unwrap();
                    }
                }
                o.flush().unwrap();
            });
        }
    });
}
