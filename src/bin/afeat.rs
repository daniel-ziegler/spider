//! What the line player would do next in each position of the analysis's
//! training data (`spider::vnet::next_kind`): a byte for each record of a
//! file written by adata.
//! Usage: afeat in.bin out.feat   (SPIDER_THREADS sets the threads, all cores by default)
use spider::vnet::{next_kind, ANALYSIS_RECORD, ENC};
use std::io::{Read, Write};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let threads = std::env::var("SPIDER_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let mut input = std::io::BufReader::new(std::fs::File::open(&a[1]).unwrap());
    let mut out = std::io::BufWriter::new(std::fs::File::create(&a[2]).unwrap());
    let mut count = [0usize; 7];
    // A piece of the file at a time, its records shared out among the threads.
    let mut buf = vec![0u8; ANALYSIS_RECORD * 100_000];
    loop {
        let mut len = 0;
        while len < buf.len() {
            match input.read(&mut buf[len..]).unwrap() {
                0 => break,
                n => len += n,
            }
        }
        let records = len / ANALYSIS_RECORD;
        if records == 0 {
            break;
        }
        let mut kinds = vec![0u8; records];
        let per = records.div_ceil(threads);
        std::thread::scope(|sc| {
            for (recs, kinds) in buf[..records * ANALYSIS_RECORD].chunks(per * ANALYSIS_RECORD).zip(kinds.chunks_mut(per)) {
                sc.spawn(move || {
                    for (r, k) in recs.chunks(ANALYSIS_RECORD).zip(kinds) {
                        *k = next_kind(&r[..ENC], r[ENC + 2]);
                    }
                });
            }
        });
        for &k in &kinds {
            count[k as usize] += 1;
        }
        out.write_all(&kinds).unwrap();
    }
    out.flush().unwrap();
    println!("{} records, by what comes next: {count:?}", count.iter().sum::<usize>());
}
