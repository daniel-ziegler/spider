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
    /// with a copy of every lower card of the suit moved, or in a top unit
    /// above its bottom card (which may have been split off)?
    fn completable(&self, left: &[u8; NUM_COLS]) -> bool {
        let starts: [usize; NUM_COLS] = std::array::from_fn(|c| self.unit(c, left[c]));
        (0..NUM_COLS).any(|c| {
            let king = self.cols[c][starts[c]];
            if king % 13 != 12 {
                return false;
            }
            let lowest = self.cols[c][left[c] as usize - 1];
            (king - 12..lowest).all(|card| (0..NUM_COLS).any(|j| self.cols[j][starts[j] + 1..].contains(&card)))
        })
    }
}

/// The top-rank certificate carried across deals and past the emptying of
/// columns, for any position: a search of a small game that every line of
/// real play maps onto up to the first suit completed. If it cannot
/// complete one, with all the deals, the position is lost.
///
/// Where no column is empty and the stock is, it is the game of
/// [`top_rank_certificate`], which has the argument: per column how many
/// cards have never moved, in units, and the ranks of the top cards.
///
/// *Empty columns.* A run put in an empty column uncovers the card it lay
/// on, and its bottom card is the column's until the column is emptied
/// again, which takes a top one rank above it. So the small game keeps the
/// rank at the bottom of each column emptied and refilled. It may put a
/// column's top unit in an empty column instead of on a top; put there any
/// card that has moved, or that is in a top unit above its bottom card,
/// uncovering a card one rank higher; and empty a refilled column when a
/// top is one rank above its bottom card.
///
/// *Deals.* A deal (no column being empty) puts a card on every column, and
/// what each lies on is not known here: the small game forgets where the
/// cards that moved went. It is known that the ranks under the ten dealt
/// cards are the ranks of the tops before the deal, and which cards could
/// have been the top of each column: the top unit's top card, a card
/// further down the unit if what is on it could have been split off, the
/// card at the bottom of a refilled column, or a card that has moved,
/// chained down from one of those. So the dealt cards become the tops, and a
/// dealt card comes off its column, onto a top one rank above it or into an
/// empty column, uncovering one of the ranks its column could have had and
/// that are not yet accounted for: the small game may choose which. If the
/// card under it could have been the next card of its suit it may also be
/// taken as part of that card's run, with no step. The cards of a column
/// come off from the top: those dealt onto it, last first, then its units.
///
/// *Completing a suit.* Possible, as far as the small game can tell, when
/// one of the suit's kings has moved, or is on top of what has not moved of
/// its column with only cards of its suit dealt onto it since, and every
/// lower card of the suit not in the king's unit has moved, is in a top
/// unit, or was dealt.
///
/// Returns whether the position is proved lost and the positions of the
/// small game looked at, `limit` at most before giving up.
pub fn lost_certificate(g: &crate::game::Game, limit: u64) -> (bool, u64) {
    let cols: Vec<Vec<u8>> = g.columns.iter().map(|c| c.iter().map(|k| k.0).collect()).collect();
    let deals = crate::solver::stock_deals(g);
    let r = lost(std::array::from_fn(|c| cols[c].as_slice()), g.face_down, &deals, limit);
    if std::env::var_os("SPIDER_CERT_DEBUG").is_some() {
        eprintln!("certificate with {} deals: {} ({} positions)", deals.len(), if r.0 { "no suit can be completed" } else { "a suit might be completed" }, r.1);
    }
    r
}

/// [`lost_certificate`] for these columns (bottom card first), `down[c]`
/// cards of column `c` face down, and these deals to come.
pub(crate) fn lost(cols: [&[u8]; NUM_COLS], down: [usize; NUM_COLS], deals: &[[u8; crate::game::DEAL_SIZE]], limit: u64) -> (bool, u64) {
    lost_unseen(cols, down, deals, &Unseen::default(), limit)
}

