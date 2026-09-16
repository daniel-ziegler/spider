//! Terminal Spider Solitaire with an optional perfect-information solver.

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor},
    terminal::{self, ClearType},
};
use spider::game::{encode_moves, parse_moves, Card, Game, Move, NUM_COLS};
use spider::solver::{Config, SolveResult, SolverHandle, Verdict};
use std::io::{self, Write};
use std::os::unix::process::CommandExt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_BUDGET: u64 = 3_000_000;

#[derive(PartialEq, Eq, Clone, Copy)]
enum Prompt {
    None,
    ConfirmUndo,
    ConfirmNew,
    ConfirmRestart,
    ConfirmQuit,
    Help,
}

struct App {
    game: Game,
    suits: u8,
    cursor: usize,
    /// Selected source column and number of cards.
    sel: Option<(usize, usize)>,
    msg: String,
    prompt: Prompt,
    solver_on: bool,
    solver: Option<SolverHandle>,
    solver_result: Option<SolveResult>,
    /// Ranked legal moves for the hint key, computed lazily per position.
    hints: Option<Vec<Move>>,
    /// Index into `hints` of the hint currently shown.
    hint_idx: Option<usize>,
    budget: u64,
    threads: usize,
    quit: bool,
    /// Set by Ctrl-R: exec a fresh copy of the binary into this position.
    reload: bool,
    /// Resume commands recorded with S, printed to the terminal on exit.
    saved: Vec<String>,
}

impl App {
    fn new(suits: u8, seed: u64, budget: u64, threads: usize, solver_on: bool) -> App {
        let mut app = App {
            game: Game::new(suits, seed),
            suits,
            cursor: 0,
            sel: None,
            msg: String::from("Welcome to Spider. Press ? for help."),
            prompt: Prompt::None,
            solver_on,
            solver: None,
            solver_result: None,
            hints: None,
            hint_idx: None,
            budget,
            threads,
            quit: false,
            reload: false,
            saved: Vec::new(),
        };
        app.restart_solver();
        app
    }

    /// Restore a position from a reload: replay `moves`, then push `redo` onto
    /// the redo stack by applying and undoing it.
    fn restore(&mut self, moves: &[Move], redo: &[Move]) -> Result<(), String> {
        for (i, &mv) in moves.iter().enumerate() {
            self.game.apply(mv).map_err(|e| format!("replay move {}: {e}", i + 1))?;
        }
        for (i, &mv) in redo.iter().enumerate() {
            self.game.apply(mv).map_err(|e| format!("redo move {}: {e}", i + 1))?;
        }
        for _ in redo {
            self.game.undo();
        }
        self.msg = format!("Reloaded at move {}.", self.game.move_count());
        self.restart_solver();
        Ok(())
    }

    /// Ctrl-R: only leave the screen if the binary on disk is actually runnable
    /// (a build in progress can leave it missing or half-written).
    fn reload_requested(&mut self) {
        let exe = reload_exe();
        let check = std::process::Command::new(&exe)
            .arg("--help")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match check {
            Ok(st) if st.success() => self.reload = true,
            Ok(st) => self.msg = format!("Reload refused: {} exited with {st} (build in progress?).", exe.display()),
            Err(e) => self.msg = format!("Reload refused: cannot run {}: {e}.", exe.display()),
        }
    }

    /// S: record the command that resumes this exact position. It is
    /// printed when the program exits and written to a file right away.
    fn save_requested(&mut self) {
        let cmd = resume_command(&reload_exe(), &self.reload_args());
        self.saved.push(cmd.clone());
        self.msg = match write_save_file(&cmd) {
            Ok(path) => format!("Saved: resume command written to {} and printed when you quit.", path.display()),
            Err(e) => format!("Resume command will be printed when you quit (could not write save file: {e})."),
        };
    }

