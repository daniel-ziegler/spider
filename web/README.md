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

## Analysis

A game of Spider can be looked over once it is won or marked as lost
(**Analyze**, in the tray and in the win dialog; at any time from the menu),
somewhat as a Go server reviews a game: the player's biggest mistakes, each
with the move that would have been better and what it was for, a plot of the
chance of winning over the moves, and the board to step through (click or
drag on the plot, `←` `→`, `↑` `↓` or the digits for the mistakes, `B` for
the better move and `S` for what it sets up, `Esc` to go back).

* **Whose chance.** That of a computer player that sees only the cards face
  up and takes nothing back: the line player of the main README in a cheap
  configuration (`LineConfig::fast`: six-step lines, a beam of 50, no
  expectimax; it wins 87%, 63%, 44% and 26% of deals with one to four suits,
  the full player 88%, 70%, 54% and 39%, at a thirtieth of the work with four
  suits). `static/lineplayer.js` is a port of it that plays move for move as
  the Rust does and about as fast (some 50 ms a game).
* **What is analysed.** The line of moves on the board, as if it had been
  played straight through. Moves taken back are not looked at: the tree of
  moves does not say when they were played, so what the player had seen of
  the face-down cards at each point is not known. A game won with undos is so
  read as luckier than it was.
* **Stretches.** A move that turns a card over or deals ends a stretch of
  moves. Within a stretch the player learns nothing, so what its moves change
  is the player's doing and what the cards it shows change is luck.
* **The curve** comes from a network (`static/vnet.js`, a forward pass in
  plain typed arrays; `static/nets/vN.bin`, 320 kB for each number of suits,
  float16): the value network of the main README (a transformer over the
  cards, 160,000 weights) trained anew on games of that cheap player, one for
  each number of suits, since the existing one was for four suits and
  another player. It values every position, each position where a card was
  turned with that card unknown (as it was trained to), and sixteen sampled
  deals for each deal.
* **A mistake** is a move after which the computer player wins less often
  than from the position before it, where it would have chosen its own. That
  is measured by playing games out, in shuffles of the cards the player had
  not seen: the same shuffles from both positions, which makes the difference
  much less noisy than the two rates. The network is not asked (its error
  from one position to the next is as large as most mistakes, and the
  moments it used to pick were mostly not consequential), and what the cards
  did is no part of it.
  * *Candidates.* Every stretch whose moves are not in effect the computer
    player's own (`track` in `analysis-worker.js`): its own line from the
    stretch's start goes up to its first move that shows cards, a move played
    that is its next is no departure, and one that is not is a departure only
    if the player, asked anew after it, would end its line somewhere else
    (moves can often be played in another order, or taken back). A deal or a
    turned card where it would first have made other moves is a departure
    like any other: the commonest mistake, dealing too early, is found so.
  * *Sharing out the games* (`findMistakes` in `analysis-core.js`, `SEARCH`
    for the numbers). Each candidate first gets 16 shuffles, two games in
    each (from its start and from its end); then, round by round, the six
    that look worst and are not settled get as many again, up to 512. A
    candidate is settled when it is surely a mistake (256 shuffles or more, a
    loss of at least five points and at least 2.5 standard errors) or
    cannot well become one. This goes on until all are settled or 4,400
    games are played, and for up to 1,600 more while a candidate is close
    (a loss of five points, one and a half standard errors, 64 shuffles). What is not surely a mistake by then is not listed: a
    game may have none, and the page then says so.
  * *Which move.* A stretch with several departures is cut in two at one in
    its middle, games are played from there in 256 of the same shuffles, and
    the half that lost more is cut again, until one move is left. If that
    move by itself is surely a mistake it is the one shown; if not (the loss
    is spread over several) the stretch is shown from its first departure on.
  * *What is shown*, for at most five, the costliest first: the move played;
    the computer player's next move in its place and what that is for (the
    card it then turns, or the deal, and how many moves on); the chances of
    winning after each; and on the board the two moves as arrows, red and
    green. One click shows the position the better line reaches just before
    its card is turned or its deal is made, and `→` steps along it.
  * *At any position* the same can be asked for (**?** beside the arrows, or
    the `?` or `C` key): the computer player's line from the position on the
    board, shown as a mistake's better line is, with its first move, what
    that is for and what it sets up, and whether the move played there was
    the same or came to the same. Nothing is played out for it; it is worked
    out in a worker ahead of the games waiting (some 10 to 100 ms, a second
    at most) and kept, and the workers stay for it when the search is done.
  * *Luck* is one line: the stretch where the network has the cards doing
    most is played out (128 shuffles, after its moves with the shuffle's
    cards and with the real ones, the shuffle's others as they were but for
    those swapped at random to make room), and named if that is five points
    or more and twice its standard error.
