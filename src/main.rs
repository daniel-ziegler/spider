//! Terminal Spider Solitaire with an optional perfect-information solver.

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor},
    terminal::{self, ClearType},
};
use spider::game::{Card, Game, Move, NUM_COLS};
use spider::solver::{Config, SolveResult, SolverHandle, Verdict};
use std::io::{self, Write};
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
    budget: u64,
    threads: usize,
    quit: bool,
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
            budget,
            threads,
            quit: false,
        };
        app.restart_solver();
        app
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
        match key.code {
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
                self.msg.clear();
            }
            KeyCode::Char('d') => self.deal(),
            KeyCode::Char('u') => self.undo_requested(),
            KeyCode::Char('r') => self.redo(),
            KeyCode::Char('s') => self.toggle_solver(),
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
    Card(Card, bool),
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
        .map(|i| if i < down { Slot::Hidden(1) } else { Slot::Card(cards[i], i >= selected_from) })
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

fn draw(out: &mut impl Write, app: &App) -> io::Result<()> {
    let (w, h) = terminal::size()?;
    queue!(out, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))?;
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
        queue!(out, SetForegroundColor(Color::DarkGrey), Print("off  (press s to peek at whether this game is still winnable)"), ResetColor)?;
    } else if let Some(r) = &app.solver_result {
        let (color, text) = match r.verdict {
            Verdict::Solvable => (Color::Green, "SOLVABLE"),
            Verdict::Unsolvable => (Color::Red, "UNSOLVABLE"),
            Verdict::Unknown => (Color::Yellow, "UNKNOWN"),
        };
        queue!(out, SetForegroundColor(color), SetAttribute(Attribute::Bold), Print(text), SetAttribute(Attribute::Reset), ResetColor)?;
        let detail = match r.verdict {
            Verdict::Solvable => format!("  a winning line exists ({} moves)", r.line.len()),
            Verdict::Unsolvable => "  no winning line exists from here".to_string(),
            Verdict::Unknown => "  search budget exhausted without a verdict".to_string(),
        };
        queue!(
            out,
            Print(detail),
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  [{} classes, {} positions, {:.2}s, {}]", r.classes, r.nodes, r.elapsed.as_secs_f64(), r.config)),
            ResetColor
        )?;
    } else if let Some(hnd) = &app.solver {
        queue!(
            out,
            SetForegroundColor(Color::Cyan),
            Print(format!("thinking…  {} positions on {} thread{}, {:.1}s", hnd.work(), hnd.threads(), if hnd.threads() == 1 { "" } else { "s" }, hnd.elapsed().as_secs_f64())),
            ResetColor
        )?;
    }

    // Message line.
    queue!(out, cursor::MoveTo(1, 2), SetForegroundColor(Color::White), Print(&app.msg), ResetColor)?;

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
                Slot::Card(card, selected) => {
                    let color = if card.is_red() { Color::Red } else { Color::White };
                    if *selected {
                        queue!(out, SetBackgroundColor(Color::DarkYellow), SetForegroundColor(if card.is_red() { Color::Red } else { Color::Black }))?;
                    } else {
                        queue!(out, SetForegroundColor(color))?;
                    }
                    queue!(out, Print(format!(" {:>2}{}  ", card.rank_str(), card.suit_char())), ResetColor)?;
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
        Print(" 1-9,0 pick/place  ←→ cursor  ↑↓ count  ⏎ act  d deal  u undo  r redo  s solver  n new  R restart  ? help  q quit"),
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
        "  Esc        clear the selection",
        "  d          deal from the stock",
        "  u / r      undo / redo (undoing past a reveal asks for confirmation)",
        "  s          toggle the peeking solver (uses hidden cards + stock order)",
        "  n / R      new random game / restart this deal;   q quits",
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
}

fn default_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, 4)
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args { suits: 2, seed: random_seed(), budget: DEFAULT_BUDGET, threads: default_threads(), solver: false };
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
            "-h" | "--help" => {
                println!("usage: spider [--suits 1|2|4] [--seed N] [--budget WORK] [--threads N] [--solver]");
                println!("  --suits   number of suits (default 2)");
                println!("  --seed    deal number; the same seed always gives the same deal");
                println!("  --budget  solver work limit per thread before it answers UNKNOWN (default {DEFAULT_BUDGET})");
                println!("  --threads solver configurations to run in parallel (default min(cores, 4), max 8)");
                println!("  --solver  start with the peeking solver switched on");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

fn run(args: Args) -> io::Result<()> {
    let mut out = io::stdout();
    terminal::enable_raw_mode()?;
    execute!(out, terminal::EnterAlternateScreen, cursor::Hide)?;
    let result = (|| -> io::Result<()> {
        let mut app = App::new(args.suits, args.seed, args.budget, args.threads, args.solver);
        draw(&mut out, &app)?;
        while !app.quit {
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
        Ok(())
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
    if let Err(e) = run(args) {
        eprintln!("spider: {e}");
        std::process::exit(1);
    }
}
