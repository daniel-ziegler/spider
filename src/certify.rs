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

/// The first-event certificate: a counting argument that no column can ever
/// be emptied and no suit ever completed, so the game is lost.
///
/// Take the first of those events, in a position with no empty column.
/// Until it happens no card is ever put anywhere but on a card one rank
/// higher, and kings never move. So just before it every column is a *stem*
/// (the bottom cards that have not moved, at least one) with, on top of it,
/// cards that each sit on a card one rank higher; a card dealt since and not
/// moved may sit on anything, and is called an anchor like the top of a
/// stem. Hence the moved cards form chains, one at most per anchor, running
/// down by rank from one below the anchor: with `m[r]` moved cards and
/// `s[r]` anchors of rank r, `m[r] <= m[r+1] + s[r+1]` for every rank.
/// Emptying a column means all its cards are moved; completing a suit means
/// everything above one of its kings is moved and a copy of each of its
/// cards is. If for every number of deals from here on, no choice of stems
/// satisfies those inequalities for any column or king, there is no first
/// event. Which cards could be reached in what order is ignored, so this
/// proves only some lost positions lost; it never calls a winnable one lost.
///
/// Returns false, proving nothing, if a column is empty.
pub fn first_event_certificate(g: &crate::game::Game) -> bool {
    let cols: Vec<Vec<u8>> = g.columns.iter().map(|c| c.iter().map(|k| k.0).collect()).collect();
    if cols.iter().any(|c| c.is_empty()) {
        return false;
    }
    let deals = crate::solver::stock_deals(g);
    let debug = std::env::var_os("SPIDER_CERT_DEBUG").is_some();
    let mut search = Counting { nodes: 0, failed: std::collections::HashSet::new() };
    for d in 0..=deals.len() {
        // The cards dealt onto each column by then: anchors, kings included.
        let dealt: Vec<Vec<u8>> = (0..NUM_COLS).map(|c| deals[..d].iter().map(|deal| deal[c]).collect()).collect();
        let mut anchors = [0i16; 12];
        for &v in dealt.iter().flatten() {
            supply(&mut anchors, v % 13);
        }
        // The lowest stem each column may have: above its top king.
        let kmin: Vec<usize> = cols.iter().map(|c| c.iter().rposition(|&v| v % 13 == 12).map_or(1, |i| i + 1)).collect();
        let options: Vec<Vec<Opt>> = (0..NUM_COLS).map(|c| column_options(&cols[c], kmin[c])).collect();
        // Emptying column c: all its cards move, those dealt onto it too.
        for c in 0..NUM_COLS {
            if cols[c].iter().chain(&dealt[c]).any(|&v| v % 13 == 12) {
                continue;
            }
            let mut fixed = anchors;
            for &v in &dealt[c] {
                unsupply(&mut fixed, v % 13);
            }
            for &v in cols[c].iter().chain(&dealt[c]) {
                moved(&mut fixed, v % 13);
            }
            let others: Vec<&[Opt]> = (0..NUM_COLS).filter(|&j| j != c).map(|j| options[j].as_slice()).collect();
            if search.feasible(fixed, &others, None) {
                if debug {
                    eprintln!("after {d} deals column {c} might be emptied ({} nodes)", search.nodes);
                }
                return false;
            }
        }
        // Completing the suit of the one king of each column that can be
        // uncovered: the last one dealt onto it, else its top king.
        for c in 0..NUM_COLS {
            let forced;
            let (king, own): (u8, &[Opt]) = match dealt[c].iter().rev().find(|&&v| v % 13 == 12) {
                Some(&v) => (v, &options[c]),
                None => match cols[c].iter().rposition(|&v| v % 13 == 12) {
                    Some(i) => {
                        forced = [options[c].iter().find(|o| o.cut == i + 1).expect("the cut above the king").clone()];
                        (cols[c][i], &forced)
                    }
                    None => continue,
                },
            };
            let suit = king / 13;
            // Cards of the suit dealt onto this column may fall into place.
            let have = dealt[c].iter().filter(|&&v| v / 13 == suit && v % 13 < 12).fold(0u16, |a, &v| a | 1 << (v % 13));
            let mut all: Vec<&[Opt]> = (0..NUM_COLS).filter(|&j| j != c).map(|j| options[j].as_slice()).collect();
            all.push(own);
            if search.feasible(anchors, &all, Some((suit as usize, have))) {
                if debug {
                    eprintln!("after {d} deals the king in column {c} might be completed ({} nodes)", search.nodes);
                }
                return false;
            }
        }
    }
    if debug {
        eprintln!("no first event ({} nodes)", search.nodes);
    }
    !search.gave_up()
}