    /// Command line that reproduces the current position and settings.
    fn reload_args(&self) -> Vec<String> {
        let mut a = vec![
            "--suits".into(),
            self.suits.to_string(),
            "--seed".into(),
            self.game.seed.to_string(),
            "--budget".into(),
            self.budget.to_string(),
            "--threads".into(),
            self.threads.to_string(),
        ];
        if self.solver_on {
            a.push("--solver".into());
        }
        let moves = encode_moves(self.game.history().iter().map(|r| r.mv));
        if !moves.is_empty() {
            a.extend(["--replay".into(), moves]);
        }
        let redo = encode_moves(self.game.redo_moves());
        if !redo.is_empty() {
            a.extend(["--redo".into(), redo]);
        }
        a
    }

    fn new_game(&mut self, seed: u64) {
        self.game = Game::new(self.suits, seed);
        self.sel = None;
        self.cursor = 0;
        self.msg = format!("New {}-suit game, seed {}.", self.suits, seed);
        self.restart_solver();
    }

    /// The position changed: drop any running solve and start over if enabled.
    fn restart_solver(&mut self) {
        self.solver = None;
        self.solver_result = None;
        self.hints = None;
        self.hint_idx = None;
        if self.solver_on && !self.game.is_won() {
            self.solver = Some(SolverHandle::spawn_with(&self.game, self.budget, Config::portfolio(self.threads)));
        }
    }

    fn poll_solver(&mut self) {
        if let Some(h) = &self.solver {
            if let Some(r) = h.result() {
                self.solver_result = Some(r);
                self.solver = None;
            }
        }
    }

    fn column_key(&mut self, col: usize) {
        match self.sel {
            None => self.select(col),
            Some((from, count)) => {
                if from == col {
                    self.sel = None;
                    self.msg.clear();
                } else {
                    self.try_move(from, col, count);
                }
            }
        }
    }

    fn select(&mut self, col: usize) {
        let run = self.game.run_len(col);
        if run == 0 {
            self.msg = if self.game.columns[col].is_empty() {
                "That column is empty.".into()
            } else {
                "Nothing movable there.".into()
            };
            return;
        }
        self.sel = Some((col, run));
        self.cursor = col;
        self.msg = "Pick a destination column (↑/↓ change how many cards).".into();
    }

    fn try_move(&mut self, from: usize, to: usize, count: usize) {
        let count = if self.game.columns[to].is_empty() {
            count
        } else {
            match self.game.required_count(from, to) {
                Some(k) => k,
                None => {
                    self.msg = "Illegal move: the top card there must be one rank higher.".into();
                    return;
                }
            }
        };
        match self.game.apply(Move::Move { from, to, count }) {
            Ok(()) => {
                self.sel = None;
                self.cursor = to;
                self.after_change();
                let rec = self.game.history().last().unwrap();
                if !rec.completed.is_empty() {
                    self.msg = format!("Completed a suit! {}/8 done.", self.game.completed.len());
                } else if !rec.flips.is_empty() {
                    self.msg = "Revealed a card.".into();
                } else {
                    self.msg.clear();
                }
            }
            Err(e) => self.msg = format!("Illegal move: {e}."),
        }
    }

    fn deal(&mut self) {
        match self.game.apply(Move::Deal) {
            Ok(()) => {
                self.sel = None;
                self.after_change();
                self.msg = format!("Dealt. {} deals left.", self.game.deals_remaining());
            }
            Err(e) => self.msg = format!("Cannot deal: {e}."),
        }
    }

    fn undo_requested(&mut self) {
        if !self.game.can_undo() {
            self.msg = "Nothing to undo.".into();
            return;
        }
        if self.game.undo_reveals_info() {
            self.prompt = Prompt::ConfirmUndo;
        } else {
            self.do_undo();
        }
    }

    fn do_undo(&mut self) {
        if let Some(rec) = self.game.undo() {
            self.sel = None;
            self.after_change();
            self.msg = match rec.mv {
                Move::Deal => "Undid the deal.".into(),
                Move::Move { from, to, count } => {
                    format!("Undid moving {count} card{} from {} to {}.", if count == 1 { "" } else { "s" }, label(from), label(to))
                }
            };
        }
    }

