//! The value network player, games in lockstep, the network served by
//! `vnet/train.py` over stdin/stdout.
//! Usage: vplay suits first count   (SPIDER_V_CONCURRENT games at once;
//! SPIDER_V_* and SPIDER_L_* settings, see `VConfig`)
//!
//! Messages to the server (little-endian):
//!   'E' n:u32, n positions of ENC bytes: the server answers n f32 win
//!       probabilities
//!   'G' seed:u64, completed:u8, won:u8, moves:u32: a finished game
//!   'Q': all games done
use spider::vnet::{Live, Proposal, VConfig};
use std::io::{Read, Write};

fn main() -> std::io::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let suits: u8 = a[1].parse().unwrap();
    let first: u64 = a[2].parse().unwrap();
    let count: u64 = a[3].parse().unwrap();
    let concurrent: usize = std::env::var("SPIDER_V_CONCURRENT").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let cfg = VConfig::from_env(suits);
    let mut out = std::io::BufWriter::with_capacity(1 << 22, std::io::stdout().lock());
    let mut inp = std::io::stdin().lock();
    let mut next = first;
    let mut live: Vec<Live> = Vec::new();
    loop {
        while live.len() < concurrent && next < first + count {
            live.push(Live::new(suits, next));
            next += 1;
        }
        if live.is_empty() {
            break;
        }
        let chunk = live.len().div_ceil(threads);
        let props: Vec<Option<Proposal>> = std::thread::scope(|sc| {
            let hs: Vec<_> = live.chunks_mut(chunk).map(|ls| sc.spawn(|| ls.iter_mut().map(|l| l.propose(&cfg)).collect::<Vec<_>>())).collect();
            hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        let n: usize = props.iter().flatten().map(|p| p.len()).sum();
        if n > 0 {
            out.write_all(b"E")?;
            out.write_all(&(n as u32).to_le_bytes())?;
            for p in props.iter().flatten() {
                out.write_all(&p.encs)?;
            }
            out.flush()?;
        }
        let mut raw = vec![0u8; 4 * n];
        inp.read_exact(&mut raw)?;
        let vals: Vec<f32> = raw.chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        let mut at = 0;
        let mut work: Vec<(&mut Live, Option<(&Proposal, &[f32])>)> = Vec::new();
        for (l, p) in live.iter_mut().zip(&props) {
            let pv = p.as_ref().map(|p| {
                let v = &vals[at..at + p.len()];
                at += p.len();
                (p, v)
            });
            work.push((l, pv));
        }
        std::thread::scope(|sc| {
            for ws in work.chunks_mut(chunk) {
                sc.spawn(|| {
                    for (l, pv) in ws.iter_mut() {
                        if let Some((p, v)) = pv {
                            l.act(p, v, &cfg);
                        }
                    }
                });
            }
        });
        let mut i = 0;
        while i < live.len() {
            if live[i].done {
                let l = live.swap_remove(i);
                out.write_all(b"G")?;
                out.write_all(&l.seed.to_le_bytes())?;
                out.write_all(&[l.game.completed.len() as u8, l.game.is_won() as u8])?;
                out.write_all(&(l.game.move_count() as u32).to_le_bytes())?;
            } else {
                i += 1;
            }
        }
    }
    out.write_all(b"Q")?;
    out.flush()?;
    Ok(())
}