/// The cards a player has not seen: the lowest `hidden[c]` cards of column
/// `c` (what `cols[c]` has there is not looked at), which are some `cards[r]`
/// cards of each rank r, with values among `values` (a bit set).
#[derive(Default)]
pub struct Unseen {
    pub hidden: [usize; NUM_COLS],
    pub cards: [u8; 13],
    pub values: u64,
}

/// Whether a player who has seen only some of the cards can know the game
/// lost: [`lost_certificate`] with the cards never seen (face down, and not
/// turned up in any line since taken back) unknown, proving the position
/// lost whatever they are. Nothing is proved with unseen cards in the stock.
///
/// In the small game an unseen card is uncovered as a card of any rank that
/// the unseen cards have left, the small game choosing; it is then a unit of
/// its own, on the next unseen card. It can be any card of that rank among
/// the unseen ones when it comes to completing a suit.
///
/// `seen[c]` is how many of column `c`'s cards have never been seen;
/// `stock_seen` whether every card of the stock has been.
pub fn lost_for_all(g: &crate::game::Game, seen: [usize; NUM_COLS], stock_seen: bool, limit: u64) -> (bool, u64) {
    if !g.stock.is_empty() && !stock_seen {
        return (false, 0);
    }
    let mut cols: Vec<Vec<u8>> = g.columns.iter().map(|c| c.iter().map(|k| k.0).collect()).collect();
    let deals = crate::solver::stock_deals(g);
    let mut unseen = Unseen { hidden: seen, ..Default::default() };
    for c in 0..NUM_COLS {
        assert!(seen[c] <= g.face_down[c]);
        for v in &mut cols[c][..seen[c]] {
            unseen.cards[(*v % 13) as usize] += 1;
            unseen.values |= 1 << *v;
            *v = 255; // which card is where is not for the proof to know
        }
    }
    lost_unseen(std::array::from_fn(|c| cols[c].as_slice()), g.face_down, &deals, &unseen, limit)
}

fn lost_unseen(cols: [&[u8]; NUM_COLS], down: [usize; NUM_COLS], deals: &[[u8; crate::game::DEAL_SIZE]], unseen: &Unseen, limit: u64) -> (bool, u64) {
    if deals.len() > MAX_DEALS {
        return (false, 0);
    }
    let mut st = Dealt {
        left: [0; NUM_COLS],
        base: [0; NUM_COLS],
        tops: [0; 14],
        ever: 0,
        deals: 0,
        in_place: [0; MAX_DEALS],
        pool: [[0; 13]; MAX_DEALS],
        under: None,
        shown: [0; NUM_COLS],
        unseen: unseen.cards,
        unseen_moved: 0,
    };
    for c in 0..NUM_COLS {
        st.left[c] = cols[c].len() as u8;
        match cols[c].last() {
            Some(&v) => {
                st.tops[(v % 13) as usize] += 1;
                st.ever |= 1 << (v % 13);
            }
            None => st.ever = ANY_RANK,
        }
    }
    let mut game = Dealing { cols, down, deals, hidden: unseen.hidden, values: unseen.values, seen: Default::default(), nodes: 0, limit };
    let event = game.event(st);
    (!event, game.nodes)
}

const MAX_DEALS: usize = 5;
const ANY_RANK: u16 = 0x3FFF;

/// A position of the small game.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Dealt {
    /// Per column, how many of its cards have never moved.
    left: [u8; NUM_COLS],
    /// Per column with none of those, 0 if it is empty, else one more than
    /// the rank of the card now at its bottom.
    base: [u8; NUM_COLS],
    /// How many top cards have each rank.
    tops: [u8; 14],
    /// The ranks the tops have ever had, as a bit set (all of them once a
    /// column has been empty: then any run could have been split).
    ever: u16,
    /// Deals made.
    deals: u8,
    /// Per deal made, the columns whose card from it is still where it was dealt.
    in_place: [u16; MAX_DEALS],
    /// Per deal made, how many of the ranks it covered are not yet accounted for.
    pool: [[u8; 13]; MAX_DEALS],
    /// Per deal made and column, the cards (a bit set) its card may lie on
    /// (nothing before the first deal: this is most of a position).
    under: Option<std::rc::Rc<[[u64; NUM_COLS]; MAX_DEALS]>>,
    /// Per column whose top card that has not moved was unseen, one more
    /// than the rank it was uncovered as.
    shown: [u8; NUM_COLS],
    /// How many unseen cards of each rank are still to be uncovered.
    unseen: [u8; 13],
    /// The ranks of unseen cards that have been uncovered and have moved.
    unseen_moved: u16,
}

