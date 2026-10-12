//! Web Spider for friends: serves the static client, keeps accounts, and
//! records wins. A win is checked by replaying its move list with the
//! terminal game's rules (`src/game.rs`), so a seed deals the same cards here,
//! in the browser and in the terminal.
//!
//! FreeCell is played here too (rules in `freecell.rs`). A deal is
//! `(game, suits, seed)`, in the database and in the API: game `spider` with
//! 1-4 suits, or `freecell`, which always has 4.

#[allow(dead_code)]
#[path = "../../src/game.rs"]
mod game;
#[allow(dead_code)]
mod freecell;

use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// Seeds stay within JavaScript's exact integer range.
const MAX_SEED: u64 = (1 << 53) - 1;
const SESSION_COOKIE: &str = "session";
/// The most a saved game may take (the request body limit is 2 MB).
const MAX_GAME_STATE: usize = 1_000_000;

/// Daily challenges `(date, game, suits, seed)` in date order. Spider's are in
/// challenges.txt (`date suits seed`, made by tools/dailies), four a day;
/// FreeCell's in freecell-challenges.txt (`date deal`, made by
/// tools/freecell/dailies.mjs), one a day. Days start at midnight Pacific time.
static CHALLENGES: LazyLock<Vec<(String, &'static str, u8, u64)>> = LazyLock::new(|| {
    let lines = |text: &'static str| text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.split_whitespace().collect::<Vec<_>>());
    let spider = lines(include_str!("../challenges.txt")).map(|f| (f[0].to_string(), "spider", f[1].parse().unwrap(), f[2].parse().unwrap()));
    let freecell = lines(include_str!("../freecell-challenges.txt")).map(|f| (f[0].to_string(), "freecell", 4, f[1].parse().unwrap()));
    let mut v: Vec<_> = spider.chain(freecell).collect();
    v.sort();
    v
});

fn today() -> String {
    chrono::Utc::now().with_timezone(&chrono_tz::America::Los_Angeles).date_naive().to_string()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- game: 'spider' (suits 1-4) or 'freecell' (suits 4), here and in games.
-- moves: length of the winning line. undos: every undo; real_undos: those
-- that took back a card flip or a deal (in FreeCell, a move that could not
-- just be played back).
CREATE TABLE IF NOT EXISTS wins (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    suits INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    moves INTEGER NOT NULL,
    real_undos INTEGER NOT NULL,
    undos INTEGER NOT NULL,
    move_list TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    game TEXT NOT NULL DEFAULT 'spider'
);
CREATE INDEX IF NOT EXISTS wins_by_game_deal ON wins(game, suits, seed);
-- A player's game of a deal, as the client saves it (JSON): the tree of every
-- move played and the line of it on the board.
CREATE TABLE IF NOT EXISTS games (
    user_id INTEGER NOT NULL REFERENCES users(id),
    game TEXT NOT NULL,
    suits INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, game, suits, seed)
);
";

/// Bring a database from before deals had a game up to SCHEMA (run before
/// it). Then every deal was Spider's, but for a day when FreeCell's were kept
/// as deals of 0 suits.
fn migrate(db: &mut Connection) -> rusqlite::Result<()> {
    let lacks_game = |table: &str| -> rusqlite::Result<bool> {
        let columns: Vec<String> = db.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(!columns.is_empty() && !columns.iter().any(|c| c == "game"))
    };
    let (wins, games) = (lacks_game("wins")?, lacks_game("games")?);
    let tx = db.transaction()?;
    if wins {
        tx.execute_batch(
            "ALTER TABLE wins ADD COLUMN game TEXT NOT NULL DEFAULT 'spider';
             UPDATE wins SET game = 'freecell', suits = 4 WHERE suits = 0;
             DROP INDEX IF EXISTS wins_by_deal;",
        )?;
    }
    if games {
        tx.execute_batch(
            "ALTER TABLE games RENAME TO games_old;
             CREATE TABLE games (
                 user_id INTEGER NOT NULL REFERENCES users(id),
                 game TEXT NOT NULL,
                 suits INTEGER NOT NULL,
                 seed INTEGER NOT NULL,
                 state TEXT NOT NULL,
                 updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                 PRIMARY KEY (user_id, game, suits, seed)
             );
             INSERT INTO games (user_id, game, suits, seed, state, updated_at)
                 SELECT user_id, iif(suits = 0, 'freecell', 'spider'), iif(suits = 0, 4, suits), seed, state, updated_at FROM games_old;
             DROP TABLE games_old;",
        )?;
    }
    tx.commit()
}

