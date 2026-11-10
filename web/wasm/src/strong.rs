//! A stronger player made of the analysis's own: at each choice (from one
//! move that shows cards to the next) the line player's moves and a few
//! other lines are each played on by the line player in the same worlds,
//! shuffles of the cards not seen, as the analysis measures a mistake
//! (`static/analysis-worker.js`: `roll` with `stop`, the network valuing
//! where the games stop), and the one that does best is played. It sees no
//! more than the line player does: a world agrees with every card face up
//! and says nothing of where the others really are.
//!
//! The worlds are numbered and made from the deal's seed, so the game of a
//! deal is always the same one, here and in the page (`static/strong.js`
//! does the choosing there over the workers, with `candidates` and `worth`
//! from this file through `lib.rs`; `tools/analysis/strong.mjs` checks that
//! the two play the same games).

use crate::net::Net;
use crate::player::{apply_move, remove_if_complete, Config, Search, BLANK, DONE, DOWN, LEN, MAXC, NUM_COLS, SIZE};
use spider::vnet::{next_kind, ENC, ROWS};

/// How the stronger player chooses.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Lines that turn a card, besides the line player's own: the best so
    /// many by its evaluation,
    pub most: usize,
    /// of them at most so many turning the card of one column.
    pub per_col: usize,
    /// Whether the line player's moves if it were about to deal are a choice too.
    pub deal: bool,
    /// Worlds each choice is played in first, and at most: the number
    /// doubles, and a choice behind the best by `z_drop` standard errors of
    /// their difference is dropped.
    pub first: usize,
    pub max: usize,
    pub z_drop: f64,
    /// The line player's choice is kept unless the best is ahead of it by
    /// this many standard errors.
    pub z_keep: f64,
    /// Moves showing cards a game is played on for before the network
    /// values it (0: to the end, won or lost).
    pub stop: usize,
}

impl Params {
    /// strong.js's `strongParams`.
    pub fn standard(suits: u8) -> Params {
        if suits > 1 {
            Params { most: 6, per_col: 2, deal: true, first: 16, max: 64, z_drop: 2.0, z_keep: 1.0, stop: 8 }
        } else {
            Params { most: 6, per_col: 2, deal: true, first: 32, max: 128, z_drop: 2.0, z_keep: 1.0, stop: 0 }
        }
    }
}

/// mulberry32, as analysis-worker.js's `random`.
struct Rand(u32);

impl Rand {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_add(0x6D2B79F5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (((t ^ (t >> 14)) as u64 * n as u64) >> 32) as usize
    }
}

/// The seed of a choice's worlds: of the deal `seed`, the choice number `turn`.
pub fn world_seed(seed: u64, turn: usize) -> u32 {
    ((seed % 1000003) as u32).wrapping_mul(131).wrapping_add(turn as u32)
}

fn hidden(s: &[u8]) -> usize {
    s[DOWN..DOWN + NUM_COLS].iter().map(|&d| d as usize).sum()
}

/// The cards in the stock of a position that had `total` cards in play.
fn stock_left(s: &[u8]) -> usize {
    104 - 13 * s[DONE] as usize - s[LEN..LEN + NUM_COLS].iter().map(|&n| n as usize).sum::<usize>()
}

/// Play moves ((from, to, count) bytes, 255s for a deal) in a position with
/// its real cards and `left` cards in the stock: how many it then has, or
/// None if a column gets too long for the line player.
pub fn play(s: &mut [u8], stock: &[u8], mut left: usize, moves: &[u8]) -> Option<usize> {
    for mv in moves.chunks_exact(3) {
        if mv[0] == 255 {
            if left < NUM_COLS || (0..NUM_COLS).any(|c| s[LEN + c] as usize >= MAXC) {
                return None;
            }
            for c in 0..NUM_COLS {
                left -= 1;
                s[c * MAXC + s[LEN + c] as usize] = stock[left];
                s[LEN + c] += 1;
            }
            for c in 0..NUM_COLS {
                remove_if_complete(s, c, None);
            }
        } else {
            if s[LEN + mv[1] as usize] as usize + mv[2] as usize > MAXC {
                return None;
            }
            apply_move(s, mv[0] as usize, mv[1] as usize, mv[2] as usize, None);
        }
    }
    Some(left)
}