struct Dealing<'a> {
    cols: [&'a [u8]; NUM_COLS],
    down: [usize; NUM_COLS],
    deals: &'a [[u8; crate::game::DEAL_SIZE]],
    /// How many cards at the bottom of each column are unseen, and the
    /// cards (a bit set) they may be.
    hidden: [usize; NUM_COLS],
    values: u64,
    seen: std::collections::HashSet<Dealt, std::hash::BuildHasherDefault<Mixer>>,
    nodes: u64,
    limit: u64,
}

/// A quick hasher for the positions.
#[derive(Default)]
struct Mixer(u64);

impl std::hash::Hasher for Mixer {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
        self.0 ^= self.0 >> 29;
    }
}

/// The cards of rank `rank` in a bit set of cards.
fn of_rank(cards: u64, rank: usize) -> u64 {
    cards & (0x0000_0080_0400_2001u64 << rank)
}

/// What a unit lies on.
#[derive(Clone, Copy, PartialEq)]
enum Under {
    /// Nothing: it is at the bottom of its column.
    Nothing,
    /// A card of this rank.
    Rank(usize),
    /// A card nobody has seen.
    Unseen,
}

impl Dealing<'_> {
    fn unit(&self, c: usize, left: u8) -> usize {
        let col = self.cols[c];
        let mut u = left as usize - 1;
        while u > self.down[c] && col[u - 1] == col[u] + 1 && col[u] % 13 != 12 {
            u -= 1;
        }
        u
    }

    /// The top unit of what has not moved of column `c` (which has some):
    /// where it starts, the rank of its bottom card, and what it lies on.
    fn top_unit(&self, st: &Dealt, c: usize) -> (usize, usize, Under) {
        let left = st.left[c] as usize;
        let (u, rank) = if left <= self.hidden[c] {
            (left - 1, st.shown[c] as usize - 1) // an unseen card, uncovered
        } else {
            let u = self.unit(c, st.left[c]);
            (u, (self.cols[c][u] % 13) as usize)
        };
        let under = match u {
            0 => Under::Nothing,
            _ if u <= self.hidden[c] => Under::Unseen,
            _ => Under::Rank((self.cols[c][u - 1] % 13) as usize),
        };
        (u, rank, under)
    }

    /// The last deal whose card on column `c` is still in place.
    fn dealt_on(&self, st: &Dealt, c: usize) -> Option<usize> {
        (0..st.deals as usize).rev().find(|&j| st.in_place[j] >> c & 1 == 1)
    }

    /// The cards of column `c` that may be the top of what has not moved of
    /// it: the top unit's top card, and those under a place where it could
    /// have been split.
    fn stem_tops(&self, st: &Dealt, c: usize) -> u64 {
        let (col, left) = (self.cols[c], st.left[c] as usize);
        if left <= self.hidden[c] {
            return of_rank(self.values, st.shown[c] as usize - 1);
        }
        (self.unit(c, st.left[c])..left).filter(|&i| i == left - 1 || st.ever >> (col[i + 1] % 13 + 1) & 1 == 1).fold(0, |a, i| a | 1 << col[i])
    }

    /// The cards that may have moved: those of the columns above what has
    /// never moved, those of a top unit above a place where it could have
    /// been split, the dealt cards no longer in place, and whatever the
    /// unseen cards that have moved may be.
    fn moved(&self, st: &Dealt) -> u64 {
        let mut cards = 0u64;
        for c in 0..NUM_COLS {
            let (col, left) = (self.cols[c], st.left[c] as usize);
            for &v in &col[left.max(self.hidden[c])..] {
                cards |= 1 << v;
            }
            if left > self.hidden[c] {
                let u = self.unit(c, st.left[c]);
                if let Some(i) = (u + 1..left).find(|&i| st.ever >> (col[i] % 13 + 1) & 1 == 1) {
                    for &v in &col[i..left] {
                        cards |= 1 << v;
                    }
                }
            }
        }
        for j in 0..st.deals as usize {
            for c in 0..NUM_COLS {
                if st.in_place[j] >> c & 1 == 0 {
                    cards |= 1 << self.deals[j][c];
                }
            }
        }
        for rank in 0..13 {
            if st.unseen_moved >> rank & 1 == 1 {
                cards |= of_rank(self.values, rank);
            }
        }
        cards
    }

    /// Might a suit be completed from `start`? Says yes when it gives up.
    fn event(&mut self, start: Dealt) -> bool {
        // (A stack of positions to look at: the search can go too deep to recurse.)
        let mut stack = vec![start];
        while let Some(mut st) = stack.pop() {
            self.nodes += 1;
            if self.nodes > self.limit {
                return true;
            }
            // Depth first, the steps in the order `step` gives them.
            let from = stack.len();
            if self.step(&mut st, &mut stack) {
                return true;
            }
            stack[from..].reverse();
        }
        false
    }

    /// The positions after the top unit of column `c` has come off (`t`,
    /// but for what it uncovers), onto `stack`: one if that is known, else
    /// one for each rank an unseen card may have.
    fn uncover(&self, mut t: Dealt, c: usize, u: usize, under: Under, stack: &mut Vec<Dealt>) {
        if (t.left[c] as usize) <= self.hidden[c] {
            t.unseen_moved |= 1 << (t.shown[c] - 1); // the unit was an unseen card
        }
        t.left[c] = u as u8;
        t.shown[c] = 0;
        match under {
            Under::Nothing => stack.push(t),
            Under::Rank(a) => {
                t.tops[a] += 1;
                t.ever |= 1 << a;
                stack.push(t);
            }
            Under::Unseen => {
                for rank in 0..13 {
                    if t.unseen[rank] > 0 {
                        let mut t = t.clone();
                        t.unseen[rank] -= 1;
                        t.shown[c] = rank as u8 + 1;
                        t.tops[rank] += 1;
                        t.ever |= 1 << rank;
                        stack.push(t);
                    }
                }
            }
        }
    }

    /// Look at one position: whether a suit might be completed in it, and
    /// if not and it is new, the positions one step on, onto `stack`.
    fn step(&mut self, st: &mut Dealt, stack: &mut Vec<Dealt>) -> bool {
        // Units that come off onto a top without changing the tops cost nothing.
        loop {
            let mut free = false;
            for c in 0..NUM_COLS {
                if st.left[c] == 0 || self.dealt_on(st, c).is_some() {
                    continue;
                }
                let (u, rank, under) = self.top_unit(st, c);
                if st.tops[rank + 1] > 0 && under == Under::Rank(rank + 1) {
                    st.left[c] = u as u8;
                    free = true;
                }
            }
            if !free {
                break;
            }
        }
        let dealt_all = st.deals as usize == self.deals.len();
        // After the last deal, columns with nothing that never moved and
        // nothing dealt in place are alike.
        let alike = |st: &Dealt, c: usize| st.left[c] == 0 && self.dealt_on(st, c).is_none();
        if dealt_all && st.left.contains(&0) {
            let (mut which, mut bases, mut n) = ([0; NUM_COLS], [0u8; NUM_COLS], 0);
            for c in 0..NUM_COLS {
                if alike(st, c) {
                    (which[n], bases[n]) = (c, st.base[c]);
                    n += 1;
                }
            }
            bases[..n].sort_unstable();
            for i in 0..n {
                st.base[which[i]] = bases[i];
            }
        }
        let (mut empties, mut n) = ([0; NUM_COLS], 0);
        for c in 0..NUM_COLS {
            if st.left[c] == 0 && st.base[c] == 0 {
                empties[n] = c;
                n += 1;
            }
        }
        let mut empty = &empties[..n];
        if !empty.is_empty() {
            st.ever = ANY_RANK;
        }
        let moved = self.moved(st);
        if self.completable(st, moved) {
            if std::env::var_os("SPIDER_CERT_DEBUG").is_some() {
                eprintln!("  a suit might be completed with left {:?} bottoms {:?} tops {:?} after {} deals", st.left, st.base, &st.tops[..13], st.deals);
            }
            return true;
        }
        if !self.seen.insert(st.clone()) {
            return false;
        }
        let can_deal = !dealt_all && empty.is_empty();
        if dealt_all {
            empty = &empty[..empty.len().min(1)]; // empty columns are alike too
        }
        for c in 0..NUM_COLS {
            if let Some(j) = self.dealt_on(st, c) {
                // The card dealt onto the column.
                let card = self.deals[j][c];
                let rank = (card % 13) as usize;
                // As part of the run of the next card of its suit, if it may lie on one.
                let under = st.under.as_ref().expect("dealt")[j][c];
                if rank < 12 && st.pool[j][rank + 1] > 0 && under >> (card + 1) & 1 == 1 {
                    let mut t = st.clone();
                    t.in_place[j] &= !(1 << c);
                    t.pool[j][rank + 1] -= 1;
                    stack.push(t);
                }
                for gives in 0..13 {
                    if st.pool[j][gives] == 0 || of_rank(under, gives) == 0 {
                        continue;
                    }
                    let mut t = st.clone();
                    t.in_place[j] &= !(1 << c);
                    t.pool[j][gives] -= 1;
                    t.tops[gives] += 1;
                    t.ever |= 1 << gives;
                    if st.tops[rank + 1] > 0 {
                        let mut t = t.clone();
                        t.tops[rank + 1] -= 1;
                        stack.push(t);
                    }
                    for &e in empty {
                        let mut t = t.clone();
                        t.base[e] = rank as u8 + 1;
                        stack.push(t);
                    }
                }
                continue;
            }
            if st.left[c] == 0 {
                // A refilled column is emptied.
                let b = st.base[c] as usize;
                if b > 0 && st.tops[b] > 0 {
                    let mut t = st.clone();
                    t.base[c] = 0;
                    t.tops[b] -= 1;
                    stack.push(t);
                }
                continue;
            }
            let (u, rank, under) = self.top_unit(st, c);
            if st.tops[rank + 1] > 0 {
                // The top unit goes onto a top.
                let mut t = st.clone();
                t.tops[rank + 1] -= 1;
                self.uncover(t, c, u, under, stack);
            }
            if under != Under::Nothing {
                // The top unit goes into an empty column.
                for &e in empty {
                    let mut t = st.clone();
                    t.base[e] = rank as u8 + 1;
                    self.uncover(t, c, u, under, stack);
                }
            }
        }
        for &e in empty {
            // A card that has moved, or of a top unit, goes into an empty
            // column, uncovering a card one rank higher.
            let mut loose = moved;
            for c in 0..NUM_COLS {
                if st.left[c] as usize > self.hidden[c] && self.dealt_on(st, c).is_none() {
                    for &v in &self.cols[c][self.unit(c, st.left[c]) + 1..st.left[c] as usize] {
                        loose |= 1 << v;
                    }
                }
            }
            for rank in 0..12 {
                if of_rank(loose, rank) != 0 {
                    let mut t = st.clone();
                    t.base[e] = rank as u8 + 1;
                    t.tops[rank + 1] += 1;
                    stack.push(t);
                }
            }
        }
        if can_deal {
            let j = st.deals as usize;
            let mut t = st.clone();
            let mut under = st.under.as_deref().copied().unwrap_or([[0; NUM_COLS]; MAX_DEALS]);
            for c in 0..NUM_COLS {
                // What may be on top of the column: its dealt card, a card
                // of its top unit or the one at its bottom if it was
                // refilled, or moved cards chained down from those.
                let mut top = match self.dealt_on(st, c) {
                    Some(k) => 1u64 << self.deals[k][c],
                    None if st.left[c] > 0 => self.stem_tops(st, c),
                    None => of_rank(moved, st.base[c] as usize - 1),
                };
                for rank in (1..13).rev() {
                    if of_rank(top, rank) != 0 {
                        top |= of_rank(moved, rank - 1);
                    }
                }
                under[j][c] = top;
            }
            t.under = Some(std::rc::Rc::new(under));
            t.pool[j].copy_from_slice(&st.tops[..13]);
            t.tops = [0; 14];
            for c in 0..NUM_COLS {
                let rank = self.deals[j][c] % 13;
                t.tops[rank as usize] += 1;
                t.ever |= 1 << rank;
            }
            t.in_place[j] = (1 << NUM_COLS) - 1;
            t.deals += 1;
            stack.push(t);
        }
        false
    }

    /// Might some suit be completed (see [`lost_certificate`])? Every card
    /// of it that is not in place on its king has to have moved onto the
    /// run by then, unless it was dealt there.
    fn completable(&self, st: &Dealt, moved: u64) -> bool {
        // The cards dealt and in place on columns emptied and refilled,
        // where a king that moved may be.
        let mut refilled = 0u64;
        for j in 0..st.deals as usize {
            for c in 0..NUM_COLS {
                if st.left[c] == 0 && st.in_place[j] >> c & 1 == 1 {
                    refilled |= 1 << self.deals[j][c];
                }
            }
        }
        (0..4u8).any(|suit| {
            let (king, ace) = (suit * 13 + 12, suit * 13);
            let all = |lowest: u8, have: u64| (ace..lowest).all(|card| have >> card & 1 == 1);
            if moved >> king & 1 == 1 && all(king, moved | refilled) {
                return true;
            }
            (0..NUM_COLS).any(|c| {
                // The cards dealt onto the column and in place, last first:
                // a king of the suit there, or under them all, will do if
                // those above it are of the suit.
                let mut dealt = 0u64;
                for j in (0..st.deals as usize).rev().filter(|&j| st.in_place[j] >> c & 1 == 1) {
                    let v = self.deals[j][c];
                    if v == king && all(king, moved | dealt) {
                        return true;
                    }
                    if v / 13 != suit {
                        return false;
                    }
                    dealt |= 1 << v;
                }
                let left = st.left[c] as usize;
                if left == 0 {
                    false
                } else if left <= self.hidden[c] {
                    // An unseen card uncovered as a king may be this one.
                    st.shown[c] == 13 && self.values >> king & 1 == 1 && all(king, moved | dealt)
                } else {
                    self.cols[c][self.unit(c, st.left[c])] == king && all(self.cols[c][left - 1], moved | dealt)
                }
            })
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
    fn lost_whatever_is_face_down() {
        // The first position above again: nothing that can still move ever
        // turns a card up, so it is lost without looking at them. Not so a
        // new deal.
        let stuck = "0;3/36,42,36,45,8,33,32;5/15,20,22,50,21,51,26,47,18,43,3,2,1,0;5/46,38,7,48,18,27,26,37,41,40,30,29,28,27;0/25;4/10,0,44,7,14,44,24,23,45,5,4,3,2,1,39,40,39,17;3/32,35,11,9,34,31,30,29,28,14,13,19,5,4,12,46;0/23,48,8,51,50;2/34,22,20,19,31,17,16,41;3/13,21,37,33,6,47,43,12,49;4/42,15,35,6,9,38,24,10,25,11,49,16";
        let g = Game::from_position_text(4, stuck).unwrap();
        assert!(lost_for_all(&g, g.face_down, true, 100_000).0);
        assert!(lost_certificate(&g, 100_000).0);
        let g = Game::new(4, 1);
        assert!(!lost_for_all(&g, g.face_down, false, 100_000).0);
        assert!(!lost_for_all(&g, g.face_down, true, 100_000).0);
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