/// Whether there is such a deal.
fn is_deal(game: &str, suits: u8, seed: u64) -> bool {
    match game {
        "spider" => matches!(suits, 1..=4) && seed <= MAX_SEED,
        "freecell" => suits == 4 && seed <= freecell::MAX_DEAL,
        _ => false,
    }
}

fn spider() -> String {
    "spider".into()
}

struct App {
    db: Mutex<Connection>,
    invite_code: String,
    secure_cookie: bool,
}

type AppState = State<Arc<App>>;

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("database error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
    }
}

fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

type ApiResult<T> = Result<T, ApiError>;

struct User {
    id: i64,
    username: String,
    settings: String,
}

impl User {
    fn to_json(&self) -> Value {
        let settings: Value = serde_json::from_str(&self.settings).unwrap_or(json!({}));
        json!({ "username": self.username, "settings": settings })
    }
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|c| c.trim().strip_prefix(&format!("{SESSION_COOKIE}=")).map(str::to_string))
}

fn current_user(app: &App, headers: &HeaderMap) -> ApiResult<Option<User>> {
    let Some(token) = session_token(headers) else { return Ok(None) };
    let db = app.db.lock().unwrap();
    Ok(db
        .query_row(
            "SELECT u.id, u.username, u.settings FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1",
            [token],
            |r| Ok(User { id: r.get(0)?, username: r.get(1)?, settings: r.get(2)? }),
        )
        .optional()?)
}

fn require_user(app: &App, headers: &HeaderMap) -> ApiResult<User> {
    current_user(app, headers)?.ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "log in first".into()))
}

fn cookie(app: &App, value: &str, max_age: i64) -> HeaderValue {
    let secure = if app.secure_cookie { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}").parse().unwrap()
}

/// Start a session for `user` and answer with its cookie.
fn logged_in(app: &App, user: &User) -> ApiResult<Response> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    app.db.lock().unwrap().execute("INSERT INTO sessions (token, user_id) VALUES (?1, ?2)", params![token, user.id])?;
    let mut resp = Json(user.to_json()).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, cookie(app, &token, 400 * 24 * 3600));
    Ok(resp)
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    invite: String,
}

async fn signup(State(app): AppState, Json(c): Json<Credentials>) -> ApiResult<Response> {
    let username = c.username.trim();
    if c.invite.trim() != app.invite_code {
        return Err(ApiError(StatusCode::FORBIDDEN, "wrong invite code".into()));
    }
    if username.is_empty() || username.len() > 24 || !username.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        return Err(bad("username: 1-24 letters, digits, _ or -"));
    }
    if c.password.len() < 6 {
        return Err(bad("password: at least 6 characters"));
    }
    let hash = Argon2::default().hash_password(c.password.as_bytes()).expect("hashing").to_string();
    let id = {
        let db = app.db.lock().unwrap();
        match db.execute("INSERT INTO users (username, pw_hash) VALUES (?1, ?2)", params![username, hash]) {
            Ok(_) => db.last_insert_rowid(),
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err(ApiError(StatusCode::CONFLICT, "that username is taken".into()));
            }
            Err(e) => return Err(e.into()),
        }
    };
    logged_in(&app, &User { id, username: username.to_string(), settings: "{}".into() })
}

async fn login(State(app): AppState, Json(c): Json<Credentials>) -> ApiResult<Response> {
    let found = app
        .db
        .lock()
        .unwrap()
        .query_row("SELECT id, username, settings, pw_hash FROM users WHERE username = ?1", [c.username.trim()], |r| {
            Ok((User { id: r.get(0)?, username: r.get(1)?, settings: r.get(2)? }, r.get::<_, String>(3)?))
        })
        .optional()?;
    let ok = found.as_ref().is_some_and(|(_, hash)| {
        PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(c.password.as_bytes(), &h).is_ok())
    });
    match found {
        Some((user, _)) if ok => logged_in(&app, &user),
        _ => Err(ApiError(StatusCode::UNAUTHORIZED, "wrong username or password".into())),
    }
}

async fn logout(State(app): AppState, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = session_token(&headers) {
        app.db.lock().unwrap().execute("DELETE FROM sessions WHERE token = ?1", [token])?;
    }
    let mut resp = Json(json!({})).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, cookie(&app, "", 0));
    Ok(resp)
}

