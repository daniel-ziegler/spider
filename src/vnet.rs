//! A value network for the line player: positions are encoded for the
//! network (`vnet/train.py`), training data comes from line player games,
//! and [`propose`] / [`choose`] make a player that picks between the ends
//! of the line search by the network's value instead of the evaluation.
//!
//! A position is encoded as `ENC` bytes: for each column, `ROWS` codes from
//! the bottom (0: no card, 1: face down, 2: face up but unknown, a card just
//! turned at the end of a line, 3 + card), keeping the top `ROWS` cards of
//! a longer column; then the deals left and the completed suits. The
//! network computes its per-card features from these.

use crate::game::{Game, Move, NUM_COLS};
use crate::human::{mask, BLANK};
use crate::lines::{decide, decide_steps, line_to, masked_hash, progress, search_state, unseen_counts, Choice, Decision, LineConfig, Tempo, LOST};
use crate::smart::Rng;
use crate::solver::{State, MAXC};
use std::collections::HashSet;

pub const ROWS: usize = 32;
pub const ENC: usize = NUM_COLS * ROWS + 2;

/// Encode a (masked) state with `deals_left` deals left into `out` (`ENC`
/// bytes).
pub(crate) fn encode(s: &State, deals_left: usize, out: &mut [u8]) {
    out[..ENC].fill(0);
    for c in 0..NUM_COLS {
        let n = s.len[c] as usize;
        let d = s.down[c] as usize;
        let start = n.saturating_sub(ROWS);
        for (r, i) in (start..n).enumerate() {
            let card = s.cols[c][i];
            out[c * ROWS + r] = if i < d {
                1
            } else if card == BLANK.0 {
                2
            } else {
                3 + card
            };
        }
    }
    out[NUM_COLS * ROWS] = deals_left as u8;
    out[NUM_COLS * ROWS + 1] = s.completed;
}

/// Encode a game's masked position.
pub fn encode_game(g: &Game) -> Vec<u8> {
    let mut out = vec![0; ENC];
    encode(&State::from_game(&mask(g)), g.deals_remaining(), &mut out);
    out
}

/// Encode the masked position right after a deal from `g` with the ten cards
/// dealt not yet known: an unknown card on every column and a deal less (the
/// analysis's network is trained on these too, made of the positions dealt
/// from; `web/static/analysis-core.js` encodes the same).
pub fn encode_dealt(g: &Game) -> Vec<u8> {
    let mut m = mask(g);
    for col in &mut m.columns {
        col.push(BLANK);
    }
    let mut out = vec![0; ENC];
    encode(&State::from_game(&m), g.deals_remaining() - 1, &mut out);
    out
}

/// Bytes per training record: the encoding, won (0/1), suits completed at
/// the end, and the seed (u32).
pub const RECORD: usize = ENC + 6;

/// Play `g` with the line player, except that with probability `eps` a
/// decision is instead a random line among the best eight by the normal
/// evaluation. With probability `sample` a decision's position is
/// recorded, and with it the end of the line played (whose turned card, if
/// any, is unknown). Records are appended to `out` once the outcome is
/// known. Returns (won, suits completed).
pub fn record_game(g: &Game, cfg: &LineConfig, eps: f64, sample: f64, seed: u64, out: &mut Vec<u8>) -> (bool, usize) {
    let mut g = g.clone();
    let mut rng = Rng(seed ^ 0xDA7A);
    let unit = |rng: &mut Rng| (rng.next() >> 11) as f64 / (1u64 << 53) as f64;
    let mut visited = HashSet::new();
    let mut tempo = Tempo::default();
    let mut encs: Vec<u8> = Vec::new();
    let start = g.move_count();
    while !g.is_won() && g.move_count() - start < 5000 && g.columns.iter().all(|c| c.len() <= MAXC) {
        let obs = mask(&g);
        let root = State::from_game(&obs);
        visited.insert(root.hash());
        let before = progress(&g);
        let deals_left = g.deals_remaining();
        let mut choice = decide_steps(&obs, deals_left, &visited, &mut tempo, cfg).0;
        if matches!(choice, Choice::Line(_)) && unit(&mut rng) < eps {
            let nodes = search_state(root.clone(), cfg);
            let mut ranked: Vec<(i32, usize)> = (1..nodes.len())
                .filter(|&k| !visited.contains(&nodes[k].state.hash()))
                .map(|k| (nodes[k].parts.value(deals_left, cfg.empty), k))
                .filter(|&(v, _)| v > LOST)
                .collect();
            ranked.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
            ranked.truncate(8);
            if !ranked.is_empty() {
                let k = ranked[(rng.next() % ranked.len() as u64) as usize].1;
                choice = Choice::Line(line_to(&nodes, k));
            }
        }
        let rec = unit(&mut rng) < sample;
        if rec {
            let at = encs.len();
            encs.resize(at + ENC, 0);
            encode(&root, deals_left, &mut encs[at..]);
        }
        match choice {
            Choice::Line(steps) => {
                let mut after = obs.clone();
                for mv in steps.concat() {
                    g.apply(mv).expect("planned move is legal");
                    after.apply(mv).expect("planned move is legal");
                }
                if rec && after.columns.iter().all(|c| c.len() <= MAXC) {
                    let at = encs.len();
                    encs.resize(at + ENC, 0);
                    encode(&State::from_game(&after), deals_left, &mut encs[at..]);
                }
            }
            Choice::Deal => g.apply(Move::Deal).expect("deal is legal"),
            Choice::Stuck => break,
        }
        if progress(&g) != before {
            tempo = Tempo::default();
        }
    }
    let won = g.is_won();
    for e in encs.chunks(ENC) {
        out.extend_from_slice(e);
        out.push(won as u8);
        out.push(g.completed.len() as u8);
        out.extend_from_slice(&(seed as u32).to_le_bytes());
    }
    (won, g.completed.len())
}

