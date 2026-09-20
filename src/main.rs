//! Terminal Spider Solitaire with an optional perfect-information solver.

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor},
    terminal::{self, ClearType},
};
use spider::game::{encode_moves, parse_moves, Card, Game, Move, NUM_COLS};
use spider::lineopt::{commit_kind, shorten, Commit};
use spider::solver::{Config, SolveResult, SolverHandle, Verdict};
use std::io::{self, Write};
use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_BUDGET: u64 = 3_000_000;
/// Search caps of the successive line-shortening passes run in the
/// background once the solver finds a winning line (see `lineopt`).
const SHORTEN_CAPS: [usize; 2] = [500, 4000];

/// The solver's winning line from the current position, kept in step with
/// the game as long as the moves played are the line's own.
struct Line {
    /// Moves still to play.
    moves: Vec<Move>,
    /// Moves of the line already played (undo walks back through them).
    played: Vec<Move>,
    /// Shortening passes completed.
    stage: usize,
    opt: Option<LineOpt>,
    /// The first irreversible move of the line, for the superhint highlight.
    commit: Option<CommitInfo>,
}

/// A background shortening pass on the line as it was when it started.
struct LineOpt {
    rx: mpsc::Receiver<Vec<Move>>,
    cancel: Arc<AtomicBool>,
    /// `played.len()` when the pass started; moves played since are
    /// stripped from its result if it agrees with them.
    base: usize,
}