async fn me(State(app): AppState, headers: HeaderMap) -> ApiResult<Json<Value>> {
    Ok(Json(current_user(&app, &headers)?.map_or(Value::Null, |u| u.to_json())))
}

async fn put_settings(State(app): AppState, headers: HeaderMap, Json(settings): Json<Value>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    let text = settings.to_string();
    if !settings.is_object() || text.len() > 4000 {
        return Err(bad("settings must be a small JSON object"));
    }
    app.db.lock().unwrap().execute("UPDATE users SET settings = ?1 WHERE id = ?2", params![text, user.id])?;
    Ok(Json(settings))
}

#[derive(Deserialize)]
struct Win {
    /// (Left out by pages loaded before FreeCell.)
    #[serde(default = "spider")]
    game: String,
    suits: u8,
    seed: u64,
    moves: String,
    real_undos: u32,
    undos: u32,
}

/// Replay a claimed win; on success, the number of moves in it.
fn check_win(w: &Win) -> Result<usize, String> {
    if !is_deal(&w.game, w.suits, w.seed) {
        return Err("no such deal".into());
    }
    if w.real_undos > w.undos {
        return Err("more real undos than undos".into());
    }
    if w.game == "freecell" {
        return check_freecell_win(w);
    }
    let moves = game::parse_moves(&w.moves)?;
    let mut g = game::Game::new(w.suits, w.seed);
    for (i, &mv) in moves.iter().enumerate() {
        g.apply(mv).map_err(|e| format!("move {}: {e}", i + 1))?;
    }
    if !g.is_won() {
        return Err("those moves do not win the deal".into());
    }
    Ok(moves.len())
}

fn check_freecell_win(w: &Win) -> Result<usize, String> {
    let moves = freecell::parse_moves(&w.moves)?;
    let mut g = freecell::Game::new(w.seed as u32);
    for (i, &mv) in moves.iter().enumerate() {
        g.apply(mv).map_err(|e| format!("move {}: {e}", i + 1))?;
    }
    if !g.is_won() {
        return Err("those moves do not win the deal".into());
    }
    Ok(moves.len())
}

async fn record_win(State(app): AppState, headers: HeaderMap, Json(w): Json<Win>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    let moves = check_win(&w).map_err(|e| bad(&e))?;
    app.db.lock().unwrap().execute(
        "INSERT INTO wins (user_id, game, suits, seed, moves, real_undos, undos, move_list) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![user.id, w.game, w.suits, w.seed as i64, moves as i64, w.real_undos, w.undos, w.moves],
    )?;
    results(&app, &user, &w.game, w.suits, w.seed).map(Json)
}

/// Everyone's best win of a deal (fewest real undos, then fewest moves).
/// Only shown to players who have won it themselves.
fn results(app: &App, user: &User, game: &str, suits: u8, seed: u64) -> ApiResult<Value> {
    let db = app.db.lock().unwrap();
    let seed = seed as i64;
    let won: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM wins WHERE user_id = ?1 AND suits = ?2 AND seed = ?3 AND game = ?4)",
        params![user.id, suits, seed, game],
        |r| r.get(0),
    )?;
    if !won {
        return Err(ApiError(StatusCode::FORBIDDEN, "win this deal to see the results".into()));
    }
    let mut stmt = db.prepare(
        "SELECT u.username, w.moves, w.real_undos, w.created_at
         FROM wins w JOIN users u ON u.id = w.user_id
         WHERE w.game = ?3 AND w.suits = ?1 AND w.seed = ?2
           AND w.id = (SELECT b.id FROM wins b WHERE b.user_id = w.user_id AND b.game = ?3 AND b.suits = ?1 AND b.seed = ?2
                       ORDER BY b.real_undos, b.moves, b.id LIMIT 1)
         ORDER BY w.real_undos, w.moves, w.created_at",
    )?;
    let rows = stmt
        .query_map(params![suits, seed, game], |r| {
            Ok(json!({
                "username": r.get::<_, String>(0)?,
                "moves": r.get::<_, i64>(1)?,
                "real_undos": r.get::<_, i64>(2)?,
                "at": r.get::<_, i64>(3)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "results": rows }))
}

async fn get_results(State(app): AppState, headers: HeaderMap, Path((game, suits, seed)): Path<(String, u8, u64)>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    results(&app, &user, &game, suits, seed).map(Json)
}

async fn put_game(
    State(app): AppState,
    headers: HeaderMap,
    Path((game, suits, seed)): Path<(String, u8, u64)>,
    Json(state): Json<Value>,
) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    let text = state.to_string();
    if !is_deal(&game, suits, seed) || !state.is_object() || text.len() > MAX_GAME_STATE {
        return Err(bad("not a game"));
    }
    app.db.lock().unwrap().execute(
        "INSERT INTO games (user_id, game, suits, seed, state) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, game, suits, seed) DO UPDATE SET state = excluded.state, updated_at = unixepoch()",
        params![user.id, game, suits, seed as i64, text],
    )?;
    Ok(Json(json!({})))
}

