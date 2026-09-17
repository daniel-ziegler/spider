//! Shortening a winning line, and classifying moves as reversible or not.
//!
//! The solver's lines are long: each step through an equivalence class is
//! the shortest route from that class's entry to the exit it chose, but the
//! exits themselves are chosen by evaluation, not by distance, so a 4-suit
//! line is often 500–800 moves where a purposeful play is 150–250.
//!
//! `shorten` walks the line and, from each position, runs a bounded
//! breadth-first search over all legal moves looking for the farthest later
//! position of the line. When that position is closer than the line's own
//! route the segment is replaced by the search path. Passes repeat until one
//! finds nothing. The result is checked by replaying it; a line that fails
//! to win (which a 64-bit hash collision could produce) is discarded.

use crate::game::{Game, Move, DEAL_SIZE};
use crate::solver::{legal_moves, mix, stock_deals, IdBuild, State};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

/// Why a move cannot be taken back (the solver's notion of an irreversible
/// move, the kind that leaves an equivalence class).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Commit {
    Deal,
    CompletesSuit,
    RevealsCard,
    /// Joins a run to a same-suit card one rank higher (undoing it needs a split).
    JoinsSuit,
    /// The card left behind is not one rank higher than the moved run, so
    /// the run cannot go back.
    LeavesGap,
}

impl Commit {
    pub fn describe(self) -> &'static str {
        match self {
            Commit::Deal => "deals",
            Commit::CompletesSuit => "completes a suit",
            Commit::RevealsCard => "reveals a card",
            Commit::JoinsSuit => "joins a same-suit run",
            Commit::LeavesGap => "leaves a non-linkage behind",
        }
    }
}

/// None if `mv` can immediately be moved back as a whole.
pub fn commit_kind(g: &Game, mv: Move) -> Option<Commit> {
    let (from, to, count) = match mv {
        Move::Deal => return Some(Commit::Deal),
        Move::Move { from, to, count } => (from, to, count),
    };
    let src = &g.columns[from];
    if count == 0 || count > src.len() {
        return None;
    }
    let bottom = src[src.len() - count];
    let mut g2 = g.clone();
    if g2.apply(mv).is_err() {
        return None;
    }
    let rec = g2.history().last().unwrap();
    if !rec.completed.is_empty() {
        return Some(Commit::CompletesSuit);
    }
    if !rec.flips.is_empty() {
        return Some(Commit::RevealsCard);
    }
    if g.columns[to].last().map(|c| c.suit()) == Some(bottom.suit()) {
        return Some(Commit::JoinsSuit);
    }
    match g2.columns[from].last() {
        None => None,
        Some(c) if c.rank() == bottom.rank() + 1 => None,
        Some(_) => Some(Commit::LeavesGap),
    }
}

/// Order-sensitive position hash (the solver's own hash ignores column
/// order, which would splice moves with the wrong column numbers).
fn exact_hash(s: &State) -> u64 {
    let mut h: u64 = 0x2545F4914F6CDD1D ^ ((s.deals_done as u64) << 8) ^ s.completed as u64;
    for &x in &s.colh {
        h = mix(h, x);
    }
    h
}

/// Shorten `line`, a winning line from `game`. `cap` bounds the positions
/// searched from each point of the line. Returns the original line if
/// cancelled or if the shortened line fails to replay.
pub fn shorten(game: &Game, line: &[Move], cap: usize, cancel: &AtomicBool) -> Vec<Move> {
    let deals = stock_deals(game);
    let root = State::from_game(game);
    let mut cur = line.to_vec();
    loop {
        let next = shorten_pass(&root, &deals, &cur, cap, cancel);
        if cancel.load(Ordering::Relaxed) {
            return line.to_vec();
        }
        if next.len() >= cur.len() {
            break;
        }
        cur = next;
    }
    if !replays_to_win(game, &cur) {
        return line.to_vec();
    }
    cur
}

fn replays_to_win(game: &Game, line: &[Move]) -> bool {
    let mut g = game.clone();
    for &mv in line {
        if g.apply(mv).is_err() {
            return false;
        }
    }
    g.is_won()
}

struct Node {
    state: State,
    parent: u32,
    mv: Move,
    depth: u32,
}

