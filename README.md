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

### Portfolio

Different configurations solve different deals, so the UI runs up to four of
them (`--threads`) in parallel and takes the first win or proof: the default,
a wider one (100,000-work slices, six-slice allowances), one with a smaller
run-length bonus, and a best-first one. Every configuration is sound; only
what they find within the budget differs.

### Statistics

100 deals per suit count (seeds 1–100), budget 3,000,000 work per thread,
winning lines verified by replay. "Work" is positions enumerated; one thread
does about 1.3M work per second.

| suits | one config | median work | portfolio of 4 | median wall time |
|-------|-----------|-------------|----------------|------------------|
| 1     | 100%      | 0.12M       | 100%           | ~0.1 s           |
| 2     | 99%       | 0.12M       | 100%           | ~0.1 s           |
| 4     | 91%       | 0.18M       | 97%            | 0.35 s           |

Before the depth-first, resumable-stage search the numbers were 84% / 94%
for four suits at a median of 1.28M work (about 1.1 s). The three 4-suit deals
that no configuration solves (seeds 82, 91, 98) stay unknown at 30,000,000
work and are probably unwinnable. Things that were tried and did not help:
a global best-first queue over all stages (dives into the first endgame and
never returns), restarts with growing slices (dives with small slices rarely
succeed), smaller class caps, more or fewer deal points per class, other
evaluation weights (they only reshuffle which deals get solved, which is what
the portfolio exploits), and treating same-suit joins as reversible in the
end game (class sizes explode; solves nothing).

`cargo run --release --bin bench -- <suits> <first_seed> <count> [budget]`
solves a range of seeds and verifies each winning line by replaying it.
`SPIDER_PORTFOLIO=4` makes it use the portfolio; `SPIDER_DEBUG=1` traces the
stage search; `SPIDER_W_*`, `SPIDER_STAGE_CAP`, `SPIDER_END_CAP`,
`SPIDER_SUB_ALLOC`, `SPIDER_SUB_GROWTH`, `SPIDER_RESUME_TAX`,
`SPIDER_DEALS_PER_STAGE`, `SPIDER_DEALS_PER_CLASS`, `SPIDER_DEPTH_W`,
`SPIDER_CLASS_CAP` override the single-configuration parameters.
`SPIDER_DUMP_END=file` records every stock-empty position the search enters
(`dead`/`cut` plus the work spent), and `--bin endgame file` re-solves those
with a large budget; `--bin certcheck file` measures the certificate on them.