async fn get_game(State(app): AppState, headers: HeaderMap, Path((game, suits, seed)): Path<(String, u8, u64)>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    let text: Option<String> = app
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT state FROM games WHERE user_id = ?1 AND game = ?2 AND suits = ?3 AND seed = ?4",
            params![user.id, game, suits, seed as i64],
            |r| r.get(0),
        )
        .optional()?;
    let state = text.and_then(|t| serde_json::from_str::<Value>(&t).ok());
    Ok(Json(json!({ "state": state })))
}

/// Challenges up to today, newest day first, with how many players have won
/// each and (when logged in) the player's own best win of it.
async fn dailies(State(app): AppState, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&app, &headers)?;
    let today = today();
    let db = app.db.lock().unwrap();
    // Who has won each deal, first winner first. Logged-in friends see the
    // names; everyone sees how many.
    type Deal = (String, u8, i64);
    let mut solvers: HashMap<Deal, Vec<String>> = HashMap::new();
    let mut stmt = db.prepare(
        "SELECT w.game, w.suits, w.seed, u.username FROM wins w JOIN users u ON u.id = w.user_id
         GROUP BY w.game, w.suits, w.seed, w.user_id ORDER BY MIN(w.created_at), MIN(w.id)",
    )?;
    for row in stmt.query_map([], |r| Ok(((r.get(0)?, r.get(1)?, r.get(2)?), r.get(3)?)))? {
        let (key, name) = row?;
        solvers.entry(key).or_default().push(name);
    }
    // Worst first, so the best win is inserted last.
    let mut mine: HashMap<Deal, Value> = HashMap::new();
    if let Some(user) = &user {
        let mut stmt = db.prepare("SELECT game, suits, seed, real_undos, moves FROM wins WHERE user_id = ?1 ORDER BY real_undos DESC, moves DESC")?;
        for row in stmt.query_map([user.id], |r| {
            Ok(((r.get(0)?, r.get(1)?, r.get(2)?), json!({ "real_undos": r.get::<_, i64>(3)?, "moves": r.get::<_, i64>(4)? })))
        })? {
            let (key, best) = row?;
            mine.insert(key, best);
        }
    }
    // The deals the player has played to where they could no longer be won
    // (the client says so in the game it saves).
    let mut lost: HashSet<Deal> = HashSet::new();
    if let Some(user) = &user {
        let mut stmt = db.prepare("SELECT game, suits, seed FROM games WHERE user_id = ?1 AND json_extract(state, '$.lost')")?;
        for row in stmt.query_map([user.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))? {
            lost.insert(row?);
        }
    }
    let mut days: Vec<Value> = Vec::new();
    for (date, game, suits, seed) in CHALLENGES.iter().rev().filter(|c| c.0 <= today) {
        let key = (game.to_string(), *suits, *seed as i64);
        let names = solvers.get(&key).map(Vec::as_slice).unwrap_or_default();
        let mut challenge = json!({ "game": game, "suits": suits, "seed": seed, "solved": names.len(), "mine": mine.get(&key) });
        if user.is_some() {
            challenge["solvers"] = json!(names);
            challenge["lost"] = json!(lost.contains(&key));
        }
        match days.last_mut() {
            Some(day) if day["date"] == *date => day["challenges"].as_array_mut().unwrap().insert(0, challenge),
            _ => days.push(json!({ "date": date, "challenges": [challenge] })),
        }
    }
    Ok(Json(json!({ "today": today, "days": days })))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let db_path = env_or("DATABASE_PATH", "spider.db");
    let static_dir = env_or("STATIC_DIR", "static");
    let port = env_or("PORT", "8080");
    let invite_code = std::env::var("INVITE_CODE").unwrap_or_else(|_| {
        eprintln!("INVITE_CODE is not set; signing up needs the invite code \"spider\"");
        "spider".into()
    });

    let mut db = Connection::open(&db_path).expect("open database");
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").expect("configure database");
    migrate(&mut db).expect("migrate database");
    db.execute_batch(SCHEMA).expect("create tables");
    let app = Arc::new(App { db: Mutex::new(db), invite_code, secure_cookie: std::env::var("COOKIE_SECURE").is_ok() });

    let api = Router::new()
        .route("/signup", post(signup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/settings", put(put_settings))
        .route("/wins", post(record_win))
        .route("/results/{game}/{suits}/{seed}", get(get_results))
        .route("/games/{game}/{suits}/{seed}", get(get_game).put(put_game))
        .route("/dailies", get(dailies))
        .with_state(app);
    // Any other path (e.g. /play/2/1234) is the single-page client.
    let client = ServeDir::new(&static_dir).fallback(ServeFile::new(format!("{static_dir}/index.html")));
    let router = Router::new()
        .nest("/api", api)
        .fallback_service(client)
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")));

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    eprintln!("listening on http://{addr} (database {db_path})");
    axum::serve(listener, router).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The browser's port of the rules (static/game.js) must deal the same
    /// cards, play moves and rank hints the same way as game.rs. test/port.mjs plays
    /// random games in JavaScript and prints each one's deal, moves and final
    /// position; replaying them here must agree.
    #[test]
    fn javascript_port_matches() {
        let out = std::process::Command::new("node").arg("test/port.mjs").output().expect("node is needed for this test");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8(out.stdout).unwrap();
        let mut games = 0;
        for line in text.lines() {
            let f: Vec<&str> = line.split(' ').collect();
            let (suits, seed): (u8, u64) = (f[0].parse().unwrap(), f[1].parse().unwrap());
            let mut g = game::Game::new(suits, seed);
            let stock: Vec<String> = g.stock.iter().map(|c| c.0.to_string()).collect();
            assert_eq!(g.to_position_text(), f[2], "deal {suits}/{seed}");
            assert_eq!(stock.join(","), f[3], "stock {suits}/{seed}");
            for mv in game::parse_moves(f[4]).unwrap() {
                g.apply(mv).unwrap();
            }
            assert_eq!(g.to_position_text(), f[5], "after moves {suits}/{seed}");
            assert_eq!(game::encode_moves(g.hint_moves()), f[6], "hints {suits}/{seed}");
            games += 1;
        }
        assert!(games >= 30);
    }

    /// The same for FreeCell: test/fcport.mjs plays random games and the
    /// solver's winning lines, and freecell.rs must agree on every position.
    #[test]
    fn javascript_freecell_matches() {
        let out = std::process::Command::new("node").arg("test/fcport.mjs").output().expect("node is needed for this test");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8(out.stdout).unwrap();
        let (mut games, mut wins) = (0, 0);
        for line in text.lines() {
            let f: Vec<&str> = line.split(' ').collect();
            let seed: u32 = f[0].parse().unwrap();
            let mut g = freecell::Game::new(seed);
            assert_eq!(g.to_position_text(), f[1], "deal {seed}");
            for mv in freecell::parse_moves(f[2]).unwrap() {
                g.apply(mv).unwrap();
            }
            assert_eq!(g.to_position_text(), f[3], "after moves {seed}");
            games += 1;
            let win = |undos, real_undos| Win { game: "freecell".into(), suits: 4, seed: seed as u64, moves: f[2].into(), real_undos, undos };
            if g.is_won() {
                wins += 1;
                assert_eq!(check_win(&win(2, 2)), Ok(f[2].split(',').count()));
                assert!(check_win(&win(1, 2)).is_err());
                assert!(check_win(&Win { seed: seed as u64 + 1, ..win(0, 0) }).is_err());
            } else {
                assert!(check_win(&win(0, 0)).is_err());
            }
        }
        assert!(games >= 40 && wins >= 4);
    }

    /// Deal 1 is Microsoft's deal 1.
    #[test]
    fn freecell_deals_are_microsofts() {
        let g = freecell::Game::new(1);
        // J♦ K♦ 2♠ 4♣ 3♠ 6♦ 6♠ and 5♥ 3♥ 3♣ 7♠ 7♦ 10♣
        assert_eq!(g.columns[0], [36, 38, 1, 42, 2, 31, 5]);
        assert_eq!(g.columns[7], [17, 15, 41, 6, 32, 48]);
    }

    /// The FreeCell solver (static/fcwinnable.js) against a search that
    /// shares nothing with it; see test/fcwinnable.mjs.
    #[test]
    fn freecell_solver_is_sound() {
        let out = std::process::Command::new("node").arg("test/fcwinnable.mjs").output().expect("node is needed for this test");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let n: Vec<u32> = String::from_utf8(out.stdout).unwrap().split_whitespace().map(|n| n.parse().unwrap()).collect();
        assert!(n[0] >= 100 && n[1] >= 100, "too few positions judged: {n:?}");
    }

    /// A database from before deals had a game keeps its wins and saved games.
    #[test]
    fn migrates_a_database_without_games() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL,
                 settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch()));
             CREATE TABLE wins (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), suits INTEGER NOT NULL, seed INTEGER NOT NULL,
                 moves INTEGER NOT NULL, real_undos INTEGER NOT NULL, undos INTEGER NOT NULL, move_list TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch()));
             CREATE INDEX wins_by_deal ON wins(suits, seed);
             CREATE TABLE games (user_id INTEGER NOT NULL REFERENCES users(id), suits INTEGER NOT NULL, seed INTEGER NOT NULL, state TEXT NOT NULL,
                 updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (user_id, suits, seed));
             INSERT INTO users (username, pw_hash) VALUES ('a', '');
             INSERT INTO wins (user_id, suits, seed, moves, real_undos, undos, move_list) VALUES (1, 2, 7, 100, 0, 3, 'x'), (1, 0, 7, 90, 1, 1, 'y');
             INSERT INTO games (user_id, suits, seed, state, updated_at) VALUES (1, 2, 7, '{}', 5), (1, 0, 7, '{\"lost\":true}', 6);",
        )
        .unwrap();
        for _ in 0..2 {
            // (the second time, there is nothing to do)
            migrate(&mut db).unwrap();
            db.execute_batch(SCHEMA).unwrap();
        }
        let rows = |sql: &str| -> Vec<String> { db.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect() };
        assert_eq!(rows("SELECT game || suits || '/' || seed || '/' || moves FROM wins ORDER BY id"), ["spider2/7/100", "freecell4/7/90"]);
        assert_eq!(rows("SELECT game || suits || '/' || seed || state || updated_at FROM games ORDER BY updated_at"), ["spider2/7{}5", "freecell4/7{\"lost\":true}6"]);
    }

    #[test]
    fn challenges_are_complete() {
        let days: std::collections::BTreeSet<&str> = CHALLENGES.iter().map(|c| c.0.as_str()).collect();
        for day in &days {
            let deals: Vec<(&str, u8)> = CHALLENGES.iter().filter(|c| c.0 == *day).map(|c| (c.1, c.2)).collect();
            assert_eq!(deals, [("freecell", 4), ("spider", 1), ("spider", 2), ("spider", 3), ("spider", 4)], "{day}");
        }
        assert!(CHALLENGES.iter().all(|c| is_deal(c.1, c.2, c.3)));
        assert!(days.contains(today().as_str()), "the challenges have run out: run tools/dailies and tools/freecell/dailies.mjs");
        let freecell: HashSet<u64> = CHALLENGES.iter().filter(|c| c.1 == "freecell").map(|c| c.3).collect();
        assert_eq!(freecell.len(), days.len(), "a FreeCell deal is a challenge twice");
    }

    #[test]
    fn rejects_bogus_wins() {
        let w = |moves: &str| Win { game: spider(), suits: 1, seed: 5, moves: moves.into(), real_undos: 0, undos: 0 };
        assert!(check_win(&w("")).is_err());
        assert!(check_win(&w("d,d")).is_err());
        assert!(check_win(&w("0>0:1")).is_err());
        assert!(check_win(&Win { seed: MAX_SEED + 1, ..w("") }).is_err());
        let line = include_str!("../test/win-1-3.txt").trim();
        assert_eq!(check_win(&Win { seed: 3, ..w(line) }), Ok(line.split(',').count()));
        assert!(check_win(&Win { seed: 4, ..w(line) }).is_err());
        assert!(check_win(&Win { seed: 3, real_undos: 1, ..w(line) }).is_err());
    }
}
