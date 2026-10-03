//! A non-peeking player that plays roughly the way a person does.
//!
//! It never sees a face-down card or the stock order: every decision is made
//! on a [`mask`]ed copy of the game in which those cards are blanks. From the
//! visible position it looks a few moves ahead (a small breadth-first search
//! over the legal moves, with only some splits of same-suit runs), stopping
//! at any move that turns a card over, since what comes up is unknown. It
//! plays the line to the best position it found if that position scores
//! better than the current one, then looks again. When nothing scores better
//! it turns over any card it can reach; failing that it deals, first
//! arranging the best position that leaves no column empty; with the stock
//! gone it gives up.
//!
//! The score is a visible-only evaluation: completed suits, hidden cards,
//! same-suit and cross-suit linkages, breaks, run lengths and empty columns.
//! Only strict improvements are played between card turns, so the player
//! cannot cycle.

use crate::game::{Card, Game, Move, NUM_COLS};
use crate::solver::{legal_moves, IdBuild, State, MAXC};
use std::collections::HashMap;

/// Stands in for every card the player cannot see.
pub const BLANK: Card = Card(255);

/// The game as the player sees it: face-down cards and the stock replaced by
/// [`BLANK`]s (the number of each stays visible).
pub fn mask(g: &Game) -> Game {
    let mut m = g.clone();
    for c in 0..NUM_COLS {
        for card in &mut m.columns[c][..g.face_down[c]] {
            *card = BLANK;
        }
    }
    for card in &mut m.stock {
        *card = BLANK;
    }
    m
}

/// Evaluation weights and search size.
#[derive(Clone, Copy, Debug)]
pub struct HumanConfig {
    /// Positions examined per decision.
    pub nodes: usize,
    /// Which splits of a same-suit run are considered: 0 none, 1 only onto
    /// a card of the same suit, 2 also into an empty column, 3 all.
    pub splits: u8,
    pub completed: i32,
    pub hidden: i32,
    /// Extra for a column with no hidden cards left (it can be emptied).
    pub clear: i32,
    pub empty: i32,
    pub same: i32,
    pub diff: i32,
    pub wrong: i32,
    /// Bonus per same-suit run of length L: run_sq * L^2 / 16.
    pub run_sq: i32,
}

impl HumanConfig {
    /// Defaults, tuned on seeds 1-200 (2 and 4 suits). Splits into an empty
    /// column are what 1-suit play needs; with more suits they mostly waste
    /// the lookahead.
    pub fn for_suits(suits: u8) -> HumanConfig {
        HumanConfig {
            nodes: 2000,
            splits: if suits == 1 { 2 } else { 1 },
            completed: 1000,
            hidden: 20,
            clear: 20,
            empty: 60,
            same: 8,
            diff: 1,
            wrong: 0,
            run_sq: 16,
        }
    }

    /// [`HumanConfig::for_suits`] with `SPIDER_H_*` overrides (NODES, SPLITS,
    /// COMPLETED, HIDDEN, CLEAR, EMPTY, SAME, DIFF, WRONG, RUN_SQ).
    pub fn from_env(suits: u8) -> HumanConfig {
        fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
            std::env::var(format!("SPIDER_H_{name}")).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        let d = HumanConfig::for_suits(suits);
        HumanConfig {
            nodes: get("NODES", d.nodes),
            splits: get("SPLITS", d.splits),
            completed: get("COMPLETED", d.completed),
            hidden: get("HIDDEN", d.hidden),
            clear: get("CLEAR", d.clear),
            empty: get("EMPTY", d.empty),
            same: get("SAME", d.same),
            diff: get("DIFF", d.diff),
            wrong: get("WRONG", d.wrong),
            run_sq: get("RUN_SQ", d.run_sq),
        }
    }

