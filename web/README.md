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
drag on the plot; `←` `→` are always the game's own moves, `↑` `↓` or the
digits pick the mistakes; `A`, `Y`, `B` and `S` show a mistake's position
before, your move, the better move and what it sets up; `,` `.` step along
the better line; `?` or `C` has the computer's move shown at every position;
`Esc` goes back).

* **Whose chance.** That of a computer player that sees only the cards face
  up and takes nothing back: the line player of the main README in a
  configuration made for this (`LineConfig::rollout`: lines of up to
  fourteen steps, two with one suit; a beam of 100; and the four best lines
  that turn a card valued by expectimax one step deep). It wins 89%, 68%, 50%
  and 31% of deals with one to four suits; the full player 88%, 70%, 54% and
  39%, at nine times the work with two suits and more with four; the cheap
  one the analysis began with (`LineConfig::fast`) 86%, 63%, 42% and 25%, at
  a sixth of the work. `static/lineplayer.js` is a port of it that plays move
  for move as the Rust does (65 ms a four-suit game from the deal on one core, 17 ms a one-suit game).
* **WebAssembly.** The workers value positions with the network, and where
  JavaScript runs interpreted (Chrome with its optimizer off, as under
  Android's Advanced Protection: a short loop at a worker's start tells)
  also play the games, in WebAssembly (`static/spider.wasm`, built from
  `wasm/`: the line player of `src/lines.rs` itself and a port of
  `vnet.js`'s forward pass; `static/wasm.js` loads it). It gives what the
  JavaScript gives, to the bit (`test/wasm.mjs`). The network is some 30%
  faster in it than in compiled JavaScript, the games some 30% slower;
  where JavaScript is interpreted both are several times faster in it,
  so a whole analysis takes about as long there as anywhere. `bench.html`
  times all this on a device. After a change to the line player or the
  network, rebuild it (see `wasm/src/lib.rs`).
* **What is analysed.** The line of moves on the board, as if it had been
  played straight through. Moves taken back are not looked at: the tree of
  moves does not say when they were played, so what the player had seen of
  the face-down cards at each point is not known. A game won with undos is so
  read as luckier than it was.
* **Stretches.** A move that turns a card over or deals ends a stretch of
  moves. Within a stretch the player learns nothing, so what its moves change
  is the player's doing and what the cards it shows change is luck.
* **The curve** comes from a network (`static/vnet.js`, a forward pass in
  plain typed arrays; `static/nets/value.bin`, 650 kB, float16): the value
  network of the main README (a transformer over the cards, here of 325,000
  weights: 80 wide, four layers) trained on games of that player, one
  network for all four numbers of suits. Besides the cards it is told the
  number of suits and what the cheap line player would do next in the
  position (a line, one that turns a card, the same about to deal, a deal, or
  nothing: a search of a millisecond, `nextKind` in `lineplayer.js`), which
  it cannot see for itself and which says most of what it used to get wrong:
  that nothing is left to do before a deal, or at all. It values every
  position, and each position where cards were shown with those cards not
  yet known: a turned card as an unknown card in its place, a deal as an
  unknown card on every column (it is trained on both). Where the game is
  over the plot ends with how it ended, a ring that is no estimate of the
  network's: at 100% on the last move of a game won, and for a game lost
  (marked as no longer to be won when the analysis is opened, or with
  nothing left to play) a place of its own after the last move, at 0%, since
  the last position by its cards face up may still look worth something; the
  board there is the last position. A game still going has none.
* **A mistake** is a move after which the computer player wins less often
  than from the position before it, where it would have chosen its own. That
  is measured by playing games out, in shuffles of the cards the player had
  not seen: the same shuffles from both positions, which makes the difference
  much less noisy than the two rates. What the cards did is no part of it.
  * *Candidates.* Every stretch whose moves are not in effect the computer
    player's own (`track` in `analysis-worker.js`): its own line from the
    stretch's start goes up to its first move that shows cards, a move played
    that is its next is no departure, and one that is not is a departure only
    if the player, asked anew after it, would end its line somewhere else
    (moves can often be played in another order, or taken back). A deal or a
    turned card where it would first have made other moves is a departure
    like any other: the commonest mistake, dealing too early, is found so.
    A real game of fifty stretches has thirty to forty candidates.
  * *Where to look first* (`screen` in `analysis-core.js`). That is too many
    to play each out as far as it takes to be sure, so the network orders
    them: for each candidate it values the position the player's moves came
    to and the one the computer player's own line would have come to, both
    just before their cards show (a turned card or a deal not yet known, on
    either side), and the candidates are taken by that difference. Whatever
    the network gets wrong about such positions is on both sides, which the
    fall of the curve over a stretch does not have. The end of a game not
    won always comes first. See below for how good the order is.
  * *Sharing out the games* (`findMistakes`, `SEARCH` for the numbers). The
    first six candidates get 32 shuffles each, two games in each (from the
    stretch's start and from its end); then, round by round, the three that
    look worst and are not settled get as many again, up to 512, and when
    fewer than three are open the next by the network's order come in. A
    candidate is settled when it is surely a mistake (128 shuffles or more, a
    loss of at least five points and at least 2.5 standard errors) or cannot
    well become one. This goes on until all are settled or 2,400 games are
    played. The games go to the workers four shuffles at a time, so that
    a round's last games are spread over them.
  * *Which move.* A stretch with several departures is cut in two at one in
    its middle, games are played from there in 128 of the same shuffles, and
    the half that lost more is cut again, until one move is left. If that
    move by itself is surely a mistake it is the one shown; if not (the loss
    is spread over several) the stretch is shown from its first departure on,
    but only if it lost ten points or more: a small loss over a dozen moves
    is nothing a player can use.
  * *What it cost.* The games that found a mistake make it look worse than
    it is (it was picked because they went badly, and the search stops when
    they do; the losses listed ran some 30% high). So each mistake is played once more, in
    128 shuffles not used before, and the loss shown and its interval are of
    those games alone; one that then loses less than half of five points is
    dropped.
  * *What is shown*, for at most four, the costliest first: the move played;
    the computer player's next move in its place and what that is for (the
    card it then turns, or the deal, and how many moves on); the chances of
    winning after each; and on the board the two moves as arrows, red and
    green. One click shows the position the better line reaches just before
    its card is turned or its deal is made, and the line can be stepped
    along move by move (‹ › on the mistake, or `,` `.`), each next move
    drawn as an arrow; `←` `→` leave it for the game's neighbouring move.
  * *What may be mistakes.* With fewer than three mistakes the list is
    filled up with the candidates that lost most in the games they got (two
    points or more, in at least 128 shuffles: those that have fewer are
    first brought up to that), marked as unsure and drawn dashed, each put
    to a move if most of its loss is there. A mistake that its fresh games
    did not bear out is among them. Their losses are picked for being bad
    and so are worse than the truth on average; the ± says how little is
    known. Only where nothing lost two points does the page say that there
    are no clear mistakes and nothing more.
  * *At any position* the same can be asked for (**?** beside the arrows, or
    the `?` or `C` key, which stays on from position to position and from one
    analysis to the next until it is turned off; where a mistake picked out
    begins the mistake says it instead): the computer player's line from the
    position on the board, shown as a mistake's better line is, with its first move, what
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
  asked for; the network is served to be kept for good (`/nets`,
  `Cache-Control: immutable`) and asked for by version (`NET_VERSION` in
  `analysis.js`, to be raised when it changes). The GPU is not used:
  valuing a game's 150 to 450 positions takes about a second on twelve
  workers (14 ms a position, a millisecond of it the search for what the
  cheap player does next), and the rest of the time goes to playing games
  out, which is a search and not arithmetic. An analysis plays 2,400 to
  3,700 games out (2,400 to find the mistakes, then for each found some 250
  to 500 for its move and 256 for its loss, and 256 for the luck). In
  headless Chrome on a laptop with eight cores (twelve workers), with nothing
  else running, the owner's eight games below took 8 s (one suit), 40 to 50 s
  (two and three suits) and 47 to 74 s (four suits; the longest is a game
  of 353 moves won, whose games played out are long); a desktop that ran
  the analysis before this one (2,300 games of the cheap player, 21 s on
  that laptop) in 5 s should take a quarter of that.
* `cargo test` in the repository root compares the port of the player with
  the Rust on 48 deals for each of the two configurations (`GAMES=250` in
  the environment for 1,000: moves and positions searched are the same), the
  network's values with PyTorch's and what it is told the line player does
  next with the Rust's (`test/vnet.mjs`: the values agree to 1e-6), the
  positions' encoding with `src/vnet.rs`, and checks the shuffles, the
  departures and the search for mistakes, the last with games won by chance
  (`test/analysis.mjs`).

### The player

`runs/analysis2/sweep.sh` (not in the repository; `SPIDER_L_*` on
`target/release/lines`) tried what lies between the cheap player and the
full one, on seeds 62001 to 66000, with the CPU time as a multiple of the
cheap player's:

| setting (steps/beam, lines by one-step expectimax) | four suits | three suits |
|-----------------------------------------------------|------------|-------------|
| `fast`: 6/50                                        | 25.4%      | 42.1%       |
| 14/100                                              | 30.0% (4.6×) | 45.8% (4.5×) |
| 14/100, 2 lines                                     | 30.7% (5.2×) | 49.0% (5.0×) |
| **14/100, 4 lines** (`rollout`)                     | 31.4% (6.3×) | 49.8% (6.3×) |
| 14/100, 8 lines                                     | 31.8% (8.2×) | 49.5% (7.1×) |
| 14/100, 16 lines                                    | 32.0% (10.3×) | 50.0% (9.7×) |
| 14/150, 2 lines                                     | 31.1% (7.1×) | 49.9% (6.8×) |
| 14/75, 4 lines                                      | 30.6% (5.1×) | 48.3% (5.3×) |
| 10/100, 4 lines                                     | 29.2% (4.8×) | 47.3% (5.1×) |

With two suits (3,000 seeds) the cheap player wins 62.6%, 14/100 64.5%,
`rollout` 68.1% (6.1×) and the full player 69.5% (54×); with one suit 86.2%,
88.8% (5.7×), and with four-step lines besides 90.0% (14×). What the full
player has beyond this is its expectimax four steps deep with replanning: on
seeds 60001 to 61600 with four suits, 14/50 wins 29.8% and with those 35.1%,
at 18 times the CPU time (and the full beam of 300 makes that 39%). Less of
it bought nothing: one line four steps deep, or two or four lines two steps
deep, were no better than one step, replanning alone doubled the work for
nothing, and so did the wider search before a deal. The port to JavaScript
was then made to play the same games in six tenths of the time (the places
a sequence can go looked up by rank, a position a step on evaluated and
hashed from its two changed columns, the beam picked by a sort of numbers).

### The network

```
cargo build --release
target/release/adata 4 1000001 320000 runs/analysis2/a4.bin    # games of the player, positions with their outcomes
target/release/afeat runs/analysis2/a4.bin runs/analysis2/a4.feat   # what the cheap player does next in each
.venv/bin/python web/tools/analysis/train.py train --data runs/analysis2/a?.bin --out runs/analysis2/net.pt
.venv/bin/python web/tools/analysis/train.py report --data runs/analysis2/a?.bin --ckpt runs/analysis2/net.pt
.venv/bin/python web/tools/analysis/export.py --ckpt runs/analysis2/net.pt --data runs/analysis2/a?.bin
```

The data (3.6 GB; some five hours of ten threads):

| suits | games   | positions | with those dealt, not yet known | won (noisy starts and all) |
|-------|---------|-----------|---------------------------------|----------------|
| 1     | 80,000  | 1.34M     | 1.66M                           | 88%            |
| 2     | 100,800 | 1.69M     | 2.10M                           | 66%            |
| 3     | 180,500 | 2.94M     | 3.68M                           | 48%            |
| 4     | 320,300 | 4.96M     | 6.27M                           | 31%            |

(The networks before had 120,000, 130,000, 130,000 and 200,000 games of the
cheap player, 2.9M to 4.3M positions; this player costs six times as much a
game.) Half the games start with a noisy stretch that is not recorded (a
random line among the best eight one decision in four, now and then a deal
too early), so that there are positions the player would not get into
itself; from there on the player plays alone, so that a position's outcome
is what games played out from it measure. Recorded are an eighth of the
decisions with the end of the line played (a turned card unknown), some
positions between a line's moves, every position dealt from (of which the
trainer makes the position after the deal with its ten cards unknown), half
of those after a deal, and the position a game not won ends in.

