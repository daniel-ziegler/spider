//! Spider solitaire rules, state, and undo/redo history.
//!
//! Standard two-deck (104 card) Spider: ten tableau columns, five stock deals
//! of ten cards, complete K..A same-suit runs are removed automatically.

use std::fmt;

pub const NUM_COLS: usize = 10;
pub const DEAL_SIZE: usize = 10;
pub const NUM_DEALS: usize = 5;
pub const TOTAL_CARDS: usize = 104;

/// A card packed as `suit * 13 + rank`. Rank 0 = Ace .. 12 = King.
/// Suits: 0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Card(pub u8);

impl Card {
    pub fn new(suit: u8, rank: u8) -> Card {
        debug_assert!(suit < 4 && rank < 13);
        Card(suit * 13 + rank)
    }
    #[inline]
    pub fn suit(self) -> u8 {
        self.0 / 13
    }
    #[inline]
    pub fn rank(self) -> u8 {
        self.0 % 13
    }
    pub fn rank_str(self) -> &'static str {
        const R: [&str; 13] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
        R[self.rank() as usize]
    }
    pub fn suit_char(self) -> char {
        const S: [char; 4] = ['♠', '♥', '♦', '♣'];
        S[self.suit() as usize]
    }
    pub fn is_red(self) -> bool {
        matches!(self.suit(), 1 | 2)
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.rank_str(), self.suit_char())
    }
}

/// A player action.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Move {
    /// Move the top `count` cards of column `from` onto column `to`.
    Move { from: usize, to: usize, count: usize },
    /// Deal one card from the stock onto every column.
    Deal,
}

impl Move {
    /// Compact text form: `d` for a deal, `F>T:N` for moving N cards from
    /// column F to column T (0-based). See [`Move::parse`].
    pub fn encode(self) -> String {
        match self {
            Move::Deal => "d".into(),
            Move::Move { from, to, count } => format!("{from}>{to}:{count}"),
        }
    }

    pub fn parse(s: &str) -> Option<Move> {
        if s == "d" {
            return Some(Move::Deal);
        }
        let (from, rest) = s.split_once('>')?;
        let (to, count) = rest.split_once(':')?;
        Some(Move::Move { from: from.parse().ok()?, to: to.parse().ok()?, count: count.parse().ok()? })
    }
}

/// Comma-separated [`Move::encode`] list.
pub fn encode_moves(moves: impl IntoIterator<Item = Move>) -> String {
    moves.into_iter().map(Move::encode).collect::<Vec<_>>().join(",")
}

pub fn parse_moves(s: &str) -> Result<Vec<Move>, String> {
    s.split(',').filter(|t| !t.is_empty()).map(|t| Move::parse(t).ok_or_else(|| format!("bad move {t:?}"))).collect()
}

/// Everything needed to reverse one applied move.
#[derive(Clone, Debug)]
pub struct Record {
    pub mv: Move,
    /// Columns whose top face-down card was turned face up by this move.
    pub flips: Vec<usize>,
    /// Completed suit runs removed by this move: (column, suit), in removal order.
    pub completed: Vec<(usize, u8)>,
}