    fn redo(&mut self) {
        if let Some(rec) = self.game.redo() {
            self.sel = None;
            self.after_change();
            self.msg = match rec.mv {
                Move::Deal => "Redid the deal.".into(),
                Move::Move { from, to, .. } => format!("Redid the move from {} to {}.", label(from), label(to)),
            };
        } else {
            self.msg = "Nothing to redo.".into();
        }
    }

    fn after_change(&mut self) {
        self.restart_solver();
        if self.game.is_won() {
            self.msg = format!("You won! Score {}. Press n for a new game.", self.game.score());
        } else if !self.game.has_any_move() {
            self.msg = "No moves left. Undo or start a new game.".into();
        }
    }

    fn toggle_solver(&mut self) {
        self.solver_on = !self.solver_on;
        self.restart_solver();
        self.msg = if self.solver_on { "Solver on: peeking at hidden cards.".into() } else { "Solver off.".into() };
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        match self.prompt {
            Prompt::None => {}
            Prompt::Help => {
                self.prompt = Prompt::None;
                return;
            }
            p => {
                let yes = matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter);
                self.prompt = Prompt::None;
                if yes {
                    match p {
                        Prompt::ConfirmUndo => self.do_undo(),
                        Prompt::ConfirmNew => self.new_game(random_seed()),
                        Prompt::ConfirmRestart => {
                            let seed = self.game.seed;
                            self.new_game(seed);
                        }
                        Prompt::ConfirmQuit => self.quit = true,
                        _ => {}
                    }
                } else {
                    self.msg = "Cancelled.".into();
                }
                return;
            }
        }
        if key.code != KeyCode::Tab && key.code != KeyCode::BackTab {
            self.hint_idx = None;
        }
        match key.code {
            KeyCode::Tab => self.hint(1),
            KeyCode::BackTab => self.hint(-1),
            KeyCode::Char(c @ '0'..='9') => {
                let col = if c == '0' { 9 } else { c as usize - '1' as usize };
                self.column_key(col);
            }
            KeyCode::Left | KeyCode::Char('h') => self.cursor = (self.cursor + NUM_COLS - 1) % NUM_COLS,
            KeyCode::Right | KeyCode::Char('l') => self.cursor = (self.cursor + 1) % NUM_COLS,
            KeyCode::Enter | KeyCode::Char(' ') => self.column_key(self.cursor),
            KeyCode::Up | KeyCode::Char('k') | KeyCode::Char('+') | KeyCode::Char('=') => self.adjust_sel(1),
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Char('-') => self.adjust_sel(-1),
            KeyCode::Esc => {
                self.sel = None;
                self.hint_idx = None;
                self.msg.clear();
            }
            KeyCode::Char('d') => self.deal(),
            KeyCode::Char('r') if ctrl => self.reload_requested(),
            KeyCode::Char('u') => self.undo_requested(),
            KeyCode::Char('r') => self.redo(),
            KeyCode::Char('s') => self.toggle_solver(),
            KeyCode::Char('S') => self.save_requested(),
            KeyCode::Char('n') => self.prompt = Prompt::ConfirmNew,
            KeyCode::Char('R') => self.prompt = Prompt::ConfirmRestart,
            KeyCode::Char('?') => self.prompt = Prompt::Help,
            KeyCode::Char('q') => {
                if self.game.move_count() > 0 && !self.game.is_won() {
                    self.prompt = Prompt::ConfirmQuit;
                } else {
                    self.quit = true;
                }
            }
            _ => {}
        }
    }

    /// Show the next hint. Hints are the legal moves ranked by visible
    /// information only (never the solver's line, which peeks). The hinted
    /// move is left selected with the cursor on its destination so Enter plays it.
    fn hint(&mut self, step: isize) {
        if self.game.is_won() {
            self.msg = "The game is won; nothing left to do.".into();
            return;
        }
        if self.hints.is_none() {
            self.hints = Some(self.game.hint_moves());
        }
        let hints = self.hints.as_ref().unwrap();
        if hints.is_empty() {
            self.msg = "No legal moves. Undo or start a new game.".into();
            return;
        }
        let n = hints.len() as isize;
        let i = match self.hint_idx {
            Some(i) => (i as isize + step).rem_euclid(n) as usize,
            None if step < 0 => hints.len() - 1,
            None => 0,
        };
        self.hint_idx = Some(i);
        let mv = hints[i];
        let what = match mv {
            Move::Deal => {
                self.sel = None;
                "deal".to_string()
            }
            Move::Move { from, to, count } => {
                self.sel = Some((from, count));
                self.cursor = to;
                let col = &self.game.columns[from];
                let top = col[col.len() - 1];
                let bottom = col[col.len() - count];
                let cards = if count == 1 {
                    format!("{}{}", top.rank_str(), top.suit_char())
                } else {
                    format!("{}{}..{}{}", top.rank_str(), top.suit_char(), bottom.rank_str(), bottom.suit_char())
                };
                let onto = match self.game.columns[to].last() {
                    Some(c) => format!("onto {}{} in column {}", c.rank_str(), c.suit_char(), label(to)),
                    None => format!("to empty column {}", label(to)),
                };
                format!("{cards} from column {} {onto}", label(from))
            }
        };
        self.msg = format!(
            "Hint {}/{}: {what}.  {} plays it, Tab/Shift-Tab cycle.",
            i + 1,
            hints.len(),
            if mv == Move::Deal { "d" } else { "Enter" }
        );
    }

    fn adjust_sel(&mut self, delta: i32) {
        if let Some((col, count)) = self.sel {
            let run = self.game.run_len(col) as i32;
            let n = (count as i32 + delta).clamp(1, run.max(1)) as usize;
            self.sel = Some((col, n));
            self.msg = format!("{n} card{} selected.", if n == 1 { "" } else { "s" });
        } else {
            self.msg = "Select a column first (press its number).".into();
        }
    }
}

