//! The same positions as the AlphaZero network and the analysis's network
//! see them, for comparing how well each predicts the game's end
//! (az/vcmp.py): the line player's games (SPIDER_L_* as for azplay), each
//! decision's position with probability `sample`.
//! Usage: vcmp suits first count out.bin [sample]
//! (records of POS + ENC + 8 bytes: `spider::az::both_inputs`'s, then won,
//! suits completed and the seed as u32, with two bytes of padding before it)
use spider::az::{both_inputs, AzParams, POS};
use spider::lines::LineConfig;
use spider::vnet::ENC;
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let sample: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.25);
    let mut p = AzParams::for_suits(suits);
    p.max_moves = 5000;
    p.lines = LineConfig::from_env(suits);
    let out = Mutex::new(std::io::BufWriter::new(std::fs::File::create(&a[4]).unwrap()));
    let next = AtomicU64::new(first);
    let wins = AtomicUsize::new(0);
    std::thread::scope(|sc| {
        for _ in 0..std::thread::available_parallelism().map_or(1, |n| n.get()) {
            sc.spawn(|| loop {
                let seed = next.fetch_add(1, Ordering::Relaxed);
                if seed >= first + count {
                    break;
                }
                let (won, completed, recs) = both_inputs(&p, seed, sample);
                wins.fetch_add(won as usize, Ordering::Relaxed);
                let mut buf = Vec::new();
                for r in recs.chunks(POS + ENC + 2) {
                    buf.extend_from_slice(r);
                    buf.extend_from_slice(&[won as u8, completed]);
                    buf.extend_from_slice(&(seed as u32).to_le_bytes());
                }
                out.lock().unwrap().write_all(&buf).unwrap();
            });
        }
    });
    out.into_inner().unwrap().flush().unwrap();
    println!("{count} games, {} won", wins.load(Ordering::Relaxed));
}