/// A stem for a column: `cut` cards stay, the rest are moved.
#[derive(Clone)]
struct Opt {
    cut: usize,
    /// What this adds to `m[r+1] + s[r+1] - m[r]`, for each rank r below king.
    slack: [i16; 12],
    /// The ranks moved, per suit, as bit sets.
    moved: [u16; 4],
}

/// An anchor of this rank takes a card one rank lower.
fn supply(slack: &mut [i16; 12], rank: u8) {
    if rank > 0 {
        slack[rank as usize - 1] += 1;
    }
}

fn unsupply(slack: &mut [i16; 12], rank: u8) {
    if rank > 0 {
        slack[rank as usize - 1] -= 1;
    }
}

/// A moved card needs a card one rank higher and takes one a rank lower.
fn moved(slack: &mut [i16; 12], rank: u8) {
    slack[rank as usize] -= 1;
    supply(slack, rank);
}

/// The stems a column may have, from `kmin` cards up.
fn column_options(col: &[u8], kmin: usize) -> Vec<Opt> {
    let mut out = Vec::new();
    let mut slack = [0i16; 12];
    let mut ranks = [0u16; 4];
    for cut in (kmin..=col.len()).rev() {
        let mut o = Opt { cut, slack, moved: ranks };
        supply(&mut o.slack, col[cut - 1] % 13);
        out.push(o);
        let v = col[cut - 1];
        if v % 13 < 12 {
            moved(&mut slack, v % 13);
            ranks[v as usize / 13] |= 1 << (v % 13);
        }
    }
    out
}

const COUNTING_NODES: u64 = 2_000_000;

struct Counting {
    nodes: u64,
    /// (columns left, slack so far, ranks had) from which nothing works.
    failed: std::collections::HashSet<(usize, [i16; 12], u16)>,
}

impl Counting {
    fn gave_up(&self) -> bool {
        self.nodes > COUNTING_NODES
    }

    /// Can one option per column be chosen so that the slack, starting from
    /// `fixed`, ends nowhere negative, and with `need` = (suit, ranks had),
    /// so that every rank of the suit below king is had or moved? Says yes
    /// when it gives up.
    fn feasible(&mut self, fixed: [i16; 12], cols: &[&[Opt]], need: Option<(usize, u16)>) -> bool {
        // The most the columns from i on can add to each rank, and move of the suit.
        let suit = need.map_or(0, |n| n.0);
        let mut best = vec![([0i16; 12], 0u16); cols.len() + 1];
        for i in (0..cols.len()).rev() {
            let (mut b, mut ranks) = best[i + 1];
            for (r, slot) in b.iter_mut().enumerate() {
                *slot += cols[i].iter().map(|o| o.slack[r]).max().unwrap_or(0);
            }
            for o in cols[i] {
                ranks |= o.moved[suit];
            }
            best[i] = (b, ranks);
        }
        self.failed.clear();
        let want = if need.is_some() { 0xFFF } else { 0 };
        self.go(0, fixed, need.map_or(0, |n| n.1), cols, &best, suit, want)
    }

    #[allow(clippy::too_many_arguments)]
    fn go(&mut self, i: usize, slack: [i16; 12], had: u16, cols: &[&[Opt]], best: &[([i16; 12], u16)], suit: usize, want: u16) -> bool {
        self.nodes += 1;
        if self.gave_up() {
            return true;
        }
        if (0..12).any(|r| slack[r] + best[i].0[r] < 0) || (had | best[i].1) & want != want {
            return false;
        }
        if i == cols.len() {
            return true;
        }
        if self.failed.contains(&(i, slack, had & want)) {
            return false;
        }
        for o in cols[i] {
            let mut next = slack;
            for r in 0..12 {
                next[r] += o.slack[r];
            }
            if self.go(i + 1, next, had | o.moved[suit], cols, best, suit, want) {
                return true;
            }
        }
        self.failed.insert((i, slack, had & want));
        false
    }
}