fn label(col: usize) -> String {
    if col == 9 { "0".into() } else { (col + 1).to_string() }
}

/// The path to re-exec. `current_exe` reads /proc/self/exe, which turns
/// into `<path> (deleted)` once a rebuild has replaced the file; the new
/// build lives at the original path, so strip the suffix and fall back to
/// argv[0] if even that is gone.
fn reload_exe() -> std::path::PathBuf {
    let argv0: std::path::PathBuf = std::env::args().next().unwrap_or_default().into();
    let Ok(exe) = std::env::current_exe() else { return argv0 };
    let exe = match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(stripped) => std::path::PathBuf::from(stripped),
        None => exe,
    };
    if exe.exists() {
        exe
    } else if argv0.exists() {
        argv0
    } else {
        exe
    }
}

/// Quote a command-line word for pasting into a shell.
fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Round a count to a short human form: 850, 12K, 0.7M, 2.3M.
fn fmt_count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1_000 {
        format!("{}K", n / 1_000)
    } else {
        n.to_string()
    }
}

fn random_seed() -> u64 {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (t.as_nanos() as u64 ^ std::process::id() as u64) % 1_000_000_000
}

// ---------------------------------------------------------------- rendering

const CELL_W: u16 = 6;
const LEFT: u16 = 2;
const TOP: u16 = 5;

/// One displayed row of a column.
enum Slot {
    /// A face-up card: (card, selected, the card on top of it is not one
    /// rank lower, so the stack is broken here).
    Card(Card, bool, bool),
    Hidden(usize),
    More(usize),
    Empty,
}

fn column_slots(game: &Game, col: usize, sel: Option<(usize, usize)>, avail: usize) -> Vec<Slot> {
    let cards = &game.columns[col];
    if cards.is_empty() {
        return vec![Slot::Empty];
    }
    let down = game.face_down[col];
    let selected_from = match sel {
        Some((c, n)) if c == col => cards.len() - n,
        _ => usize::MAX,
    };
    let mut slots = Vec::new();
    let mut up_start = 0;
    if cards.len() > avail && down > 1 {
        slots.push(Slot::Hidden(down));
        up_start = down;
    }
    let mut rest: Vec<Slot> = (up_start..cards.len())
        .map(|i| {
            if i < down {
                Slot::Hidden(1)
            } else {
                let broken = i + 1 < cards.len() && cards[i + 1].rank() + 1 != cards[i].rank();
                Slot::Card(cards[i], i >= selected_from, broken)
            }
        })
        .collect();
    let room = avail.saturating_sub(slots.len()).max(1);
    if rest.len() > room {
        let cut = rest.len() - (room - 1);
        rest.drain(..cut);
        slots.push(Slot::More(cut + up_start));
    }
    slots.extend(rest);
    slots
}

