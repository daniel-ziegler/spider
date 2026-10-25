//! Self-play, evaluation and imitation games for the AlphaZero trainer
//! (`az/train.py`), talking over stdin/stdout.
//!
//! Usage: azplay selfplay|eval|imitate suits first count
//! Settings from the environment: AZ_CONCURRENT (games in lockstep),
//! AZ_SIMS, AZ_CPUCT, AZ_ALPHA, AZ_EPS, AZ_TEMP_MOVES, AZ_MAX_MOVES,
//! AZ_MAX_DEPTH, AZ_MAX_LINES, AZ_DEAL_SAMPLES, AZ_THREADS, AZ_SEED;
//! AZ_TREE_BEAM, AZ_TREE_STEPS (the line search below a search's root),
//! AZ_REPLAN (steps of the chosen line played before searching again),
//! AZ_ANCHOR=1 with AZ_MARGIN and AZ_ANCHOR_PRIOR (the line player's move
//! unless the search's is worth more by the margin), AZ_H=0 (no lookahead
//! values in the records), AZ_IMIT_SAMPLE and AZ_IMIT_SOFT (imitation: the
//! share of decisions recorded, the soft share of the policy target);
//! SPIDER_L_* for the line search (and the line player imitated);
//! AZ_IMIT_TAU for the softness of imitation's policy targets.
//!
//! Messages to the trainer (little-endian):
//!   'E' n:u32, n positions of POS bytes: evaluate these; the trainer
//!       answers with n (value logit, policy logit) f32 pairs
//!   'R' k:u32, z:f32, h:f32, played:u32, h_next:f32, q:f32, q_next:f32,
//!       (k + 1) * POS bytes, k f32: a training record (outcome, line
//!       player's lookahead value, move played, next position's lookahead
//!       value, search value and the next position's (NaN without search),
//!       position, afterstates of its k moves, visit distribution)
//!   'G' seed:u64, completed:u8, won:u8, decisions:u32, overrides:u32: a
//!       finished game (overrides: decisions where the anchored search
//!       overruled the line player; in imitation, decisions whose move was
//!       not among those offered)
//!   'Q': all games done
use spider::az::{imitate, AzParams, Driver, Eval, GameResult, Record, C, G, POS};
use spider::lines::LineConfig;
use std::io::{Read, Write};

