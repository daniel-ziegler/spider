//! FreeCell rules, to check wins: a port of `static/freecell.js`, which
//! describes them (the cards, Microsoft's deal numbers, the moves, and the
//! cards that go to the foundations by themselves after every move).

pub const COLS: usize = 8;
pub const CELLS: usize = 4;
/// The place that means the foundations; columns are 0-7 and free cells 8-11.
pub const HOME: usize = COLS + CELLS;
pub const MAX_DEAL: u64 = (1 << 31) - 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub from: usize,
    pub to: usize,
    pub count: usize,
}

/// Moves as the client writes them: `from>to:count`, comma separated.
pub fn parse_moves(s: &str) -> Result<Vec<Move>, String> {
    s.split(',')
        .filter(|t| !t.is_empty())
        .map(|t| {
            let (from, rest) = t.split_once('>')?;
            let (to, count) = rest.split_once(':')?;
            Some(Move { from: from.parse().ok()?, to: to.parse().ok()?, count: count.parse().ok()? })
        })
        .map(|m| m.ok_or_else(|| "bad move list".to_string()))
        .collect()
}

fn suit(card: u8) -> usize {
    (card / 13) as usize
}

fn rank(card: u8) -> u8 {
    card % 13
}

fn is_red(card: u8) -> bool {
    matches!(suit(card), 1 | 2)
}

fn follows(parent: u8, card: u8) -> bool {
    rank(parent) == rank(card) + 1 && is_red(parent) != is_red(card)
}

pub struct Game {
    pub columns: [Vec<u8>; COLS],
    pub cells: [Option<u8>; CELLS],
    pub found: [u8; 4],
}

impl Game {
    pub fn new(seed: u32) -> Game {
        let mut deck: Vec<u8> = (0..52u8).map(|i| (3 - (i & 3)) * 13 + (i >> 2)).collect();
        let mut columns: [Vec<u8>; COLS] = Default::default();
        let mut state = seed;
        for i in 0..52 {
            state = state.wrapping_mul(214013).wrapping_add(2531011) & 0x7fff_ffff;
            let j = (state >> 16) as usize % deck.len();
            columns[i % COLS].push(deck.swap_remove(j));
        }
        let mut g = Game { columns, cells: [None; CELLS], found: [0; 4] };
        g.autoplay();
        g
    }

    pub fn is_won(&self) -> bool {
        self.found == [13; 4]
    }

    /// The card that can be taken from a place.
    fn top(&self, place: usize) -> Option<u8> {
        if place < COLS {
            self.columns[place].last().copied()
        } else {
            self.cells[place - COLS]
        }
    }

    fn run_len(&self, place: usize) -> usize {
        if place >= COLS {
            return self.cells[place - COLS].is_some() as usize;
        }
        let col = &self.columns[place];
        let mut k = col.len().min(1);
        while k < col.len() && follows(col[col.len() - k - 1], col[col.len() - k]) {
            k += 1;
        }
        k
    }

    fn capacity(&self, to: usize) -> usize {
        let cells = self.cells.iter().filter(|c| c.is_none()).count();
        let columns = self.columns.iter().enumerate().filter(|(i, c)| c.is_empty() && *i != to).count();
        (cells + 1) << columns
    }

    pub fn check(&self, mv: Move) -> Result<(), &'static str> {
        let Move { from, to, count } = mv;
        if from >= HOME || to > HOME {
            return Err("no such place");
        }
        if from == to {
            return Err("source and destination are the same");
        }
        if count == 0 || count > self.run_len(from) {
            return Err("those cards cannot move together");
        }
        let bottom = if from < COLS { self.columns[from][self.columns[from].len() - count] } else { self.cells[from - COLS].unwrap() };
        if to == HOME {
            return if count == 1 && rank(bottom) == self.found[suit(bottom)] { Ok(()) } else { Err("that cannot go to a foundation") };
        }
        if to >= COLS {
            return if count == 1 && self.cells[to - COLS].is_none() { Ok(()) } else { Err("that cannot go to that free cell") };
        }
        if self.columns[to].last().is_some_and(|&top| !follows(top, bottom)) {
            return Err("the destination card must be one rank higher and the other colour");
        }
        if count > self.capacity(to) {
            return Err("not enough free cells");
        }
        Ok(())
    }

    fn safe(&self, card: u8) -> bool {
        let r = rank(card);
        r == self.found[suit(card)] && (r <= 1 || (if is_red(card) { [0, 3] } else { [1, 2] }).iter().all(|&o| self.found[o] >= r))
    }

    fn autoplay(&mut self) {
        while let Some(place) = (0..HOME).find(|&p| self.top(p).is_some_and(|c| self.safe(c))) {
            let card = self.take(place, 1)[0];
            self.found[suit(card)] += 1;
        }
    }

    fn take(&mut self, place: usize, count: usize) -> Vec<u8> {
        if place < COLS {
            let at = self.columns[place].len() - count;
            self.columns[place].split_off(at)
        } else {
            vec![self.cells[place - COLS].take().unwrap()]
        }
    }

    pub fn apply(&mut self, mv: Move) -> Result<(), &'static str> {
        self.check(mv)?;
        let cards = self.take(mv.from, mv.count);
        if mv.to == HOME {
            self.found[suit(cards[0])] += 1;
        } else if mv.to >= COLS {
            self.cells[mv.to - COLS] = Some(cards[0]);
        } else {
            self.columns[mv.to].extend(cards);
        }
        self.autoplay();
        Ok(())
    }

    /// The same text as `positionText` in freecell.js.
    pub fn to_position_text(&self) -> String {
        let join = |v: &mut dyn Iterator<Item = String>| v.collect::<Vec<_>>().join(",");
        let mut parts = vec![join(&mut self.found.iter().map(|n| n.to_string())), join(&mut self.cells.iter().map(|c| c.map_or("-".into(), |c| c.to_string())))];
        parts.extend(self.columns.iter().map(|c| join(&mut c.iter().map(|c| c.to_string()))));
        parts.join(";")
    }
}
