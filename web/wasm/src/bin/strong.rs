//! The stronger player (`strong.rs`) against the line player it is made of,
//! deal by deal, on all cores:
//!
//!     cargo run --release --bin strong -- suits first count
//!
//! prints for each deal `seed line strong turns open changed rolls values ms
//! hash gain short` (whether each won; the stronger player's choices, those of more
//! than one line and those not the line player's; games played on and
//! positions valued; its time; a hash of its moves; with `S_AUDIT=worlds`
//! what its choices gained in so many other worlds, in points, played to
//! the end and stopped: `strong::Played::gain`) and then the sums, with
//! the difference in points of win rate and its standard error. `S_MOST`,
//! `S_PER_COL`, `S_DEAL`, `S_FIRST`, `S_MAX`, `S_ZDROP`, `S_ZKEEP` and
//! `S_STOP` set `strong::Params`; `S_ROLL` the player the worlds are played
//! on with (as `play_out`'s `cfg`); `S_NET` the network's file; `S_THREADS`
//! the threads. With `S_SEEDS` (a file whose lines start with a seed, `seed
//! N ...` too, `#` comments aside) those deals are played and not a range:
//! the ones at `first..first + count` in the file, counting from 1 (to pick
//! deals the stronger player wins: it plays here what the page plays). Build
//! the page's module with `--lib`: this is not for it.
use spider::game::Game;
use spider_wasm::net::Net;
use spider_wasm::player::{Config, Search, DOWN, LEN, MAXC, NUM_COLS, SIZE};
use spider_wasm::strong::{Params, Strong};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize, d: u64| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let (suits, first, count) = (arg(1, 4) as u8, arg(2, 1), arg(3, 100));
    let d = Params::standard(suits);
    let p = Params {
        most: get("S_MOST", d.most),
        per_col: get("S_PER_COL", d.per_col),
        deal: get("S_DEAL", d.deal as u8) != 0,
        first: get("S_FIRST", d.first),
        max: get("S_MAX", d.max),
        z_drop: get("S_ZDROP", d.z_drop),
        z_keep: get("S_ZKEEP", d.z_keep),
        stop: get("S_STOP", d.stop),
    };
    let roll: i64 = get("S_ROLL", -1);
    let file = std::fs::read(get("S_NET", "../static/nets/value.bin".to_string())).expect("the network's file (S_NET)");
    let threads = get("S_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    eprintln!("{p:?} roll {roll} threads {threads}");
    // S_STUDY=file: the line player's games with every choice played out
    // (`Strong::study`), in S_WORLDS worlds, S_FIRST of them for all.
    let study = std::env::var("S_STUDY").ok().map(|name| (Mutex::new(std::fs::OpenOptions::new().create(true).append(true).open(name).expect("S_STUDY")), p.first, get("S_WORLDS", 512usize)));
    let audit: usize = get("S_AUDIT", 0);
    let listed: Option<Vec<u64>> = std::env::var("S_SEEDS").ok().map(|path| {
        let text = std::fs::read_to_string(&path).expect("S_SEEDS");
        text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.trim_start_matches("seed ").split_whitespace().next().unwrap().parse().expect("a seed")).collect()
    });
    let next = AtomicU64::new(first);
    // line won, strong won, both, turns, open, changed, rolls, values, ms, lost with nothing hidden
    let sums = Mutex::new([0u64; 10]);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| {
                let mut strong = Strong::new(Net::new(&file, suits).expect("a network"), suits);
                if roll >= 0 {
                    strong.roll_with(roll as u32);
                }
                let mut search = Search::default();
                loop {
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
                    let mut s = [0u8; SIZE];
                    for c in 0..NUM_COLS {
                        for (i, card) in g.columns[c].iter().enumerate() {
                            s[c * MAXC + i] = card.0;
                        }
                        s[LEN + c] = g.columns[c].len() as u8;
                        s[DOWN + c] = g.face_down[c] as u8;
                    }
                    let stock: Vec<u8> = g.stock.iter().map(|c| c.0).collect();
                    if let Some((file, first, worlds)) = &study {
                        let mut out = Vec::new();
                        let at = std::time::Instant::now();
                        let won = strong.study(&mut s, &stock, seed, &p, *first, *worlds, &mut out);
                        use std::io::Write;
                        file.lock().unwrap().write_all(&out).unwrap();
                        println!("{seed} {} {} {}", won as u8, out.len(), at.elapsed().as_millis());
                        continue;
                    }
                    let mut t = s;
                    search.play_out(&mut t, &stock, &Config::analysis(suits), None, false);
                    let line = t[SIZE - 1] == 8;
                    let at = std::time::Instant::now();
                    let r = strong.play_game(&mut s, &stock, seed, &p, audit);
                    let ms = at.elapsed().as_millis() as u64;
                    let hash = r.moves.iter().fold(0x811C9DC5u32, |h, &b| (h ^ b as u32).wrapping_mul(0x01000193));
                    println!("{seed} {} {} {} {} {} {} {} {ms} {hash:08x} {:.3} {:.3}", line as u8, r.won as u8, r.turns, r.open, r.changed, r.rolls, r.values, 100.0 * r.gain[0], 100.0 * r.gain[1]);
                    let mut sums = sums.lock().unwrap();
                    for (i, x) in [line as u64, r.won as u64, (line && r.won) as u64, r.turns as u64, r.open as u64, r.changed as u64, r.rolls, r.values, ms, r.lost_open as u64].into_iter().enumerate() {
                        sums[i] += x;
                    }
                }
            });
        }
    });
    let s = sums.lock().unwrap();
    let n = count as f64;
    let (gained, lost) = ((s[1] - s[2]) as f64, (s[0] - s[2]) as f64);
    let diff = (gained - lost) / n;
    let se = ((gained + lost) / n - diff * diff).max(0.0).sqrt() / n.sqrt();
    println!(
        "# suits {suits} seeds {first}+{count}: line {} ({:.2}%) strong {} ({:.2}%) diff {:+.2} ± {:.2} (gained {gained} lost {lost}); a game: {:.1} choices, {:.1} open, {:.1} changed, {:.0} rolls, {:.0} values, {:.1} s; lost with nothing hidden {}",
        s[0], 100.0 * s[0] as f64 / n, s[1], 100.0 * s[1] as f64 / n, 100.0 * diff, 100.0 * se, s[3] as f64 / n, s[4] as f64 / n, s[5] as f64 / n, s[6] as f64 / n, s[7] as f64 / n, s[8] as f64 / n / 1000.0, s[9]
    );
}
