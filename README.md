# spider

Terminal Spider Solitaire (1, 2, 3 or 4 suits; three suits are three sets
of spades, three of hearts and two of diamonds) with an optional **peeking solver**
that looks at the face-down cards and the stock order and tells you whether the
current position can still be won.

```
cargo run --release -- --suits 2            # random 2-suit deal
cargo run --release -- --suits 4 --seed 42  # a specific deal
cargo run --release -- --solver             # start with the solver on
```

A card is underlined when the card on top of it is not one rank lower: the
line marks where a stack is broken and will have to be cleared.

## Keys

| key            | action                                                        |
|----------------|---------------------------------------------------------------|
| `1`-`9`, `0`   | select a column, then a destination column                    |
| `←` `→` / `h` `l` | move the cursor; `Enter` or `Space` acts on the cursor column |
| `↑` `↓` / `+` `-` | change how many cards are selected (matters for empty columns) |
| `Tab` / `Shift-Tab` | hint: cycle through the moves, greediest first. Each move is scored by its destination (suit completion, same-suit linkage, cross-suit linkage, empty column) plus what it frees at the source (a card flip, an emptied column, a non-linkage, a cross-suit linkage, or a broken same-suit run), so cross→same-suit joins outrank non-linkage→linkage moves, which outrank plain shuffles; among equals, onto another suit the higher card first; the deal comes last. A move that only puts the columns in another order is not offered, and of moves that differ only so, one is. Ranked from visible cards only; it never uses the solver's peek. The hinted move is left selected, so `Enter` plays it |
| `Esc`          | clear the selection                                           |
| `d`            | deal ten cards from the stock (not allowed with an empty column) |
| `u` / `r`      | undo / redo. Undoing past a move that revealed information (a card flip or a deal) asks for confirmation |
| `s`            | toggle the peeking solver                                     |
| `H`            | superhint: the solver line shows the solver's next move, and the cards of the line's next *irreversible* move are marked in green (bright: the cards it moves, dark: the card they land on). Turns the solver on if it was off. See [Superhint](#superhint-following-the-solvers-line) |
| `p` / `P`      | with superhint on: play the solver's next move / play through its next irreversible move. Moves that follow the line do not restart the solver |
| `n` / `R`      | new random deal / restart the same deal (its moves go onto the redo stack, so `r` replays them) |
| `?` / `q`      | help / quit                                                   |
| `S`            | save: records the command line that resumes the current position (settings, history and redo stack), writes it to `~/.local/state/spider/resume.sh` immediately and prints it to the terminal when you quit, so `sh ~/.local/state/spider/resume.sh` or the printed command brings the game back |
| `Ctrl-R`       | reload: re-exec the program at the current position (history and redo stack included), so a rebuilt binary can be picked up mid-game. It first checks that the binary on disk runs (refusing while a build is in progress) and prints the exact reload command to the terminal before exec'ing, so the position can be recovered by hand. Implemented with `--replay MOVES` / `--redo MOVES`, where a move is `F>T:N` (N cards from 0-based column F to T) or `d` |

Rules are the usual ones: a descending same-suit run may move onto any card one
rank higher or into an empty column; a complete K..A same-suit run is removed
automatically; score is 500 − moves + 100 per completed suit.

## Solver

The solver (`src/solver.rs`) runs on background threads and restarts whenever
the position changes. Verdicts:

* **SOLVABLE** – a winning line exists from this exact position.
* **UNSOLVABLE** – proven: no sequence of legal moves wins (by exhausting the search, helped by a [certificate](#unsolvability-certificates)).
* **UNKNOWN** – the work budget (`--budget`, default 3,000,000 per thread) ran out.

### Search over reversible-move classes

It searches over *equivalence classes of positions under reversible moves*
rather than over positions. Moving a run between two parents that are both one
rank higher (or an empty column) is reversible, and almost all of Spider's
branching is this kind of shuffling; collapsing each connected component of
reversible moves into one node (the hashes of its members are remembered, so
entering it anywhere else is recognised) removes that blow-up entirely. The remaining edges are irreversible: flipping a card,
completing a suit, detaching a run from a wrong parent, joining a run onto its
same-suit predecessor, and dealing. Within a stock stage these edges increase
a potential function, so the class graph is a DAG. A class that grows past
the enumeration cap (20,000 positions; it happens with several empty columns)
is handed to the search in chunks, so nothing is lost.

Each stage (the positions reachable without dealing) is explored
**depth-first with siblings ordered by evaluation**: the evaluation counts
completed suits, hidden cards, same-suit adjacencies (with a bonus growing as
the square of a run's length), wrong attachments and empty columns. Pure
best-first was much worse here: the winning line of an endgame typically has
to give up an empty column or split progress between suits, which lowers the
evaluation for a while, and best-first then wanders over hundreds of
thousands of equally-scored alternatives before returning.

Stages are explored in slices (`budget / 100` work, at least 20,000). A stage
whose slice runs out is kept alive and can be resumed; each run releases only
its best few deal points onto one global candidate queue keyed by the
post-deal evaluation, the rest waiting for a resumption. Because deeper
stages always evaluate higher (fewer hidden cards, more completed suits), the
queue alone would pour the whole budget into stock-empty positions, so every
stage's **subtree has a work allowance** (eight slices to start, doubling each
time the stage is resumed): candidates below an exhausted allowance are frozen
until their ancestor is resumed, and the resumption competes with that
ancestor's siblings. This is what lets small slices work: the search dives
quickly, and when a dive dies the budget flows back up to alternatives at
every level instead of being absorbed by the endgame.

Splitting a same-suit run is deferred to later passes that only run if the
first pass exhausts its space, so `UNSOLVABLE` is a proof over the full move
set. Two passes handle splits differently. The second treats a split (and a
same-suit join) as an irreversible exit, so classes stay small and the
search orders the splits by evaluation: a win that needs a split is then
found in a few thousand positions. It gets an eighth of the budget. If it
neither wins nor exhausts, the third pass treats splits and joins as
reversible, which merges the huge classes they create and exhausts a
position with about a third of the work, giving the proof. (Before the
capped second pass existed, the third-pass behaviour was the only one: an
endgame with a suit completion one split away, such as 8♥..A♥ from under
10♥ 9♥ onto a 9♥, sat in a class of millions of positions that the
enumeration crawled through 20K at a time with 50K overflow exits per
chunk, and the solver answered UNKNOWN at 3M work; the second pass finds
it in 12K.) `SPIDER_TRACE=1` prints every expanded class (pass, size,
exits, evaluation, work) to stderr. Column order is treated as irrelevant. That is exact once the stock is
empty; before that it ignores the option of permuting columns through an
empty column to change which column a dealt card lands on.

### Unsolvability certificates

Exhausting a lost position is often out of reach: a messy position just after
the last deal, with twenty or thirty cards still face down, can stay
`UNKNOWN` at 20M work, and one where nothing moves but runs split onto other
suits took over a million. `src/certify.rs` has sufficient conditions for a
position being lost, none of which ever calls a winnable one lost.

**The top-rank certificate** (`top_rank_certificate`: stock empty, no empty
column) is the idea the working ones share. While no column is empty, a run
only ever moves onto a card one rank above its bottom card, so if the card it
leaves is also one rank above, the ranks of the ten top cards are the same
multiset afterwards. That multiset therefore changes only when a card leaves
a card of the wrong rank, which nothing ever puts it back on: by the first
move of a card `x` lying on such a card `a` in the position at hand, when it
loses `rank(x) + 1` and gains `rank(a)`. And a card lying on anything but the
next card up of its own suit can only leave as the bottom of a run, so only
while some top card is one rank above it. So a far smaller game is searched:
per column how many cards have never moved, counted in *units* (a card and
the same-suit run on it), and the ranks of the tops; a step takes the top
unit off a column if the tops have the rank above its bottom card. Every line
of real play, splits included, is a line of this game, which forgets where
the units went and that they get in each other's way. If it can neither take
the last unit off a column nor bring a king's unit to the top with every
lower card of its suit moved, the real game can neither empty a column nor
complete a suit, and is lost.

**`lost_certificate`** carries that game past the emptying of columns and
across deals, up to the first suit completed, for any position. A run put in
an empty column uncovers the card it lay on, and its bottom card is the
column's until the column is emptied again, which takes a top one rank above
it; so the small game keeps the rank at the bottom of each refilled column,
and may also put a unit, or any card that has moved, in an empty column. A
deal covers the ten tops with known cards; which rank is under which is not
known (the game forgot where things went), only that they are the ranks of
the tops before, and which cards each column could have had on top; a dealt
card comes off uncovering one of those, the small game choosing.

On 640 games of the line player (160 per suit count, seeds 40001–40160) it
never called lost any of the 88,725 positions of the 403 games that were won
(looking at up to 100,000 positions of the small game each). In the 237 lost
games it calls 1,783 positions lost, in 233 of the games; the first with a
deal still to come in 44 games, never with two. The solver uses these: the
long one on the position to be solved (a quick try before searching when a
deal or none is left, 200,000 positions if no win is found), on positions
right after the last deal, and on the deal points it would otherwise drop
when one deal is left (it keeps the best four per class, which used to make
every search with stock left incomplete); the plain one on every stock-empty
position of the search. Of 29 lost four-suit games (seeds 30001–30048), the
position where the line player gave up is proved lost in all 29 with at most
41K work (before the certificates: 22 at 400K work, 25 at 20M), and the
position after the last deal in 17, with 8 winnable and 4 unknown at 20M
(before: 9, 8 and 12). At 2M work the position where the line player is about
to make the last deal is proved lost in 20 of the 106 lost four-suit games
(18 of 70 with three suits, 8 of 44 with two, 2 of 17 with one). Solving the
640 games every fourth move at 500K work, no position of a won game got
`UNSOLVABLE`. Nothing proves a position with two or more deals left lost,
which is where most games are lost: the last position the solver still finds
a win from (at 500K work) has two or more deals left in half the lost
four-suit games.

**`lost_for_all`** is the same game for a player who has not seen every
card: it proves the position lost *whatever the unseen cards are*, so saying
so gives nothing away. An unseen card is uncovered as a card of any rank the
unseen ones have left, the small game choosing, and is then a unit of its
own; when it comes to completing a suit it may be any unseen card of its
rank. It proves nothing while cards in the stock are unseen. With every
face-down card unseen and the stock empty, it calls 657 positions of the 237
lost games lost (the certificate that sees them: 1,627), in 232 of the
games, on average two moves before the line player gave up; none of the
19,263 stock-empty positions of the won games; and with the face-down cards
shuffled six times over, the solver won none of the 657. The web game uses
this one.

**The first-event certificate** is a counting argument: before the first
column is emptied or suit completed, every moved card lies on a card one rank
higher, so the moved cards form at most one chain per column (and per card
dealt and not moved), which bounds the moved cards of each rank by those and
the anchors of the next. It ignores suits and fires only on positions that
are stuck already. **The stuck-card certificate** (`stuck_certificate`) is
the oldest: a greatest-fixpoint marking of cards that can never move and
never be removed in place; if every column holds one, no column can ever
empty. It only recognises positions the search refutes in under a hundred
work anyway. Neither is used.

`--bin lab` has the experiments behind these numbers.

### Alternate engines: rollouts and beam search

Two further solvers use different algorithms on the same class abstraction.
Neither can prove unsolvability; both are portfolio members because they
win deals the class search does not, or win them faster.

**NRPA rollouts** (`src/rollout.rs`): nested rollout policy adaptation.
A rollout plays a whole game by sampling, at each step, one exit of the
current class from a softmax over `w[code] + beta * delta`, where `delta` is
the evaluation change the exit causes and `w` is a learned weight per move
code (card moved × card landed on). A level-2 search runs 40 level-1
searches, each 40 rollouts, and after each one shifts the policy toward the
best rollout seen. Deals are offered only when no exit improves the
evaluation. Rolling out over single card moves instead of class exits does
not work: winning lines are full of worsen-then-improve pairs that a
one-move prior cannot follow. It wins 1-suit deals in one rollout and most
2-suit deals in a few hundred; on 4 suits its policy plateaus within a
quarter second and it solves few deals.

**Beam search** (`src/beam.rs`): one beam per stock level. From the frontier
it expands every class, keeps at most 8 children per parent and the 16 best
children overall, and pools deal exits separately (they always evaluate
worse than card moves); when a level's beam runs dry the 16 best pooled
post-deal positions seed the next level. Once the stock is empty each
candidate is handed to the class solver with a 100,000-work budget, because
a beam cannot backtrack and endgames need it. If every level runs dry the
width quadruples and it restarts. Classes are cut at 500 members (their
remainder becomes ordinary exits), which matters more than the width.

On 4-suit seeds 1–100 with 6 s each, beam solves 59 and NRPA 5, but beam
solves seed 82 (6 s, 8.5M work), which no class-search configuration solves
at 30M work, and both solve seed 91 in about 3 s. On the 117 hard endgame
positions of the cut set they solve 24 (NRPA) and 22 (beam) against 44 for
the class search, with 4 positions only they solve.

### Non-peeking player

`src/human.rs` plays without looking: every decision is made on a masked
copy of the game in which face-down cards and the stock are blanks, so it
knows only what a person at the table knows. It plays roughly the way a
person does, with very little compute (about 2,000 positions per decision,
15–40 ms for a whole game):

* Look a few moves ahead: a breadth-first search over the legal moves from
  the visible position, stopping at any move that turns a card over (what
  comes up is unknown). Splits of a same-suit run are only tried onto a card
  of the same suit, and with one suit also into an empty column.
* Play the line to the best position found if it scores better than the
  current one, then look again. The score is visible-only: completed suits,
  hidden cards, columns with nothing hidden, empty columns, same-suit and
  cross-suit linkages, run lengths. Only strict improvements are played
  between card turns, so it cannot cycle.
* If nothing scores better, turn over any card that can be reached at all
  (even at the cost of an empty column: a deal fills it anyway).
* Otherwise deal, first arranging the best position that fills every empty
  column; with the stock gone, give up.

| suits | won, seeds 1–200 | won, seeds 201–400 | suits completed per deal |
|-------|------------------|--------------------|--------------------------|
| 1     | 75%              | 69%                | 6.9                      |
| 2     | 33%              | 32%                | 4.0                      |
| 4     | 8%               | 9%                 | 0.9                      |

Weights were tuned on seeds 1–200 (2 and 4 suits). `cargo run --release
--bin human -- <suits> <first_seed> <count>` plays a range of seeds;
`SPIDER_H_*` (`NODES`, `SPLITS`, `HIDDEN`, `CLEAR`, `EMPTY`, `SAME`, `DIFF`,
`WRONG`, `RUN_SQ`, `COMPLETED`) override the parameters, `SPIDER_H_TRACE=1`
prints every decision with the position it was made from and
`SPIDER_H_QUIET=1` only the summary.

### Line player

`src/lines.rs` is a stronger non-peeking player whose unit of play is a
*line* of human-sized steps. A step moves a run, or a mixed-suit sequence
through the empty columns (up to `2^e` same-suit pieces with `e` free
empty columns), from the top of a column onto a card one rank higher or
into an empty column. A line is up to 14 steps (four suits; searched as
a beam of the 300 best positions at each depth), each touching a column an
earlier step touched, and it ends as soon as a card turns over. The player
scores where every line ends with a visible-only evaluation (completed
suits, face-down cards, empty columns, same-suit and off-suit links, cards
out of sequence, distinct ranks on top, squared run lengths) and plays the
best line that raises it. Failing that, it scores again "about to deal",
with a lower value for an empty column (and, with four suits, a wider
search that may split runs anywhere), and stays in that mode until a card
turns, a deal or a suit completes. Failing that, it fills the empty columns
(splitting runs if it must) and deals. `deal_flip`, a bonus in that mode for
a line that turns a card, makes no difference at any value: a turned card
already raises the value by itself. A position with stock left and fewer than ten cards on the
table is lost, and it never returns to a position it has stood in.

With two or more suits, two further things:

* **Expectimax over the turned card.** The best four lines that turn a
  card (by each evaluation) are valued not at where they end but at the
  mean, over every card that can come up weighted by how many of it are
  unseen, of the best position a small search (4 steps, beam 20) reaches
  after it.
* **Replanning.** It plays only the first four steps of the chosen line
  and searches again. It keeps to the rest of the line unless the new
  search finds one that ends better (in the same mode), so it cannot
  wander among equally good positions.

| suits | won                               | ms per game |
|-------|-----------------------------------|-------------|
| 1     | 88% (seeds 10001–11000)           | 8           |
| 2     | 70% (seeds 10001–14000)           | 1,400       |
| 3     | 54.3% (seeds 40001–41000, 42001–44000) | 2,100  |
| 4     | 38.9% (seeds 1–2000, 20001–22000) | 2,100       |

| four suits, wins of 4,000 seeds (1–2000, 20001–22000) | won   | ms per game |
|-------------------------------------------------------|-------|-------------|
| 14-step lines                                         | 34.1% | 850         |
| expectimax, best 2 lines that turn a card (1–2000)    | 33.6% | 780         |
| expectimax, best 4                                    | 36.1% | 1,200       |
| expectimax, best 8 (1–2000)                           | 33.9% | 1,800       |
| expectimax, best 4, replanning after every step       | 38.8% | 6,500       |
| expectimax, best 4, replanning after 4 steps          | 38.6% | 2,100       |
| the same, an empty column valued at 103 (was 83)      | 38.9% | 2,100       |

On seeds 1–2000 alone, replanning after 2, 6 and 8 steps wins 37.0%,
36.4% and 36.0% (4 steps: 37.4%); a deeper search after the turned card
(8 steps, beam 50) does no better at four times the cost, nor does
expectimax in the wider about-to-deal search, and dropping the rule that
every step touch a column touched before loses a little (32.0%).
Replanning after every step without expectimax wins 35.0% of seeds 1–2000
(2.6 s per game). Without the rule that a new line must end better than
the plan, replanning wanders between near-equal positions for thousands
of moves.

Retuning the 13 evaluation weights for this search (coordinate search on
seeds 30001–32000) found nothing that holds up. An empty column at 103
instead of 83 gained 34 wins on the tuning seeds and 11 on the 4,000
others; the full tuned set (also `hidden_sq` -6, `end_empty` 29, one win
each on the tuning seeds) lost 62 there. Small weight changes move the
result by a few dozen wins per 2,000 seeds either way. Only the empty
column's value was changed (to 103): over all 6,000 seeds it is 45 wins
ahead, the full set 26 behind.

Three suits play with the four-suit search and weights, which win 54.3%
of seeds 40001–41000 and 42001–44000 (the two-suit weights 49.6% of the first 1,000,
against 53.7%). A coordinate search over the 13 weights on seeds
40001–41000 moved only the empty column (103 to 127) and `end_empty` (39
to 47), from 537 wins to 571, and on seeds 42001–44000 that set won 1,088
against 1,091, so nothing was changed.

With two suits the lines were 6 steps with no beam: replanning alone does
nothing there (65%), expectimax alone gives 67%, and lines as long as with
four suits, expectimax and replanning 70%. One suit gains nothing from
either.

Before expectimax, with four suits, longer lines were what more time
bought: over the 4,000 seeds, 8 steps win 30.4%, 12 steps 33.1%, 14 steps
34.1% and 16 steps 33.7%, while a wider beam (1,000 or 3,000 positions)
gains nothing and splitting runs anywhere in the normal search loses.

`cargo run --release --bin lines -- <suits> <first> <count>` plays the
seeds on all cores; `SPIDER_L_*` override the weights and search.
`SPIDER_L_FAST=1` is a much cheaper setting (`LineConfig::fast`: six-step
lines, a beam of 50, no expectimax, no replanning, no wider search before a
deal), which wins 87%, 63%, 44% and 26% of seeds 60001–60800 with one to
four suits at some 15,000 positions a game. `SPIDER_L_ROLLOUT=1` is the
setting the web game's analysis plays games out with (`LineConfig::rollout`:
fourteen-step lines, a beam of 100, expectimax one step deep; 89%, 68%, 50%
and 31% at six times the work of the cheap one; `web/static/lineplayer.js`
is a port of both; see `web/README.md` for what lies between).

`src/pimc.rs` (`--bin pimc`) adds rollouts on top: the line player's
choice and a few alternatives are played out in worlds guessed from the
visible cards by a cheaper line player, and an alternative is played only
when it does clearly better. By default it does so only after the last
deal (128 rollouts a decision, up to 8 candidates, a six-step line player
playing each world to the end, wins counted), which is the one place it
gains: 814 wins against the line player's 797 on seeds 20001–22000 (65
games gained, 48 lost), and 43 more on 1,600 of seeds 50001–51600, about a
point and a half in all, at 23 s per game (see
[stage-wise evaluation](#stage-wise-evaluation-a-plateau-until-the-last-deal)).
A network trained to rank the same candidates does as well without the
rollouts: 39.9% of 6,000 games against the line player's 38.6%, at 3.1 s
per game (see [contrasts](#contrasts-is-another-choice-better-and-a-network-that-ranks-them)).
At every decision of the game (`SPIDER_P_FROM=5 SPIDER_P_STAGE=0`), with
an earlier line player, it added nothing (50 against 48 wins on seeds
1–200, at about 130 s per game). It is not that rollouts cannot improve
the line player: given
the real deal instead of guessed worlds (`SPIDER_P_CHEAT=1`, a diagnostic)
the same rollouts win 110 of seeds 30001–30200 against its 58. But in
guessed worlds the outcome depends far more on where the hidden cards are
than on the candidate, and averaged over worlds the candidates differ by a
point or two of win rate, too little to tell apart. Also no better (on
2,000 seeds): choosing where to deal from by sampling the deal and
searching on after it; judging endgame candidates (stock gone) by solving
guessed worlds with the full-information solver; making the value of a
face-down card or an empty column depend on the deals left; and rewarding
mobility (runs that have somewhere to go), which is much worse at any
weight.

`--bin winnable` asks the full-information solver, each time the line
player is about to deal, whether the real game can still be won. On four
suits (seeds 30001–30320) about 280 of 320 are still winnable at the first
deal and 136 right after the last; the line player won 99, losing 42 of the
games that were winnable after the last deal. Those are mostly winnable
only with knowledge of the face-down cards: guessed worlds give no
candidate the edge.

### Stage-wise evaluation: a plateau until the last deal

Win counts are a blunt instrument: over 2,000 games the standard error is
about a point of win rate, and the changes worth finding are smaller.
`src/bin/stage.rs` and `stage/*.py` judge a change one *stage* at a time (a
stage is the play between two deals):

* `stage dump` plays reference games (here seeds 50001–58000 with the
  defaults: 2,929 won, 36.6%) and records their moves.
* `stage/fit.py` fits, for each number of deals left, the chance that the
  reference player goes on to win from the position it is about to deal
  from: logistic regression on 24 visible features (`src/stagev.rs`).
* `stage/ev.py` plays one stage with the changed player from the positions
  the reference games stood in at its start, and compares the fitted value
  where each is about to deal (after the last deal: the game's result),
  game by game. `stage/tune.py` is a coordinate search on that.
  `SPIDER_L_K<n>_*` set a weight for the stage with `n` deals left only.

On 2,000–4,000 positions the standard error is 0.05–0.2 points of win rate
for the first five stages, and a stage costs a sixth of a game (the first,
less than a tenth). As a check, taking expectimax out loses 0.4–0.9 points
in every stage, 4.2 ± 1.0 in all (in whole games, 2 to 2.5).

How the game goes is mostly a matter of how many cards are still face down
at each deal. The count alone carries nearly all of what the 24 features
say about the result (log loss at the first deal 0.577 with it, 0.575 with
all; at the last 0.305 and 0.278; 0.657 knowing nothing):

| face down at the first deal (seeds 1–640) | ≤ 23  | 24–27 | 28–31  | 32–35  | 36–39  | ≥ 40  |
|-------------------------------------------|-------|-------|--------|--------|--------|-------|
| games won                                 | 60/77 | 31/56 | 47/101 | 45/148 | 40/166 | 16/92 |

Every lost game ends with the stock gone, and 212 of 298 lost games (seeds
1–480) without one suit completed. The player already turns every card it
can before it deals: told to turn any card within reach whatever the cost
before dealing, it plays all but a handful of 6,000 stages the same.

Before the last deal, nothing tried moves the fitted value up by more
than its error, in the first stage (4,000 positions) or the third (2,000),
in points of win rate:

| change                                                    | first stage      | third stage  |
|-----------------------------------------------------------|------------------|--------------|
| no expectimax                                             | −0.68 ± 0.16     |              |
| expectimax over the best 8 lines / 16                     | −0.10 ± 0.08 / – | +0.03 ± 0.10 / +0.24 ± 0.14 |
| expectimax over the best line for each column turned      | −0.17 ± 0.09     | −0.24 ± 0.15 (best 8) |
| deeper search after the turned card (8 steps, beam 50 / 6, 40) | +0.01 ± 0.05 | −0.16 ± 0.08 |
| expectimax over a second turned card (6 sampled cards)    |                  | +0.04 ± 0.12 |
| replanning after every step                               | +0.04 ± 0.05     | +0.12 ± 0.11 |
| beam 1,000 (first stage: and 20 steps)                    | +0.00 ± 0.00     | +0.05 ± 0.07 |
| rollouts to the next deal (below; 320 and 240 positions)  | −0.59 ± 0.65     | +0.13 ± 0.48 |

The rollouts are `SPIDER_P_STAGE=1` of the rollout player: 96 per decision
in guessed worlds, finished to the next deal by a six-step line player
without expectimax and scored by the fitted value there, at 80 times the
cost. The other options in the table gained nothing and are not kept in
the code. After the last deal, where the measure is the game's result
(4,000 positions), a wider search (beam 1,500, 24 steps) is +0.33 ± 0.33.

The weights are where they should be. In the third stage, of 28 single
changes (each weight up and down by a third to a half, and the unused
`KING`, `DIG`, `TURNABLE`, `SAME`), one is above zero (`RUN_SQ` 2: +0.15 ±
0.14) and the worst lose a point (`OFF` −4, `WRONG` −12). In the first
stage `HIDDEN` and `EMPTY` up or down by a quarter are within ±0.08.
Four new terms (an ace on top of a column, a king lying on another card, a
column with one card face down, the runs in a column with nothing face
down) lose at either sign in both stages, as do other styles of play in
the first stage: digging the deepest columns first (`HIDDEN_SQ` 60,
`HIDDEN` 45) −3.8, the shortest (`HIDDEN_SQ` −40, `HIDDEN` 85) −0.75,
tidier (`OFF` −30, `WRONG` −10, `RUN_SQ` 14) +0.01 ± 0.15.

So before the last deal the player is at a local optimum of everything
that could be measured, rollouts over its own lines included, and what it
reaches is set by the cards.

After the last deal the measure is the game's result, and there rollouts
to the end of the game do gain (1,600 positions; the line player's own
variants on 4,000):

| change, after the last deal                                        | points of win rate |
|--------------------------------------------------------------------|--------------------|
| 64 rollouts, up to 6 candidates                                    | +1.75 ± 0.51       |
| 128 rollouts, up to 8 candidates, lines raising the giving-up value too | +2.69 ± 0.54  |
| line player: replanning after every step                           | +0.25 ± 0.27       |
| line player: expectimax over the best 8 lines                      | −0.15 ± 0.24       |
| line player: beam 1,500, 24 steps                                  | +0.33 ± 0.33       |
| line player: no replanning (800 positions)                         | −2.25 ± 0.86       |

In whole games on other seeds the rollouts gain less: 774 wins against
759 on seeds 1–2000 (64 rollouts) and 814 against 797 on seeds 20001–22000
(128, +0.85 ± 0.53), so about a point and a half over all 3,600 games of
the larger setting. In the stage before the last deal, rollouts to that
deal scored by the fitted value are +0.45 ± 0.32 (1,000 positions).

There is not much more to be had after the last deal: the
full-information solver (300,000 work) finds a win in 160 of 400 reference
games there, 26 of them games the line player lost; with the 12 of its 146
wins that the solver did not find, 43% were still winnable by a player who
sees every card, against 36.5% won. 45% is not within reach of this kind
of player: it would have to come from more games surviving the deals, and
between deals nothing measured gains.

### Contrasts: is another choice better, and a network that ranks them

The stage-wise measure cannot see a choice that the fitted value is blind
to, such as how the position dealt from is arranged. `src/contrast.rs`
measures choices directly: the line player's candidates at a decision
(`--bin contrast`: its choice, the next-best lines by either evaluation, the
best line turning each set of columns), or other arrangements to deal from
(`--bin dealgen`), are each played on *in the same worlds* (the real cards
and reshuffles of the hidden ones) by the line player until it is next
about to deal, where the fitted value counts. Within a decision most of the
luck cancels. `stage/headroom.py` reads the files.

**Nothing to gain at the deal.** From 865 positions the line player dealt
from (seeds 50001–50300, four worlds each), with up to seven other
arrangements reachable without turning a card: those with the same
evaluation are within ±0.4 points of the one chosen in every stage, those
with a lower one 1 to 2 points worse, and picking the best by two worlds
loses 0.2 to 1 point in the other two.

**Little to gain between deals, and only late.** A world's luck moves a
candidate's value by 6 to 9 points, the candidates really differ by 1 to 2,
and nearly all of that is alternatives being worse. With the standard
player playing on (24,000 decisions with two or one deals left, one world
each), in points of fitted win probability against the choice:

| alternative, the choice turning a card             | two deals left | one deal left |
|----------------------------------------------------|----------------|---------------|
| a line turning another card                        | −1.24 ± 0.15   | −1.52 ± 0.22  |
| a line turning none                                | −0.10 ± 0.18   | +0.01 ± 0.31  |
| a line instead of dealing (the choice the deal)    | −1.75 ± 0.55   |               |

Dealing where the line player would still play a line is 4 to 15 points
worse (1,300 decisions, four worlds). No class of alternative picked out by
the evaluations is better than the choice.

**A network that ranks the candidates.** `vnet/adv.py` trains the value
network's transformer on these files: it values the position after each
candidate (also given whether the candidate is the line player's choice and
how its two evaluations compare with the choice's), and the loss is mostly
on the differences within a decision. `src/advnet.rs` evaluates it on the
CPU (4 ms a position), and the rollout player plays the candidate it puts
first if that is ahead of the line player's choice by a margin
(`SPIDER_P_NET=vnet/rank.bin SPIDER_P_NET_MARGIN=0.04`; `SPIDER_P_FROM`: with at
most so many deals left), instead of rollouts.

    SPIDER_V_MODEL=runs/stage/v.txt SPIDER_P_ROLLOUT_STEPS=14 SPIDER_P_ROLLOUT_BEAM=300 \
      SPIDER_P_ROLLOUT_EXPECT=4 SPIDER_P_ROLLOUT_REPLAN=4 \
      cargo run --release --bin contrast -- 4 500001 100000 1 1.0 2 1 > runs/predeal/s21.csv
    .venv/bin/python vnet/adv.py train --data runs/predeal/s*.csv --init runs/predeal/a4.pt --lr 1e-4 --epochs 3 --out runs/predeal/a5.pt
    .venv/bin/python vnet/adv.py export --ckpt runs/predeal/a5.pt --out vnet/rank.bin
    SPIDER_P_NET=vnet/rank.bin SPIDER_P_FROM=1 SPIDER_P_NET_MARGIN=0.04 cargo run --release --bin pimc -- 4 20001 2000

It was trained from the old value network (`v5`) on 105,000 decisions of
all stages labelled by a cheap player playing on (no expectimax or
replanning, the narrow search before a deal: five times faster), then on
24,000 with two or one deals left labelled by the standard player. One
stage played with it, from the reference positions:

| deals left in the stage                                 | points of win rate          |
|---------------------------------------------------------|-----------------------------|
| 3 (cheap labels only, 1,000 positions)                  | −0.27 ± 0.25                |
| 2 (cheap labels only, margin 0.01 / 0.02)               | −0.69 ± 0.17 / −0.25 ± 0.13 |
| 2                                                       | −0.17 ± 0.12                |
| 1 (4,000 positions, margin 0.02 / 0.04)                 | +0.26 ± 0.15 / +0.30 ± 0.12 |
| 0 (4,000 positions, the game's result)                  | +1.25 ± 0.36                |

So it gains where the rollouts did, after the last deal and a little in
the stage before, and loses earlier, where there is nothing to find and
its mistakes cost. More data does not help: trained on with 70,000 more
last-stage decisions (three times as many), it is no better (+0.98 ± 0.35
and +0.05 ± 0.12 in the last two stages). In whole games, ranking only with one or no deals left
(`SPIDER_P_FROM=1`, margin 0.04), on seeds it has not seen:

| four suits, wins of 2,000 | line player | with the network     | with rollouts |
|---------------------------|-------------|----------------------|---------------|
| seeds 1–2000              | 759         | 788                  | 774 (64)      |
| seeds 20001–22000         | 797         | 828                  | 814 (128)     |
| seeds 700001–702000       | 758         | 779                  |               |
| all 6,000                 | 38.6%       | 39.9% (+1.35 ± 0.35) |               |

267 games gained and 186 lost, at 3.1 s per game against 2.1 (the
rollouts: 23 s).

Two things about the method. The player that plays on must be the real
one: on held-out decisions labelled by the cheap player the network
trained on those labels looked 0.3 points a decision better than the line
player with two deals left, on decisions labelled by the standard player
0.1 worse, and in play it was worse. And decisions of one game share its
hidden cards, so errors must be counted per game, not per decision. The
old value networks, trained on the outcomes of games, rank the candidates
about as well by correlation (0.12 against 0.13 to 0.2) but pick nothing
better than the line player's choice at any margin.

### AlphaZero player

`src/az.rs`, `src/bin/azplay.rs` and `az/train.py` train a network by
self-play to choose between the line player's lines. A decision offers the
lines that raise the line player's evaluation (normally or about to deal),
every line that turns a card, the best 24 of them, and the deal. The search
is MCTS with expectimax over hidden cards. A line that turns a card leads
to a chance node with a child for every card that can come up, weighted by
how many of it are unseen, all valued by the network at once. A deal has
six sampled outcomes. A chance node's value is the weighted mean of its
children's values. The search never looks at a hidden card.

The Rust side runs hundreds of games in lockstep and sends their positions
to the Python side in batches, where a small transformer over the ten
columns runs on the GPU. Two halves of the games take turns, so that one
half searches while the other's batch is on the GPU. The network gives each
position a value (the expected outcome, `(suits completed + 4 if won) /
12`) and a policy score. A move's prior is the softmax of the scores of the
positions the moves lead to. The network starts by imitating the line
player, then trains on self-play: its policy learns the search's visit
counts and its value learns a mix of the outcome and the search's value.

    python -m venv .venv && .venv/bin/pip install torch numpy
    cargo build --release
    .venv/bin/python az/train.py imitate --suits 4 --games 4000 --out runs/L4
    .venv/bin/python az/train.py selfplay --suits 4 --out runs/L4b --init runs/L4/imitate.pt
    .venv/bin/python az/train.py eval --suits 4 --ckpt runs/L4b/latest.pt --first 1 --count 200

| four suits, seeds 1–200       | won   | suits per game |
|-------------------------------|-------|----------------|
| line player (old version)     | 13%   | 1.60           |
| imitation network, 64 sims    | 18.5% | 1.84           |
| after 7,700 self-play games   | 16%   | 1.46           |

Self-play has not yet improved on the imitation network (learning rate
2e-4, 64 simulations per move, about 0.5 games per second, limited by the
line search on the CPU).

### Value network player

`src/vnet.rs`, `src/bin/vplay.rs` and `vnet/train.py` train only a value
network, which judges where the line player's lines end. A position is a
token per card (its rank, suit, row and column embeddings summed with
features: how it links to the cards above and below, how much of its
same-suit run is above and below it, whether its column is one run), a
token per empty column and one for the deals left and suits completed: a
transformer of 160k parameters (3 layers, width 64). A decision values the
line player's best few lines by each of its evaluations and a few sampled
deals, and plays the best line or deals. Training data is 200,000 line
player games, then self-play, with TD(λ) targets bootstrapped from the
previous network.

    .venv/bin/python vnet/train.py play --ckpt runs/vnet/v3.pt --first 20001 --count 2000

| four suits, seeds 20001–22000                          | won   |
|--------------------------------------------------------|-------|
| line player (8-step lines; 14 steps: 707)              | 630   |
| network on outcomes of line player games               | 548   |
| after a round of self-play, TD(0.7) targets            | 599   |
| another round of self-play                             | 567   |
| line player until it would deal, network from there    | 638   |

Valuing more lines makes it worse: the network's errors are larger than
the differences between good lines, so the more it chooses from the more
likely it picks one it overrates. Deciding only about dealing
(`SPIDER_V_DEAL_ONLY=1`), it is no better than the line player at any
margin by which a line must beat dealing (`SPIDER_V_DEAL_MARGIN`, best at
0.1); dealing as soon as the line player stops raising its normal value
does as well (628).

### What is left to gain

A day on a rented machine (thirty cores and a GPU, October 2026) went into
asking how much stronger a player that does not peek can be, with every
number of suits. In short: nothing found plays much better than the line
player, and nothing that sees only the face-up cards will win nine games in
ten of two suits or more; but replanning is worth far more to the cheap
player of the web game's analysis than was thought, and with four suits
the default player spends two thirds of its time on an expectimax that buys
nothing.

**Where games are lost.** `--bin winnable` with one, two and three suits
(200, 160 and 200 games; four suits are above):

| suits | line player won | winnable at the start | before the last deal | after the last deal |
|-------|-----------------|-----------------------|----------------------|---------------------|
| 1     | 87.5%           | 100%                  | 96.5% (1% unknown)   | 95.5%               |
| 2     | 70%             | 100%                  | 92.5% (6% unknown)   | 90% (2.5% unknown)  |
| 3     | 52%             | 100%                  | 71% (18% unknown)    | 68.5% (13% unknown) |

So with fewer suits most lost games can still be won after the last deal by
a player who sees every card. But they are the games that come to the last
deal with many cards face down, and what is under them decides:

| face down right after the last deal (seeds 10001-11000) | 0-4     | 5-9   | 10-14 | 15-19  | 20-24  | 25-29 | 30 or more |
|---------------------------------------------------------|---------|-------|-------|--------|--------|-------|------------|
| one suit, games won                                     | 629/630 | 51/52 | 64/69 | 68/82  | 39/73  | 21/51 | 10/43      |
| two suits                                               | 441/442 | 45/45 | 79/99 | 69/110 | 52/122 | 21/97 | 9/85       |

**Rollouts with fewer suits** (`--bin pimc`, which had only been measured
with four; wins of 1,000, seeds 10001-11000, with three suits 40001-41000):

| suits | line player | rollouts after the last deal | the solver on the guessed worlds | rollouts at every decision |
|-------|-------------|------------------------------|----------------------------------|----------------------------|
| 1     | 882         | 911 (64 rollouts)            | 900                              | 918 (43 s a game)          |
| 2     | 716         | 732 (128)                    | 748                              | 410 of 600 (line player: 438) |
| 3     | 537         | 560 (128)                    | 563                              |                            |

Two to three points, as with four suits, and again only after the last
deal. `SPIDER_P_SOLVE=<work>` (new) gives each guessed world, after the
candidate, to the full-information solver instead of playing it out
(`SPIDER_P_SOLVE_WEIGHT`: how much of the value is the solver's verdict, 1
for no rollouts): with two suits that is a point and a half better than
rollouts and no dearer, with one and three suits no better. A deeper last
search before giving up (up to thirty steps, any split, a beam of up to
3,000, for any line that turns a card or completes a suit; not kept) finds
nothing: when the line player stops with one suit there is nothing more
within reach.

**The networks.** The AlphaZero search (`az/`) with a network imitating
8,000 games (64 simulations, seeds 20001-20600) wins 148 of 600 where the
line player wins 248: no better than the player its imitation games are of
(26%: they are played without replanning), so no self-play was run from it.
The value network player with one suit (`vnet/`, 400,000 games of the line
player, 19 million positions, 93% of them of games won) wins none of 2,000
games choosing every line and 979 deciding only about dealing, where the
line player wins 1,761: with almost every position a won one it has nothing
to tell lines apart by.

**Weights for the last stage** (`stage/coord.py`: a coordinate search on
whole games' wins, for one stage's weights if asked; 20,000 and 8,000
tuning games, changes kept at two standard errors). With one suit `HIDDEN`
26, `KING` 8 and `TURNABLE` 2 after the last deal are worth +0.29 ± 0.13
points on 10,000 other seeds to the analysis's player; with two suits
`HIDDEN` 15 and `SAME` 3 +0.70 ± 0.28 on 6,000. The rest of the weights are
where they should be for the last stage too.

**Replanning and the beam, for the analysis's player.** `web/README.md`
has replanning as doubling the work for nothing; with the one-step
expectimax of `LineConfig::rollout` it is the cheapest strength there is,
and a wider beam then pays too. Seeds 700001-706000, differences paired,
milliseconds on the rented machine with all its cores busy:

| `SPIDER_L_ROLLOUT=1` and           | four suits            | ms a game | three suits      | two suits             |
|------------------------------------|-----------------------|------|-----------------------|-----------------------|
| nothing (the analysis's player)    | 31.92%                | 107  | 49.12%                | 67.75%                |
| `BEAM=150`                         | +1.23 ± 0.42          | 137  | +0.67 ± 0.39          |                       |
| `REPLAN=6`                         | +2.13 ± 0.48          | 160  | +2.13 ± 0.48          |                       |
| `REPLAN=4 BEAM=50`                 | +1.62 ± 0.56          | 129  | +1.27 ± 0.55          |                       |
| `REPLAN=4 BEAM=75`                 | +2.93 ± 0.55          | 167  | +1.53 ± 0.53          |                       |
| `REPLAN=4`                         | +3.55 ± 0.54          | 208  | +2.23 ± 0.51          | +1.32 ± 0.44          |
| `REPLAN=4 BEAM=150`                | +4.88 ± 0.54          | 278  | +2.57 ± 0.53          | +2.00 ± 0.47          |
| `REPLAN=4 BEAM=300`                | +5.60 ± 0.56          | 464  | +3.67 ± 0.53          | +2.43 ± 0.50          |
| the default player                 | +5.13 ± 0.66 (37.05%) | 1338 | +4.43 ± 0.67 (53.55%) | +2.73 ± 0.60 (70.48%) |

Also with four suits, on `REPLAN=4`: replanning after three steps is the
same and after five a point less (with a beam of 150); only with one or no
deals left +1.72 ± 0.42, with two or fewer +2.37 ± 0.47, with three or more
+1.00 ± 0.36; lines of ten steps +1.88 ± 0.55; and with a beam of 150,
expectimax over two lines +4.13 ± 0.64, over eight +4.55 ± 0.60, over none
-1.40 ± 0.67 (replanning needs the expectimax: this is what the earlier
trial lacked). Expectimax two steps deep is worse than one at every beam
(-1.07 ± 0.64 at 300).

So with four suits the analysis's player at twice its time wins three and a
half points more, and at four times its time what the default player wins
at twelve and a half. On top of `REPLAN=4 BEAM=300` (37.52%), still with four suits:
the wider search before a deal (`DEAL_SPLITS=3`) +0.57 ± 0.21, lines of
twenty steps +0.63 ± 0.39, a beam of 600 +0.52 ± 0.37, expectimax over
eight lines +0.27 ± 0.49, replanning after two steps +0.10 ± 0.44. The first two together
(`REPLAN=4 BEAM=300 DEAL_SPLITS=3 MAX_STEPS=20`) win 38.42% at 0.9 s a
game and with a beam of 600 38.97% at 1.8 s, +1.37 ± 0.66 and +1.92 ± 0.66
on the default player (1.3 s), whose expectimax four steps deep is what
they do without. With three and two suits the same settings are no better
than the default (53.02% against 53.55%, 70.33% against 70.48%), at two
thirds of its time and at half.

**One suit.** The analysis's player (two-step lines, one-step expectimax)
wins 89.15% of seeds 700001-710000 and the default 86.40%. Longer lines by
themselves lose, at every stage or after the last deal only, and so does
expectimax two steps deep at every stage (-0.8); but after the last deal
only, four-step lines with expectimax two steps deep
(`SPIDER_L_K0_MAX_STEPS=4 SPIDER_L_K0_EXPECT_STEPS=2`) are worth +1.38 ±
0.23 at half as much time again (+1.50 with the last stage's weights
above), and nothing more was found: expectimax over eight lines or three
steps deep, the same in the stage before, replanning (-0.7) and a beam do
no more.

None of this is in the players' defaults or the web game yet: the port
(`web/static/lineplayer.js`, `web/wasm`) has neither replanning nor
settings by stage, and the analysis's network is of the games of the player
it has.

### Superhint: following the solver's line

`H` shows the winning line's next move on the solver line, marks its next
irreversible move on the table, and lets `p`/`P` play it. Irreversible is
the solver's own notion: a move that leaves an equivalence class (deal,
suit completion, card flip, same-suit join, or leaving a non-linkage
behind); the moves before it are shuffles that only prepare it. As long as
the moves played (by `p`, `P`, or by hand) are the line's own, the line is
consumed instead of re-solved, and undo walks back along it. A move off the
line that can be taken straight back (nothing turned over or completed, and
the cards could return to where they came from, which includes a same-suit
join since splitting it is legal) keeps the line with the inverse move put in
front, and undoing any other move keeps it with that move put in front; the
shortener then removes the detour. Only a move that cannot be taken back
restarts the solver. (The solver itself treats joins as one-way in its first
pass, so re-solving after a join could fail on a position that was winning.)

Raw solver lines are long: a 4-suit line is typically 500–800 moves where
150–250 would do, because each class is crossed by the shortest route to
the exit the search happened to pick, not to the best one. `lineopt::shorten`
walks the line and from each position runs a bounded breadth-first search
over all legal moves for the farthest later position of the line, splicing
in the search path when it is shorter; passes repeat until nothing improves,
and the result is replayed to check it still wins (an order-sensitive hash
is used, since the solver's hash ignores column order). It runs in the
background in two stages (500 then 4000 positions per search point): the
first lands in about 0.2 s and removes 40–45% of the moves, the second takes
1–3 s for another 10–15% (seed 1: 828 → 486 → 436). `SPIDER_SHORTEN=cap`
makes `bench` report shortened lengths and times.

### Portfolio

Different configurations solve different deals, so the UI runs up to four of
them (`--threads`) in parallel and takes the first win or proof: the default
class search, the beam search, a best-first class search, and one with a
smaller run-length bonus; NRPA is fifth, then the wide class search. The
class-search configurations are sound; the beam and rollout engines only
report wins, so an UNSOLVABLE verdict always comes from a class search.
Chosen by per-seed analysis of all candidates on 4-suit seeds 1–100; beam
is the member no class-search configuration can replace, and it gets four
times the budget (its work is cheaper per unit, and the hard deals it wins
need 5–10M work). On 2-suit deals beam wins the race three times out of four.

### Statistics

100 deals per suit count (seeds 1–100), budget 3,000,000 work per thread,
winning lines verified by replay. "Work" is positions enumerated; one thread
does about 2M work per second on four suits and 4M on one (the wall times in
the table are from when it did 1.3M: since then the enumeration hashes a
reversible move's result before building it, keeps one set of member hashes
instead of a map per class, drops an exit into a class already expanded
before queueing it, and scores deals column by column instead of dealing
onto every member; none of that changes what is searched).

| suits | one config | median work | portfolio of 4 | median wall time |
|-------|-----------|-------------|----------------|------------------|
| 1     | 100%      | 0.12M       | 100%           | ~0.05 s          |
| 2     | 99%       | 0.12M       | 100%           | 0.10 s           |
| 4     | 91%       | 0.18M       | 99%            | 0.34 s           |

On held-out 4-suit seeds 101–200 (not used for tuning) the default solves
91 and the portfolio 100; the previous solver solved 65 of those. Before the
alternate engines joined, the portfolio of four class-search configurations
solved 97 of seeds 1–100 and 97 of 101–200; before the depth-first,
resumable-stage search the numbers on seeds 1–100 were 84% / 94% for four
suits at a median of 1.28M work (about 1.1 s). The one 4-suit deal in 1–100
nothing solves, seed 98, stays unknown at 30,000,000 work for the class
search and 18M for the beam. Things that were tried and did not help:
a global best-first queue over all stages (dives into the first endgame and
never returns), restarts with growing slices (dives with small slices rarely
succeed), smaller class caps, more or fewer deal points per class, other
evaluation weights (they only reshuffle which deals get solved, which is what
the portfolio exploits), treating same-suit joins as reversible in the
end game (class sizes explode; solves nothing), rollouts over single card
moves, beam widths above 16, and beaming through the endgame instead of
handing it to the class search.

`cargo run --release --bin bench -- <suits> <first_seed> <count> [budget]`
solves a range of seeds and verifies each winning line by replaying it.
`SPIDER_PORTFOLIO=4` makes it use the portfolio, `SPIDER_ROLLOUT=1` the NRPA
engine and `SPIDER_BEAM=1` the beam engine (also in `--bin endgame`);
`SPIDER_R_*` (`BETA`, `DEAL_H`, `LEVEL`, `ITERS`, `ALPHA`, `MAX_LEN`,
`DEAL_RULE`, `CLASSES`, `CLASS_CAP`, `DEALS_PER_CLASS`, `TIME`) and
`SPIDER_B_*` (`WIDTH`, `GROWTH`, `CLASS_CAP`, `DEALS_PER_CLASS`,
`PER_PARENT`, `END_DFS`, `TIME`) set their parameters; `SPIDER_DEBUG=1` traces the
stage search; `SPIDER_W_*`, `SPIDER_STAGE_CAP`, `SPIDER_END_CAP`,
`SPIDER_SUB_ALLOC`, `SPIDER_SUB_GROWTH`, `SPIDER_RESUME_TAX`,
`SPIDER_DEALS_PER_STAGE`, `SPIDER_DEALS_PER_CLASS`, `SPIDER_DEPTH_W`,
`SPIDER_CLASS_CAP` override the single-configuration parameters.
`SPIDER_DUMP_END=file` records every stock-empty position the search enters
(`dead`/`cut` plus the work spent), and `--bin endgame file` re-solves those
with a large budget; `--bin certcheck file` measures the certificate on them.