fn shorten_pass(root: &State, deals: &[[u8; DEAL_SIZE]], line: &[Move], cap: usize, cancel: &AtomicBool) -> Vec<Move> {
    // Positions along the line; a hash maps to its last occurrence so that
    // a loop in the line (same position twice) is cut out.
    let mut states = Vec::with_capacity(line.len() + 1);
    states.push(root.clone());
    for &mv in line {
        let mut s = states.last().unwrap().clone();
        if !s.apply(mv, deals) {
            return line.to_vec();
        }
        states.push(s);
    }
    let n = line.len();
    let mut index: HashMap<u64, usize, IdBuild> = HashMap::default();
    for (i, s) in states.iter().enumerate() {
        index.insert(exact_hash(s), i);
    }
    let mut out = Vec::with_capacity(n);
    let mut nodes: Vec<Node> = Vec::with_capacity(cap);
    let mut seen: HashMap<u64, (), IdBuild> = HashMap::default();
    let mut moves = Vec::with_capacity(64);
    let mut i = 0;
    while i < n {
        if cancel.load(Ordering::Relaxed) {
            return line.to_vec();
        }
        // Best jump so far: the line's own next move.
        let mut best_j = i + 1;
        let mut best_node: Option<usize> = None;
        nodes.clear();
        seen.clear();
        nodes.push(Node { state: states[i].clone(), parent: u32::MAX, mv: Move::Deal, depth: 0 });
        seen.insert(exact_hash(&states[i]), ());
        if let Some(&j) = index.get(&exact_hash(&states[i])) {
            if j > i {
                best_j = j;
                best_node = Some(0);
            }
        }
        let mut head = 0;
        while head < nodes.len() && nodes.len() < cap {
            let depth = nodes[head].depth + 1;
            let s = nodes[head].state.clone();
            legal_moves(&s, true, &mut moves);
            if (s.deals_done as usize) < deals.len() && s.len.iter().all(|&l| l > 0) {
                moves.push(Move::Deal);
            }
            for &mv in &moves {
                let mut t = s.clone();
                if !t.apply(mv, deals) {
                    continue;
                }
                let h = exact_hash(&t);
                if seen.contains_key(&h) {
                    continue;
                }
                seen.insert(h, ());
                if let Some(&j) = index.get(&h) {
                    if j > best_j && (j - i) > depth as usize {
                        best_j = j;
                        best_node = Some(nodes.len());
                    }
                }
                nodes.push(Node { state: t, parent: head as u32, mv, depth });
                if nodes.len() >= cap {
                    break;
                }
            }
            head += 1;
        }
        match best_node {
            None => {
                out.push(line[i]);
                i += 1;
            }
            Some(mut k) => {
                let mut path = Vec::new();
                while nodes[k].parent != u32::MAX {
                    path.push(nodes[k].mv);
                    k = nodes[k].parent as usize;
                }
                path.reverse();
                out.extend(path);
                i = best_j;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solver::{Config, Solver};

    #[test]
    fn shortened_line_still_wins_and_is_no_longer() {
        for seed in 1..=3 {
            let g = Game::new(2, seed);
            let r = Solver::with_config(&g, 2_000_000, Config::default()).solve(&g);
            if r.line.is_empty() {
                continue;
            }
            let short = shorten(&g, &r.line, 2000, &AtomicBool::new(false));
            assert!(short.len() <= r.line.len());
            assert!(replays_to_win(&g, &short));
        }
    }

    #[test]
    fn commit_kinds() {
        let g = Game::new(1, 1);
        assert_eq!(commit_kind(&g, Move::Deal), Some(Commit::Deal));
        // Any legal single-card move off a column with a face-down card
        // beneath it reveals a card.
        let mut found = false;
        for from in 0..10 {
            for to in 0..10 {
                if from == to || g.columns[to].is_empty() {
                    continue;
                }
                if g.required_count(from, to) == Some(1) && g.face_down[from] + 1 == g.columns[from].len() {
                    assert_eq!(commit_kind(&g, Move::Move { from, to, count: 1 }), Some(Commit::RevealsCard));
                    found = true;
                }
            }
        }
        assert!(found);
    }
}
