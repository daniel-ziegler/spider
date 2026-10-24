//! The web analysis's two costly parts in WebAssembly, for its workers
//! (`static/wasm.js` loads this as `static/spider.wasm`): the line player
//! playing a game on (`playOut` in `static/lineplayer.js`, ported in
//! `player.rs`) and the network's forward pass (`Net` in `static/vnet.js`,
//! ported in `net.rs`). Both give what the JavaScript gives:
//! `web/test/wasm.mjs` compares them. The games take less than half the
//! JavaScript's time and the network some two thirds of it, and where
//! JavaScript runs interpreted (Chrome with its optimizer off, as under
//! Android's Advanced Protection) both a small fraction.
//!
//! Built with
//!
//!     cargo build --release --target wasm32-unknown-unknown
//!     cp target/wasm32-unknown-unknown/release/spider_wasm.wasm ../static/spider.wasm
//!
//! The interface is plain exports over buffers in the module's memory (see
//! wasm.js): positions in lineplayer.js's layout, moves as three bytes each.

use spider::vnet::{next_kind, ENC, ROWS};

mod player;
mod net;

use player::{Config, Search, DONE, SIZE};

struct Buffers {
    state: [u8; SIZE],
    stock: [u8; 104],
    moves: Vec<u8>,
    work: u64,
    enc: [u8; ENC],
    file: Vec<u8>,
    net: Option<net::Net>,
    search: Option<Box<Search>>,
}

static mut BUFFERS: Buffers = Buffers { state: [0; SIZE], stock: [0; 104], moves: Vec::new(), work: 0, enc: [0; ENC], file: Vec::new(), net: None, search: None };

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
    let cfg = if cfg == 1 { Config::fast(suits) } else { Config::rollout(suits) };
    b.moves.clear();
    let search = b.search.get_or_insert_with(Default::default);
    let (turned, work) = search.play_out(&mut b.state, &b.stock[..stock_len], &cfg, (record != 0).then_some(&mut b.moves), to_show != 0);
    b.work = work;
    let done = b.state[DONE] as u32;
    (done == 8) as u32 | done << 1 | (turned as u32) << 5 | ((b.moves.len() / 3) as u32) << 8
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