* **Where it runs.** All in the browser, in workers (as many as the cores,
  less one, at most twelve), and shown as it arrives. `analysis.js` (the
  page), `analysis-core.js`, `analysis-worker.js`, `lineplayer.js`, `vnet.js`,
  `analysis.css` and the network are fetched only when an analysis is first
  asked for; the networks are served to be kept for good (`/nets`,
  `Cache-Control: immutable`) and asked for by version (`NET_VERSION` in
  `analysis.js`, to be raised when they change). The GPU is not used: valuing
  a game's 300 to 500 positions takes about two seconds on eight workers, and nine tenths of
  the time goes to playing games out, which is a search and not arithmetic.
  The mistakes take at most some 7,000 games played out (4,400 to 6,000 to
  find them, the rest to put them to their moves and for the luck).
* `cargo test` in the repository root compares the port of the player with
  the Rust on 48 deals (`GAMES=250` in the environment for 1,000: moves and
  positions searched are the same), the network's values with PyTorch's
  (`test/vnet.mjs`: they agree to 1e-6), the positions' encoding with
  `src/vnet.rs`, and checks the shuffles, the departures and the search for
  mistakes, the last with games won by chance (`test/analysis.mjs`).

To make the networks again (the data is some 1.3 GB for each):

```
cargo build --release
SPIDER_L_FAST=1 target/release/vdata 4 1000001 200000 runs/analysis/d4.bin 0.05 0.25
.venv/bin/python vnet/train.py train --data runs/analysis/d4.bin --out runs/analysis/w4.pt
.venv/bin/python web/tools/analysis/export.py --ckpt runs/analysis/w4.pt --suits 4 --data runs/analysis/d4.bin
```

| suits | games (records)     | the line player won | log loss, held out (knowing nothing) |
|-------|---------------------|---------------------|--------------------------------------|
| 1     | 120,000 (2.9M)      | 86%                 | 0.163 (0.262)                        |
| 2     | 130,000 (3.4M)      | 63%                 | 0.363 (0.533)                        |
| 3     | 130,000 (3.7M)      | 42%                 | 0.452 (0.677)                        |
| 4     | 200,000 (4.3M)      | 24%                 | 0.449 (0.668)                        |

(The games have a random line among the best eight one decision in twenty,
as the value network's did. One, two and three suits were trained for two
epochs, four for three.) The network is right on average but not about
what the player will do next. On the line player's own games, where the
moves should cost nothing and luck be fair, its value climbs between deals
and falls at each (by 5, 10, 11 and 7 points on average with one to four
suits): it cannot tell that nothing is left to do, so a position about to
be dealt from is too high. And a position with a turned card unknown is one
to two points higher than it is on average with the card known. The second
is taken off (`BIAS` in `analysis-core.js`); the first is left in the
curve, and is one reason why the mistakes are not chosen by it: they are
found by games played out alone, and the curve is to be read as rough.
`node tools/analysis/calib.mjs SUITS` measures this on the line player's
own games.

## FreeCell

