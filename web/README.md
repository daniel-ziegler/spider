# Spider on the web

Spider Solitaire (and [FreeCell](#freecell)) for a few friends: play in the browser (mouse, touch or
keyboard), log in, and wins are recorded with their move count and real undos.

* `static/` – the client: plain JavaScript modules, no build step.
  `game.js` is a port of the terminal game's rules (`../src/game.rs`), so a
  deal number deals the same cards in both.
* `src/main.rs` – the server (axum + SQLite): accounts, settings, wins. It
  compiles `../src/game.rs` directly and replays every claimed win before
  saving it.

A game in progress is saved in the browser as the tree of every move played
in it (undone lines included) and, when logged in, synced to the server
(`/api/games`), so it can be carried on in another browser; the two copies'
trees are merged. An undo counts only the first time a move is taken back. A win stores the length of
the winning line (undone moves don't count), the number of undos, and the
number of **real undos**: undos that took back a card turned over or a deal.
Restarting a deal counts as undoing every move back to the start. Results for
a deal are shown only to players who have won it.

## Can it still be won?

A setting (on by default) marks the game, and says so when a move does it,
once it can no longer be won *whatever the cards you have not seen are*. It
goes only by what the player has seen (the cards face up, those turned up in
some line since taken back, and the stock if every deal has been made in some
line), so it gives nothing away; while cards in the stock are unseen it
proves nothing. `static/winnable.js` has the proof, a port of `lost_for_all`
in `../src/certify.rs` (see the main README), run in a worker; in play it
mostly comes a move or two before one is stuck. The file is a port of the
whole peeking solver (`../src/solver.rs`, default configuration), which is
used only when nothing at all is unseen, and then only to say that there is
no win. Both search step for step as the Rust does: `cargo test` in the
repository root runs them on some 300 positions from play
(`test/winnable.mjs`) and compares verdicts, work and winning lines.

A deal once played to where it could no longer be won is marked so in its
saved game (`lost`), and its daily challenge shows red until it is won.

## FreeCell

The home page switches between Spider and FreeCell. FreeCell has free play
only (no daily challenges yet): a random deal or a deal number, numbered as
in Microsoft FreeCell. Its home page is `/freecell` and a deal
`/freecell/DEAL`. A deal is
`(game, suits, seed)` in the API and the database: `spider` with 1-4 suits,
or `freecell`, always with 4. (A database from before FreeCell is migrated
when the server starts.)

* `static/freecell.js` has the rules, on the same tree of moves as Spider
  (`Played` in `game.js`), and `src/freecell.rs` is the server's port of
  them, which replays claimed wins; `cargo test` compares the two on random
  games (`test/fcport.mjs`).
* Cards that nothing could still want to lie on go to the foundations by
  themselves after every move, as part of it. A run moves between columns in
  one move if the empty cells and columns allow it a card at a time.
* Nothing is hidden, so every undo counts (`real_undos` = `undos`), still
  only the first time a move is taken back. Only the first undo of a game
  asks before it is made.
* The mark for a game that can no longer be won comes from a search in a
  worker (`static/fcwinnable.js`, which describes it): up to 2,000,000
  positions, after quick restarts that find nearly every win in a few
  milliseconds. The positions of a winning line it finds are remembered as
  winnable, so playing along one costs nothing. `cargo test` checks its
  verdicts against an independent search (`test/fcwinnable.mjs`).
* Auto-complete is offered once sending cards to the foundations is all
  that is left.
* Cards are red and black whatever the colour setting, since the colours
  are what the game goes by.
* For daily challenges to come, `tools/freecell/dumb.mjs` is a dumb player
  that tells easy deals from hard ones: it plays the move whose position
  scores best, with a little noise, and never takes one back. Of deals
  1-200 it never wins 45% in 20 games and wins 17% of all its games.
  `node tools/freecell/pick.mjs FROM TO [MAX] [GAMES]` lists the winnable
  deals it wins at most MAX (0.2) of the time.

## Daily challenges

Every day (midnight to midnight Pacific time) has four challenges: 1, 2, 3 and
4 suits (three suits are three sets of spades, three of hearts and two of
diamonds; they were added on 2026-10-10 and the earlier days backfilled). They are listed in `challenges.txt` (`date suits seed`), which is built
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
same way (weak player with 3-step lines): 567 found in seeds 1–4300, 485
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
