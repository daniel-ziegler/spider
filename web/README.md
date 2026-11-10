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

Since 2026-11-04 the tree also keeps when each move was **first played**, for
looking at how a game went (what had been seen by a decision; the order lines
were tried in; how long a move took). A saved game's `times` is a second tree
beside `tree`, in the same form but with only the moves that have a time and
those on the way to them, each with `@` and its time in tenths of a second
since 1970 by the player's clock, less the time of the nearest move above it
that has one (so it can be negative if the clock went back):
`5>6:1@17931234567,2>5:3@42(d@80|1>2:1@1500)`. It is a separate field because
a page from before it, which may still be open, would take `@` in `tree` for
a bad save; it names its moves, rather than following `tree`'s order, so that
it holds for a tree that has changed since. Going back into a move keeps its
first time, games played before have no times, and merging two copies keeps a
move's earlier time. Such a page sends games without `times`, and the server
keeps the ones it has (`keep_times`). Nothing about the rules, undos or wins
reads the times.

The **undo tree** (menu, or <kbd>t</kbd>; `static/tree.js`, `tree.css`,
loaded when opened) draws that tree beside the board, or under it on a
narrow screen: a row per move, each node's longest branch going straight on
and the others in lanes to its right, moves that turned a card over or dealt
marked, won ends and ends with no move left too, and quiet stretches folded
(a tap opens them). Tapping a position goes there as the buttons would: undo
back to where its line and the board's part, then play down to it, so the
undos count exactly as those presses would (one question first if any of
them is a real undo).

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
  configuration made for this (`analysisConfig` in `static/lineplayer.js`,
  a port that plays move for move as the Rust does: `LineConfig::rollout`,
  which is lines of up to fourteen steps, two with one suit, a beam of 100,
  and the four best lines that turn a card valued by expectimax one step
  deep; and besides, with two suits or more, only four steps of a line
  played before it looks again, with a beam of 150, after the last deal
  eight and 100; with one suit lines of four steps and expectimax two deep
  after the last deal). It wins 91%, 69%, 52% and 37% of deals with one to
  four suits; `rollout` alone, which the analysis had before, 89%, 67%, 49%
  and 32.5% at four tenths of the work; the full player 88%, 70%, 54% and
  39%, at five times the work with four suits; the cheap one the analysis
  began with (`LineConfig::fast`) 86%, 63%, 42% and 25% (see [the player
  looking again](#the-player-looking-again)). That is the player whose line
  is shown and who plays the games that measure the mistakes. The curve's
  network is of this very player's games (see [the network](#the-network)
  and [the network without the cards face down](#the-network-without-the-cards-face-down)).
* **WebAssembly.** The workers play the games and value the positions in
  WebAssembly where it loads (`static/spider.wasm`, built from `wasm/`:
  `lineplayer.js` and `vnet.js`'s forward pass over again in Rust;
  `static/wasm.js` loads it), else in JavaScript. It gives what the
  JavaScript gives, to the bit (`test/wasm.mjs`, and 2,000 more deals played
  the same by both), in less than half the time for the games (of `rollout`
  28 ms a four-suit game from the deal on one core against 63; the player
  of now 59 ms) and two thirds of it
  for the network; where JavaScript runs interpreted (Chrome with its
  optimizer off, as under Android's Advanced Protection) the games take a
  seventeenth of the JavaScript's time and the network a twentieth, so a
  whole analysis takes about as long there as anywhere: the cheap player's
  game of `bench.html` (3,552 games played out) 22 s on twelve workers of a
  laptop, where it took 42 s with the games in JavaScript. (The Rust of
  `src/lines.rs` itself, which this first used for the games, took half as
  long again as the JavaScript: it copies and allocates for every position,
  and several workers at once got in each other's way in the cache.)
  `bench.html` times all this on a device. After a change to the line
  player or the network, change `wasm/src` to match and rebuild it (see
  `wasm/src/lib.rs`).
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
  weights: 80 wide, four layers, a token for each face-up card and none for
  those face down) trained on games of the player that plays the games out, one
  network for all four numbers of suits. Besides the cards it is told the
  number of suits and what the cheap line player would do next in the
  position (a line, one that turns a card, the same about to deal, a deal, or
  nothing: a search of a millisecond, `nextKind` in `lineplayer.js`), which
  it cannot see for itself and which says most of what it used to get wrong:
  that nothing is left to do before a deal, or at all. It values every
  position, and each position where cards were shown with those cards not
  yet known: a turned card as an unknown card in its place, a deal as an
  unknown card on every column (it is trained on both). Where the game is
  over its last position is worth what it came to and not what the network
  makes of it: 100% for a game won, 0% for a game lost (marked as no longer
  to be won when the analysis is opened, or with nothing left to play), with
  the word under the plot's end. So a deal that loses the game is a bar of
  the cards' down to nothing, and where nothing was shown since the last
  cards the fall is on the last move, the player's. A game still going ends
  with the network's value as anywhere. Once games are played out (below)
  the curve is the network's put together with them, as they come in: see
  [the curve with the games](#the-curve-with-the-games).
* **A mistake** is a move after which the computer player wins less often
  than from the position before it, where it would have chosen its own. That
  is measured by playing games out, in shuffles of the cards the player had
  not seen: the same shuffles from both positions, which makes the difference
  much less noisy than the two rates. What the cards did is no part of it.
  * *How far the games go.* With one suit to the end. With two or more a
    game is played on until eight moves have shown cards (turned one over,
    or dealt), counted from the start of its stretch so that the games from
    after the player's moves stop as far on as those from before them, and
    is then worth what the network makes of the position (`stop` in `SHORT`
    in `analysis-core.js`; a game over by then is worth what it came to). A
    value takes as long as a game, so a shuffle is no cheaper, but its
    difference is half as noisy (20 points for 39 with four suits) and a
    quarter of the shuffles do: the numbers below are those of one suit, and
    with more they are a quarter or less (16 shuffles at first, up to 128, a
    mistake from 32, 2,000 games; 64 for the move, the loss and the luck, 16
    for the curve). Near the
    end of a game fewer than eight such moves are left, the games end after
    all and are as noisy as ever; a mistake found there gets up to four
    times the shuffles for its move and its loss again. What this was
    measured to cost and gain is under [the network](#the-network).
  * *Candidates.* Every stretch whose moves are not in effect the computer
    player's own (`track` in `analysis-worker.js`): its own line from the
    stretch's start goes up to its first move that shows cards, a move played
    that is its next is no departure, and one that is not is a departure only
    if the player, asked anew after it, would end its line somewhere else
    (moves can often be played in another order, or taken back) and the line
    it had can no longer be played on to where it ended (a later move of the
    line played first is on the line still, though the player asked anew may
    choose another). The line shown in a departure's place is the computer
    player's with what it does for nothing taken out (`simplify`: a move and
    the one that takes it back, a detour, two moves of the same cards made
    one; it is legal, shows no card before its end and comes to the same
    position). A deal or a
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
    well become one. This goes on until all are settled or 6,000 games are
    played (most games are settled well before). The games go to the workers four shuffles at a time, so that
    a round's last games are spread over them.
  * *Which move.* A stretch with several departures is cut in two at one in
    its middle, games are played from there in 256 of the same shuffles, and
    the half that lost more is cut again, until one move is left. If that
    move by itself is surely a mistake it is the one shown; if not (the loss
    is spread over several) the stretch is shown from its first departure on,
    but only if it lost ten points or more: a small loss over a dozen moves
    is nothing a player can use.
  * *What it cost.* The games that found a mistake make it look worse than
    it is (it was picked because they went badly, and the search stops when
    they do; the losses listed ran some 30% high). So each mistake is played once more, in
    256 shuffles not used before, and the loss shown and its interval are of
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
    most is played out (256 shuffles, after its moves with the shuffle's
    cards and with the real ones, the shuffle's others as they were but for
    those swapped at random to make room), and named if that is five points
    or more and twice its standard error.
  * *For the curve* the start of every stretch is then played out in 64
    shuffles (16 with two suits or more), less those the search played
    there (`curve` in `SEARCH`, `fillCurve`), so that the curve has games
    everywhere and not only where the mistakes were looked for.
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
  out, which is a search and not arithmetic. An analysis of a one-suit
  game plays 2,400 to 3,700 games out (2,400 to find the mistakes, then for
  each found some 250 to 500 for its move and 256 for its loss, and 256 for
  the luck), one of more suits 600 to 2,000, each stopped and valued (the
  cheap player's four-suit game of `bench.html`, whose two mistakes are at
  its end and get the most: 2,000 games in 6.4 s on a laptop's twelve
  workers, where the 3,552 played to the end took 21 s; a person's four-suit
  game of 343 moves 750 games for 3,300, on one core 14 s for 69). Those
  are of the search before it was given more games for the curve (see [the
  curve with the games](#the-curve-with-the-games)), which now plays two to
  four times as many and takes two to three times as long. The
  times that follow are of games all played to the end, in JavaScript. In
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
P="SPIDER_L_REPLAN=4 SPIDER_L_BEAM=300"                      # the player the games are of: `rollout` with these (now the analysis's own: see below)
P1="SPIDER_L_K0_MAX_STEPS=4 SPIDER_L_K0_EXPECT_STEPS=2"      # (one suit)
env $P1 target/release/adata 1 5000001 80000 runs/strong/a1.bin
env $P target/release/adata 2 5000001 100000 runs/strong/a2.bin
env $P target/release/adata 3 5000001 180000 runs/strong/a3.bin
env $P target/release/adata 4 5000001 320000 runs/strong/a4.bin    # games of the player, positions with their outcomes
for s in 1 2 3 4; do target/release/afeat runs/strong/a$s.bin runs/strong/a$s.feat; done   # what the cheap player does next in each
python web/tools/analysis/train.py train --data runs/strong/a4.bin --suits 4 --epochs 1.5 --out runs/strong/net4.pt
python web/tools/analysis/train.py train --data runs/strong/a?.bin --init runs/strong/net4.pt --epochs 1.5 --out runs/strong/net.pt
python web/tools/analysis/train.py report --data runs/strong/a?.bin --ckpt runs/strong/net.pt
python web/tools/analysis/export.py --ckpt runs/strong/net.pt --data runs/strong/a?.bin
```

**Whose games.** The network says how often a player wins from a position,
and the player is whichever `adata` is given (`LineConfig::rollout` with the
environment's `SPIDER_L_*`, those for one stage too). It was the analysis's
own (`rollout`), so that the curve and the games played out measured the
same thing; it is now the strongest line player that so many games could be
had of, so that the curve says what good play makes of a position (and the
analysis's own has since been made that player, but for a narrower beam:
[the player looking again](#the-player-looking-again)): with two
to four suits `rollout` replanning every four steps with a beam of 300, which
plays as well as the full player at a third of its time, and with one suit
`rollout` with four-step lines and expectimax two steps deep after the last
deal (the main README's "What is left to gain"). On deals it has not seen it
wins 90.5%, 70.2%, 52.8% and 37.5% with one to four suits, the analysis's
player 89.2%, 67.8%, 49.1% and 31.9%. A stronger player's games are all it
takes to have the network follow: the commands above with other settings.

The data (4.5 GB; two and a half hours of a rented machine's thirty
threads, and an hour and a quarter of its GPU, an A10, for the training):

| suits | games   | positions | with those dealt, not yet known | won (noisy starts and all) |
|-------|---------|-----------|---------------------------------|----------------|
| 1     | 80,000  | 1.76M     | 2.12M                           | 88.6%          |
| 2     | 100,000 | 2.03M     | 2.45M                           | 66.4%          |
| 3     | 180,000 | 3.69M     | 4.45M                           | 49.3%          |
| 4     | 320,000 | 6.27M     | 7.60M                           | 33.5%          |

(The network before this one had as many games of the analysis's own
player, 1.34M to 4.96M positions, of which 88%, 66%, 48% and 31% were won;
those before had 120,000, 130,000, 130,000 and 200,000 games of the
cheap player.) Half the games start with a noisy stretch that is not recorded (a
random line among the best eight one decision in four, now and then a deal
too early), so that there are positions the player would not get into
itself; from there on the player plays alone, so that a position's outcome
is what that player makes of it. Recorded are an eighth of the
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
thousand positions is 1.7 points. These are of the network before, on the
analysis's own player's games.) The network of the stronger player's games,
the same and trained the same way, against the one before, each on games
held out of both players (40,000 more of the analysis's player for each
number of suits; log loss, and in brackets the mean value less the share
won, in points):

| suits | the stronger player's games: this network | the one before | the analysis's player's games: this network | the one before |
|-------|----------------|----------------|----------------|----------------|
| 1     | 0.1456 (−0.3)  | 0.1473 (−1.2)  | 0.1730 (+0.7)  | 0.1723 (−0.2)  |
| 2     | 0.3225 (−0.1)  | 0.3241 (−1.5)  | 0.3449 (+1.0)  | 0.3439 (−0.4)  |
| 3     | 0.3998 (−0.4)  | 0.4034 (−2.8)  | 0.4264 (+2.7)  | 0.4222 (+0.2)  |
| 4     | 0.4084 (+0.5)  | 0.4135 (−3.2)  | 0.4090 (+4.7)  | 0.3997 (+0.8)  |

So each is right about its own player and off by the difference between the
two about the other's (the positions are not only from the deal on, where
the players differ by 1.4 to 5.6 points); its calibration error on its own
games is 0.4 to 0.6 points. Being told what the cheap player does
next is worth more than the size: on 885,000 four-suit positions the same
network had 0.4214 with it and 0.4351 without, and without it valued the
positions a game is given up in at 12% (with: 0.3%), those dealt from at 39%
where 33% were won (with: 34%) and those between a line's moves at 56% where
61% were won (with: 61%).

`node tools/analysis/calib.mjs SUITS FIRST GAMES` measures what is left on
the line player's own games, where the moves should cost nothing and luck
be fair (40 games for each number of suits; in brackets the networks
before, on 24). This is of the network of the analysis's own player's
games:

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

With the network of the stronger player's games the same 40 games (of the
analysis's player, whose moves now do cost something: it is the weaker)
give: a lost game stops at 0.2%, 0.1%, 0.1% and 0.0%; the fall over a
stretch that ends in a deal is 1.3, 1.9, 2.4 and 1.8 points; a deal unknown
is 0.3, 0.1, −0.2 and 0.1 above the mean of sixteen deals; the dips are
0.2, 0.5, 1.0 and 0.9 points, over three in 2%, 5%, 10% and 9% of the
stretches. A turned card unknown is 1.1, 1.1 and 1.2 points low with two to
four suits (one suit: 0.2 high; before 0.6 low): over a stretch that ends
with a card turned the moves lose that much on average and the card gives
it back. `BIAS` is left at zero: it is two pixels of the plot, and the order
of the candidates has it on both sides.

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

All that is of the network before. A mistake is still what costs the
analysis's own player games, while the network now values positions for a
stronger one, so the order was measured again for both networks, by
`tools/analysis/order.mjs`: 54 games (16 each with two to four suits, 6
with one; seeds 81001 on) played as the analysis's player does but for one
stretch in eight, where a deal comes before its time or one to three legal
moves at random, and half the others, which are the cheap player's; every
candidate played out in 256 shuffles. Of 390 candidates 68 cost eight points
or more and surely something. Among the first three, five and eight of
their games by the network's difference are 63, 66 and 67 of them (the
network before: 63, 66 and 66; at random 31, 47 and 60), and over all
candidates the difference and the cost correlate at 0.71 (before: 0.72),
the difference where the cost is under three points having a standard
deviation of 4.7 points (4.9). These mistakes are plainer than a person's
(the eight games above were not to hand to be played again), but the two
networks order them alike.

What stopping the games is worth was measured first (`tools/analysis/short.mjs`,
on the same 54 games, 393 candidates, 256 shuffles each): the games of a
mistake not played out to the end but until so many moves have shown cards,
counted from the stretch's start, the network then valuing the position. A value takes as long as a
game or longer (12 to 18 ms against 5 to 25 ms for a game from the middle),
so a shuffle is no cheaper; what is gained is that a shuffle's difference is
far less noisy. With four suits:

| stopped after | correlation with the full games' cost | difference left with shuffles without end (rms) | a shuffle's sd | shuffles for the same error | time for the same error |
|---|---|---|---|---|---|
| 1 showing | 0.68 | 5.8 points | 4.6 points | 1/70 | 1/100 |
| 2 | 0.84 | 3.4 | 7.8 | 1/25 | 1/32 |
| 4 | 0.92 | 1.8 | 13.0 | 1/9 | 1/10 |
| 8 | 0.94 | 1.1 | 19.8 | 1/4 | 1/4 |
| 16 | 0.96 | 0.7 | 26.9 | 1/2 | 2/3 |
| the next deal | 0.93 | 2.1 | 17.6 | 1/5 | 1/5 |
| the end | 1 | 0 | 38.7 | 1 | 1 |

(The times are of a laptop with four of these running, where a shuffle's two
full games took 53 ms; alone they took 24 and the gain at four showings was
six times rather than ten.) One to three suits are alike (after four
showings 1.7, 1.7 and 0.5 points left, a seventh to a tenth of the time with
two and three suits; with one suit a game is cheaper than a value and little
is gained before eight). Of the 73 candidates that are mistakes by the full
games in 256 shuffles, 64 shuffles stopped after eight showings find 67 and
call 2 others mistakes; 64 shuffles of full games find 39. The network being
of a stronger player shows with four suits only: there the mistakes that
cost 15 points in full games cost 19 so (measured in shuffles other than
those that chose them); with one to three suits the two agree within a
point.

The page now stops after eight showings with two suits or more, and the
whole search was then compared with the one before on 48 such games (16 for
each of two to four suits, made again since the hints and the lines had
changed; `tools/analysis/found.mjs`, against every candidate's cost by full
games in 256 shuffles). Of the 62 candidates that are mistakes by those (five
points, 2.5 standard errors):

| the search | found | not | called mistakes besides: costing three points or more | less | games | time, one core, sixteen at once |
|---|---|---|---|---|---|---|
| games to the end (`SEARCH`) | 56 | 6 | 3 | 1 | 2,325 | 231 s |
| stopped after eight showings (`SHORT`) | 55 | 7 | 5 | 1 | 763 | 38 s |

(Three of the seven not found are in the list as perhaps mistakes; as are
three of the six.) The losses shown for those found are 20.3 points on
average, their full games' 20.4 (17.6 and 17.6 with four suits). More games
(800 for 600) or sixteen shuffles at first find no more. Before a mistake at
a game's end got more shuffles (`noisy`), the two in `bench.html`'s game
were found but not put to their moves, their losses known to 8 and 11
points.

### The player looking again

The analysis's player was `LineConfig::rollout`, five and a half points
weaker with four suits than the player its network had come to be of. The
main README's "What is left to gain" has what makes the difference:
replanning (only the first four steps of a line are played, then the player
looks again and keeps to its line unless it finds one that ends better) and
a wider beam. Both are now in `lineplayer.js` and `wasm/src/player.rs`
(`replan`, and `stages`: settings for a number of deals left), as
`analysisConfig`, and the root's `cargo test` plays its games against
`src/lines.rs` with `SPIDER_L_REPLAN` and the rest. What each setting costs
an analysis, in WebAssembly on one core (seeds 700001 to 703000 for the
deals won; the analysis of a real four-suit game of 293 moves, 624 to 752
games stopped after eight showings):

| with two suits or more | four suits | three | two | positions a game, four suits | the analysis |
|---|---|---|---|---|---|
| `rollout` (before) | 32.50% | 49.37% | 67.47% | 55,000 | 18 s |
| replanning after 4 steps | | | | 103,000 | 28 s |
| and a beam of 150 | | | | 149,000 | 36 s |
| **and after the last deal after 8 steps with a beam of 100** (now) | 37.10% | 51.83% | 69.13% | 130,000 | 32 s |
| replanning after 4 steps, a beam of 300 (the network's) | 37.83% | 53.50% | 69.87% | 259,000 | 48 s |

(On 6,000 deals natively replanning alone is worth 3.6 points with four
suits, with a beam of 150 4.9 and of 300 5.6.) The beam of 300 would have
made an analysis two and a half times as long for three quarters of a
point. After the last deal the lines are long and replanning costs most,
and there the games of an analysis are played to their end whatever `SHORT`
says, so a game with its mistakes at the end (`bench.html`'s) took five
times as long, 92 s for 19 on one core; looking again only after eight steps
there with a beam of 100 makes that 24 s, and of 4,000 deals it wins 36.8%
for 37.5% (natively; `rollout` after the last deal 35.5%, replanning after
four steps with a beam of 100 there 36.9%, after eight with 150 36.9%).
With one suit, where the games are all played to the end, lines of four
steps and expectimax two deep after the last deal (the network's player)
win 91.03% for 89.30% at two and a half times the positions: the analysis
of a game there 17.5 s for 7 on one core.

The whole analysis, one core: 32.5 s for 18.2 (the real game above), 23.8
for 18.7 (`bench.html`'s), 36.9 for 23.7 and 14.6 for 11.8 (a cheap
player's game of three suits and of two); `bench.html` on a laptop's twelve
workers 7.8 s for 5.6. A four-suit game from the deal takes 59 ms for 24.5.

The search for mistakes on the 48 games with mistakes put in, made again
with this player (`tools/analysis/found.mjs`; 67 candidates are mistakes by
full games in 256 shuffles): 57 found and 10 not (five of them listed as
perhaps mistakes), 7 more called mistakes that cost three points or more
and 2 that cost less, in 817 games; with the player before 55 of 62, 5 and
1 in 763. The losses shown for those found are 19.5 points on average,
their full games' 20.2. `SHORT` is as it was.

`tools/analysis/strength.mjs` plays deals with a configuration in
WebAssembly and counts.

### The network without the cards face down

The network had a token for every card on the table, and a card face down
says nothing but that it is there: a face-up card's row is its height in
the column, and the lowest is told that the card under it is face down. So
the face-down cards are no tokens now (`card_features` in `vnet/train.py`
with `down_tokens` off, `tokens` in `vnet.js` and `wasm/src/net.rs`; the
file says `SPV3`): 47 tokens for 70 in a four-suit game's decisions, ten for
54 at its first deal, and a value in 7.5 ms for 11.2 in WebAssembly (9.9
for 15.3 in JavaScript). The weights are not the old ones' (the face-down
tokens were attended to), so it was trained again, and on the games of the
player the analysis now has (`P="SPIDER_L_REPLAN=4 SPIDER_L_BEAM=150
SPIDER_L_K0_REPLAN=8 SPIDER_L_K0_BEAM=100"` in the commands above; lines.rs
with these wins the very 91.0%, 69.1%, 51.8% and 37.1% of seeds 700001 to
703000 that the WebAssembly does), so that the curve and the games played
out are of one player: 680,000 games as before (16.1 million positions
with the deals not yet known), an hour and a quarter of thirty threads
for them and as long of an A10 for the training. On the games held out (log loss; in
brackets the mean value less the share won, in points), against the network
before, which is of the beam of 300:

| suits | this network   | the one before |
|-------|----------------|----------------|
| 1     | 0.1455 (−0.3)  | 0.1456 (−0.3)  |
| 2     | 0.3319 (+0.2)  | 0.3316 (+1.0)  |
| 3     | 0.4039 (−1.0)  | 0.4035 (+0.2)  |
| 4     | 0.4084 (−0.1)  | 0.4085 (+1.6)  |

As good, then, without the tokens (on four-suit decisions alone a network
with them had 0.4502 held out and one without 0.4519: nothing that shows in
the analysis). `calib.mjs` on 40 games for each number of suits: a turned
card unknown is 0.2 high with one suit and 0.5, 0.7 and 0.9 points low with
two to four (before 0.1, 0.8, 1.0 and 1.0; counting such positions double
in training did not change it: 0.5, 0.9, 1.1), a deal unknown 0.1, −0.1,
0.3 and 0.6 above the mean of sixteen deals, so `BIAS` stays zero.
`order.mjs` on the 48 games of [the player looking
again](#the-player-looking-again): of 65 real mistakes 59, 64 and 65 are
among the first three, five and eight (before 57, 64 and 64), the
correlation 0.80 (0.80); `found.mjs`: 57 of 67 found, 6 near and 2 false
besides (57, 7 and 2), in 813 games (817). A game of the page's own
(four suits, 20820) on one core: the values 3.0 s for 3.9, the games 20.8 s
for 27.7. The checkpoints and logs are in `runs/vnet-faceup`.

### The curve with the games

The games played out to find the mistakes are each a sample of the very
chance the curve is of: a game from a stretch's start (the line player
choosing) of the position there, one from after some of its moves of the
position they come to, one from its end with the shuffle's cards coming up
of the position with its cards not yet known, and the luck's with the real
cards of the position after them. A position's games are noisy (a game
stopped after eight showings varies about its chance by 0.31 v(1 − v), v
being the chance, against v(1 − v) for a win or a loss), but they are of the
player and the position themselves, where the network is wrong about a
position by some 8.6 points (0.052 v(1 − v): measured below). So the curve
is now the network's put together with them as they come in (`evidence` and
`blend` in `static/analysis-core.js`, the numbers in `BLEND`): the network's
error is taken to be a random walk along the curve that drifts back to
nothing (its errors at a stretch's start and at its end, cards not yet
known, correlate at 0.66, and at that end and the next stretch's start at
0.50), the games are measurements of the chance at their positions with the
variance of their spread over their number, and the value shown is the
network's plus the error most likely given all the games (a Kalman smoother
along the curve, in units of v(1 − v)). A position with games and none near
is so the network's value counted as some six games (0.31 / 0.05) against
its own; positions between those with games are moved as far as their
errors go together. The end of a game over stays what it came to.

To have games everywhere the search was given more (it is faster since [the
network without the cards face down](#the-network-without-the-cards-face-down)),
and then the start of every stretch the search did not play out is played
out in 16 shuffles (64 with one suit: `curve`, `fillCurve`). Measured by
`tools/analysis/blend.mjs` on the 48 games with mistakes put in of [the
player looking again](#the-player-looking-again) (two to four suits, every
candidate's two positions played to the end in 256 shuffles: the truth, its
own noise taken out of the errors), the search playing in other shuffles
than the truth's (so it finds a few more than `found.mjs`, which uses the
same):

| | games a game | positions with games (of 758) | error with games | without | all | mistakes found (of 67), near, false |
|---|---|---|---|---|---|---|
| the search before, the network alone | 822 | 506 | 8.7 points | 8.5 | 8.6 | 61, 8, 3 |
| the search before, its games put in | 822 | 506 | 3.3 | 8.0 | 5.3 | 61, 8, 3 |
| 1,500 games | 1,164 | 716 | 3.1 | 6.2 | 3.4 | 61, 9, 3 |
| twice the shuffles for everything, 1,200 games | 1,614 | 638 | 2.9 | 7.1 | 3.9 | 61, 10, 3 |
| the curve's 16 shuffles alone | 1,256 | 632 | 3.3 | 5.7 | 3.8 | 61, 8, 3 |
| stopped after 16 showings, 1,200 games | 1,288 | 668 | 3.6 | 8.1 | 4.4 | 58, 4, 2 |
| **1,500 games, 16 shuffles at first, 64 for the move, loss and luck, 16 for the curve** (now) | 1,924 | 736 | 3.1 | 7.0 | 3.3 | 61, 10, 3 |
| the same with 2,000 games | 1,984 | 757 | 2.9 | | 2.9 | 61, 10, 3 |

With one suit (16 games made so by `order.mjs make 1`, games to the end):
the network is 8.9 points out; the search before with its games put in 4.9
(2,706 games), now (6,000 games, 256 shuffles for the move, the loss and the
luck, 64 for the curve) 2.9 (6,374 games), finding 23 of 27 mistakes for
22. The search finds no more mistakes with more games: it settles its
candidates well before they run out, and what it misses is too near to call.
So the time went where it changes what is shown: the curve, now some three
points from the truth where it was nine, and the losses shown, whose ±
is now a third narrower. (2,000 games cover the last few candidates too,
but where the games run out, as in a person's game with many candidates,
they cost a third more again.) What is left of the error with games is
most of it the stopped games' own (they end in the network's value) and the
search's choosing where to play. The ways of putting the games in differ
little: each position by its own games alone is as good where there are
games, the smoother better between them (7.0 for 9.6 points); the numbers
of `BLEND` changed by half or double move the error by a tenth of a point.

The whole analysis, one core, eight at once: the owner's four-suit game of
293 moves 194 s for 101 (2,352 games for 592, and 512 for the luck for
256), a cheap player's two-suit game 84 for 30, three-suit 157 for 84,
`bench.html`'s 238 for 161, one suit 73 for 52. In headless Chrome on
sixteen cores the four-suit game takes 33 s for 12.

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
like the others).

From 2026-11-11 a medium deal is one that

* the computer wins: the game that compare mode shows of it, played as the
  page plays it (`tools/dailies/computer.mjs`), so that a lost medium
  challenge always has a won game beside it;
* the computer wavering (a random line among those within 2 of the best)
  wins at least 27 of 30 times;
* `pick_seeds`' weak player (lines of 3 steps with three suits, of 4 with
  four, no expectimax or replanning, wavering) wins 60% to 70% of 300 times
  with three suits, 57% to 67% with four.

`../src/bin/medium_rates.rs` grades seeds for it, dropping a seed as soon as
it fails (the computer wins 52% of three-suit deals and 35% of four-suit
ones; the weak player is asked 100 times first, and 200 more with other
salts of the seeds within 10 points of the range that pass the rest), and the ones that come
through are kept with their rates in `tools/dailies/medium3.txt` and
`medium4.txt` (957 of the three-suit seeds 110001–123500, 561 of the
four-suit seeds 110001–132500), so that the ranges (in
`tools/dailies/src/main.rs`) can be moved without playing them again. 348
and 202 of them are in the ranges, 2.6% and 0.9% of all seeds. Its computer
plays a game through where the page plays it from one card shown to the
next, and one deal in ten or twelve ends otherwise (25 of 300 with three
suits, 30 with four), so the page's own game has the last word: it wins 337
and 187 of them. 171 of each are used, through 2027-04-30.

The ones before (through 2026-11-10, from `tools/dailies/picked3_medium.txt`
and `picked4_medium.txt`) were seeds that the default line player, wavering,
won at least 27 of 30 times and the weak player 50 to 79 of 100, measured
once. Three things were wrong with that. The player asked was not the
page's computer, which lost 2 of the 56 that came up and 6 of the 102 that
were still to come. The 100 games were the ones the seeds were picked by:
of 200 more with other salts the weak player won from 44% to 86% (64% and
61% of them on average with three and four suits, with a standard deviation
of 9 points, of which the 200 games' own chance is 3.4; the new ones, played
200 times with salts they were not picked by either: 64% and 62%, a
standard deviation of 5 points, from 49% to 80%; without the games' chance
the deals' own spread is some 8.5 points before and 3.5 now). And some were deals that
the computer itself often loses: wavering, it won 32 of 40 times or fewer
on 7 of the 79 with three suits and on 13 with four.

How much of this a player feels is less sure. Of everything measured on the
deals that two players had won or lost by 2026-11-10 (205 games of three and
four suits, 61 of them medium: the weak player's rate, the same with lines
of 2 and of 8 steps, the wavering computer's, whether the computer wins,
whether `human.rs` does), the weak player's rate says most about who wins
(the area under the curve, among one player's games with one number of
suits, is 0.71; a logit of it is worth 0.65 ± 0.18 of a logit in a player's
odds, and nothing adds to it), which is why the range is still on it. By
that fit the chance of someone who wins four medium deals in ten went up and
down from deal to deal by 6 points (a standard deviation) under the old
rule, and does by 2 under the new. But among the medium deals alone nothing measured says who
won (0.49 for the weak player's rate, over 61 games), and on the 58 deals
both played, medium or hard, the two had the same result 27 times where
chance would have them agree 23.5 times: what the deal is like is a small
part of who wins it. Most of how uneven the medium deals feel is then the
game itself, which the picking cannot change: someone who wins four in ten
of them loses three in a row one time in five.

When the computer plays differently (a new player, a new network) it may
lose deals picked here; `cargo test` plays the coming days' ones
(`test/medium.mjs`). To pick the days from a date on again, with
`static/spider.wasm` built:

```
tools/dailies/medium.sh 2026-12-01 2027-04-30
```

(the page's computer plays every graded seed, a minute on eight cores, and
`dailies medium` gives each day the next medium deal that it wins; the days
before the first date are kept, and it must be after today). 16 four-suit
deals are spare, and 166 three-suit ones. To grade more seeds, from where
the files end (their first lines say), and extend the list:

```
cd .. && cargo run --release --bin medium_rates -- 4 132501 20000 | grep again >> web/tools/dailies/medium4.txt
web/tools/dailies/medium.sh 2027-05-01 2027-09-30
```

(20000 four-suit seeds took 32 minutes on a rented box of 30 cores and gave
some 165 deals; 12000 three-suit ones 27 minutes, some 300). `cargo test`
fails once today is past the end of the medium ones too.

## Playstyle: what two players do wrong over many decisions

`tools/playstyle/` looks for what a player does systematically wrong, on
all of their saved games. The analysis's mistake cards show single large
errors; this adds up many small ones. To run it on fresh data:

```
web/tools/playstyle/run.sh DIR
```

(the live database, then steps 1 and 2, the fit, the tables and `DIR/index.html`;
`DIR/findings.html`, if present, is put at the page's head). Steps 1 and 2 took
22 minutes on a rented 30-vCPU box, where `vm.max_map_count` must be raised
(`sudo sysctl -w vm.max_map_count=2000000`) or thirty worker threads run out of
memory maps; `check.mjs DB` compares `board.mjs` with the game's rules.

A decision is a stretch, as in the analysis. The tests are T1, the rate of
finding a line to a clean turn, a suit or an empty column, by its length and
kind (`board.mjs`: `reach`), against the line player on the same positions; T2,
a conditional logit of the end chosen against a sample of those reachable
(`fit.py`), with the weights compared with the line player's and with the
network's choice; T3, every departure from the line player played out both
ways; T4, named questions (`QUESTIONS`) with both moves played out; and T5, all
of them on the line player with a flaw put in (`planted.mjs`), to see which of
them can find one. Playouts are the analysis's: the same shuffles both ways,
eight moves that show cards, then the network. The searches only ever see cards
face up.

Saved trees have had the time of each move only since 2026-11-04; before that a
decision is set aside if a branch off its line had shown a card still hidden on
the line. A rerun could use the times to tell what had really been seen when, and
to keep decisions made before a card was seen on a branch that came later; this
does not do so yet.

## Hardness: which deals are hard for a given player

`tools/hardness/` asks whether what the playstyle analysis found of a player
says which deals that player loses, better than the weak line player's win
rate does (the measure the medium challenges are picked by). It does not, on
the games there were (2026-11-10: 205 decided games of three and four suits,
138 of one player and 67 of the other, on 147 deals):

```
node web/tools/hardness/outcomes.mjs DB DIR            # outcomes.json, played3.txt, played4.txt
SPIDER_R_SEEDS=DIR/played4.txt cargo run --release --bin model_rates 4 200 > DIR/model4.out   # and 3
node web/tools/hardness/compgames.mjs DIR              # the computer's game of each deal, as DIR/comp.db
node web/tools/playstyle/step1.mjs DIR/comp.db DIR/comp --users=computer
node web/tools/playstyle/step1.mjs DB DIR/ps           # the players' own games, for games.py
python3 web/tools/hardness/fit.py DIR; python3 web/tools/hardness/games.py DIR
```

(some 40 minutes on 16 cores, most of it `model_rates` at 200 games a player and
step 1.) `model_rates` (`src/bin/model_rates.rs`) plays line players made to
miss lines as a person does: `capNN` sees one step of a line always and each
further one with probability NN%, drawn anew whenever a card turns, a deal is
made or a suit completes. The found rates of a clean turn by the moves it
needs (`games.py`: 97-99% at one move for both players; at 2, 3, 4-5 and 6 or
more, 83, 75, 55 and 36% for one and 90, 83, 75 and 71% for the other) are
roughly those of `cap80` and of `cap90` to `cap95` (a step is often more than
one move). `fit.py` judges a measure within a
player's games of one number of suits: the AUC (how often a won deal has the
higher measure than a lost one), the AUC less the weak player's with an
interval from resampling deals, the slope beside the weak player's rate, and
the log loss saved on deals left out.

What it found. The weak player's rate has an AUC of 0.69 (0.62 to 0.77) over
all deals; `cap80` 0.71, `cap95` 0.69, each player's own model 0.70 and the
other's 0.69; none differs from the weak player by more than its interval, and
they go with it at 0.85 to 0.94 across deals. Counts along the computer's game
of the decisions whose clean turn needs four moves or more (2.2 a deal, from 0
to 6), or an empty column, or has none, and the network's value at the start,
are at 0.50 or below. Within the medium challenges nothing is above chance
(weak 0.43, 61 games); within the hard ones `cap80` has 0.72 against the weak
player's 0.62 (difference 0.01 to 0.20), one of some hundred comparisons and
not to be relied on. How far a lost game got and the undos of the player who
undoes go with every model as with the weak player (rank correlations 0.45 and
0.22). On the 58 deals both played, the third of deals the models set furthest
apart for the two went 14 of 20 and 4 of 20, the third they set nearest 12 of
19 and 4 of 19. The two players' results on those deals correlate at 0.33
(-0.05 to 0.99, as two cut normal variables), which would let a perfect
measure of what the deal is to both reach about 0.76: the weak player's rate
is near that already, and what a deal is to one player only cannot be told
without that player playing it twice. So the misses are a cost on every deal
alike, and not something a deal can be picked for.

## Comparing attempts

The menu, the win dialog and the analysis have **Compare**: two attempts at a
deal side by side, the game on the board against the computer's game, a
friend's, or another win of the player's own (`static/compare.js`,
`compare-core.js`, `test/compare.mjs`).

Lines are lined up by the positions they share, not by their moves. Attempts
at a deal have the same cards in the same places, so two positions are the same
if each column with cards face down has the same cards face up in the same
place, and the columns with none hold the same cards in any order (the
`positionKey`; positions with nothing left hidden are not counted, since every
win ends on the same empty board). The moves between two shared positions are moves in another
order, or moves back to where a line was, and count for nothing. So only the
last position shared is a real choice, and there is one per pair of lines. Each
side's moves up to the next card they show are played out from it in the same
shuffles of the cards not seen there (as a mistake is measured), so nothing
either line turned up later is used.

That is mostly all exact positions can say: of 30 pairs from real games (20 of
two players, 10 of a player and the computer) most shared nothing after the
first few moves, and by the first deal 4 to 10 of the 10 columns differed in 25
of them. After the split the lines are compared deal by deal, which is what they
have in common: what stood at each deal, and how far each part moved the gap
between their chances of winning by the network. The parts that moved it most are
picked out, each with that side's worst stretch to look at. They are pointers and
not measurements, and part of what moves the gap is the cards. (Splitting each
part into what the moves did and what the cards did, as the curve does, was tried
and dropped: over a part the two came out large and opposite, up to moves −102
and cards +63 on a real game. The gap adds those back together.)

Free columns are interchangeable only until the next deal, which puts a card on
each by its place: if both lines deal from one position with such columns in
different places, the same choice gets different cards, and the page says there
was no choice there.

A game still being played asks first, since the computer's game shows the cards
to come.

### The computer's game

The computer of the comparison is the analysis's own measure made a player
(`static/strong.js`, `wasm/src/strong.rs`, `test/strong.mjs`): at every choice
it plays what the analysis would rate best. A choice is from one move that
shows cards to the next. The lines to choose from are the line player's own
moves, what it would play if it were about to deal, and the three best other
lines of its search that turn a card (two at most for a column). Each is
played on as the analysis plays a mistake: in shuffles of the cards not seen,
the line player playing, eight moves that show cards and then the network
with two suits or more, to the end with one. All get the same 16 worlds, then
32 and 64 (with one suit 32 to 128); a line two standard errors behind the best
is dropped; and the best is played, the line player's own unless another is a
standard error ahead of it (most lines are a point or two worse than the
line player's and a few better, and with these few worlds the best of several
by the games alone is mostly the luckiest: without that rule it loses). So it
sees only what is face up, as the line player does, and takes nothing back.

The worlds are numbered and made from the deal's seed, so it plays one game on
a deal, the same in every browser, and the same as `wasm`'s `--bin strong`
plays natively (the network's `exp` is written out in `wasm/src/net.rs` so that
the two agree to the bit; `tools/analysis/strong.mjs play` and `test/strong.mjs`
check that they do). They are also the analysis's own worlds for the same
stretch of the game, so the analysis of its game finds what it chose by: in 23
of its games (three to ten of each number of suits; `tools/analysis/strong.mjs
analyze`) the page's search called nothing a mistake and listed nothing as
perhaps one, 4 to 16 of each game's choices being its own and not the line
player's.

It is stronger than the line player by three to six points of win rate
(`cargo run --release --bin strong` in `wasm/`, with `S_AUDIT=128`; a rented
machine of thirty cores for three and a half hours):

| suits | deals | line player won | stronger player won | gain, games played to the end | gain, stopped and valued | games played on a game |
|-------|-------|-----------------|---------------------|-------------------------------|--------------------------|------------------------|
| 4     | 320   | 31.9%           | 37.5% (+5.6 ± 3.1)  | +3.46 ± 0.69                  | +4.21 ± 0.47             | 4,900                  |
| 3     | 160   | 44.4%           | 53.8% (+9.4 ± 4.8)  | +5.56 ± 1.04                  | +5.62 ± 0.82             | 5,500                  |
| 2     | 60    | 73.3%           | 76.7% (+3.3 ± 5.8)  | +4.21 ± 1.25                  | +3.39 ± 0.94             | 6,500                  |
| 1     | 60    | 86.7%           | 95.0% (+8.3 ± 4.9)  | +3.35 ± 0.97                  | (the same)               | 8,000                  |

Wins counted say little: the two play different games of a deal from the
first choice that differs (seven of some thirty in a four-suit game), and one
wins where the other loses one deal in three with four suits (the stronger
player wins 60% of the deals the line player wins with four suits, 69% with
three, 89% with two, 96% with one, and 58 of the 60 medium challenges of the
month from 2026-11-11, which are picked for the line player's win: the
comparison says so when the computer lost a deal the quick computer wins). The
gain is the closer measure: at each choice of its own, what that line is worth
less the line player's, in 128 other worlds, summed over the game. The line
player's chance at the start and these gains at the stronger player's choices
add up to the stronger player's chance, exactly with the games played to the
end. So the analysis's chances, which are the line player's, are low for the
computer of the comparison by three to six points at the start of a game (it
wins some 40%, 57%, 73% and 94% of deals with four suits to one where the
line player wins 37%, 52%, 69% and 91%), and by less later.

What more would buy was measured on the line player's own games first
(`S_STUDY`, `tools/analysis/study.py`: 48 four-suit games, every choice's
lines each played in the same 384 worlds; a rule picks by the first 128 and
is judged by the rest, summed over a game, which is the gain to first order
and by the network's measure):

| other lines | worlds    | played instead of the line player's if | gain a game  | games played on |
|-------------|-----------|----------------------------------------|--------------|-----------------|
| none (only what it would play about to deal) | 16 to 64 | a standard error ahead | +0.0 ± 0.2 | 900 |
| 2           | 16 to 64  | a standard error ahead                 | +2.0 ± 0.7   | 3,900           |
| 3           | 8 to 32   | a standard error ahead                 | +2.1 ± 0.9   | 2,500           |
| 3 (the page's) | 16 to 64 | a standard error ahead               | +3.8 ± 0.9   | 5,100           |
| 4           | 16 to 64  | a standard error ahead                 | +3.9 ± 0.9   | 6,200           |
| 6           | 16 to 64  | a standard error ahead                 | +3.8 ± 1.0   | 7,700           |
| 6           | 16 to 64  | ahead at all / two standard errors     | +2.0 ± 1.3 / +2.4 ± 0.7 | 7,700 |
| 6           | 16 to 32  | ahead at all                           | −1.7 ± 1.4   | 4,200           |
| 3           | 16 to 128 | a standard error ahead                 | +4.6 ± 1.0   | 9,500           |
| 4           | 32 to 128 | a standard error ahead                 | +5.2 ± 0.9   | 12,200          |
| 6           | 32 to 128 | a standard error ahead                 | +5.3 ± 1.0   | 14,900          |

More lines than three find nothing more, and twice the worlds a point and a
half for more than twice the time. (The other lines are on average 0.3 to 2
points worse than the line player's, with a spread of 1.5 to 3 between them:
what there is to gain is the few that are better, and telling them from the
lucky ones.)

A long four-suit game takes 40 s on the twelve workers of a laptop with eight
cores and one of two suits a minute (the games are a quarter of that on one
core: twelve workers do the work of some three and a half), so it is kept in
the browser once played (30 of them), and where it would take minutes (fewer than eight cores, or a touch
screen) the comparison opens with the **quick computer**, the line player's
own game (thought out anew at each card, as the analysis's games are), there at
once, and the other is one of the choices. Without WebAssembly there is only
the quick one.

`GET /api/attempts/{game}/{suits}/{seed}` gives others' lines only to a player
who has finished the deal, by winning it or having a game of it marked as lost:
everyone's best win and others' lost games. A game in progress is never given.

## Offline, and as an app on a phone

A service worker (`static/sw.js`) keeps the whole site in the browser, so
that it opens and plays without the network: every static file, the
analysis's network included (1.2 MB in all), and the API's last answers to
GET, so the player stays logged in, the daily challenges last seen still
show and a game's copy on the server is what it was. A game played offline
is saved in the browser as ever and goes to the server when the network is
back (`online`); a win made offline is kept with those made while logged
out (`spider:pending`) and recorded then. Logging in or out drops the kept
answers. Only what has not been seen needs the network: a deal's results,
other days' challenges.

The server fills the worker in with a version, a hash of every static file,
and the list of them (`main.rs`: `service_worker`), so a deploy that
changes anything is a new version: the browser finds it on the next visit
(`/sw.js` is served with `Cache-Control: no-cache`), it fetches every file
afresh into a cache of its own, and when nothing is being played, or the
page has just opened and nothing has been played on it yet, the page lets
it take over and loads itself again (`app.js`: `applyUpdate`), so a page
never mixes two versions' files. A game being played carries on with the
old version until the player goes back to the home page or opens the page
again (the game is saved at every move, so nothing is lost).

`manifest.webmanifest` and the icons (`icon.svg`, rendered to `icon-192.png`
and `icon-512.png` with `rsvg-convert`) let the site be installed: in Chrome
on Android, the menu's **Add to Home screen** / **Install app** puts it on
the home screen and it opens full screen, without the browser's bars.

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