impl Record {
    /// Did this move reveal previously hidden information (turn a card over or deal)?
    pub fn reveals_info(&self) -> bool {
        matches!(self.mv, Move::Deal) || !self.flips.is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct Game {
    pub columns: Vec<Vec<Card>>,
    /// Number of face-down cards at the bottom of each column.
    pub face_down: [usize; NUM_COLS],
    /// Remaining stock; cards are dealt from the *end* (`pop`).
    pub stock: Vec<Card>,
    /// Suits of completed runs, in completion order.
    pub completed: Vec<u8>,
    pub suits: u8,
    pub seed: u64,
    history: Vec<Record>,
    redo_stack: Vec<Record>,
}

/// splitmix64: tiny deterministic PRNG so seeds are stable across platforms/versions.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

impl Game {
    /// Create a new shuffled game. `suits` must be 1, 2 or 4.
    pub fn new(suits: u8, seed: u64) -> Game {
        assert!(matches!(suits, 1 | 2 | 4), "suits must be 1, 2 or 4");
        let mut deck: Vec<Card> = Vec::with_capacity(TOTAL_CARDS);
        for set in 0..8u8 {
            let suit = match suits {
                1 => 0,
                2 => set % 2,
                _ => set % 4,
            };
            for rank in 0..13 {
                deck.push(Card::new(suit, rank));
            }
        }
        let mut rng = Rng(seed ^ 0xD1B54A32D192ED03);
        for i in (1..deck.len()).rev() {
            let j = rng.below(i + 1);
            deck.swap(i, j);
        }

        let mut columns: Vec<Vec<Card>> = (0..NUM_COLS).map(|_| Vec::with_capacity(32)).collect();
        for i in 0..54 {
            columns[i % NUM_COLS].push(deck.pop().unwrap());
        }
        let mut face_down = [0; NUM_COLS];
        for (c, col) in columns.iter().enumerate() {
            face_down[c] = col.len() - 1;
        }
        Game {
            columns,
            face_down,
            stock: deck,
            completed: Vec::new(),
            suits,
            seed,
            history: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn deals_remaining(&self) -> usize {
        self.stock.len() / DEAL_SIZE
    }
    pub fn move_count(&self) -> usize {
        self.history.len()
    }
    pub fn score(&self) -> i64 {
        500 - self.history.len() as i64 + 100 * self.completed.len() as i64
    }
    pub fn is_won(&self) -> bool {
        self.completed.len() == 8
    }
    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }
    pub fn history(&self) -> &[Record] {
        &self.history
    }
    /// Moves that `redo` would replay, in redo order (next first).
    pub fn redo_moves(&self) -> Vec<Move> {
        self.redo_stack.iter().rev().map(|r| r.mv).collect()
    }
    /// Would the next undo take back a move that revealed information?
    pub fn undo_reveals_info(&self) -> bool {
        self.history.last().is_some_and(|r| r.reveals_info())
    }
    pub fn last_move(&self) -> Option<Move> {
        self.history.last().map(|r| r.mv)
    }

    #[inline]
    pub fn face_up_count(&self, col: usize) -> usize {
        self.columns[col].len() - self.face_down[col]
    }

    /// Length of the longest movable run (same suit, descending toward the top)
    /// at the top of `col`, honouring the face-down boundary.
    pub fn run_len(&self, col: usize) -> usize {
        run_len(&self.columns[col], self.face_down[col])
    }

    /// Check legality of moving `count` cards from `from` to `to`.
    pub fn check_move(&self, from: usize, to: usize, count: usize) -> Result<(), &'static str> {
        if from >= NUM_COLS || to >= NUM_COLS {
            return Err("no such column");
        }
        if from == to {
            return Err("source and destination are the same column");
        }
        if count == 0 {
            return Err("nothing selected");
        }
        if count > self.run_len(from) {
            return Err("those cards are not a same-suit descending run");
        }
        let src = &self.columns[from];
        let bottom = src[src.len() - count];
        if let Some(&top) = self.columns[to].last() {
            if top.rank() != bottom.rank() + 1 {
                return Err("destination card must be one rank higher");
            }
        }
        Ok(())
    }

    /// For a non-empty destination, the number of cards that would have to move
    /// from `from` to `to` to be legal (if any). Empty destinations return `None`
    /// because any run length is legal.
    pub fn required_count(&self, from: usize, to: usize) -> Option<usize> {
        let top = *self.columns[to].last()?;
        let src_top = *self.columns[from].last()?;
        let k = top.rank() as i32 - src_top.rank() as i32;
        if k >= 1 && k as usize <= self.run_len(from) {
            Some(k as usize)
        } else {
            None
        }
    }

    pub fn check_deal(&self) -> Result<(), &'static str> {
        if self.stock.is_empty() {
            return Err("the stock is empty");
        }
        if self.columns.iter().any(|c| c.is_empty()) {
            return Err("cannot deal while a column is empty");
        }
        Ok(())
    }

    /// Apply a move, recording it for undo. Clears the redo stack.
    pub fn apply(&mut self, mv: Move) -> Result<(), &'static str> {
        let rec = self.apply_raw(mv)?;
        self.history.push(rec);
        self.redo_stack.clear();
        Ok(())
    }

