//! Is another choice better than the line player's? Its candidates at a
//! decision ([`contrasts`]), or other arrangements to deal from than the
//! one it chose ([`arrangements`], [`outcomes`]), are each played on in
//! the same worlds (the real one and ones guessed from the visible cards)
//! to the next deal, where the fitted value counts ([`crate::stagev`]).
//! The differences within a decision, where the luck of the cards mostly
//! cancels, measure how much there is to gain (`stage/headroom.py`) and
//! train a network that ranks the candidates (`vnet/adv.py`,
//! [`crate::advnet`]).
use crate::game::{Game, Move};
use crate::human::mask;
use crate::lines::{line_to, masked_hash, play_until, progress, search_state, LineConfig, Tempo, LOST};
use crate::pimc::{apply, candidates_plan, Cand, PimcConfig};
use crate::smart::{determinize, Rng};
use crate::solver::{State, MAXC};
use crate::stagev::{deal_value, features};
use crate::vnet::{encode, ENC};
use std::collections::HashSet;

/// An arrangement to deal from.
pub struct Arrangement {
    /// The moves to it from the position (none: the position itself).
    pub moves: Vec<Move>,
    /// The line player's about-to-deal evaluation, less the position's.
    pub gain: i32,
    /// The network encoding (`vnet::ENC` bytes).
    pub enc: Vec<u8>,
}

/// Arrangements reachable from the masked position `obs` without turning
/// a card, with a card in every column: the position itself, the best
/// `top` others by the about-to-deal evaluation and `random` of the next
/// best `pool`.
pub fn arrangements(obs: &Game, deals_left: usize, cfg: &LineConfig, top: usize, random: usize, pool: usize, seed: u64) -> Vec<Arrangement> {
    let root = State::from_game(obs);
    let wide = LineConfig { splits: if cfg.deal_splits != 0 { cfg.deal_splits } else { cfg.splits }, ..*cfg };
    let nodes = search_state(root, &wide);
    let value = |k: usize| nodes[k].parts.value(deals_left, cfg.deal_empty);
    let mut ranked: Vec<(i32, usize)> = (1..nodes.len())
        .filter(|&k| !nodes[k].leaf && value(k) > LOST && nodes[k].state.len.iter().all(|&l| l > 0 && (l as usize) < MAXC))
        .map(|k| (value(k), k))
        .collect();
    ranked.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
    let mut picked: Vec<usize> = ranked.iter().take(top).map(|&(_, k)| k).collect();
    let mut rest: Vec<usize> = ranked.iter().skip(top).take(pool).map(|&(_, k)| k).collect();
    let mut rng = Rng(seed);
    for _ in 0..random.min(rest.len()) {
        picked.push(rest.swap_remove((rng.next() % rest.len() as u64) as usize));
    }
    let make = |k: usize| {
        let mut enc = vec![0; ENC];
        encode(&nodes[k].state, deals_left, &mut enc);
        Arrangement { moves: line_to(&nodes, k).concat(), gain: value(k) - value(0), enc }
    };
    std::iter::once(0).chain(picked).map(make).collect()
}

/// The value of dealing from each arrangement of the game `g` (about to
/// deal) in `worlds` worlds, the first the real one and the others guessed
/// from the visible cards: the line player deals and plays on until it is
/// about to deal again, where the fitted value counts (`stagev`), or to
/// the end after the last deal (1 for a win). Also each arrangement's
/// features.
pub fn outcomes(g: &Game, arrs: &[Arrangement], worlds: usize, cfg: &LineConfig, seed: u64) -> Vec<(Vec<f64>, [f64; 24])> {
    let k = g.deals_remaining();
    let obs = mask(g);
    let ws: Vec<Game> = (0..worlds).map(|w| if w == 0 { g.clone() } else { determinize(&obs, seed.wrapping_add(w as u64)) }).collect();
    arrs.iter()
        .map(|a| {
            let mut feats = [0.0; 24];
            let vals = ws
                .iter()
                .enumerate()
                .map(|(w, world)| {
                    let mut t = world.clone();
                    for &mv in &a.moves {
                        t.apply(mv).expect("arrangement move is legal");
                    }
                    if w == 0 {
                        feats = features(&t);
                    }
                    t.apply(Move::Deal).expect("deal is legal");
                    let stopped = play_until(&mut t, cfg, HashSet::new(), if k > 1 { Some(k - 1) } else { None }).1;
                    if t.is_won() {
                        1.0
                    } else if stopped {
                        deal_value(&t)
                    } else {
                        0.0
                    }
                })
                .collect();
            (vals, feats)
        })
        .collect()
}

/// Bytes of a candidate's encoding: the position's ([`ENC`]), then
/// [`extras`].
pub const EXT: usize = ENC + 3;

/// What the line player thinks of a candidate, for the network: whether
/// it is its choice, and the evaluation of the position `after` it less
/// that of the position after the choice (`first`), normally and about to
/// deal (or to give up), halved and offset by 128.
pub(crate) fn extras(after: &State, first: &State, is_first: bool, level: usize, cfg: &LineConfig) -> [u8; 3] {
    let end = if level > 0 { cfg.deal_empty } else { cfg.end_empty };
    let q = |empty: i32| ((cfg.eval(after, level, empty).max(LOST) as i64 - cfg.eval(first, level, empty).max(LOST) as i64) / 2).clamp(-127, 127) + 128;
    [is_first as u8, q(cfg.empty) as u8, q(end) as u8]
}