The home page switches between Spider and FreeCell. FreeCell has a daily
challenge and free play: a random deal or a deal number, numbered as
in Microsoft FreeCell. Its home page is `/freecell`, its past challenges
`/freecell/archive` and a deal `/freecell/DEAL`. A deal is
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
* Nothing is hidden, so an undo counts (a real undo), unless a move could
  do the same: the cards can go straight back and none went to the
  foundations meanwhile. Still only the first time a move is taken back.
  Only the first undo of a game that counts asks before it is made.
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
* `tools/freecell/dumb.mjs` is a dumb player
  that tells easy deals from hard ones: it plays the move whose position
  scores best, with a little noise, and never takes one back. Of deals
  1-200 it never wins 45% in 20 games and wins 17% of all its games.
  `node tools/freecell/pick.mjs FROM TO [MAX] [GAMES]` lists the winnable
  deals it wins at most MAX (0.2) of the time.
* The daily challenges, one a day, are in `freecell-challenges.txt`
  (`date deal`), built into the server. `tools/freecell/dailies.mjs` picks
  them: for each date, the first candidate (deals 1-1,000,000, from a hash
  of the date) that can be won and that the dumb player wins at most 10% of
  40 games of, which drops about a third of the deals. Like Spider's they
  were backfilled from 2026-09-03 and run through 2027-12-31; dates in the
  file are kept, so to extend it:
  `node tools/freecell/dailies.mjs 2028-01-01 2028-12-31`.

## Daily challenges

Every day (midnight to midnight Pacific time) has four challenges: 1, 2, 3 and
4 suits, and with three and four suits a [medium one](#medium-challenges) too (three suits are three sets of spades, three of hearts and two of
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

### Medium challenges

With three and four suits a day (from 2026-10-14) also has a **medium**
challenge beside the hard one. It is another deal, so both can be played and
their wins and saved games are apart. The home page shows each medium one
above its hard one, and the archive one of the two kinds at a time. They are
listed in `medium-challenges.txt` (`date suits seed`, built into the server
like the others) and taken, in shuffled order, from
`tools/dailies/picked3_medium.txt` and `picked4_medium.txt`: seeds that the
wavering line player wins at least 27 of 30 times and `pick_seeds`' weak
player 50 to 79 of 100, so they are easy for it but not sure. That keeps 7.4%
of three-suit seeds (85 of 100001–101147) and 3.0% of four-suit ones (88 of
100001–102957); 79 of each are used, through 2026-12-31. Played again with
other salts (`../src/bin/seed_rates.rs`: 12 games each by the line player and
by it without expectimax or replanning, 50 by the weak one), against 40 of
the hard deals of `picked3.txt` and `picked4_2026.txt`:

| won                             | 3 suits, medium | hard | 4 suits, medium | hard |
|---------------------------------|-----------------|------|-----------------|------|
| line player                     | 95%             | 79%  | 93%             | 76%  |
| without expectimax, replanning  | 92%             | 65%  | 83%             | 54%  |
| weak player                     | 66%             | 26%  | 62%             | 31%  |
| `human.rs` (deals it wins)      | 52%             | 18%  | 38%             | 18%  |

Of all deals the line player wins 54% and 39%, and the weak one about 22%
and 17%. To extend the list, pick more seeds from where the files end (their
first lines say), add the kept ones to them, and give the dates:

```
cd ../.. && SPIDER_W_MIN=0.5 SPIDER_W_MAX=0.8 SPIDER_W_RUNS=100 SPIDER_W_FIRST=20 SPIDER_W_FIRST_MIN=7 \
    SPIDER_S_MIN=0.89 SPIDER_S_RUNS=30 cargo run --release --bin pick_seeds -- 4 102958 3000
cd web/tools/dailies && cargo run --release -- medium 2027-01-01 2027-03-31
```

(about 50 games of the line player, two minutes of one core, for each seed
kept). `cargo test` fails once today is past the end of the medium
ones too.

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
