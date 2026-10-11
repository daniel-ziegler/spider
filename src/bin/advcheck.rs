//! Check the CPU network against `adv.py export --check`: lines of an
//! encoding (hex) and the value expected, on stdin. Usage: advcheck net.bin
use spider::advnet::AdvNet;
use std::io::BufRead;

fn main() {
    let net = AdvNet::load(&std::env::args().nth(1).unwrap());
    let (mut worst, mut n) = (0f32, 0);
    let t0 = std::time::Instant::now();
    for l in std::io::stdin().lock().lines() {
        let l = l.unwrap();
        let (hex, want) = l.split_once(' ').unwrap();
        let enc: Vec<u8> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        worst = worst.max((net.value(&enc) - want.parse::<f32>().unwrap()).abs());
        n += 1;
    }
    println!("{n} positions, largest difference {worst:.5}, {:.2} ms each", t0.elapsed().as_secs_f64() * 1000.0 / n as f64);
}
