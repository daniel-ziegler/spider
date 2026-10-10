# Spider on the web

Spider Solitaire for a few friends: play in the browser (mouse, touch or
keyboard), log in, and wins are recorded with their move count and real undos.

* `static/` – the client: plain JavaScript modules, no build step.
  `game.js` is a port of the terminal game's rules (`../src/game.rs`), so a
  deal number deals the same cards in both.
* `src/main.rs` – the server (axum + SQLite): accounts, settings, wins. It
  compiles `../src/game.rs` directly and replays every claimed win before
  saving it.

In-progress games are saved only in the browser. A win stores the length of
the winning line (undone moves don't count), the number of undos, and the
number of **real undos**: undos that took back a card turned over or a deal.
Restarting a deal counts as undoing every move back to the start. Results for
a deal are shown only to players who have won it.

## Daily challenges

Every day (midnight to midnight Pacific time) has four challenges: 1, 2, 3 and
4 suits (three suits, from 2026-10-10, are three sets of spades, three of
hearts and two of diamonds). They are listed in `challenges.txt` (`date suits seed`), which is built
into the server. `tools/dailies` picks them: for each date and suit count, the
first candidate seed (from a hash of the date) that the peeking solver proves
winnable. It keeps dates already in the file, so extending the list never
changes a past challenge. From 2026-10-06 the four-suit challenges are instead
taken (in shuffled order) from `tools/dailies/picked4.txt`: seeds that the
non-peeking line player, choosing at random among nearly equal lines, wins
more than 70% of the time and a weak one (short lines, narrow search) less
than 40% (`src/bin/pick_seeds.rs`; 544 found in seeds 1–20000, 452 used
through 2027-12-31). From 2026-10-10 through 2026-12-31 the two- and
four-suit challenges come from `picked2_2026.txt` and `picked4_2026.txt`,
picked the same way with the stronger line player (expectimax and
replanning; the two-suit weak player uses 2-step lines): 136 found in
two-suit seeds 1–320 and 172 in four-suit seeds 20001–23200, 83 of each
used. The three-suit challenges all come from `picked3.txt`, picked the
same way (weak player with 3-step lines): 567 found in seeds 1–4300, 448
used through 2027-12-31. To extend the list:

```
cd tools/dailies && cargo run --release -- 2028-01-01 2028-12-31
```

The list runs through 2027-12-31, and `cargo test` fails once today is past
the end of it.

## Running locally

```
cargo run          # http://localhost:8080, database spider.db, invite code "spider"
cargo test         # includes a check that static/game.js plays exactly like game.rs (needs node)
```

Environment: `PORT`, `DATABASE_PATH`, `STATIC_DIR`, `INVITE_CODE` (needed to
sign up), `COOKIE_SECURE` (set when served over https).

## Deploying to Fly.io

One small machine with the SQLite database on a 1 GB volume; it stops when
idle and starts on the next request.

```
fly auth login
fly apps create spider-friends                   # or pick a name and change `app` in fly.toml
fly volumes create spider_data --size 1 --region sjc -a spider-friends
fly secrets set INVITE_CODE=something-secret -a spider-friends
./deploy.sh
```

`primary_region` is San Jose (`sjc`); the volume must be in the same region.
To back up the database: `fly ssh sftp get /data/spider.db`.