    fn apply_raw(&mut self, mv: Move) -> Result<Record, &'static str> {
        let mut rec = Record { mv, flips: Vec::new(), completed: Vec::new() };
        match mv {
            Move::Move { from, to, count } => {
                self.check_move(from, to, count)?;
                let at = self.columns[from].len() - count;
                let cards: Vec<Card> = self.columns[from].drain(at..).collect();
                self.columns[to].extend(cards);
                self.flip_if_needed(from, &mut rec);
                self.collect_complete(to, &mut rec);
            }
            Move::Deal => {
                self.check_deal()?;
                for col in 0..NUM_COLS {
                    let c = self.stock.pop().unwrap();
                    self.columns[col].push(c);
                }
                for col in 0..NUM_COLS {
                    self.collect_complete(col, &mut rec);
                }
            }
        }
        Ok(rec)
    }

    fn flip_if_needed(&mut self, col: usize, rec: &mut Record) {
        let len = self.columns[col].len();
        if len > 0 && self.face_down[col] == len {
            self.face_down[col] -= 1;
            rec.flips.push(col);
        }
    }

    fn collect_complete(&mut self, col: usize, rec: &mut Record) {
        let c = &self.columns[col];
        if let Some(&top) = c.last() {
            if top.rank() == 0 && self.run_len(col) >= 13 {
                let suit = top.suit();
                let at = c.len() - 13;
                self.columns[col].truncate(at);
                self.completed.push(suit);
                rec.completed.push((col, suit));
                self.flip_if_needed(col, rec);
            }
        }
    }

    fn unapply(&mut self, rec: &Record) {
        for &(col, suit) in rec.completed.iter().rev() {
            let popped = self.completed.pop();
            debug_assert_eq!(popped, Some(suit));
            for rank in (0..13).rev() {
                self.columns[col].push(Card::new(suit, rank));
            }
        }
        for &col in rec.flips.iter().rev() {
            self.face_down[col] += 1;
        }
        match rec.mv {
            Move::Move { from, to, count } => {
                let at = self.columns[to].len() - count;
                let cards: Vec<Card> = self.columns[to].drain(at..).collect();
                self.columns[from].extend(cards);
            }
            Move::Deal => {
                for col in (0..NUM_COLS).rev() {
                    let c = self.columns[col].pop().unwrap();
                    self.stock.push(c);
                }
            }
        }
    }

    /// Undo the last move. Returns the undone record, if any.
    pub fn undo(&mut self) -> Option<Record> {
        let rec = self.history.pop()?;
        self.unapply(&rec);
        self.redo_stack.push(rec.clone());
        Some(rec)
    }

    /// Redo the most recently undone move.
    pub fn redo(&mut self) -> Option<Record> {
        let rec = self.redo_stack.pop()?;
        let new_rec = self.apply_raw(rec.mv).expect("redo of a previously legal move");
        debug_assert_eq!(new_rec.flips, rec.flips);
        self.history.push(new_rec.clone());
        Some(new_rec)
    }

    /// Every legal player move, ranked greedily for use as hints.
    ///
    /// Each move is scored by what it does at the destination plus what it
    /// frees at the source, so for example a run moved off a cross-suit
    /// linkage onto a same-suit one ranks above a run moved off a non-linkage
    /// (a card that is not one rank higher) onto a cross-suit linkage, which in
    /// turn ranks above a plain cross-to-cross shuffle. Suit completions come
    /// first, moves that break a same-suit run or spend an empty column come
    /// last, and the deal is after all card moves. Only whole movable runs are
    /// offered for empty columns.
    pub fn hint_moves(&self) -> Vec<Move> {
        let mut out: Vec<(i32, usize, Move)> = Vec::new();
        let first_empty = self.columns.iter().position(|c| c.is_empty());
        for from in 0..NUM_COLS {
            let run = self.run_len(from);
            if run == 0 {
                continue;
            }
            let src = &self.columns[from];
            for to in 0..NUM_COLS {
                if to == from {
                    continue;
                }
                let count = if self.columns[to].is_empty() {
                    if first_empty != Some(to) || run == src.len() {
                        continue;
                    }
                    run
                } else {
                    match self.required_count(from, to) {
                        Some(k) => k,
                        None => continue,
                    }
                };
                out.push((self.hint_score(from, to, count), count, Move::Move { from, to, count }));
            }
        }
        // Best score first; among equals, the longer run.
        out.sort_by_key(|&(score, count, _)| (-score, std::cmp::Reverse(count)));
        let mut moves: Vec<Move> = out.into_iter().map(|(_, _, m)| m).collect();
        if self.check_deal().is_ok() {
            moves.push(Move::Deal);
        }
        moves
    }

    /// Greedy value of moving `count` cards from `from` to `to`.
    ///
    /// Destination: completes a suit +100, same-suit linkage +15, cross-suit
    /// linkage 0, empty column -15.
    /// Source (what the bottom card was sitting on): a face-down card that
    /// will flip +12, nothing (column becomes empty) +10, a non-linkage +8,
    /// a cross-suit linkage 0, a same-suit linkage -20 (breaks a run).
    fn hint_score(&self, from: usize, to: usize, count: usize) -> i32 {
        let src = &self.columns[from];
        let bottom = src[src.len() - count];
        let dest = &self.columns[to];
        let dst_score = match dest.last() {
            None => -15,
            Some(top) if top.suit() == bottom.suit() => {
                // The joined run is K..A exactly when it starts at the ace and
                // has thirteen cards.
                if bottom.rank() == 0 && run_len(dest, self.face_down[to]) + count == 13 {
                    100
                } else {
                    15
                }
            }
            Some(_) => 0,
        };
        let src_score = if count == src.len() {
            10
        } else if count == self.face_up_count(from) {
            12
        } else {
            let parent = src[src.len() - count - 1];
            if parent.rank() != bottom.rank() + 1 {
                8
            } else if parent.suit() == bottom.suit() {
                -20
            } else {
                0
            }
        };
        dst_score + src_score
    }

    /// Any legal move at all? (Used to report a stuck game.)
    pub fn has_any_move(&self) -> bool {
        if self.check_deal().is_ok() {
            return true;
        }
        for from in 0..NUM_COLS {
            if self.columns[from].is_empty() {
                continue;
            }
            for to in 0..NUM_COLS {
                if to == from {
                    continue;
                }
                if self.columns[to].is_empty() || self.required_count(from, to).is_some() {
                    return true;
                }
            }
        }
        false
    }
}