/// Truncate a line to the screen width. Nothing may reach the last cell of
/// the bottom row: the terminal would wrap and scroll the whole screen up a
/// line until the next redraw.
fn fit(s: &str, w: u16) -> String {
    s.chars().take((w as usize).saturating_sub(1)).collect()
}

/// The bottom key line, dropping the least important entries until it fits
/// the screen width (`? help` and `q quit` always stay).
fn key_bar(w: u16) -> String {
    // (text, drop priority: lower is dropped first; u8::MAX never)
    let entries: [(&str, u8); 15] = [
        ("1-9,0 pick/place", 9),
        ("←→ cursor", 2),
        ("↑↓ count", 1),
        ("⏎ act", 0),
        ("Tab hint", 8),
        ("d deal", 10),
        ("u undo", 7),
        ("r redo", 4),
        ("s solver", 6),
        ("S save", 3),
        ("n new", 5),
        ("R restart", 3),
        ("^R reload", 2),
        ("? help", u8::MAX),
        ("q quit", u8::MAX),
    ];
    let mut keep: Vec<bool> = vec![true; entries.len()];
    let width = |keep: &[bool]| {
        1 + entries.iter().zip(keep).filter(|(_, k)| **k).map(|(e, _)| e.0.chars().count() + 2).sum::<usize>()
    };
    while width(&keep) > (w as usize).saturating_sub(1) {
        let Some((i, _)) = entries.iter().enumerate().filter(|(i, e)| keep[*i] && e.1 != u8::MAX).min_by_key(|(_, e)| e.1) else {
            break;
        };
        keep[i] = false;
    }
    let mut out = String::from(" ");
    for (e, k) in entries.iter().zip(&keep) {
        if *k {
            out.push_str(e.0);
            out.push_str("  ");
        }
    }
    fit(out.trim_end(), w)
}