/// The position of an encoding, as far as the evaluation looks (a deal's
/// mark dropped).
fn decode(enc: &[u8]) -> State {
    let mut s = State { cols: [[0; MAXC]; crate::game::NUM_COLS], len: [0; crate::game::NUM_COLS], down: [0; crate::game::NUM_COLS], colh: [0; crate::game::NUM_COLS], deals_done: 0, completed: enc[ENC - 1] };
    for c in 0..crate::game::NUM_COLS {
        for &code in enc[c * crate::vnet::ROWS..(c + 1) * crate::vnet::ROWS].iter().take_while(|&&x| x > 0) {
            let n = s.len[c] as usize;
            s.cols[c][n] = if code >= 3 { code - 3 } else { crate::human::BLANK.0 };
            s.len[c] += 1;
            s.down[c] += (code == 1) as u8;
        }
    }
    s
}

/// [`extras`] for the candidates of a decision from their encodings (the
/// choice first; columns longer than the encoding keeps are cut).
pub fn extras_of(encs: &[Vec<u8>], cfg: &LineConfig) -> Vec<[u8; 3]> {
    let first = decode(&encs[0]);
    let level = (encs[0][ENC - 2] & 15) as usize;
    encs.iter().enumerate().map(|(i, e)| extras(&decode(e), &first, i == 0, level, cfg)).collect()
}

/// A decision of the line player with its alternatives, each played on in
/// the same worlds.
pub struct Contrast {
    pub deals_left: usize,
    /// Per candidate (the line player's choice first): whether it is the
    /// deal, the encoding of the masked position after it (a deal: the
    /// position, with 16 added to the deals left) with its [`extras`], and
    /// its value in each world.
    pub cands: Vec<(bool, Vec<u8>, Vec<f64>)>,
}

/// Play `g` with the line player (`cfg.base`). At a decision with
/// alternatives (see [`crate::pimc::candidates`]; not one that continues a
/// line already planned) and `levels` deals left (least, most), with
/// probability `sample`, every candidate is
/// played in `worlds` worlds (the first the real one, the others guessed)
/// and `cfg.rollout` plays on until it is about to deal, where the fitted
/// value counts, or to the end with the stock gone.
pub fn contrasts(g: &Game, cfg: &PimcConfig, worlds: usize, sample: f64, levels: (usize, usize), seed: u64) -> Vec<Contrast> {
    let mut g = g.clone();
    let mut out = Vec::new();
    let mut rng = Rng(seed ^ 0xC0_17A5);
    let mut visited = HashSet::new();
    let mut tempo = Tempo::default();
    let start = g.move_count();
    while !g.is_won() && g.move_count() - start < 5000 && g.columns.iter().all(|c| c.len() <= MAXC) {
        let obs = mask(&g);
        visited.insert(masked_hash(&obs));
        let before = progress(&g);
        let level = g.deals_remaining();
        if level < levels.0 {
            break;
        }
        let planned: Vec<Move> = tempo.plan.iter().flatten().copied().collect();
        let (cands, play) = candidates_plan(&obs, level, &visited, &mut tempo, cfg);
        let Some(play) = play else { break };
        let continuing = !planned.is_empty() && cands.first() == Some(&Cand::Line(planned));
        if !continuing && cands.len() > 1 && level >= levels.0 && level <= levels.1 && ((rng.next() >> 11) as f64 / (1u64 << 53) as f64) < sample {
            let ws: Vec<Game> = (0..worlds).map(|w| if w == 0 { g.clone() } else { determinize(&obs, rng.next()) }).collect();
            let mut rows: Vec<(bool, Vec<u8>, Vec<f64>)> = Vec::new();
            let mut first: Option<State> = None;
            for c in &cands {
                let mut after = obs.clone();
                let mut enc = vec![0; ENC];
                if let Cand::Line(_) = c {
                    apply(&mut after, c);
                }
                if after.columns.iter().any(|col| col.len() > MAXC) {
                    continue;
                }
                let st = State::from_game(&after);
                encode(&st, level, &mut enc);
                if *c == Cand::Deal {
                    enc[ENC - 2] += 16;
                }
                let f = first.get_or_insert_with(|| st.clone());
                enc.extend_from_slice(&extras(&st, f, rows.is_empty(), level, &cfg.base));
                let vals = ws
                    .iter()
                    .map(|world| {
                        let mut t = world.clone();
                        apply(&mut t, c);
                        let mut seen = visited.clone();
                        seen.insert(masked_hash(&mask(&t)));
                        let stopped = play_until(&mut t, &cfg.rollout, seen, (level > 0).then_some(level)).1;
                        if t.is_won() {
                            1.0
                        } else if stopped {
                            deal_value(&t)
                        } else {
                            0.0
                        }
                    })
                    .collect();
                rows.push((*c == Cand::Deal, enc, vals));
            }
            out.push(Contrast { deals_left: level, cands: rows });
        }
        apply(&mut g, &play);
        if progress(&g) != before {
            tempo = Tempo::default();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encoding_decodes_to_a_position_with_the_same_evaluation() {
        let cfg = LineConfig::for_suits(4);
        let mut g = Game::new(4, 7);
        g.apply(Move::Deal).unwrap();
        let obs = mask(&g);
        let arrs = arrangements(&obs, 4, &cfg, 3, 3, 50, 1);
        assert!(arrs.len() > 1);
        for a in &arrs {
            let mut t = obs.clone();
            for &mv in &a.moves {
                t.apply(mv).unwrap();
            }
            let s = State::from_game(&t);
            assert_eq!(cfg.eval(&decode(&a.enc), 4, cfg.deal_empty), cfg.eval(&s, 4, cfg.deal_empty));
            assert_eq!(cfg.eval(&s, 4, cfg.deal_empty) - cfg.eval(&State::from_game(&obs), 4, cfg.deal_empty), a.gain);
        }
    }
}