/// Longest same-suit descending run at the top of `col`, not crossing into the
/// first `face_down` cards.
pub fn run_len(col: &[Card], face_down: usize) -> usize {
    let n = col.len();
    if n == face_down {
        return 0;
    }
    let mut k = 1;
    while n - k > face_down {
        let upper = col[n - k - 1];
        let lower = col[n - k];
        if upper.suit() == lower.suit() && upper.rank() == lower.rank() + 1 {
            k += 1;
        } else {
            break;
        }
    }
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deal_layout() {
        let g = Game::new(4, 1);
        let total: usize = g.columns.iter().map(|c| c.len()).sum::<usize>() + g.stock.len();
        assert_eq!(total, TOTAL_CARDS);
        for c in 0..NUM_COLS {
            assert_eq!(g.columns[c].len(), if c < 4 { 6 } else { 5 });
            assert_eq!(g.face_down[c], g.columns[c].len() - 1);
        }
        assert_eq!(g.deals_remaining(), 5);
    }

    #[test]
    fn seed_is_deterministic() {
        let a = Game::new(2, 42);
        let b = Game::new(2, 42);
        assert_eq!(a.columns, b.columns);
        assert_eq!(a.stock, b.stock);
    }

    fn empty_game() -> Game {
        let mut g = Game::new(1, 0);
        for c in g.columns.iter_mut() {
            c.clear();
        }
        g.face_down = [0; NUM_COLS];
        g.stock.clear();
        g
    }

    #[test]
    fn move_flip_complete_undo_redo() {
        let mut g = empty_game();
        // Column 0: hidden 5♥, then K♠..2♠ face up. Column 1: A♠ on hidden 9♣.
        g.columns[0].push(Card::new(1, 4));
        for rank in (1..13).rev() {
            g.columns[0].push(Card::new(0, rank));
        }
        g.face_down[0] = 1;
        g.columns[1].push(Card::new(3, 8));
        g.columns[1].push(Card::new(0, 0));
        g.face_down[1] = 1;

        assert_eq!(g.run_len(0), 12);
        assert_eq!(g.required_count(1, 0), Some(1));
        assert!(g.check_move(0, 1, 3).is_err());

        g.apply(Move::Move { from: 1, to: 0, count: 1 }).unwrap();
        // Run completes: column 0 loses 12 + 1 cards, exposes 5♥; column 1 flips 9♣.
        assert_eq!(g.completed, vec![0]);
        assert_eq!(g.columns[0], vec![Card::new(1, 4)]);
        assert_eq!(g.face_down[0], 0);
        assert_eq!(g.columns[1], vec![Card::new(3, 8)]);
        assert_eq!(g.face_down[1], 0);
        let rec = g.history().last().unwrap().clone();
        assert!(rec.reveals_info());
        assert_eq!(rec.flips, vec![1, 0]);

        let before = g.clone();
        g.undo().unwrap();
        assert_eq!(g.completed, Vec::<u8>::new());
        assert_eq!(g.columns[0].len(), 13);
        assert_eq!(g.face_down, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert!(g.can_redo());
        g.redo().unwrap();
        assert_eq!(g.columns, before.columns);
        assert_eq!(g.face_down, before.face_down);
        assert_eq!(g.completed, before.completed);
    }

    #[test]
    fn deal_and_undo() {
        let mut g = Game::new(2, 7);
        let before = g.clone();
        assert!(g.apply(Move::Deal).is_ok());
        assert_eq!(g.deals_remaining(), 4);
        assert!(g.undo_reveals_info());
        g.undo();
        assert_eq!(g.columns, before.columns);
        assert_eq!(g.stock, before.stock);
        g.redo();
        assert_eq!(g.stock.len(), 40);
        // No dealing onto an empty column.
        let mut e = empty_game();
        e.stock = (0..20).map(|i| Card::new(0, i % 13)).collect();
        assert!(e.apply(Move::Deal).is_err());
    }
}