impl Drop for LineOpt {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Where the line first commits, in the coordinates of the current position.
struct CommitInfo {
    /// Index into `Line::moves` of the committing move.
    idx: usize,
    kind: Commit,
    /// Positions (column, index) of the cards it moves that are already on
    /// the table, and of the card they land on.
    cards: Vec<(usize, usize)>,
    dest: Option<(usize, usize)>,
}

/// What just happened to the game, for keeping the solver's line in step.
enum Change {
    Played(Move),
    Undone(Move),
}

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
    /// Superhint: show the solver's next move and highlight its next commit.
    superhint: bool,
    line: Option<Line>,
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
            superhint: false,
            line: None,
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
        if moves.is_empty() && redo.is_empty() {
            return Ok(()); // a fresh start, not a reload
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

    /// R: back to the start of this deal by undoing every move, so the whole
    /// game sits on the redo stack (r replays it; S saves it under --redo).
    fn restart(&mut self) {
        let n = self.game.move_count();
        while self.game.undo().is_some() {}
        self.sel = None;
        self.cursor = 0;
        self.msg = format!("Restarted: {n} move{} moved to the redo stack (r replays them).", if n == 1 { "" } else { "s" });
        self.restart_solver();
    }

    /// The position changed: drop any running solve and start over if enabled.
    fn restart_solver(&mut self) {
        self.solver = None;
        self.solver_result = None;
        self.line = None;
        self.hints = None;
        self.hint_idx = None;
        if self.solver_on && !self.game.is_won() {
            self.solver = Some(SolverHandle::spawn_with(&self.game, self.budget, Config::portfolio(self.threads)));
        }
    }

    /// Returns true if the screen needs redrawing: a result arrived, or the
    /// solver is still running (its progress line changes).
    fn poll_solver(&mut self) -> bool {
        let mut changed = false;
        if let Some(h) = &self.solver {
            if let Some(r) = h.result() {
                if r.verdict == Verdict::Solvable && !r.line.is_empty() {
                    self.line = Some(Line { moves: r.line.clone(), played: Vec::new(), stage: 0, opt: None, commit: None });
                    self.refresh_line();
                }
                self.solver_result = Some(r);
                self.solver = None;
            }
            changed = true;
        }
        if self.poll_shortener() {
            changed = true;
        }
        changed
    }

    /// Collect a finished shortening pass. Its line starts from the position
    /// the pass began at, so the moves played since then must match its
    /// beginning, otherwise the pass is rerun from here.
    fn poll_shortener(&mut self) -> bool {
        let Some(line) = &mut self.line else { return false };
        let Some(opt) = &line.opt else { return false };
        let result = match opt.rx.try_recv() {
            Ok(r) => r,
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(mpsc::TryRecvError::Disconnected) => {
                line.opt = None;
                return false;
            }
        };
        let base = opt.base;
        line.opt = None;
        if line.played.len() >= base {
            let since = &line.played[base..];
            if result.len() >= since.len() && result[..since.len()] == *since {
                let rest = result[since.len()..].to_vec();
                if rest.len() <= line.moves.len() {
                    line.moves = rest;
                }
                line.stage += 1;
            }
        }
        self.refresh_line();
        true
    }

    /// The line changed: recompute where it commits and keep shortening it.
    fn refresh_line(&mut self) {
        let Some(line) = &mut self.line else { return };
        line.commit = first_commit(&self.game, &line.moves);
        if line.opt.is_none() && line.stage < SHORTEN_CAPS.len() && !line.moves.is_empty() {
            let cancel = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::channel();
            let (game, moves, cap, c2) = (self.game.clone(), line.moves.clone(), SHORTEN_CAPS[line.stage], cancel.clone());
            std::thread::Builder::new()
                .name("spider-shorten".into())
                .spawn(move || {
                    let r = shorten(&game, &moves, cap, &c2);
                    if !c2.load(Ordering::Relaxed) {
                        let _ = tx.send(r);
                    }
                })
                .expect("spawn shortener thread");
            line.opt = Some(LineOpt { rx, cancel, base: line.played.len() });
        }
    }

    /// Keep the line in step with a move played or undone; returns false if
    /// the game left the line (the solver must start over).
    fn track_line(&mut self, change: &Change) -> bool {
        let Some(line) = &mut self.line else { return false };
        match *change {
            Change::Played(mv) => {
                if line.moves.first() != Some(&mv) {
                    return false;
                }
                line.moves.remove(0);
                line.played.push(mv);
            }
            Change::Undone(mv) => {
                if line.played.last() != Some(&mv) {
                    return false;
                }
                line.played.pop();
                line.moves.insert(0, mv);
                if line.opt.as_ref().is_some_and(|o| o.base > line.played.len()) {
                    line.opt = None;
                }
            }
        }
        line.commit = first_commit(&self.game, &line.moves);
        if line.moves.is_empty() {
            line.opt = None;
        }
        true
    }

    /// H: superhint shows the solver's next move on the solver line and
    /// marks its next irreversible move in green. It needs the solver.
    fn toggle_superhint(&mut self) {
        self.superhint = !self.superhint;
        if self.superhint {
            if !self.solver_on {
                self.solver_on = true;
                self.restart_solver();
            }
            self.msg = "Superhint on: the solver's next move is shown above; green marks its next commit (p plays a move, P plays through the commit).".into();
        } else {
            self.msg = "Superhint off.".into();
        }
    }

    /// p: play the solver's next move. P: play up to and including the
    /// next irreversible move.
    fn play_line(&mut self, through_commit: bool) {
        if !self.superhint {
            self.msg = "Superhint is off (H turns it on).".into();
            return;
        }
        let Some(line) = &self.line else {
            self.msg = if self.solver.is_some() { "The solver is still thinking.".into() } else { "No winning line to follow here.".into() };
            return;
        };
        if line.moves.is_empty() {
            self.msg = "The line is finished.".into();
            return;
        }
        let n = if through_commit { line.commit.as_ref().map_or(line.moves.len(), |c| c.idx + 1) } else { 1 };
        let mut played = 0;
        let mut last = None;
        for _ in 0..n {
            let Some(&mv) = self.line.as_ref().and_then(|l| l.moves.first()) else { break };
            if self.game.apply(mv).is_err() {
                break;
            }
            played += 1;
            last = Some(mv);
            self.after_change(Change::Played(mv));
        }
        self.sel = None;
        if let Some(mv) = last {
            if let Move::Move { to, .. } = mv {
                self.cursor = to;
            }
            if !self.game.is_won() {
                let what = describe_move(&self.game_before(played), mv);
                self.msg = if played == 1 { format!("Played {what}.") } else { format!("Played {played} moves, ending with {what}.") };
            }
        } else {
            self.msg = "Could not play the line's move here.".into();
        }
    }

    /// The position `back` moves ago (for describing a move just played).
    fn game_before(&self, back: usize) -> Game {
        let mut g = self.game.clone();
        for _ in 0..back {
            g.undo();
        }
        g
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
                self.after_change(Change::Played(Move::Move { from, to, count }));
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
                self.after_change(Change::Played(Move::Deal));
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
            self.after_change(Change::Undone(rec.mv));
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
            self.after_change(Change::Played(rec.mv));
            self.msg = match rec.mv {
                Move::Deal => "Redid the deal.".into(),
                Move::Move { from, to, .. } => format!("Redid the move from {} to {}.", label(from), label(to)),
            };
        } else {
            self.msg = "Nothing to redo.".into();
        }
    }

