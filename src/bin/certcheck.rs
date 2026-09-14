//! Evaluate the dead-position certificate on dumped positions.
//! Usage: certcheck <file> [suits]   (lines: tag work position)
use spider::certify::stuck_certificate;
use spider::game::Game;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&a[1]).expect("read");
    let suits: u8 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let mut fired = std::collections::HashMap::<String, (u64, u64, u64)>::new();
    for line in text.lines() {
        let mut it = line.splitn(3, ' ');
        let tag = it.next().unwrap().to_string();
        let work: u64 = it.next().unwrap().parse().unwrap();
        let g = Game::from_position_text(suits, it.next().unwrap()).expect("parse");
        let cols: Vec<&[u8]> = g.columns.iter().map(|c| unsafe { std::slice::from_raw_parts(c.as_ptr() as *const u8, c.len()) }).collect();
        let f = stuck_certificate(&cols);
        let bucket = if work < 100 { "<100" } else if work < 1000 { "<1K" } else if work < 10000 { "<10K" } else if work < 100000 { "<100K" } else { ">=100K" };
        let e = fired.entry(format!("{tag} {bucket}")).or_default();
        e.0 += 1;
        if f {
            e.1 += 1;
            e.2 += work;
        }
    }
    let mut v: Vec<_> = fired.into_iter().collect();
    v.sort();
    for (tag, (n, f, w)) in v {
        println!("{tag}: {f}/{n} certified, work covered {w}");
    }
}
