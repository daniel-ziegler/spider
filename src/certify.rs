//! Cheap sufficient conditions for a position being unwinnable.
//!
//! `stuck_certificate` works on a position with no empty column and proves
//! that no column can ever be emptied. A card is *stuck* when it can never
//! move (it is a king, or every remaining copy of the next rank up lies
//! beneath it or beneath another stuck card) and can never be removed in
//! place (it does not sit on its own suit's chain up to the king, or some
//! lower rank of its suit is entirely buried). Cards beneath a stuck card
//! are buried for good. If every column holds a stuck card while no column
//! is empty, no column can ever become empty, so the game is lost. The
//! argument is by "first event": the first stuck card to move needs an empty
//! column or an exposed copy of the next rank, and the first column to
//! empty needs its stuck card removed.

use crate::game::NUM_COLS;

/// `cols[c]` lists column `c` bottom-up as packed cards (suit * 13 + rank).
/// Stock must be empty. Returns true only if the position is provably lost.
pub fn stuck_certificate(cols: &[&[u8]]) -> bool {
    if cols.len() != NUM_COLS || cols.iter().any(|c| c.is_empty()) {
        return false;
    }
    // Greatest fixpoint: start with everything marked stuck and unmark
    // cards that could move or be removed given the remaining marks. Any set
    // that survives supports itself, which is all the argument needs.
    let mut stuck: Vec<Vec<bool>> = cols.iter().map(|c| vec![true; c.len()]).collect();
    let mut where_: Vec<Vec<(usize, usize)>> = vec![Vec::new(); 52];
    for (c, col) in cols.iter().enumerate() {
        for (i, &v) in col.iter().enumerate() {
            where_[v as usize].push((c, i));
        }
    }
    let top_of = |stuck: &Vec<Vec<bool>>, c: usize| stuck[c].iter().rposition(|&b| b).map(|i| i as i32).unwrap_or(-1);
    let mut top_stuck: [i32; NUM_COLS] = [0; NUM_COLS];
    for (c, t) in top_stuck.iter_mut().enumerate() {
        *t = top_of(&stuck, c);
    }
    let mut changed = true;
    while changed {
        changed = false;
        for (c, col) in cols.iter().enumerate() {
            for (i, &v) in col.iter().enumerate() {
                if !stuck[c][i] {
                    continue;
                }
                let (suit, rank) = (v / 13, v % 13);
                // A copy is unavailable if it lies beneath a stuck card or beneath this card.
                let all_gone_at = |v: u8, at: usize| -> bool {
                    where_[v as usize].iter().all(|&(cc, ii)| (ii as i32) < top_stuck[cc] || (cc == c && ii < at))
                };
                let all_gone = |v: u8| all_gone_at(v, i);
                // The card moves either as the head of a run or carried by a
                // same-suit chain beneath it; every possible head must be
                // stuck for good.
                let mut immobile = true;
                let mut k = 0usize;
                loop {
                    let head_rank = rank + k as u8;
                    if head_rank < 12 && !(0..4).all(|s| all_gone_at(s * 13 + head_rank + 1, i - k)) {
                        immobile = false;
                        break;
                    }
                    if head_rank == 12 || i < k + 1 || col[i - k - 1] != suit * 13 + head_rank + 1 {
                        break;
                    }
                    k += 1;
                }
                let chain_ok = (1..=(12 - rank) as usize).all(|k| i >= k && col[i - k] == suit * 13 + rank + k as u8);
                let unremovable = !chain_ok || (0..rank).any(|q| all_gone(suit * 13 + q));
                if !(immobile && unremovable) {
                    stuck[c][i] = false;
                    top_stuck[c] = top_of(&stuck, c);
                    changed = true;
                }
            }
        }
    }
    if std::env::var_os("SPIDER_CERT_DEBUG").is_some() {
        for c in 0..NUM_COLS {
            let marks: Vec<String> = cols[c].iter().enumerate().map(|(i, &v)| format!("{}{}", crate::game::Card(v), if stuck[c][i] { "*" } else { "" })).collect();
            eprintln!("col {c}: {}", marks.join(" "));
        }
    }
    (0..NUM_COLS).all(|c| top_stuck[c] >= 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Card;

    fn k(s: u8, r: u8) -> u8 {
        Card::new(s, r).0
    }

    #[test]
    fn two_kings_block_each_other() {
        // Every column: a king on top of an ace of another suit, kings
        // cannot complete (their queens are all buried under kings).
        let cols: Vec<Vec<u8>> = (0..NUM_COLS).map(|c| vec![k((c % 2) as u8, 0), k(((c + 1) % 2) as u8, 12)]).collect();
        let refs: Vec<&[u8]> = cols.iter().map(|c| c.as_slice()).collect();
        assert!(stuck_certificate(&refs));
    }

    #[test]
    fn free_column_is_not_certified() {
        let mut cols: Vec<Vec<u8>> = (0..NUM_COLS).map(|c| vec![k((c % 2) as u8, 0), k(((c + 1) % 2) as u8, 12)]).collect();
        // A five that can move onto an exposed six: column 3 can be emptied.
        cols[3] = vec![k(0, 5)];
        cols[4] = vec![k(1, 0), k(1, 6)];
        let refs: Vec<&[u8]> = cols.iter().map(|c| c.as_slice()).collect();
        assert!(!stuck_certificate(&refs));
    }
}