/// What the choices' worth in the worlds so far says: the best (the first
/// of equals), and of the others still in the running (`alive`) those to
/// drop. `vals[c]` has choice c's worth in each world.
fn standings(vals: &[Vec<f32>], alive: &[usize], z_drop: f64) -> (usize, Vec<usize>) {
    let mean = |c: usize| vals[c].iter().map(|&v| v as f64).sum::<f64>() / vals[c].len() as f64;
    let mut best = alive[0];
    let mut most = mean(best);
    for &c in &alive[1..] {
        let m = mean(c);
        if m > most {
            best = c;
            most = m;
        }
    }
    let dropped = alive.iter().copied().filter(|&c| c != best && { let (d, se) = ahead(&vals[best], &vals[c]); se == 0.0 || d > z_drop * se }).collect();
    (best, dropped)
}

/// The mean of a - b over the worlds, and its standard error.
fn ahead(a: &[f32], b: &[f32]) -> (f64, f64) {
    let n = a.len() as f64;
    let mean = a.iter().zip(b).map(|(&x, &y)| x as f64 - y as f64).sum::<f64>() / n;
    if a.len() < 2 {
        return (mean, 0.0);
    }
    let var = a.iter().zip(b).map(|(&x, &y)| { let d = x as f64 - y as f64 - mean; d * d }).sum::<f64>() / (n - 1.0);
    (mean, (var / n).sqrt())
}

/// Which of `n` choices (the first the line player's) to play: `worth(c,
/// from, to)` gives choice c's worth in the worlds from..to.
pub fn choose(n: usize, p: &Params, mut worth: impl FnMut(usize, usize, usize) -> Vec<f32>) -> usize {
    if n < 2 {
        return 0;
    }
    let mut vals: Vec<Vec<f32>> = vec![Vec::new(); n];
    let mut alive: Vec<usize> = (0..n).collect();
    let (mut done, mut upto) = (0, p.first.min(p.max));
    let best = loop {
        for &c in &alive {
            let more = worth(c, done, upto);
            vals[c].extend(more);
        }
        done = upto;
        let (best, dropped) = standings(&vals, &alive, p.z_drop);
        alive.retain(|c| !dropped.contains(c));
        if alive.len() == 1 || done >= p.max {
            break best;
        }
        upto = (2 * done).min(p.max);
    };
    if best != 0 && p.z_keep > 0.0 && alive.contains(&0) {
        let (d, se) = ahead(&vals[best], &vals[0]);
        if d < p.z_keep * se {
            return 0;
        }
    }
    best
}

/// A game the stronger player played.
pub struct Played {
    pub won: bool,
    /// Its moves, three bytes each (255s for a deal).
    pub moves: Vec<u8>,
    /// Choices made, those of more than one line, and those not the line player's.
    pub turns: usize,
    pub open: usize,
    pub changed: usize,
    /// Games played on (a choice in a world), and positions the network valued.
    pub rolls: u64,
    pub values: u64,
    /// Whether it was lost with nothing left hidden.
    pub lost_open: bool,
}

pub struct Strong {
    pub suits: u8,
    search: Search,
    pub net: Net,
    cfg: [Config; 6],
    /// The player that plays the worlds on.
    roll: [Config; 6],
    pub rolls: u64,
    pub values: u64,
    /// What each of the last `candidates` is: 0 the line player's moves, 1
    /// its moves about to deal, 2 on the other lines, best first.
    pub kinds: Vec<u8>,
}

impl Strong {
    pub fn new(net: Net, suits: u8) -> Strong {
        Strong { suits, search: Search::default(), net, cfg: Config::analysis(suits), roll: Config::analysis(suits), rolls: 0, values: 0, kinds: Vec::new() }
    }

    /// Play the worlds on with another of the line player's configurations
    /// (0 the rollout player, 1 the cheap one, 2 the analysis's: as `play_out` in lib.rs).
    pub fn roll_with(&mut self, kind: u32) {
        self.roll = match kind {
            1 => [Config::fast(self.suits); 6],
            2 => Config::analysis(self.suits),
            _ => [Config::rollout(self.suits); 6],
        };
    }

    /// The network's chance of winning from a position with `left` cards in the stock.
    fn value(&mut self, s: &[u8], left: usize) -> f64 {
        let mut enc = [0u8; ENC];
        for c in 0..NUM_COLS {
            let (n, d) = (s[LEN + c] as usize, s[DOWN + c] as usize);
            let start = n.saturating_sub(ROWS);
            for i in start..n {
                enc[c * ROWS + i - start] = if i < d { 1 } else { 3 + s[c * MAXC + i] };
            }
        }
        enc[NUM_COLS * ROWS] = (left / NUM_COLS) as u8;
        enc[NUM_COLS * ROWS + 1] = s[DONE];
        self.values += 1;
        let next = next_kind(&enc, self.suits);
        self.net.win_prob(&enc, next)
    }