    fn after_change(&mut self, change: Change) {
        if self.track_line(&change) {
            // Still on the solver's line: the verdict stands and the rest of
            // the line is the new line.
            self.hints = None;
            self.hint_idx = None;
        } else {
            self.restart_solver();
        }
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
                        Prompt::ConfirmRestart => self.restart(),
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
            KeyCode::Char('H') => self.toggle_superhint(),
            KeyCode::Char('p') => self.play_line(false),
            KeyCode::Char('P') => self.play_line(true),
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
        match mv {
            Move::Deal => self.sel = None,
            Move::Move { from, to, count } => {
                self.sel = Some((from, count));
                self.cursor = to;
            }
        }
        let what = describe_move(&self.game, mv);
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

/// "7♠..5♠ from column 3 onto 8♥ in column 5", or "deal".
fn describe_move(game: &Game, mv: Move) -> String {
    match mv {
        Move::Deal => "deal".to_string(),
        Move::Move { from, to, count } => {
            let col = &game.columns[from];
            if count == 0 || count > col.len() {
                return format!("{count} cards from column {} to column {}", label(from), label(to));
            }
            let top = col[col.len() - 1];
            let bottom = col[col.len() - count];
            let cards = if count == 1 { top.to_string() } else { format!("{top}..{bottom}") };
            let onto = match game.columns[to].last() {
                Some(c) => format!("onto {c} in column {}", label(to)),
                None => format!("to empty column {}", label(to)),
            };
            format!("{cards} from column {} {onto}", label(from))
        }
    }
}

/// Follow `moves` from `game` up to its first irreversible move and report
/// which cards of the current position that move touches. Cards not yet on
/// the table (dealt or turned over along the way) are left out.
fn first_commit(game: &Game, moves: &[Move]) -> Option<CommitInfo> {
    let mut g = game.clone();
    // Each card's position in the current game, or None if it arrives later.
    let mut tags: Vec<Vec<Option<(usize, usize)>>> =
        (0..NUM_COLS).map(|c| (0..g.columns[c].len()).map(|i| Some((c, i))).collect()).collect();
    for (idx, &mv) in moves.iter().enumerate() {
        if let Some(kind) = commit_kind(&g, mv) {
            let (cards, dest) = match mv {
                Move::Deal => (Vec::new(), None),
                Move::Move { from, to, count } => {
                    let n = tags[from].len();
                    (tags[from][n.saturating_sub(count)..].iter().flatten().copied().collect(), tags[to].last().copied().flatten())
                }
            };
            return Some(CommitInfo { idx, kind, cards, dest });
        }
        if g.apply(mv).is_err() {
            return None;
        }
        match mv {
            Move::Deal => tags.iter_mut().for_each(|t| t.push(None)),
            Move::Move { from, to, count } => {
                let n = tags[from].len();
                let moved: Vec<_> = tags[from].drain(n.saturating_sub(count)..).collect();
                tags[to].extend(moved);
            }
        }
        let rec = g.history().last().unwrap();
        for &(col, _) in &rec.completed {
            let n = tags[col].len();
            tags[col].truncate(n.saturating_sub(13));
        }
    }
    None
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

/// Superhint marking of a card.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mark {
    None,
    /// Moved by the line's next irreversible move.
    Moved,
    /// The card that move lands on.
    Dest,
}

/// Each suit its own colour so they tell apart at a glance: spades white,
/// hearts red, diamonds orange, clubs green. On a highlighted (coloured)
/// background spades turn black and the others darken.
fn suit_color(card: Card, on_bg: bool) -> Color {
    match (card.suit(), on_bg) {
        (0, false) => Color::White,
        (0, true) => Color::Black,
        (1, _) => Color::Red,
        (2, false) => Color::AnsiValue(208),
        (2, true) => Color::AnsiValue(166),
        (3, false) => Color::Green,
        (_, _) => Color::DarkGreen,
    }
}

/// One displayed row of a column.
enum Slot {
    /// A face-up card: (card, selected, the card on top of it is not one
    /// rank lower, so the stack is broken here, superhint mark).
    Card(Card, bool, bool, Mark),
    Hidden(usize),
    More(usize),
    Empty,
}

fn column_slots(game: &Game, col: usize, sel: Option<(usize, usize)>, commit: Option<&CommitInfo>, avail: usize) -> Vec<Slot> {
    let cards = &game.columns[col];
    if cards.is_empty() {
        return vec![Slot::Empty];
    }
    let down = game.face_down[col];
    let selected_from = match sel {
        Some((c, n)) if c == col => cards.len() - n,
        _ => usize::MAX,
    };
    let mark = |i: usize| match commit {
        Some(c) if c.cards.contains(&(col, i)) => Mark::Moved,
        Some(c) if c.dest == Some((col, i)) => Mark::Dest,
        _ => Mark::None,
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
                Slot::Card(cards[i], i >= selected_from, broken, mark(i))
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
    let entries: [(&str, u8); 17] = [
        ("1-9,0 pick/place", 9),
        ("←→ cursor", 2),
        ("↑↓ count", 1),
        ("⏎ act", 0),
        ("Tab hint", 8),
        ("H superhint", 6),
        ("p/P play", 5),
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

fn draw<O: Write>(out: &mut O, app: &App) -> io::Result<()> {
    let (w, h) = terminal::size()?;
    // No full-screen clear: each row is cleared just before it is redrawn,
    // so the screen is never blank between frames. (Synchronized output
    // additionally lets capable terminals show the frame at once.)
    queue!(out, terminal::BeginSynchronizedUpdate)?;
    let clear_row = |out: &mut O, row: u16| queue!(out, cursor::MoveTo(0, row), terminal::Clear(ClearType::CurrentLine));
    for row in 0..TOP {
        clear_row(out, row)?;
    }
    let g = &app.game;

    // Title line.
    queue!(out, cursor::MoveTo(0, 0), SetAttribute(Attribute::Bold), Print(" SPIDER "), SetAttribute(Attribute::Reset))?;
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
        queue!(out, Print(detail))?;
        match (&app.line, app.superhint) {
            (Some(line), true) if !line.moves.is_empty() => {
                // Superhint: the line's next move, then where it commits.
                let next = line.moves[0];
                queue!(out, Print("  "), SetForegroundColor(Color::Cyan), Print(fit(&format!("▶ {}", describe_move(g, next)), w.saturating_sub(24))), ResetColor)?;
                let commit = match &line.commit {
                    Some(c) if c.idx == 0 => format!("  this move {}", c.kind.describe()),
                    Some(c) => format!("  commit at move {}: {}", c.idx + 1, c.kind.describe()),
                    None => String::new(),
                };
                queue!(out, SetForegroundColor(Color::Green), Print(commit), ResetColor)?;
                let shortening = if line.opt.is_some() { ", shortening…" } else { "" };
                queue!(out, SetForegroundColor(Color::DarkGrey), Print(format!("  {} to go{shortening}", line.moves.len())), ResetColor)?;
            }
            _ => {
                queue!(
                    out,
                    SetForegroundColor(Color::DarkGrey),
                    Print(format!("  {} positions, {:.1}s, {}", fmt_count(r.nodes), r.elapsed.as_secs_f64(), r.config)),
                    ResetColor
                )?;
            }
        }
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

    // Columns, drawn row by row so each screen row is cleared then filled.
    let avail = (h as usize).saturating_sub(TOP as usize + 2).max(1);
    let commit = if app.superhint { app.line.as_ref().and_then(|l| l.commit.as_ref()) } else { None };
    let slots: Vec<Vec<Slot>> = (0..NUM_COLS).map(|c| column_slots(g, c, app.sel, commit, avail)).collect();
    let shelf_x = LEFT + NUM_COLS as u16 * CELL_W + 2;
    let shelf = w > shelf_x + 8;
    if shelf {
        queue!(out, cursor::MoveTo(shelf_x, TOP - 1), SetForegroundColor(Color::DarkGrey), Print("done"), ResetColor)?;
    }
    for row in 0..avail {
        clear_row(out, TOP + row as u16)?;
        for (c, col_slots) in slots.iter().enumerate() {
            let Some(slot) = col_slots.get(row) else { continue };
            let x = LEFT + c as u16 * CELL_W;
            queue!(out, cursor::MoveTo(x, TOP + row as u16))?;
            match slot {
                Slot::Empty => queue!(out, SetForegroundColor(Color::DarkGrey), Print(" ·  · "), ResetColor)?,
                Slot::Hidden(1) => queue!(out, SetForegroundColor(Color::DarkBlue), Print(" ▒▒▒▒ "), ResetColor)?,
                Slot::Hidden(n) => queue!(out, SetForegroundColor(Color::DarkBlue), Print(format!(" ▒{:<3}", format!("×{n}"))), ResetColor)?,
                Slot::More(n) => queue!(out, SetForegroundColor(Color::DarkGrey), Print(format!(" +{n:<3}")), ResetColor)?,
                Slot::Card(card, selected, broken, mark) => {
                    let color = suit_color(*card, false);
                    let bg = match (*selected, *mark) {
                        (true, _) => Some(Color::DarkYellow),
                        (false, Mark::Moved) => Some(Color::Green),
                        (false, Mark::Dest) => Some(Color::DarkGreen),
                        (false, Mark::None) => None,
                    };
                    match bg {
                        Some(bg) => queue!(out, SetBackgroundColor(bg), SetForegroundColor(suit_color(*card, true)))?,
                        None => queue!(out, SetForegroundColor(color))?,
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
        // Completed suits shelf, to the right of the tableau if there is room.
        if shelf {
            if let Some(&suit) = g.completed.get(row) {
                let card = Card::new(suit, 12);
                queue!(
                    out,
                    cursor::MoveTo(shelf_x, TOP + row as u16),
                    SetForegroundColor(suit_color(card, false)),
                    Print(format!("K{}..A{}", card.suit_char(), card.suit_char())),
                    ResetColor
                )?;
            }
        }
    }

    // Rows below the tableau (a help box may have covered them), then the key line.
    for row in TOP + avail as u16..h {
        clear_row(out, row)?;
    }
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
        Prompt::ConfirmRestart => Some("Restart this deal from the beginning (moves stay on the redo stack)? [y/N]"),
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
        "  H          superhint: show the solver's next move; green marks the cards of",
        "             its next irreversible move (bright: moved, dark: landing card)",
        "  p / P      play the solver's next move / play through its next commit",
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
            let mut dirty = false;
            if event::poll(Duration::from_millis(100))? {
                match event::read()? {
                    Event::Key(k) => {
                        app.handle_key(k);
                        dirty = true;
                    }
                    Event::Resize(_, _) => {
                        queue!(out, terminal::Clear(ClearType::All))?;
                        dirty = true;
                    }
                    _ => {}
                }
            }
            if app.poll_solver() || dirty {
                draw(&mut out, &app)?;
            }
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
