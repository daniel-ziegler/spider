//! Web Spider for friends: serves the static client, keeps accounts, and
//! records wins. A win is checked by replaying its move list with the
//! terminal game's rules (`src/game.rs`), so a seed deals the same cards here,
//! in the browser and in the terminal.

#[allow(dead_code)]
#[path = "../../src/game.rs"]
mod game;

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
use std::sync::{Arc, Mutex};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// Seeds stay within JavaScript's exact integer range.
const MAX_SEED: u64 = (1 << 53) - 1;
const SESSION_COOKIE: &str = "session";

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
-- moves: length of the winning line. undos: every undo; real_undos: those
-- that took back a card flip or a deal.
CREATE TABLE IF NOT EXISTS wins (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    suits INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    moves INTEGER NOT NULL,
    real_undos INTEGER NOT NULL,
    undos INTEGER NOT NULL,
    move_list TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS wins_by_deal ON wins(suits, seed);
";

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
    suits: u8,
    seed: u64,
    moves: String,
    real_undos: u32,
    undos: u32,
}

/// Replay a claimed win; on success, the number of moves in it.
fn check_win(w: &Win) -> Result<usize, String> {
    if !matches!(w.suits, 1 | 2 | 4) || w.seed > MAX_SEED {
        return Err("no such deal".into());
    }
    if w.real_undos > w.undos {
        return Err("more real undos than undos".into());
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

async fn record_win(State(app): AppState, headers: HeaderMap, Json(w): Json<Win>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    let moves = check_win(&w).map_err(|e| bad(&e))?;
    app.db.lock().unwrap().execute(
        "INSERT INTO wins (user_id, suits, seed, moves, real_undos, undos, move_list) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![user.id, w.suits, w.seed as i64, moves as i64, w.real_undos, w.undos, w.moves],
    )?;
    results(&app, &user, w.suits, w.seed).map(Json)
}

/// Everyone's best win of a deal (fewest real undos, then fewest moves).
/// Only shown to players who have won it themselves.
fn results(app: &App, user: &User, suits: u8, seed: u64) -> ApiResult<Value> {
    let db = app.db.lock().unwrap();
    let seed = seed as i64;
    let won: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM wins WHERE user_id = ?1 AND suits = ?2 AND seed = ?3)",
        params![user.id, suits, seed],
        |r| r.get(0),
    )?;
    if !won {
        return Err(ApiError(StatusCode::FORBIDDEN, "win this deal to see the results".into()));
    }
    let mut stmt = db.prepare(
        "SELECT u.username, w.moves, w.real_undos, w.created_at
         FROM wins w JOIN users u ON u.id = w.user_id
         WHERE w.suits = ?1 AND w.seed = ?2
           AND w.id = (SELECT b.id FROM wins b WHERE b.user_id = w.user_id AND b.suits = ?1 AND b.seed = ?2
                       ORDER BY b.real_undos, b.moves, b.id LIMIT 1)
         ORDER BY w.real_undos, w.moves, w.created_at",
    )?;
    let rows = stmt
        .query_map(params![suits, seed], |r| {
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

async fn get_results(State(app): AppState, headers: HeaderMap, Path((suits, seed)): Path<(u8, u64)>) -> ApiResult<Json<Value>> {
    let user = require_user(&app, &headers)?;
    results(&app, &user, suits, seed).map(Json)
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

    let db = Connection::open(&db_path).expect("open database");
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").expect("configure database");
    db.execute_batch(SCHEMA).expect("create tables");
    let app = Arc::new(App { db: Mutex::new(db), invite_code, secure_cookie: std::env::var("COOKIE_SECURE").is_ok() });

    let api = Router::new()
        .route("/signup", post(signup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/settings", put(put_settings))
        .route("/wins", post(record_win))
        .route("/results/{suits}/{seed}", get(get_results))
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
    /// cards and play moves the same way as game.rs. test/port.mjs plays
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
            games += 1;
        }
        assert!(games >= 30);
    }

    #[test]
    fn rejects_bogus_wins() {
        let w = |moves: &str| Win { suits: 1, seed: 5, moves: moves.into(), real_undos: 0, undos: 0 };
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