fn env<T: std::str::FromStr>(name: &str, d: T) -> T {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn send_game(out: &mut impl Write, r: &GameResult, recs: &[Record]) -> std::io::Result<()> {
    for rec in recs {
        out.write_all(b"R")?;
        out.write_all(&(rec.pi.len() as u32).to_le_bytes())?;
        out.write_all(&rec.z.to_le_bytes())?;
        out.write_all(&rec.h.to_le_bytes())?;
        out.write_all(&rec.played.to_le_bytes())?;
        out.write_all(&rec.h_next.to_le_bytes())?;
        out.write_all(&rec.q.to_le_bytes())?;
        out.write_all(&rec.q_next.to_le_bytes())?;
        out.write_all(&rec.features)?;
        for x in &rec.pi {
            out.write_all(&x.to_le_bytes())?;
        }
    }
    out.write_all(b"G")?;
    out.write_all(&r.seed.to_le_bytes())?;
    out.write_all(&[r.completed, r.won as u8])?;
    out.write_all(&(r.decisions as u32).to_le_bytes())?;
    out.write_all(&r.overrides.to_le_bytes())?;
    Ok(())
}

fn main() -> std::io::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(String::as_str).unwrap_or("selfplay");
    let suits: u8 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(4);
    let first: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(100);
    let threads: usize = env("AZ_THREADS", std::thread::available_parallelism().map_or(1, |n| n.get()));
    let mut out = std::io::BufWriter::with_capacity(1 << 20, std::io::stdout().lock());
    let mut inp = std::io::stdin();
    eprintln!("azplay {mode}: suits {suits} seeds {first}..{} features C={C} G={G}", first + count);

    let mut p = AzParams::for_suits(suits);
    p.sims = env("AZ_SIMS", p.sims);
    p.c_puct = env("AZ_CPUCT", p.c_puct);
    p.alpha = env("AZ_ALPHA", p.alpha);
    p.eps = env("AZ_EPS", p.eps);
    p.temp_moves = env("AZ_TEMP_MOVES", p.temp_moves);
    p.max_moves = env("AZ_MAX_MOVES", p.max_moves);
    p.max_depth = env("AZ_MAX_DEPTH", p.max_depth);
    p.max_lines = env("AZ_MAX_LINES", p.max_lines);
    p.deal_samples = env("AZ_DEAL_SAMPLES", p.deal_samples);
    p.seed = env("AZ_SEED", p.seed);
    p.lines = LineConfig::from_env(suits);
    p.tree = LineConfig { beam: env("AZ_TREE_BEAM", p.lines.beam), max_steps: env("AZ_TREE_STEPS", p.lines.max_steps), replan: 0, ..p.lines };
    p.replan = env("AZ_REPLAN", 0);
    p.anchor = env("AZ_ANCHOR", 0) != 0;
    p.margin = env("AZ_MARGIN", 0.0);
    p.anchor_prior = env("AZ_ANCHOR_PRIOR", p.anchor_prior);
    p.imit_sample = env("AZ_IMIT_SAMPLE", 1.0);
    p.imit_soft = env("AZ_IMIT_SOFT", 0.5);
    p.use_h = env("AZ_H", 1) != 0;

    if mode == "imitate" {
        let tau: f32 = env("AZ_IMIT_TAU", 10.0);
        let next = std::sync::atomic::AtomicU64::new(first);
        // Games are written as they finish (a long run's would not fit in
        // memory).
        let (tx, rx) = std::sync::mpsc::sync_channel(64);
        std::thread::scope(|sc| -> std::io::Result<()> {
            for _ in 0..threads {
                let tx = tx.clone();
                let (next, p) = (&next, &p);
                sc.spawn(move || loop {
                    let seed = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if seed >= first + count || tx.send(imitate(p, seed, tau)).is_err() {
                        break;
                    }
                });
            }
            drop(tx);
            for (r, recs) in rx {
                send_game(&mut out, &r, &recs)?;
            }
            Ok(())
        })?;
        out.write_all(b"Q")?;
        out.flush()?;
        return Ok(());
    }

    let concurrent: usize = env("AZ_CONCURRENT", 256);
    if mode == "heuristic" {
        let mut d = Driver::new(p, concurrent, first, count, false);
        // No network: the line player's evaluation as value and prior.
        let (a, b, tau): (f32, f32, f32) = (env("AZ_HA", 0.0776), env("AZ_HB", 0.2782), env("AZ_HTAU", 20.0));
        let (mut games, mut suits_done, mut wins) = (0, 0usize, 0);
        while !d.done() {
            d.requests(threads);
            let ev = d.heuristic_evals(a, b, tau);
            d.feed(&ev);
            for (r, _) in d.finished.drain(..) {
                games += 1;
                suits_done += r.completed as usize;
                wins += r.won as usize;
            }
        }
        for (r, _) in d.finished.drain(..) {
            games += 1;
            suits_done += r.completed as usize;
            wins += r.won as usize;
        }
        println!("heuristic: games {games} wins {wins} suits/game {:.2}", suits_done as f64 / games.max(1) as f64);
        return Ok(());
    }
    // Two halves of the games take turns: one searches while the network
    // evaluates the other's batch. A reader thread takes the answers, so
    // the trainer never blocks writing one.
    let train = mode == "selfplay";
    let half = count / 2;
    let mut drivers = [Driver::new(p, concurrent.div_ceil(2), first, half, train), Driver::new(p, concurrent / 2, first + half, count - half, train)];
    let (ntx, nrx) = std::sync::mpsc::channel::<usize>();
    let (etx, erx) = std::sync::mpsc::channel::<std::io::Result<Vec<Eval>>>();
    std::thread::spawn(move || {
        for n in nrx {
            let mut buf = vec![0u8; n * 8];
            let r = inp.read_exact(&mut buf).map(|_| {
                buf.chunks_exact(8)
                    .map(|c| Eval { v: f32::from_le_bytes(c[..4].try_into().unwrap()), p: f32::from_le_bytes(c[4..].try_into().unwrap()) })
                    .collect()
            });
            if etx.send(r).is_err() {
                break;
            }
        }
    });
    let profile = std::env::var_os("AZ_PROFILE").is_some();
    let (t_search, mut t_wait, mut rounds, rows) = (std::cell::Cell::new(0.0), 0.0, 0u64, std::cell::Cell::new(0usize));
    let mut inflight = std::collections::VecDeque::new();
    // Search one half until it has a batch out (or is done).
    let submit = |d: &mut Driver, out: &mut std::io::BufWriter<_>| -> std::io::Result<bool> {
        while !d.done() {
            let t0 = std::time::Instant::now();
            let req = d.requests(threads);
            t_search.set(t_search.get() + t0.elapsed().as_secs_f64());
            for (r, recs) in d.finished.drain(..) {
                send_game(out, &r, &recs)?;
            }
            let n = req.len() / POS;
            if n > 0 {
                out.write_all(b"E")?;
                out.write_all(&(n as u32).to_le_bytes())?;
                out.write_all(&req)?;
                out.flush()?;
                ntx.send(n).expect("reader alive");
                rows.set(rows.get() + n);
                return Ok(true);
            }
        }
        for (r, recs) in d.finished.drain(..) {
            send_game(out, &r, &recs)?;
        }
        Ok(false)
    };
    for (i, d) in drivers.iter_mut().enumerate() {
        if submit(d, &mut out)? {
            inflight.push_back(i);
        }
    }
    while let Some(i) = inflight.pop_front() {
        let t1 = std::time::Instant::now();
        let evals = erx.recv().expect("reader alive")?;
        t_wait += t1.elapsed().as_secs_f64();
        rounds += 1;
        if profile && rounds % 200 == 0 {
            eprintln!("azplay: {rounds} rounds, {:.0} rows/round, search {:.1}s, waiting {t_wait:.1}s", rows.get() as f64 / rounds as f64, t_search.get());
        }
        drivers[i].feed(&evals);
        if submit(&mut drivers[i], &mut out)? {
            inflight.push_back(i);
        }
    }
    out.write_all(b"Q")?;
    out.flush()?;
    Ok(())
}