fn draw(out: &mut impl Write, app: &App) -> io::Result<()> {
    let (w, h) = terminal::size()?;
    // Synchronized output: terminals that support it show the frame at once
    // instead of the cleared screen filling in.
    queue!(out, terminal::BeginSynchronizedUpdate, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
    let g = &app.game;

    // Title line.
    queue!(out, SetAttribute(Attribute::Bold), Print(" SPIDER "), SetAttribute(Attribute::Reset))?;
    queue!(
        out,
        Print(format!(
            " {}-suit  seed {}   moves {}  score {}   stock {} deal{}   suits {}/8",
            app.suits,
            g.seed,
            g.move_count(),
            g.score(),
            g.deals_remaining(),
            if g.deals_remaining() == 1 { "" } else { "s" },
            g.completed.len()
        ))
    )?;

    // Solver line.
    queue!(out, cursor::MoveTo(1, 1), Print("Solver: "))?;
    if g.is_won() {
        queue!(out, SetForegroundColor(Color::Green), Print("game won"), ResetColor)?;
    } else if !app.solver_on {
        queue!(out, SetForegroundColor(Color::DarkGrey), Print("off  (s to peek at whether this game is still winnable)"), ResetColor)?;
    } else if let Some(r) = &app.solver_result {
        let (color, text) = match r.verdict {
            Verdict::Solvable => (Color::Green, "SOLVABLE"),
            Verdict::Unsolvable => (Color::Red, "UNSOLVABLE"),
            Verdict::Unknown => (Color::Yellow, "UNKNOWN"),
        };
        queue!(out, SetForegroundColor(color), SetAttribute(Attribute::Bold), Print(text), SetAttribute(Attribute::Reset), ResetColor)?;
        let detail = match r.verdict {
            Verdict::Solvable | Verdict::Unsolvable => "",
            Verdict::Unknown => "  budget exhausted",
        };
        queue!(
            out,
            Print(detail),
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  {} positions, {:.1}s, {}", fmt_count(r.nodes), r.elapsed.as_secs_f64(), r.config)),
            ResetColor
        )?;
    } else if let Some(hnd) = &app.solver {
        queue!(
            out,
            SetForegroundColor(Color::Cyan),
            Print(format!("thinking…  {:.1}M positions, {} thread{}, {:.0}s", hnd.work() as f64 / 1e6, hnd.threads(), if hnd.threads() == 1 { "" } else { "s" }, hnd.elapsed().as_secs_f64())),
            ResetColor
        )?;
    }

    // Message line.
    queue!(out, cursor::MoveTo(1, 2), SetForegroundColor(Color::White), Print(fit(&app.msg, w.saturating_sub(1))), ResetColor)?;

    // Column headers.
    for c in 0..NUM_COLS {
        let x = LEFT + c as u16 * CELL_W;
        queue!(out, cursor::MoveTo(x, TOP - 1))?;
        let is_cursor = c == app.cursor;
        let is_sel = matches!(app.sel, Some((s, _)) if s == c);
        if is_cursor {
            queue!(out, SetAttribute(Attribute::Reverse))?;
        }
        if is_sel {
            queue!(out, SetForegroundColor(Color::Yellow), SetAttribute(Attribute::Bold))?;
        }
        queue!(out, Print(format!(" [{}] ", label(c))), SetAttribute(Attribute::Reset), ResetColor)?;
    }

    // Columns.
    let avail = (h as usize).saturating_sub(TOP as usize + 2).max(1);
    for c in 0..NUM_COLS {
        let x = LEFT + c as u16 * CELL_W;
        for (row, slot) in column_slots(g, c, app.sel, avail).iter().enumerate() {
            queue!(out, cursor::MoveTo(x, TOP + row as u16))?;
            match slot {
                Slot::Empty => queue!(out, SetForegroundColor(Color::DarkGrey), Print(" ·  · "), ResetColor)?,
                Slot::Hidden(1) => queue!(out, SetForegroundColor(Color::DarkBlue), Print(" ▒▒▒▒ "), ResetColor)?,
                Slot::Hidden(n) => queue!(out, SetForegroundColor(Color::DarkBlue), Print(format!(" ▒{:<3}", format!("×{n}"))), ResetColor)?,
                Slot::More(n) => queue!(out, SetForegroundColor(Color::DarkGrey), Print(format!(" +{n:<3}")), ResetColor)?,
                Slot::Card(card, selected, broken) => {
                    let color = if card.is_red() { Color::Red } else { Color::White };
                    if *selected {
                        queue!(out, SetBackgroundColor(Color::DarkYellow), SetForegroundColor(if card.is_red() { Color::Red } else { Color::Black }))?;
                    } else {
                        queue!(out, SetForegroundColor(color))?;
                    }
                    // Underline a card whose cover is not one rank lower: the
                    // line marks where the stack breaks.
                    if *broken {
                        queue!(out, Print(" "), SetAttribute(Attribute::Underlined))?;
                        queue!(out, Print(format!("{:>2}{} ", card.rank_str(), card.suit_char())), SetAttribute(Attribute::NoUnderline), Print(" "))?;
                    } else {
                        queue!(out, Print(format!(" {:>2}{}  ", card.rank_str(), card.suit_char())))?;
                    }
                    queue!(out, ResetColor)?;
                }
            }
        }
    }

    // Completed suits shelf, to the right of the tableau if there is room.
    let shelf_x = LEFT + NUM_COLS as u16 * CELL_W + 2;
    if w > shelf_x + 8 {
        queue!(out, cursor::MoveTo(shelf_x, TOP - 1), SetForegroundColor(Color::DarkGrey), Print("done"), ResetColor)?;
        for (i, &suit) in g.completed.iter().enumerate() {
            let card = Card::new(suit, 12);
            queue!(
                out,
                cursor::MoveTo(shelf_x, TOP + i as u16),
                SetForegroundColor(if card.is_red() { Color::Red } else { Color::White }),
                Print(format!("K{}..A{}", card.suit_char(), card.suit_char())),
                ResetColor
            )?;
        }
    }

    // Key line.
    queue!(
        out,
        cursor::MoveTo(0, h.saturating_sub(1)),
        SetForegroundColor(Color::DarkGrey),
        Print(key_bar(w)),
        ResetColor
    )?;

    // Prompts overlay the message line.
    let prompt_text = match app.prompt {
        Prompt::None => None,
        Prompt::ConfirmUndo => Some("This undo takes back a move that REVEALED cards (a flip or a deal). Undo anyway? [y/N]"),
        Prompt::ConfirmNew => Some("Abandon this game and start a new one? [y/N]"),
        Prompt::ConfirmRestart => Some("Restart this same deal from the beginning? [y/N]"),
        Prompt::ConfirmQuit => Some("Quit the game in progress? [y/N]"),
        Prompt::Help => Some("HELP — press any key to close"),
    };
    if let Some(t) = prompt_text {
        queue!(out, cursor::MoveTo(1, 2), terminal::Clear(ClearType::CurrentLine), SetBackgroundColor(Color::DarkMagenta), SetForegroundColor(Color::White), Print(format!(" {t} ")), ResetColor)?;
    }
    if app.prompt == Prompt::Help {
        draw_help(out, w, h)?;
    }
    queue!(out, terminal::EndSynchronizedUpdate)?;
    out.flush()
}

fn draw_help(out: &mut impl Write, w: u16, h: u16) -> io::Result<()> {
    let lines = [
        "Spider Solitaire",
        "",
        "Goal: build eight K→A same-suit runs; each completed run leaves the table.",
        "A run of descending same-suit cards may move onto any card one rank higher,",
        "or into an empty column. Deal (d) adds a card to every column; not allowed",
        "while a column is empty. Score: 500 − moves + 100 per completed suit.",
        "",
        "  1-9, 0     select a column, then a destination column",
        "  ←/→ h/l    move the cursor;  Enter/Space acts on the cursor column",
        "  ↑/↓ +/-    change how many cards are selected (for empty destinations)",
        "  Tab        hint: cycle through the legal moves, best first (Shift-Tab back)",
        "  Esc        clear the selection",
        "  d          deal from the stock",
        "  u / r      undo / redo (undoing past a reveal asks for confirmation)",
        "  s          toggle the peeking solver (uses hidden cards + stock order)",
        "  n / R      new random game / restart this deal;   q quits",
        "  S          save: print the command that resumes this position when you quit",
        "  Ctrl-R     re-exec the program (picks up a rebuilt binary) at this position",
        "",
        "Solver verdicts:  SOLVABLE = a winning line exists from this exact position;",
        "UNSOLVABLE = proven impossible;  UNKNOWN = the work budget ran out first.",
        "Start with:  spider --suits 1|2|4  --seed N  --budget N  --threads N  --solver",
    ];
    let bw = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0) as u16 + 4;
    let bh = lines.len() as u16 + 2;
    let x0 = w.saturating_sub(bw) / 2;
    let y0 = h.saturating_sub(bh) / 2;
    for y in 0..bh {
        queue!(out, cursor::MoveTo(x0, y0 + y), SetBackgroundColor(Color::DarkBlue), SetForegroundColor(Color::White))?;
        let content = if y == 0 || y == bh - 1 { "" } else { lines[(y - 1) as usize] };
        queue!(out, Print(format!("{:<width$}", format!("  {content}"), width = bw as usize)), ResetColor)?;
    }
    Ok(())
}