/// Bytes per record of [`record_for_analysis`]: the encoding, won (0/1),
/// suits completed at the end, the number of suits, the kind of position
/// (see there) and the seed (u32).
pub const ANALYSIS_RECORD: usize = ENC + 8;

/// Training data for the network of the web game's analysis, which is to say
/// of every position of a person's game what share of games the line player
/// would win from there: positions, each with the outcome of the line player
/// playing on from it (and nothing else: no exploration after a position
/// recorded, so that the network and games played out from a position
/// estimate the same thing).
///
/// To have positions the line player would not get into itself, half the
/// games start with a noisy stretch of up to `noisy` decisions, in which a
/// decision is with probability `noise` a random line among the best eight
/// by the normal evaluation, or (a tenth as often) a deal before its time;
/// nothing is recorded there, and the player starts afresh after it.
/// From then on, a decision's position is recorded with probability
/// `sample` (kind 0), and with it the end of the line played (1; a card it
/// turns is unknown) and, each with probability `mid`, the positions between
/// the line's moves (2), which the player does not stop in but a person's
/// game does. Always recorded are the position a game not won ends in (3)
/// and a position dealt from (4), and half the time the one after a deal (5).
/// Returns (won, suits completed, decisions).
pub fn record_for_analysis(g: &Game, cfg: &LineConfig, noise: f64, noisy: usize, sample: f64, mid: f64, seed: u64, out: &mut Vec<u8>) -> (bool, usize, usize) {
    let mut g = g.clone();
    let mut rng = Rng(seed ^ 0xA7A1);
    let unit = |rng: &mut Rng| (rng.next() >> 11) as f64 / (1u64 << 53) as f64;
    let quiet_from = if rng.next() % 2 == 0 || noisy == 0 { 0 } else { 1 + (rng.next() % noisy as u64) as usize };
    let mut visited = HashSet::new();
    let mut tempo = Tempo::default();
    let mut recs: Vec<(Vec<u8>, u8)> = Vec::new();
    let record = |s: &State, deals_left: usize, kind: u8, recs: &mut Vec<(Vec<u8>, u8)>| {
        let mut e = vec![0; ENC];
        encode(s, deals_left, &mut e);
        recs.push((e, kind));
    };
    let start = g.move_count();
    let mut decisions = 0;
    let mut dealt = false;
    while !g.is_won() && g.move_count() - start < 5000 && g.columns.iter().all(|c| c.len() <= MAXC) {
        if decisions == quiet_from {
            visited.clear();
            tempo = Tempo::default();
        }
        let quiet = decisions >= quiet_from;
        decisions += 1;
        let obs = mask(&g);
        let root = State::from_game(&obs);
        visited.insert(root.hash());
        let before = progress(&g);
        let deals_left = g.deals_remaining();
        let cfg = cfg.staged.map_or(cfg, |s| &s[deals_left]);
        let mut decision = decide(&obs, deals_left, &visited, &mut tempo, cfg).0;
        if !quiet && matches!(decision, Decision::Play(_)) {
            let u = unit(&mut rng);
            if u < noise {
                let nodes = search_state(root.clone(), cfg);
                let mut ranked: Vec<(i32, usize)> = (1..nodes.len())
                    .filter(|&k| !visited.contains(&nodes[k].state.hash()))
                    .map(|k| (nodes[k].parts.value(deals_left, cfg.empty), k))
                    .filter(|&(v, _)| v > LOST)
                    .collect();
                ranked.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
                ranked.truncate(8);
                if !ranked.is_empty() {
                    let k = ranked[(rng.next() % ranked.len() as u64) as usize].1;
                    decision = Decision::Play(line_to(&nodes, k).concat());
                    tempo.plan.clear();
                }
            } else if u < 1.1 * noise && deals_left > 0 && g.columns.iter().all(|c| !c.is_empty() && c.len() < MAXC) {
                decision = Decision::Deal;
            }
        }
        let rec = quiet && unit(&mut rng) < sample;
        let after_deal = quiet && std::mem::take(&mut dealt) && rng.next() % 2 == 0;
        match decision {
            Decision::Play(moves) => {
                if rec || after_deal {
                    record(&root, deals_left, if after_deal { 5 } else { 0 }, &mut recs);
                }
                let mut after = obs.clone();
                let last = moves.len() - 1;
                for (i, mv) in moves.into_iter().enumerate() {
                    g.apply(mv).expect("planned move is legal");
                    after.apply(mv).expect("planned move is legal");
                    let fits = after.columns.iter().all(|c| c.len() <= MAXC);
                    if quiet && fits && if i == last { rec } else { unit(&mut rng) < mid } {
                        record(&State::from_game(&after), deals_left, if i == last { 1 } else { 2 }, &mut recs);
                    }
                }
            }
            Decision::Deal => {
                if quiet {
                    record(&root, deals_left, 4, &mut recs);
                }
                g.apply(Move::Deal).expect("deal is legal");
                dealt = true;
            }
            Decision::Stuck => {
                if quiet {
                    record(&root, deals_left, 3, &mut recs);
                }
                break;
            }
        }
        if progress(&g) != before {
            tempo = Tempo::default();
        }
    }
    let won = g.is_won();
    for (e, kind) in recs {
        out.extend_from_slice(&e);
        out.extend_from_slice(&[won as u8, g.completed.len() as u8, g.suits, kind]);
        out.extend_from_slice(&(seed as u32).to_le_bytes());
    }
    (won, g.completed.len(), decisions)
}

