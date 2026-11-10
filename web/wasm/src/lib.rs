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
//!     cargo build --release --lib --target wasm32-unknown-unknown
//!     cp target/wasm32-unknown-unknown/release/spider_wasm.wasm ../static/spider.wasm
//!
//! It also has the stronger player's part (`strong.rs`; `static/strong.js`
//! does its choosing over the workers): the choices in a position and what
//! one is worth in some worlds. `--bin strong` is that player whole, built
//! for the machine it runs on, for measuring it.
//!
//! The interface is plain exports over buffers in the module's memory (see
//! wasm.js): positions in lineplayer.js's layout, moves as three bytes each.

use spider::vnet::{next_kind, ENC, ROWS};

pub mod net;
pub mod player;
pub mod strong;

use player::{Config, Search, DONE, SIZE};
use strong::{Params, Strong};

struct Buffers {
    state: [u8; SIZE],
    stock: [u8; 104],
    moves: Vec<u8>,
    work: u64,
    enc: [u8; ENC],
    file: Vec<u8>,
    strong: Option<Box<Strong>>,
    search: Option<Box<Search>>,
    cand: Vec<u8>,
    worth: Vec<f32>,
}

static mut BUFFERS: Buffers = Buffers { state: [0; SIZE], stock: [0; 104], moves: Vec::new(), work: 0, enc: [0; ENC], file: Vec::new(), strong: None, search: None, cand: Vec::new(), worth: Vec::new() };

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
/// the rollout player plays, with 1 the cheap one, with 2 the analysis's. The position it ends in
/// is left in the state buffer, and with `record` the moves in the moves
/// buffer, three bytes each (from, to, count; 255 for a deal). Returns
/// whether it is won (bit 0), the suits completed (bits 1 to 4), whether it
/// stopped at a card turned with `to_show` (bit 5), and from bit 8 the
/// number of moves.
#[no_mangle]
pub extern "C" fn play_out(suits: u8, stock_len: usize, cfg: u32, record: u32, to_show: u32) -> u32 {
    let b = buffers();
    let cfg = match cfg {
        1 => [Config::fast(suits); 6],
        2 => Config::analysis(suits),
        _ => [Config::rollout(suits); 6],
    };
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
    b.strong = net::Net::new(&b.file, suits).map(|net| Box::new(Strong::new(net, suits)));
    b.file = Vec::new();
    b.strong.is_some() as u32
}

/// The network's chance of winning from the position encoded in the
/// encoding buffer.
#[no_mangle]
pub extern "C" fn win_prob() -> f64 {
    let b = buffers();
    let net = &mut b.strong.as_mut().expect("a network loaded").net;
    let next = next_kind(&b.enc, net.suits);
    net.win_prob(&b.enc, next)
}

/// The stronger player's choices (`strong.rs`: `candidates`) in the position
/// in the state buffer with the stock's `stock_len` cards, for the game of
/// the network loaded: the line player's own first, with `deal` what it
/// would play about to deal, and the best `most` lines turning a card,
/// `per_col` at most of one column. They are left in the moves buffer one
/// after the other, each its number of moves in two bytes (the low first)
/// and then its moves, three bytes each. Returns how many bytes that is.
#[no_mangle]
pub extern "C" fn strong_candidates(stock_len: usize, most: usize, per_col: usize, deal: u32) -> usize {
    let b = buffers();
    let strong = b.strong.as_mut().expect("a network loaded");
    let p = Params { most, per_col, deal: deal != 0, ..Params::standard(strong.suits) };
    b.moves.clear();
    for cand in strong.candidates(&b.state, &b.stock[..stock_len], &p) {
        let n = cand.len() / 3;
        b.moves.extend([n as u8, (n >> 8) as u8]);
        b.moves.extend(cand);
    }
    b.moves.len()
}

/// Room for a choice's moves, `len` bytes.
#[no_mangle]
pub extern "C" fn cand_ptr(len: usize) -> *mut u8 {
    let b = buffers();
    b.cand = vec![0; len];
    b.cand.as_mut_ptr()
}

/// What the moves in the choice buffer are worth from the position in the
/// state buffer (`strong.rs`: `worth`) in the worlds from..to of `seed`, the
/// games stopped after `stop` moves that show cards (0: played to the end):
/// a pointer to a 32-bit float for each world.
#[no_mangle]
pub extern "C" fn strong_worth(stock_len: usize, seed: u32, from: usize, to: usize, stop: usize) -> *const f32 {
    let b = buffers();
    let strong = b.strong.as_mut().expect("a network loaded");
    b.worth.clear();
    strong.worth(&b.state, &b.stock[..stock_len], &b.cand, seed, from, to, stop, &mut b.worth);
    b.worth.as_ptr()
}

const _: () = assert!(ROWS == net::ROWS);