The one network (80 wide, four layers, 325,000 weights; an epoch and a half
on the four-suit games, then an epoch and a half on all) against a network
of the old size (64 wide, three layers, 160,000 weights) for each number of
suits alone, trained on the same data for two epochs, by log loss on the
games held out (a twentieth):

| suits | one network | one for each | knowing nothing | calibration error |
|-------|-------------|--------------|-----------------|-------------------|
| 1     | 0.1637      | 0.1644       | 0.277           | 0.002             |
| 2     | 0.3404      | 0.3426       | 0.566           | 0.006             |
| 3     | 0.4108      | 0.4124       | 0.678           | 0.003             |
| 4     | 0.4047      | 0.4050       | 0.676           | 0.004             |

(The calibration error is the mean distance, over tenths of the value,
between the value and the share won; the largest in any tenth with a
thousand positions is 1.7 points.) Being told what the cheap player does
next is worth more than the size: on 885,000 four-suit positions the same
network had 0.4214 with it and 0.4351 without, and without it valued the
positions a game is given up in at 12% (with: 0.3%), those dealt from at 39%
where 33% were won (with: 34%) and those between a line's moves at 56% where
61% were won (with: 61%).

`node tools/analysis/calib.mjs SUITS FIRST GAMES` measures what is left on
the line player's own games, where the moves should cost nothing and luck
be fair (40 games for each number of suits; in brackets the networks
before, on 24):