/// What the line player would do next in an encoded position, for the
/// analysis's network (one more thing it is told, since it cannot see it):
/// 0 unknown (a card turned and not yet known, or the game won), 1 a line
/// that raises the evaluation, 2 one that turns a card, 3 and 4 the same
/// about to deal (or, with the stock gone, about to give up), 5 a deal, 6
/// nothing. The player asked is the cheap one, [`LineConfig::fast`] (a
/// search for every position valued; and the rollout player's expectimax
/// wants to know which cards are unseen, while the encoding does not say
/// which suits are completed), starting afresh in the position as the
/// encoding has it (the top [`ROWS`] cards of each column).
pub fn next_kind(enc: &[u8], suits: u8) -> u8 {
    let mut g = Game::new(suits, 0);
    for c in 0..NUM_COLS {
        let codes = &enc[c * ROWS..(c + 1) * ROWS];
        if codes.contains(&2) {
            return 0;
        }
        g.columns[c] = codes.iter().take_while(|&&x| x != 0).map(|&x| if x == 1 { BLANK } else { crate::game::Card(x - 3) }).collect();
        g.face_down[c] = codes.iter().filter(|&&x| x == 1).count();
    }
    let deals_left = enc[NUM_COLS * ROWS] as usize;
    g.stock = vec![BLANK; deals_left * NUM_COLS];
    g.completed = vec![0; enc[NUM_COLS * ROWS + 1] as usize];
    if g.is_won() {
        return 0;
    }
    let cfg = LineConfig::fast(suits);
    let mut tempo = Tempo::default();
    match decide_steps(&g, deals_left, &HashSet::new(), &mut tempo, &cfg).0 {
        Choice::Line(_) => 1 + tempo.turns as u8 + 2 * tempo.dealing as u8,
        Choice::Deal => 5,
        Choice::Stuck => 6,
    }
}

