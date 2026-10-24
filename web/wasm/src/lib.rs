//! The web analysis's two costly parts in WebAssembly, for its workers
//! (`static/wasm.js` loads this as `static/spider.wasm`): the line player
//! playing a game on (`playOut` in `static/lineplayer.js`, here by the
//! line player of `src/lines.rs` itself, which the JavaScript is a port of)
//! and the network's forward pass (`Net` in `static/vnet.js`, ported here).
//! Both give what the JavaScript gives: `web/test/wasm.mjs` compares them.
//! Where JavaScript runs interpreted (Chrome with its optimizer off, as under
//! Android's Advanced Protection) this is some ten times as fast, and four
//! times where it does not.
//!
//! Built with
//!
//!     cargo build --release --target wasm32-unknown-unknown
//!     cp target/wasm32-unknown-unknown/release/spider_wasm.wasm ../static/spider.wasm
//!
//! The interface is plain exports over buffers in the module's memory (see
//! wasm.js): positions in lineplayer.js's layout, moves as three bytes each.

use spider::game::{Card, Game, Move, NUM_COLS};
use spider::human::mask;
use spider::lines::{decide, progress, Decision, LineConfig, Tempo};
use spider::vnet::{next_kind, ENC, ROWS};
use std::collections::HashSet;

mod net;

/// lineplayer.js's position: MAXC cards for each column, then the columns'
/// lengths, their face-down counts, and the suits completed.
const MAXC: usize = 48;
const LEN: usize = NUM_COLS * MAXC;
const DOWN: usize = LEN + NUM_COLS;
const DONE: usize = DOWN + NUM_COLS;
const SIZE: usize = DONE + 1;

struct Buffers {
    state: [u8; SIZE],
    stock: [u8; 104],
    moves: Vec<u8>,
    work: u64,
    enc: [u8; ENC],
    file: Vec<u8>,
    net: Option<net::Net>,
}

static mut BUFFERS: Buffers = Buffers { state: [0; SIZE], stock: [0; 104], moves: Vec::new(), work: 0, enc: [0; ENC], file: Vec::new(), net: None };

fn buffers() -> &'static mut Buffers {
    // SAFETY: WebAssembly here runs on one thread, and each export takes
    // this once and lets it go before it returns.
    unsafe { &mut *std::ptr::addr_of_mut!(BUFFERS) }
}