/// The top-rank certificate, for a position with an empty stock and no
/// empty column: a search of a much smaller game that the real one maps
/// onto, which proves the position lost if it cannot empty a column or
/// complete a suit either.
///
/// While no column is empty, a run only ever moves onto a card one rank
/// above its bottom card. If the card it leaves is also one rank above, the
/// ranks of the ten top cards are the same multiset afterwards: one such top
/// was covered and one uncovered. So that multiset `tops` changes only when
/// a card leaves a parent of the wrong rank, which no move puts it back on:
/// only by the first move of a card `x` lying on such a card `a` in this
/// position, and then by losing `rank(x) + 1` and gaining `rank(a)`.
/// And a card lying on anything but the next card up of its own suit, face
/// up, can only leave it as the bottom card of a run, so only while `tops`
/// has its rank plus one.
///
/// The small game keeps, per column, how many of its cards have never moved,
/// in whole *units* (a card with the same-suit run on it), and `tops`. A
/// step takes the top unit off a column, allowed if `tops` has the rank
/// above the unit's bottom card, and updates `tops` as above. Every line of
/// real play, with or without splits, gives a line of this game (which
/// forgets where the units went, and that they are in each other's way).
/// It has an event when a unit lying at the bottom of a column can step, or
/// when a king's unit is on top and every lower card of its suit has a copy
/// that has moved or is in a top unit.
pub fn top_rank_certificate(g: &crate::game::Game) -> bool {
    if !g.stock.is_empty() {
        return false;
    }
    let cols: Vec<Vec<u8>> = g.columns.iter().map(|c| c.iter().map(|k| k.0).collect()).collect();
    let (dead, nodes) = top_rank_dead(std::array::from_fn(|c| cols[c].as_slice()), g.face_down, 1_000_000);
    if std::env::var_os("SPIDER_CERT_DEBUG").is_some() {
        eprintln!("top ranks: {} ({nodes} positions)", if dead { "no event" } else { "an event is possible" });
    }
    dead
}

/// [`top_rank_certificate`] for these columns (bottom card first), `down[c]`
/// cards of column `c` face down, the stock being empty: whether the
/// position is proved lost, and the positions of the small game looked at,
/// `limit` at most before giving up.
pub(crate) fn top_rank_dead(cols: [&[u8]; NUM_COLS], down: [usize; NUM_COLS], limit: u64) -> (bool, u64) {
    if cols.iter().any(|c| c.is_empty()) {
        return (false, 0);
    }
    let mut tops = [0u8; 14];
    let mut left = [0u8; NUM_COLS];
    for c in 0..NUM_COLS {
        tops[(cols[c][cols[c].len() - 1] % 13) as usize] += 1;
        left[c] = cols[c].len() as u8;
    }
    let mut game = Units { cols, down, seen: Vec::new(), nodes: 0, limit };
    let event = game.event(left, tops);
    (!event, game.nodes)
}

struct Units<'a> {
    cols: [&'a [u8]; NUM_COLS],
    down: [usize; NUM_COLS],
    /// Positions (cards left per column) from which there is no event.
    seen: Vec<[u8; NUM_COLS]>,
    nodes: u64,
    limit: u64,
}