/// Settings of the network player.
#[derive(Clone, Copy, Debug)]
pub struct VConfig {
    /// The line search (and the player that fills empty columns when it
    /// must, and decides when nothing the network likes is better).
    pub line: LineConfig,
    /// Line ends valued by the network: the best this many by the normal
    /// evaluation, by the about-to-deal evaluation, and of those that turn
    /// a card.
    pub top_normal: usize,
    pub top_deal: usize,
    pub top_flip: usize,
    /// Sampled deals averaged to value dealing.
    pub deal_samples: usize,
    /// A line must beat the position's own value by this much (in win
    /// probability) to be played; NaN: it need not (the position's value
    /// already counts its best continuation, so the best line beats it
    /// only by chance).
    pub margin: f32,
    /// A line must beat dealing by this much.
    pub deal_margin: f32,
    /// Added to a line's value per point the evaluation gains by it.
    pub hand: f32,
    /// Decisions without a card turned, a deal or a completed suit after
    /// which the player deals (or, with the stock gone, stops).
    pub max_idle: usize,
    /// Probability that a line played is instead a random one of the best
    /// four by the network (for training data).
    pub explore: f64,
    /// Probability that a decision's position (and the end of the line
    /// played) is recorded.
    pub record: f64,
    /// The line player decides while it raises the normal value; the
    /// network only once it would turn to dealing (or giving up), choosing
    /// among lines by the about-to-deal evaluation, lines that turn a card,
    /// and dealing.
    pub deal_only: bool,
}

impl VConfig {
    /// Defaults with `SPIDER_V_*` overrides (TOP_NORMAL, TOP_DEAL,
    /// TOP_FLIP, DEAL_SAMPLES, MARGIN, DEAL_MARGIN, HAND, MAX_IDLE, EXPLORE, RECORD, DEAL_ONLY); `SPIDER_L_*` for the line
    /// search.
    pub fn from_env(suits: u8) -> VConfig {
        fn get<T: std::str::FromStr>(name: &str, d: T) -> T {
            std::env::var(format!("SPIDER_V_{name}")).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
        }
        VConfig {
            line: LineConfig::from_env(suits),
            top_normal: get("TOP_NORMAL", 64),
            top_deal: get("TOP_DEAL", 64),
            top_flip: get("TOP_FLIP", 32),
            deal_samples: get("DEAL_SAMPLES", 8),
            margin: get("MARGIN", f32::NAN),
            deal_margin: get("DEAL_MARGIN", 0.0),
            hand: get("HAND", 0.0),
            max_idle: get("MAX_IDLE", 20),
            explore: get("EXPLORE", 0.0),
            record: get("RECORD", 0.0),
            deal_only: get("DEAL_ONLY", 0u8) != 0,
        }
    }
}

/// A decision waiting for the network: the positions to value are the
/// current one, then the end of each line, then the sampled deals.
pub struct Proposal {
    pub encs: Vec<u8>,
    lines: Vec<Vec<Move>>,
    /// The evaluation's gain (normal mode) of each line's end over the
    /// current position.
    gains: Vec<i32>,
    deals: usize,
}

impl Proposal {
    pub fn len(&self) -> usize {
        self.encs.len() / ENC
    }

    pub fn is_empty(&self) -> bool {
        self.encs.is_empty()
    }
}

