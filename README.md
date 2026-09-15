# spider

Terminal Spider Solitaire (1, 2 or 4 suits) with an optional **peeking solver**
that looks at the face-down cards and the stock order and tells you whether the
current position can still be won.

```
cargo run --release -- --suits 2            # random 2-suit deal
cargo run --release -- --suits 4 --seed 42  # a specific deal
cargo run --release -- --solver             # start with the solver on
```

## Keys

| key            | action                                                        |
|----------------|---------------------------------------------------------------|
| `1`-`9`, `0`   | select a column, then a destination column                    |
| `←` `→` / `h` `l` | move the cursor; `Enter` or `Space` acts on the cursor column |
| `↑` `↓` / `+` `-` | change how many cards are selected (matters for empty columns) |
| `Tab` / `Shift-Tab` | hint: cycle through the legal moves, greediest first. Each move is scored by its destination (suit completion, same-suit linkage, cross-suit linkage, empty column) plus what it frees at the source (a card flip, an emptied column, a non-linkage, a cross-suit linkage, or a broken same-suit run), so cross→same-suit joins outrank non-linkage→linkage moves, which outrank plain shuffles; the deal comes last. Ranked from visible cards only; it never uses the solver's peek. The hinted move is left selected, so `Enter` plays it |
| `Esc`          | clear the selection                                           |
| `d`            | deal ten cards from the stock (not allowed with an empty column) |
| `u` / `r`      | undo / redo. Undoing past a move that revealed information (a card flip or a deal) asks for confirmation |
| `s`            | toggle the peeking solver                                     |
| `n` / `R`      | new random deal / restart the same deal                        |
| `?` / `q`      | help / quit                                                   |
| `Ctrl-R`       | reload: re-exec the program at the current position (history and redo stack included), so a rebuilt binary can be picked up mid-game. It first checks that the binary on disk runs (refusing while a build is in progress) and prints the exact reload command to the terminal before exec'ing, so the position can be recovered by hand. Implemented with `--replay MOVES` / `--redo MOVES`, where a move is `F>T:N` (N cards from 0-based column F to T) or `d` |

Rules are the usual ones: a descending same-suit run may move onto any card one
rank higher or into an empty column; a complete K..A same-suit run is removed
automatically; score is 500 − moves + 100 per completed suit.

## Solver

The solver (`src/solver.rs`) runs on background threads and restarts whenever
the position changes. Verdicts:

* **SOLVABLE** – a winning line exists from this exact position.
* **UNSOLVABLE** – proven: no sequence of legal moves wins.
* **UNKNOWN** – the work budget (`--budget`, default 3,000,000 per thread) ran out.

### Search over reversible-move classes

It searches over *equivalence classes of positions under reversible moves*
rather than over positions. Moving a run between two parents that are both one
rank higher (or an empty column) is reversible, and almost all of Spider's
branching is this kind of shuffling; collapsing each connected component of
reversible moves into one node, identified by its minimum member hash, removes
that blow-up entirely. The remaining edges are irreversible: flipping a card,
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

Splitting a same-suit run is deferred to a second pass that only runs if the
first pass exhausts its space, so `UNSOLVABLE` is a proof over the full move
set. Column order is treated as irrelevant. That is exact once the stock is
empty; before that it ignores the option of permuting columns through an
empty column to change which column a dealt card lands on.

### Unsolvability certificates

`src/certify.rs` has a sound "stuck card" certificate for stock-empty
positions with no empty column: a greatest-fixpoint marking of cards that can
never move (every remaining copy of the next rank up is buried, for every
possible head of the chain the card could ride on) and never be removed in
place; if every column holds such a card, no column can ever empty. It never
fires on a winnable position in the benchmark set, but it only recognises
positions the class search refutes in under a hundred work anyway (the
expensive dead endgames are dead for global space reasons that no local rule
captures), so it is not wired into the search. Dead endgames are cheap to
refute by exhaustion in the median case (about 70 work), and the ones that are
not usually turn out to be winnable with more work, which is what the subtree
allowances are for.

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
does about 1.3M work per second.

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