// ------------------------------------------------------------------- main

struct Args {
    suits: u8,
    seed: u64,
    budget: u64,
    threads: usize,
    solver: bool,
    replay: Vec<Move>,
    redo: Vec<Move>,
}

fn default_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, 4)
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args { suits: 2, seed: random_seed(), budget: DEFAULT_BUDGET, threads: default_threads(), solver: false, replay: Vec::new(), redo: Vec::new() };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--suits" | "-s" => {
                a.suits = value("--suits")?.parse().map_err(|_| "bad --suits")?;
                if !matches!(a.suits, 1 | 2 | 4) {
                    return Err("--suits must be 1, 2 or 4".into());
                }
            }
            "--seed" => a.seed = value("--seed")?.parse().map_err(|_| "bad --seed")?,
            "--budget" => a.budget = value("--budget")?.parse().map_err(|_| "bad --budget")?,
            "--threads" => a.threads = value("--threads")?.parse::<usize>().map_err(|_| "bad --threads")?.clamp(1, 8),
            "--solver" => a.solver = true,
            "--replay" => a.replay = parse_moves(&value("--replay")?)?,
            "--redo" => a.redo = parse_moves(&value("--redo")?)?,
            "-h" | "--help" => {
                println!("usage: spider [--suits 1|2|4] [--seed N] [--budget WORK] [--threads N] [--solver]");
                println!("  --suits   number of suits (default 2)");
                println!("  --seed    deal number; the same seed always gives the same deal");
                println!("  --budget  solver work limit per thread before it answers UNKNOWN (default {DEFAULT_BUDGET})");
                println!("  --threads solver configurations to run in parallel (default min(cores, 4), max 8)");
                println!("  --solver  start with the peeking solver switched on");
                println!("  --replay  moves to replay before starting (as written by Ctrl-R reload)");
                println!("  --redo    moves to place on the redo stack");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

/// The full command line (quoted for a shell) that resumes a position.
fn resume_command(exe: &std::path::Path, args: &[String]) -> String {
    std::iter::once(exe.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|w| shell_quote(&w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Write the resume command to `~/.local/state/spider/resume.sh` (or
/// `$XDG_STATE_HOME/spider/resume.sh`); returns the path.
fn write_save_file(cmd: &str) -> io::Result<std::path::PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state")))
        .ok_or_else(|| io::Error::other("no HOME"))?;
    let dir = base.join("spider");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("resume.sh");
    std::fs::write(&path, format!("#!/bin/sh\n# spider position saved {}\nexec {cmd}\n", unix_time()))?;
    Ok(path)
}

fn unix_time() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// What to do after the UI exits: re-exec with these arguments, and/or
/// print the saved resume commands.
struct Exit {
    reload: Option<Vec<String>>,
    saved: Vec<String>,
}

fn run(args: Args) -> io::Result<Exit> {
    let mut out = io::stdout();
    terminal::enable_raw_mode()?;
    execute!(out, terminal::EnterAlternateScreen, cursor::Hide)?;
    let result = (|| -> io::Result<Exit> {
        let mut app = App::new(args.suits, args.seed, args.budget, args.threads, args.solver);
        if let Err(e) = app.restore(&args.replay, &args.redo) {
            return Err(io::Error::other(e));
        }
        draw(&mut out, &app)?;
        while !app.quit && !app.reload {
            if event::poll(Duration::from_millis(100))? {
                match event::read()? {
                    Event::Key(k) => app.handle_key(k),
                    Event::Resize(_, _) => {}
                    _ => continue,
                }
            }
            app.poll_solver();
            draw(&mut out, &app)?;
        }
        Ok(Exit { reload: if app.reload { Some(app.reload_args()) } else { None }, saved: std::mem::take(&mut app.saved) })
    })();
    execute!(out, cursor::Show, terminal::LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;
    result
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("spider: {e}\ntry: spider --help");
            std::process::exit(2);
        }
    };
    let exit = match run(args) {
        Err(e) => {
            eprintln!("spider: {e}");
            std::process::exit(1);
        }
        Ok(exit) => exit,
    };
    for (i, cmd) in exit.saved.iter().enumerate() {
        println!("spider: saved position {} of {}; resume with\n{cmd}", i + 1, exit.saved.len());
    }
    if let Some(reload_args) = exit.reload {
        // Leave the command in the scrollback so the position can be
        // recovered by hand if the exec fails or the new binary is broken.
        let exe = reload_exe();
        println!("spider: reloading with\n{}", resume_command(&exe, &reload_args));
        let err = std::process::Command::new(&exe).args(&reload_args).exec();
        eprintln!("spider: could not re-exec {}: {err}", exe.display());
        std::process::exit(1);
    }
}