/// The candidates from the game `g` (only its masked position is looked
/// at).
pub fn propose(g: &Game, visited: &HashSet<u64>, cfg: &VConfig) -> Proposal {
    let obs = mask(g);
    let deals_left = g.deals_remaining();
    let root = State::from_game(&obs);
    // Deciding only about dealing: the line player's wider search for it.
    let lc = if cfg.deal_only && cfg.line.deal_splits != 0 { LineConfig { splits: cfg.line.deal_splits, ..cfg.line } } else { cfg.line };
    let nodes = search_state(root.clone(), &lc);
    let fresh: Vec<usize> = (1..nodes.len())
        .filter(|&k| !visited.contains(&nodes[k].state.hash()) && nodes[k].parts.value(deals_left, cfg.line.empty) > LOST)
        .filter(|&k| nodes[k].state.len.iter().all(|&l| (l as usize) <= MAXC))
        .collect();
    let mut picked: Vec<usize> = Vec::new();
    let mut take = |keyed: &mut Vec<(i32, usize)>, n: usize| {
        keyed.sort_unstable_by_key(|&(v, k)| (std::cmp::Reverse(v), k));
        for &(_, k) in keyed.iter().take(n) {
            if !picked.contains(&k) {
                picked.push(k);
            }
        }
    };
    if !cfg.deal_only {
        take(&mut fresh.iter().map(|&k| (nodes[k].parts.value(deals_left, cfg.line.empty), k)).collect(), cfg.top_normal);
    }
    let end_empty = if deals_left > 0 { cfg.line.deal_empty } else { cfg.line.end_empty };
    take(&mut fresh.iter().map(|&k| (nodes[k].parts.value(deals_left, end_empty), k)).collect(), cfg.top_deal);
    take(&mut fresh.iter().filter(|&&k| nodes[k].leaf).map(|&k| (nodes[k].parts.value(deals_left, cfg.line.empty), k)).collect(), cfg.top_flip);
    let mut encs = vec![0u8; (1 + picked.len()) * ENC];
    encode(&root, deals_left, &mut encs[..ENC]);
    for (i, &k) in picked.iter().enumerate() {
        encode(&nodes[k].state, deals_left, &mut encs[(i + 1) * ENC..]);
    }
    let lines = picked.iter().map(|&k| line_to(&nodes, k).concat()).collect();
    let root_value = nodes[0].parts.value(deals_left, cfg.line.empty);
    let gains = picked.iter().map(|&k| nodes[k].parts.value(deals_left, cfg.line.empty).saturating_sub(root_value)).collect();
    let mut deals = 0;
    if deals_left > 0 && root.len.iter().all(|&l| l > 0 && (l as usize) < MAXC) {
        let count = unseen_counts(&obs);
        let mut pool: Vec<u8> = (0..52u8).flat_map(|c| std::iter::repeat_n(c, count[c as usize] as usize)).collect();
        let mut rng = Rng(masked_hash(&obs));
        for _ in 0..cfg.deal_samples {
            let mut t = root.clone();
            for c in 0..NUM_COLS {
                let j = c + (rng.next() % (pool.len() - c) as u64) as usize;
                pool.swap(c, j);
                t.cols[c][t.len[c] as usize] = pool[c];
                t.len[c] += 1;
            }
            let at = encs.len();
            encs.resize(at + ENC, 0);
            encode(&t, deals_left - 1, &mut encs[at..]);
            deals += 1;
        }
    }
    Proposal { encs, lines, gains, deals }
}

/// What the player does.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Play(Vec<Move>),
    Deal,
    Stop,
}

/// Decide, given the network's win probabilities for the proposal's
/// positions. `idle`: decisions since the last progress.
pub fn choose(g: &Game, p: &Proposal, v: &[f32], visited: &HashSet<u64>, idle: usize, cfg: &VConfig) -> Action {
    let n = p.lines.len();
    let can_deal = p.deals > 0;
    let deal_v = can_deal.then(|| v[1 + n..].iter().sum::<f32>() / p.deals as f32);
    if idle < cfg.max_idle {
        let score = |k: usize| v[1 + k] + cfg.hand * p.gains[k] as f32;
        let best = (0..n).max_by(|&a, &b| score(a).total_cmp(&score(b)));
        if let Some(b) = best {
            let over_root = cfg.margin.is_nan() || score(b) > v[0] + cfg.margin;
            if over_root && deal_v.is_none_or(|d| score(b) > d + cfg.deal_margin) {
                return Action::Play(p.lines[b].clone());
            }
        }
    }
    if can_deal {
        return Action::Deal;
    }
    if idle >= cfg.max_idle && g.deals_remaining() == 0 {
        return Action::Stop;
    }
    // Nothing better and no deal possible: the line player decides, about
    // to deal (filling empty columns, or giving up with the stock gone).
    let mut tempo = Tempo { dealing: true, ..Tempo::default() };
    match decide_steps(&mask(g), g.deals_remaining(), visited, &mut tempo, &cfg.line).0 {
        Choice::Line(steps) => Action::Play(steps.concat()),
        Choice::Deal => Action::Deal,
        Choice::Stuck => Action::Stop,
    }
}

/// A game being played by the network player.
pub struct Live {
    pub seed: u64,
    pub game: Game,
    visited: HashSet<u64>,
    idle: usize,
    start: usize,
    /// The line player's tempo (with [`VConfig::deal_only`]).
    tempo: Tempo,
    pub done: bool,
    rng: Rng,
    /// Recorded positions (see [`VConfig::record`]), `ENC` bytes each.
    encs: Vec<u8>,
}