    /// Score of a position from its visible cards only.
    fn eval(&self, s: &State) -> i32 {
        let mut score = self.completed * s.completed as i32;
        for c in 0..NUM_COLS {
            let n = s.len[c] as usize;
            if n == 0 {
                score += self.empty;
                continue;
            }
            let d = s.down[c] as usize;
            score -= self.hidden * d as i32;
            if d == 0 {
                score += self.clear;
            }
            let col = &s.cols[c];
            let mut run = 1;
            for i in d + 1..n {
                let (upper, lower) = (col[i - 1], col[i]);
                if upper % 13 == lower % 13 + 1 && upper / 13 == lower / 13 {
                    score += self.same;
                    run += 1;
                    continue;
                }
                score += if upper % 13 == lower % 13 + 1 { self.diff } else { -self.wrong };
                score += self.run_sq * run * run / 16;
                run = 1;
            }
            score += self.run_sq * run * run / 16;
        }
        score
    }
}

/// What the player decided to do from a position.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Play these moves (the last may turn a card over), then look again.
    Play(Vec<Move>),
    /// Play these moves (filling every empty column), then deal; but if the
    /// last move turns a card over, look again instead of dealing.
    Deal(Vec<Move>),
    /// Nothing improves and no deal is possible.
    Stuck,
}

struct Node {
    state: State,
    parent: u32,
    mv: Move,
    /// Turned a card over: what lies beyond is unknown, so not expanded.
    leaf: bool,
}

/// Decide from a masked position (see [`mask`]). `deals_left` is the number
/// of stock deals remaining. Returns the decision and the positions examined.
pub fn decide(obs: &Game, deals_left: usize, cfg: &HumanConfig) -> (Decision, usize) {
    if obs.is_won() {
        return (Decision::Stuck, 0);
    }
    let root = State::from_game(obs);
    let base = cfg.eval(&root);
    let mut nodes = vec![Node { state: root.clone(), parent: u32::MAX, mv: Move::Deal, leaf: false }];
    let mut seen: HashMap<u64, (), IdBuild> = HashMap::default();
    seen.insert(root.hash(), ());
    let mut moves = Vec::with_capacity(64);
    let mut i = 0;
    'bfs: while i < nodes.len() {
        if nodes[i].leaf {
            i += 1;
            continue;
        }
        let s = nodes[i].state.clone();
        legal_moves(&s, cfg.splits > 0, &mut moves);
        for &mv in &moves {
            let Move::Move { from, to, count } = mv else { continue };
            if s.len[to] as usize + count > MAXC {
                continue;
            }
            if count < s.run_len(from) {
                let bottom = s.cols[from][s.len[from] as usize - count];
                let onto_suit = s.len[to] > 0 && s.top(to) / 13 == bottom / 13;
                let ok = match cfg.splits {
                    0 => false,
                    1 => onto_suit,
                    2 => onto_suit || s.len[to] == 0,
                    _ => true,
                };
                if !ok {
                    continue;
                }
            }
            let mut t = s.clone();
            t.apply(mv, &[]);
            if seen.insert(t.hash(), ()).is_some() {
                continue;
            }
            let leaf = (0..NUM_COLS).any(|c| t.down[c] < s.down[c]);
            nodes.push(Node { state: t, parent: i as u32, mv, leaf });
            if nodes.len() >= cfg.nodes {
                break 'bfs;
            }
        }
        i += 1;
    }

    // Best strict improvement; the breadth-first order makes ties go to the
    // shorter line.
    let mut best = 0;
    let mut best_score = base;
    for (k, n) in nodes.iter().enumerate().skip(1) {
        let sc = cfg.eval(&n.state);
        if sc > best_score {
            best = k;
            best_score = sc;
        }
    }
    if best == 0 {
        // Nothing scores better, but before dealing or giving up, turn over
        // any card that can be reached at all: dealing fills the empty
        // columns anyway, and a card turned over is information. There are
        // only so many cards to turn, so this cannot cycle either.
        let mut pick_score = i32::MIN;
        for (k, n) in nodes.iter().enumerate() {
            if n.leaf {
                let sc = cfg.eval(&n.state);
                if sc > pick_score {
                    best = k;
                    pick_score = sc;
                }
            }
        }
    }
    if best == 0 && deals_left > 0 {
        // Prepare the deal: the best position with every column filled. If
        // that is where we are, deal.
        let mut pick = None;
        let mut pick_score = i32::MIN;
        for (k, n) in nodes.iter().enumerate() {
            if n.state.len.iter().all(|&l| l > 0) {
                let sc = cfg.eval(&n.state);
                if sc > pick_score {
                    pick = Some(k);
                    pick_score = sc;
                }
            }
        }
        // Dealing straight after the arrangement matters: it may score
        // below the current position, and looking again from there would
        // just walk back.
        return match pick {
            Some(k) => (Decision::Deal(line_to(&nodes, k)), nodes.len()),
            None => (Decision::Stuck, nodes.len()),
        };
    }
    if best == 0 {
        return (Decision::Stuck, nodes.len());
    }
    (Decision::Play(line_to(&nodes, best)), nodes.len())
}