| suits | where a lost game stops | fall over a stretch that ends in a deal | a turned card unknown is high by | a deal unknown is high by | dips inside a stretch: mean, over 3 points |
|-------|------------|------------|-------------|-----------|---------------------|
| 1     | 0.2% (46%) | 1.2 (4.9)  | 0.3 (1.0)   | 0.3       | 0.3, 3% (1.1, 13%)  |
| 2     | 0.1% (43%) | 1.6 (10.3) | −0.6 (1.8)  | 0.2       | 0.7, 7% (3.0, 28%)  |
| 3     | 0.1% (9%)  | 1.9 (10.7) | −0.5 (1.6)  | 0.3       | 1.3, 14% (3.0, 29%) |
| 4     | 0.1% (6%)  | 1.8 (6.9)  | −0.6 (1.6)  | 0.3       | 1.1, 11% (2.6, 24%) |

(Points of the chance of winning. A dip is how far the value falls inside a
stretch below both its start and its end before the cards show.) Nothing is
taken out any more (`BIAS` in `analysis-core.js` is zero): a deal's cards
not yet known are valued as a position of its own and not as the mean over
sixteen sampled deals, and that position is 0.2 to 0.3 points above that
mean.

### How good the network's order is

The owner's eight games (one to four suits, 110 to 353 moves, 226 candidates)
were played out for every candidate in 512 shuffles, which puts each
candidate's cost to two points or so. Seven candidates cost eight points or
more and surely something (all in the two- and three-suit games; the three
four-suit games have none). By the network's difference three of the seven
are among the first three candidates of their games, four among the first
five and six among the first eight (at random: 0.9, 1.5 and 2.4); counting
in six games of the computer player's with mistakes put in (256 shuffles),
7, 8 and 10 of 11 (at random 2.8, 4.2, 5.6). The mistakes of twelve points and more are
nearly always at the top; those of eight are not told from the noise, which
is some four points (the standard deviation of the difference where the
cost is under three points), and over all candidates the difference and the
cost correlate at only 0.2. So the order is used as an order and not as a
filter: the games go to the first candidates first and down the list as
they are settled. What the analysis then lists for the eight games (2,400
to 3,700 games each): six of the seven, nothing else, and nothing in the
four-suit games. The seventh (nine points over six moves) was seventh by
the network in its game, and the games ran out before it came in.

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
