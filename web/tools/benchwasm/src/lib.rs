//! The WebAssembly loop of the analysis benchmark (`static/bench.html`): one
//! of the network's linear layers (as `linear` in `static/vnet.js`, without
//! its unrolling), the same as a JavaScript loop of the page's, to see whether WebAssembly
//! stays fast where JavaScript is interpreted (Chrome's optimizer off, as
//! under Android's Advanced Protection). Built into `static/bench.wasm`:
//!
//!     cargo build --release --target wasm32-unknown-unknown
//!     cp target/wasm32-unknown-unknown/release/benchwasm.wasm ../../static/bench.wasm
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const T: usize = 321;
const FROM: usize = 80;
const TO: usize = 240;
static mut X: [f32; T * FROM] = [0.0; T * FROM];
static mut W: [f32; TO * FROM] = [0.0; TO * FROM];
static mut Y: [f32; T * TO] = [0.0; T * TO];

/// A position's tokens through the network's first linear layer (80 to 240
/// for 321 tokens), `reps` times; returns a sum of the outputs.
#[no_mangle]
pub extern "C" fn linear(reps: i32) -> f32 {
    // SAFETY: WebAssembly here is one thread, and nothing else holds these.
    let (x, w, y) = unsafe { (&mut *core::ptr::addr_of_mut!(X), &mut *core::ptr::addr_of_mut!(W), &mut *core::ptr::addr_of_mut!(Y)) };
    for (i, v) in x.iter_mut().enumerate() {
        *v = (i % 17) as f32 * 0.01;
    }
    for (i, v) in w.iter_mut().enumerate() {
        *v = (i % 13) as f32 * 0.02 - 0.1;
    }
    let mut total = 0.0;
    for _ in 0..reps {
        for t in 0..T {
            let xi = &x[t * FROM..(t + 1) * FROM];
            for o in 0..TO {
                let wo = &w[o * FROM..(o + 1) * FROM];
                let mut s = 0.0;
                for k in 0..FROM {
                    s += wo[k] * xi[k];
                }
                y[t * TO + o] = s;
            }
        }
        total += y[reps as usize % (T * TO)];
    }
    total
}