fn line_to(nodes: &[Node], mut k: usize) -> Vec<Move> {
    let mut line = Vec::new();
    while k != 0 {
        line.push(nodes[k].mv);
        k = nodes[k].parent as usize;
    }
    line.reverse();
    line
}

/// Outcome of playing a whole game.
#[derive(Clone, Debug)]
pub struct PlayResult {
    pub won: bool,
    pub moves: Vec<Move>,
    pub completed: usize,
    /// Positions examined over all decisions.
    pub work: u64,
}

/// Play `g` to the end, deciding every move from the masked position only.
pub fn play(g: &Game, cfg: &HumanConfig) -> PlayResult {
    let mut g = g.clone();
    let mut work = 0;
    let start = g.move_count();
    while !g.is_won() && g.move_count() - start < 5000 {
        let (d, w) = decide(&mask(&g), g.deals_remaining(), cfg);
        work += w as u64;
        if std::env::var_os("SPIDER_H_TRACE").is_some() {
            eprintln!("{}\n{d:?} ({w} positions)", show(&g));
        }
        match d {
            Decision::Play(line) => {
                for mv in line {
                    g.apply(mv).expect("planned move is legal");
                }
            }
            Decision::Deal(line) => {
                let mut flipped = false;
                for mv in line {
                    g.apply(mv).expect("planned move is legal");
                    flipped |= !g.history().last().unwrap().flips.is_empty();
                }
                if !flipped {
                    g.apply(Move::Deal).expect("deal is legal");
                }
            }
            Decision::Stuck => break,
        }
    }
    let moves = g.history()[start..].iter().map(|r| r.mv).collect();
    PlayResult { won: g.is_won(), moves, completed: g.completed.len(), work }
}

/// The visible position as text, one column per line (`##` = face down).
pub fn show(g: &Game) -> String {
    let mut out = format!("stock {} completed {}", g.deals_remaining(), g.completed.len());
    for c in 0..NUM_COLS {
        out.push_str(&format!("\n{c}:"));
        for (i, k) in g.columns[c].iter().enumerate() {
            if i < g.face_down[c] {
                out.push_str(" ##");
            } else {
                out.push_str(&format!(" {k}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_hides_face_down_cards_and_stock() {
        let g = Game::new(4, 3);
        let m = mask(&g);
        assert_eq!(m.stock.len(), g.stock.len());
        assert!(m.stock.iter().all(|&c| c == BLANK));
        for c in 0..NUM_COLS {
            let d = g.face_down[c];
            assert!(m.columns[c][..d].iter().all(|&k| k == BLANK));
            assert_eq!(m.columns[c][d..], g.columns[c][d..]);
        }
    }

    #[test]
    fn decisions_ignore_hidden_cards() {
        // Same visible cards, different face-down cards and stock.
        let a = Game::new(2, 11);
        let mut b = a.clone();
        b.columns[0][0] = Card::new(1, 5);
        b.stock.reverse();
        let cfg = HumanConfig::for_suits(2);
        assert_eq!(decide(&mask(&a), 5, &cfg).0, decide(&mask(&b), 5, &cfg).0);
    }

    #[test]
    fn plays_one_suit_deal_to_a_win() {
        let g = Game::new(1, 8);
        let r = play(&g, &HumanConfig::for_suits(1));
        assert!(r.won);
        let mut check = g.clone();
        for mv in r.moves {
            check.apply(mv).unwrap();
        }
        assert!(check.is_won());
    }
}