impl Units<'_> {
    /// Where the top unit of column `c` starts when `left` cards have not moved.
    fn unit(&self, c: usize, left: u8) -> usize {
        let col = self.cols[c];
        let mut u = left as usize - 1;
        while u > self.down[c] && col[u - 1] == col[u] + 1 && col[u] % 13 != 12 {
            u -= 1;
        }
        u
    }

    /// Can an event be reached? Says yes when it gives up.
    fn event(&mut self, mut left: [u8; NUM_COLS], tops: [u8; 14]) -> bool {
        self.nodes += 1;
        if self.nodes > self.limit {
            return true;
        }
        // Steps that leave `tops` as it is cost nothing: take them all.
        // The others: (column, cards left after, rank taken, rank given).
        let mut steps = [(0usize, 0u8, 0usize, 0usize); NUM_COLS];
        let mut n;
        loop {
            n = 0;
            let mut free = false;
            for c in 0..NUM_COLS {
                let u = self.unit(c, left[c]);
                let rank = (self.cols[c][u] % 13) as usize;
                if tops[rank + 1] == 0 {
                    continue;
                }
                if u == 0 {
                    return true; // the column is emptied
                }
                let under = (self.cols[c][u - 1] % 13) as usize;
                if under == rank + 1 {
                    left[c] = u as u8;
                    free = true;
                } else {
                    steps[n] = (c, u as u8, rank + 1, under);
                    n += 1;
                }
            }
            if !free {
                break;
            }
        }
        if self.completable(&left) {
            return true;
        }
        if self.seen.contains(&left) {
            return false;
        }
        self.seen.push(left);
        for &(c, u, takes, gives) in &steps[..n] {
            let (mut l, mut t) = (left, tops);
            l[c] = u;
            t[takes] -= 1;
            t[gives] += 1;
            if self.event(l, t) {
                return true;
            }
        }
        false
    }

    /// Might some suit be completed: is a king's unit on top of its column,
    /// with a copy of every lower card of the suit moved or in a top unit?
    fn completable(&self, left: &[u8; NUM_COLS]) -> bool {
        let starts: [usize; NUM_COLS] = std::array::from_fn(|c| self.unit(c, left[c]));
        (0..NUM_COLS).any(|c| {
            let king = self.cols[c][starts[c]];
            if king % 13 != 12 {
                return false;
            }
            let lowest = self.cols[c][left[c] as usize - 1];
            (king - 12..lowest).all(|card| (0..NUM_COLS).any(|j| self.cols[j][starts[j]..].contains(&card)))
        })
    }
}

#[cfg(test)]
mod top_rank_tests {
    use super::*;
    use crate::game::Game;

    #[test]
    fn stuck_endgames_are_lost() {
        // Where the line player gave up on four-suit deal 30003: only runs
        // split onto other suits still move. The solver took 1.4M work.
        let stuck = "0;3/36,42,36,45,8,33,32;5/15,20,22,50,21,51,26,47,18,43,3,2,1,0;5/46,38,7,48,18,27,26,37,41,40,30,29,28,27;0/25;4/10,0,44,7,14,44,24,23,45,5,4,3,2,1,39,40,39,17;3/32,35,11,9,34,31,30,29,28,14,13,19,5,4,12,46;0/23,48,8,51,50;2/34,22,20,19,31,17,16,41;3/13,21,37,33,6,47,43,12,49;4/42,15,35,6,9,38,24,10,25,11,49,16";
        assert!(top_rank_certificate(&Game::from_position_text(4, stuck).unwrap()));
        // Deal 30002 just after its last deal, with 18 cards face down: the
        // solver did not refute it in 20M work.
        let dealt = "0;5/34,8,43,5,9,10,48,21,7,19,18,17,42,41,40,13,25,11,10,0;1/42,7,32,31,4,3,2,1,0,30;5/5,18,39,50,34,51,29,28,27,26,37,45,47;1/43,40,41;0/12,29,28,15,14,13,36,35,49;0/49,48,45,6,1,39,25,8;0/16,15,14,26,12,24,6,16;2/24,9,36,22,21,33,19,47,33,32,31,27;1/46,38,11,23,22,4,3,2,17,30,20;3/35,44,44,51,46,50,38,37,23,20";
        assert!(top_rank_certificate(&Game::from_position_text(4, dealt).unwrap()));
    }

    #[test]
    fn a_column_that_can_empty_is_not_certified() {
        // Kings on aces of the other suit, except a six that can move onto a seven.
        let mut cols: Vec<String> = (0..NUM_COLS).map(|c| format!("0/{},{}", (c % 2) * 13, ((c + 1) % 2) * 13 + 12)).collect();
        assert!(top_rank_certificate(&Game::from_position_text(2, &format!("0;{}", cols.join(";"))).unwrap()));
        cols[3] = "0/5".into();
        cols[4] = "0/13,19".into();
        assert!(!top_rank_certificate(&Game::from_position_text(2, &format!("0;{}", cols.join(";"))).unwrap()));
    }
}