impl Live {
    pub fn new(suits: u8, seed: u64) -> Live {
        let game = Game::new(suits, seed);
        let start = game.move_count();
        Live { seed, game, visited: HashSet::new(), idle: 0, start, tempo: Tempo::default(), done: false, rng: Rng(seed ^ 0x5E1F), encs: Vec::new() }
    }

    /// The next decision's proposal (marks the game done if it is over).
    pub fn propose(&mut self, cfg: &VConfig) -> Option<Proposal> {
        loop {
            let g = &self.game;
            if g.is_won() || g.move_count() - self.start >= 5000 || g.columns.iter().any(|c| c.len() > MAXC) {
                self.done = true;
                return None;
            }
            let obs = mask(g);
            self.visited.insert(masked_hash(&obs));
            if !cfg.deal_only || self.tempo.dealing {
                return Some(propose(g, &self.visited, cfg));
            }
            // The line player plays its normal lines; once it would turn to
            // dealing, the network decides.
            let mut tempo = self.tempo.clone();
            match decide_steps(&obs, g.deals_remaining(), &self.visited, &mut tempo, &cfg.line).0 {
                Choice::Line(steps) if !tempo.dealing => {
                    let before = progress(&self.game);
                    for mv in steps.concat() {
                        self.game.apply(mv).expect("planned move is legal");
                    }
                    if progress(&self.game) != before {
                        self.idle = 0;
                    }
                }
                _ => {
                    self.tempo.dealing = true;
                    return Some(propose(&self.game, &self.visited, cfg));
                }
            }
        }
    }

    /// Act on the network's values for the proposal.
    pub fn act(&mut self, p: &Proposal, v: &[f32], cfg: &VConfig) {
        let before = progress(&self.game);
        let unit = |rng: &mut Rng| (rng.next() >> 11) as f64 / (1u64 << 53) as f64;
        let mut action = choose(&self.game, p, v, &self.visited, self.idle, cfg);
        let n = p.lines.len();
        if matches!(action, Action::Play(_)) && n > 0 && unit(&mut self.rng) < cfg.explore {
            // A random line among the best four by the network.
            let mut order: Vec<usize> = (0..n).collect();
            order.sort_by(|&a, &b| v[1 + b].total_cmp(&v[1 + a]));
            let k = order[(self.rng.next() % n.min(4) as u64) as usize];
            action = Action::Play(p.lines[k].clone());
        }
        if cfg.record > 0.0 && unit(&mut self.rng) < cfg.record {
            self.encs.extend_from_slice(&p.encs[..ENC]);
            if let Action::Play(moves) = &action {
                if let Some(k) = p.lines.iter().position(|l| l == moves) {
                    self.encs.extend_from_slice(&p.encs[(1 + k) * ENC..(2 + k) * ENC]);
                }
            }
        }
        if std::env::var_os("SPIDER_V_TRACE").is_some() {
            let best = v[1..1 + p.lines.len()].iter().cloned().fold(f32::NAN, f32::max);
            let deal = (p.deals > 0).then(|| v[1 + p.lines.len()..].iter().sum::<f32>() / p.deals as f32);
            eprintln!("{}\nroot {:.3} best line {best:.3} of {} deal {deal:?} idle {} -> {action:?}", crate::human::show(&self.game), v[0], p.lines.len(), self.idle);
        }
        match action {
            Action::Play(moves) => {
                for mv in moves {
                    self.game.apply(mv).expect("planned move is legal");
                }
            }
            Action::Deal => self.game.apply(Move::Deal).expect("deal is legal"),
            Action::Stop => self.done = true,
        }
        self.idle = if progress(&self.game) == before { self.idle + 1 } else { 0 };
        if self.idle == 0 {
            self.tempo = Tempo::default();
        }
    }

    /// The recorded positions as training records (see [`RECORD`]), once
    /// the game is over.
    pub fn records(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for e in self.encs.chunks(ENC) {
            out.extend_from_slice(e);
            out.push(self.game.is_won() as u8);
            out.push(self.game.completed.len() as u8);
            out.extend_from_slice(&(self.seed as u32).to_le_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_hides_face_down_cards() {
        let a = Game::new(4, 3);
        let mut b = a.clone();
        b.columns[0].swap(0, 1);
        assert_eq!(encode_game(&a), encode_game(&b));
        let e = encode_game(&a);
        assert_eq!(e[0], 1);
        assert_eq!(e[5], 3 + a.columns[0][5].0);
        assert_eq!(e[NUM_COLS * ROWS], 5);
    }
}