    /// What a game is worth to the line player, played on from a position
    /// until `stop` moves have shown cards, `shown` having done so already
    /// (analysis-worker.js's `playedOn`; `stop` 0: to its end).
    fn played_on(&mut self, s: &mut [u8], stock: &[u8], mut left: usize, mut shown: usize, stop: usize) -> f64 {
        if stop == 0 {
            self.search.play_out(s, &stock[..left], &self.roll, None, false);
            return (s[DONE] == 8) as u8 as f64;
        }
        loop {
            if s[DONE] == 8 {
                return 1.0;
            }
            if shown >= stop {
                return self.value(s, left);
            }
            let down = hidden(s);
            self.search.play_out(s, &stock[..left], &self.roll, None, true);
            let now = stock_left(s);
            if now == left && hidden(s) == down {
                return (s[DONE] == 8) as u8 as f64; // nothing more came up: it is over
            }
            shown += 1;
            left = now;
        }
    }

    /// The choices in a position (its real cards in `s`, of which those face
    /// down are not looked at): the line player's moves up to the first that
    /// shows cards, first; what it would play if it were about to deal; and
    /// other lines that turn a card. Those that come to the same position
    /// are one.
    pub fn candidates(&mut self, s: &[u8], stock: &[u8], p: &Params) -> Vec<Vec<u8>> {
        let deals_left = stock.len() / NUM_COLS;
        let mut out: Vec<Vec<u8>> = Vec::new();
        let mut keys: Vec<Vec<u8>> = Vec::new();
        let mut kinds = Vec::new();
        let mut add = |moves: Vec<u8>, kind: u8, out: &mut Vec<Vec<u8>>| {
            // Where the moves lead, the card turned not known.
            let mut t = [0u8; SIZE];
            t.copy_from_slice(s);
            let mut key = Vec::with_capacity(160);
            for mv in moves.chunks_exact(3) {
                if mv[0] == 255 {
                    key.push(255);
                } else {
                    apply_move(&mut t, mv[0] as usize, mv[1] as usize, mv[2] as usize, Some(BLANK));
                }
            }
            for c in 0..NUM_COLS {
                let (n, d) = (t[LEN + c] as usize, t[DOWN + c] as usize);
                key.extend([n as u8, d as u8]);
                key.extend_from_slice(&t[c * MAXC + d..c * MAXC + n]);
            }
            key.push(t[DONE]);
            if !keys.contains(&key) {
                keys.push(key);
                out.push(moves);
                kinds.push(kind);
            }
        };
        for dealing in [false, true] {
            if dealing && !(p.deal && deals_left > 0) {
                continue;
            }
            let mut t = [0u8; SIZE];
            t.copy_from_slice(s);
            let mut moves = Vec::new();
            self.search.play_on(&mut t, stock, &self.cfg, Some(&mut moves), true, dealing);
            add(moves, dealing as u8, &mut out);
        }
        if hidden(s) > 0 && p.most > 0 {
            let mut root = [0u8; SIZE];
            root.copy_from_slice(s);
            for (r, line) in self.search.leaf_lines(&root, deals_left, &self.cfg[deals_left], p.most, p.per_col).into_iter().enumerate() {
                add(line, 2 + r as u8, &mut out);
            }
        }
        self.kinds = kinds;
        out
    }

    /// What the moves `cand` are worth from the position `s` (its real
    /// cards, and the stock's) in the worlds from..to of `seed`: in each, a
    /// shuffle of the cards face down and in the stock, the moves are played
    /// and then the line player plays on (`played_on`).
    #[allow(clippy::too_many_arguments)]
    pub fn worth(&mut self, s: &[u8], stock: &[u8], cand: &[u8], seed: u32, from: usize, to: usize, stop: usize, out: &mut Vec<f32>) {
        let mut places = Vec::new();
        for c in 0..NUM_COLS {
            for i in 0..s[DOWN + c] as usize {
                places.push(c * MAXC + i);
            }
        }
        let nd = places.len();
        let real: Vec<u8> = places.iter().map(|&k| s[k]).chain(stock.iter().copied()).collect();
        let mut t = [0u8; SIZE];
        for w in from..to {
            let mut rng = Rand(seed.wrapping_mul(0x9E3779B1) ^ (w as u32 + 1).wrapping_mul(0x85EBCA6B));
            let mut cards = real.clone();
            for i in (1..cards.len()).rev() {
                cards.swap(i, rng.below(i + 1));
            }
            t.copy_from_slice(s);
            for (k, &at) in places.iter().enumerate() {
                t[at] = cards[k];
            }
            let st = &cards[nd..];
            self.rolls += 1;
            let v = match play(&mut t, st, st.len(), cand) {
                None => 0.0,
                Some(left) => {
                    let shown = (hidden(&t) + left < real.len()) as usize;
                    self.played_on(&mut t, st, left, shown, stop)
                }
            };
            out.push(v as f32);
        }
    }