#[no_mangle]
pub extern "C" fn state_ptr() -> *mut u8 {
    buffers().state.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn stock_ptr() -> *mut u8 {
    buffers().stock.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn moves_ptr() -> *const u8 {
    buffers().moves.as_ptr()
}

#[no_mangle]
pub extern "C" fn enc_ptr() -> *mut u8 {
    buffers().enc.as_mut_ptr()
}

/// The positions the last play_out examined.
#[no_mangle]
pub extern "C" fn work() -> f64 {
    buffers().work as f64
}

/// The game in the state buffer, with the first `stock_len` cards of the
/// stock buffer (dealt from the end), as lines.rs plays it. The state says
/// only how many suits are completed, but the player counts the cards it has
/// not seen by which: a suit is completed as often as its kings are missing.
fn game(b: &Buffers, suits: u8, stock_len: usize) -> Game {
    let mut g = Game::new(suits, 0);
    for c in 0..NUM_COLS {
        g.columns[c] = b.state[c * MAXC..c * MAXC + b.state[LEN + c] as usize].iter().map(|&x| Card(x)).collect();
        g.face_down[c] = b.state[DOWN + c] as usize;
    }
    g.stock = b.stock[..stock_len].iter().map(|&x| Card(x)).collect();
    let mut kings = [0usize; 4];
    for card in g.columns.iter().flatten().chain(&g.stock) {
        if card.rank() == 12 {
            kings[card.suit() as usize] += 1;
        }
    }
    let mut runs = [0usize; 4]; // (each suit's in the deck, as lines.rs's unseen_counts has them)
    for set in 0..8 {
        runs[set % suits as usize] += 1;
    }
    g.completed = (0..4u8).flat_map(|suit| std::iter::repeat_n(suit, runs[suit as usize].saturating_sub(kings[suit as usize]))).collect();
    debug_assert_eq!(g.completed.len(), b.state[DONE] as usize);
    g
}

/// Play the game in the buffers on, as playOut in lineplayer.js does (which
/// see): until it is won, the player gives up or 5000 moves are played; a
/// deal onto a column of MAXC cards ends it (undealt); with `to_show` it
/// stops right after the first move that turns a card or deals. With `cfg` 0
/// the rollout player plays, with 1 the cheap one. The position it ends in
/// is left in the state buffer, and with `record` the moves in the moves
/// buffer, three bytes each (from, to, count; 255 for a deal). Returns
/// whether it is won (bit 0), the suits completed (bits 1 to 4), whether it
/// stopped at a card turned with `to_show` (bit 5), and from bit 8 the
/// number of moves.
#[no_mangle]
pub extern "C" fn play_out(suits: u8, stock_len: usize, cfg: u32, record: u32, to_show: u32) -> u32 {
    let b = buffers();
    let mut g = game(b, suits, stock_len);
    let cfg = if cfg == 1 { LineConfig::fast(suits) } else { LineConfig::rollout(suits) };
    b.moves.clear();
    let (record, to_show) = (record != 0, to_show != 0);
    let mut tempo = Tempo::default();
    let mut visited = HashSet::new();
    let (mut played, mut work, mut turned) = (0, 0u64, false);
    'game: while !g.is_won() && played < 5000 {
        let obs = mask(&g);
        visited.insert(spider::lines::masked_hash(&obs));
        let before = progress(&g);
        let (d, w) = decide(&obs, g.deals_remaining(), &visited, &mut tempo, &cfg);
        work += w as u64;
        match d {
            Decision::Stuck => break,
            Decision::Deal => {
                played += 1;
                if record {
                    b.moves.extend([255, 255, 255]);
                }
                if g.columns.iter().any(|c| c.len() >= MAXC) {
                    break; // a column too long for the search ends the game
                }
                g.apply(Move::Deal).expect("a deal is legal");
            }
            Decision::Play(line) => {
                played += line.len();
                for mv in line {
                    let Move::Move { from, to, count } = mv else { unreachable!("a line is of moves") };
                    let down: usize = g.face_down.iter().sum(); // (a suit completed can turn a card too, where it was)
                    g.apply(mv).expect("a planned move is legal");
                    if record {
                        b.moves.extend([from as u8, to as u8, count as u8]);
                    }
                    if to_show && g.face_down.iter().sum::<usize>() < down {
                        turned = true; // (a step may go on after its card turns: the rest is left out)
                        break 'game;
                    }
                }
            }
        }
        let after = progress(&g);
        if after != before {
            tempo = Tempo::default();
            if to_show && (after.0, after.1) != (before.0, before.1) {
                break;
            }
        }
    }
    for c in 0..NUM_COLS {
        let col = &g.columns[c];
        for (i, card) in col.iter().enumerate() {
            b.state[c * MAXC + i] = card.0;
        }
        b.state[LEN + c] = col.len() as u8;
        b.state[DOWN + c] = g.face_down[c] as u8;
    }
    b.state[DONE] = g.completed.len() as u8;
    b.work = work;
    g.is_won() as u32 | (g.completed.len() as u32) << 1 | (turned as u32) << 5 | ((b.moves.len() / 3) as u32) << 8
}

/// Room for the network's file (export.py's), `len` bytes.
#[no_mangle]
pub extern "C" fn file_ptr(len: usize) -> *mut u8 {
    let b = buffers();
    b.file = vec![0; len];
    b.file.as_mut_ptr()
}

/// Read the network from its file, for games of this many suits: 0 if it
/// would not.
#[no_mangle]
pub extern "C" fn net_load(suits: u8) -> u32 {
    let b = buffers();
    b.net = net::Net::new(&b.file, suits);
    b.file = Vec::new();
    b.net.is_some() as u32
}

/// The network's chance of winning from the position encoded in the
/// encoding buffer.
#[no_mangle]
pub extern "C" fn win_prob() -> f64 {
    let b = buffers();
    let net = b.net.as_mut().expect("a network loaded");
    let next = next_kind(&b.enc, net.suits);
    net.win_prob(&b.enc, next)
}

const _: () = assert!(ROWS == net::ROWS);
