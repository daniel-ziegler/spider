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
| `Esc`          | clear the selection                                           |
| `d`            | deal ten cards from the stock (not allowed with an empty column) |
| `u` / `r`      | undo / redo. Undoing past a move that revealed information (a card flip or a deal) asks for confirmation |
| `s`            | toggle the peeking solver                                     |
| `n` / `R`      | new random deal / restart the same deal                        |
| `?` / `q`      | help / quit                                                   |

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
a potential function, so the class graph is a DAG.

Each stage (the positions reachable without dealing) is enumerated best-first
up to a work cap (budget/10). Its deal points go into one global priority
queue keyed by the post-deal evaluation, so the search can abandon a weak
post-deal stage for a better deal point higher up. Splitting a same-suit run is
deferred to a second pass that only runs if the first pass exhausts its space,
so `UNSOLVABLE` is a proof over the full move set. End-game proofs are cheap
because, with no stock left, the class graph of a dead position is usually a
few hundred nodes.

Column order is treated as irrelevant. That is exact once the stock is empty;
before that it ignores the option of permuting columns through an empty column
to change which column a dealt card lands on.

### Portfolio

Different evaluation weights and search parameters solve different deals, so
the UI runs up to four configurations (`--threads`) in parallel and takes the
first win or proof. Every configuration is sound; only what they find within
the budget differs.

### Statistics

100 deals per suit count (seeds 1–100), budget 3,000,000 work per thread,
winning lines verified by replay:

| suits | one config | portfolio of 4 |
|-------|-----------|----------------|
| 1     | 100%      | 100%           |
| 2     | 99%       | 99%            |
| 4     | 84%       | 94%            |

Unloaded, a 4-suit verdict typically arrives in 1–3 s; the remaining UNKNOWN
4-suit deals (seeds 36, 43, 82, 91, 98) stay unknown even at 30,000,000 work,
so they may well be unwinnable. Things that were tried and did not help:
larger or smaller stage caps, a bonus or penalty per stage on deal keys, a
demotion tax on siblings of failed deals (helps some deals, hurts others, so it
is one of the portfolio members), higher hidden-card or empty-column weights,
penalising wrong attachments more, and treating same-suit joins as reversible
in the end game (class sizes explode).

`cargo run --release --bin bench -- <suits> <first_seed> <count> [budget]`
solves a range of seeds and verifies each winning line by replaying it.
`SPIDER_PORTFOLIO=4` makes it use the portfolio; `SPIDER_DEBUG=1` traces the
stage search; `SPIDER_W_*`, `SPIDER_STAGE_CAP`, `SPIDER_END_CAP`,
`SPIDER_DEALS_PER_CLASS`, `SPIDER_DEAL_BONUS`, `SPIDER_SIBLING_TAX` override
the single-configuration parameters.