    /// The line player's game from the position `s`, stretch by stretch,
    /// with every choice there was on the way played in `worlds` worlds (one
    /// more than three standard errors behind the line player's own after
    /// `first` of them, in those only), for measuring what choosing could
    /// gain (`tools/analysis/study.py`). A record for each choice of more
    /// than one line goes to `out`: the seed (4 bytes), the choice's number
    /// (2), the deals left, the cards face down and the number of lines (1
    /// each); then for each line its kind (`kinds`), whether it ends with a
    /// deal, the number of worlds (2 bytes) and its worth in each as 16 bits.
    pub fn study(&mut self, s: &mut [u8], stock: &[u8], seed: u64, p: &Params, first: usize, worlds: usize, out: &mut Vec<u8>) -> bool {
        let mut left = stock.len();
        let mut turn = 0;
        while s[DONE] < 8 {
            let before = (hidden(s), left);
            let cands = self.candidates(s, &stock[..left], p);
            let kinds = self.kinds.clone();
            if cands.len() > 1 {
                let ws = world_seed(seed, turn);
                out.extend((seed as u32).to_le_bytes());
                out.extend((turn as u16).to_le_bytes());
                out.extend([(left / NUM_COLS) as u8, before.0 as u8, cands.len() as u8]);
                let mut base = Vec::new();
                for (c, cand) in cands.iter().enumerate() {
                    let mut v = Vec::with_capacity(worlds);
                    self.worth(s, &stock[..left], cand, ws, 0, first, p.stop, &mut v);
                    let behind = c > 0 && { let (d, se) = ahead(&base[..first], &v); d > 3.0 * se };
                    if !behind {
                        self.worth(s, &stock[..left], cand, ws, first, worlds, p.stop, &mut v);
                    }
                    out.extend([kinds[c], (cand.last() == Some(&255)) as u8]);
                    out.extend((v.len() as u16).to_le_bytes());
                    for &x in &v {
                        out.extend(((x as f64 * 65535.0).round() as u16).to_le_bytes());
                    }
                    if c == 0 {
                        base = v;
                    }
                }
            }
            turn += 1;
            let Some(now) = play(s, stock, left, &cands[0]) else { break };
            left = now;
            if (hidden(s), left) == before {
                break;
            }
        }
        s[DONE] == 8
    }

    /// Play a game from the position `s` with its stock (changing `s`).
    pub fn play_game(&mut self, s: &mut [u8], stock: &[u8], seed: u64, p: &Params) -> Played {
        let mut g = Played { won: false, moves: Vec::new(), turns: 0, open: 0, changed: 0, rolls: 0, values: 0, lost_open: false };
        let (rolls, values) = (self.rolls, self.values);
        let mut left = stock.len();
        while s[DONE] < 8 {
            let before = (hidden(s), left);
            let cands = self.candidates(s, &stock[..left], p);
            let at = if cands.len() < 2 {
                0
            } else {
                g.open += 1;
                let ws = world_seed(seed, g.turns);
                let (root, st) = (s.to_vec(), &stock[..left]);
                choose(cands.len(), p, |c, from, to| {
                    let mut out = Vec::with_capacity(to - from);
                    self.worth(&root, st, &cands[c], ws, from, to, p.stop, &mut out);
                    out
                })
            };
            g.turns += 1;
            g.changed += (at != 0) as usize;
            let Some(now) = play(s, stock, left, &cands[at]) else { break };
            g.moves.extend_from_slice(&cands[at]);
            left = now;
            if (hidden(s), left) == before {
                g.lost_open = s[DONE] < 8 && before == (0, 0);
                break; // nothing came up: it is over
            }
        }
        g.won = s[DONE] == 8;
        g.rolls = self.rolls - rolls;
        g.values = self.values - values;
        g
    }
}
