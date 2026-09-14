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

The solver (`src/solver.rs`) runs on a background thread and restarts whenever
the position changes. Verdicts:

* **SOLVABLE** – a winning line exists from this exact position.
* **UNSOLVABLE** – proven: no sequence of legal moves wins.
* **UNKNOWN** – the work budget (`--budget`, default 3,000,000) ran out.

It searches over *equivalence classes of positions under reversible moves*
rather than over positions. Moving a run between two parents that are both one
rank higher (or an empty column) is reversible, and almost all of Spider's
branching is this kind of shuffling; collapsing each connected component of
reversible moves into one node, identified by its minimum member hash, removes
that blow-up entirely. The remaining edges are irreversible: flipping a card,
completing a suit, detaching a run from a wrong parent, joining a run onto its
same-suit predecessor, and dealing. Within a stock stage these edges increase
a potential function, so the class graph is a DAG. Each stage is enumerated
best-first up to a work cap, then deals are tried best-first (post-deal
evaluation), depth-first over stages. Splitting a same-suit run is deferred to
a second pass that only runs if the first pass exhausts its space, so
`UNSOLVABLE` is a proof over the full move set.

Column order is treated as irrelevant. That is exact once the stock is empty;
before that it ignores the option of permuting columns through an empty column
to change which column a dealt card lands on.

`cargo run --release --bin bench -- <suits> <first_seed> <count> [budget]`
solves a range of seeds and verifies each winning line by replaying it.
Set `SPIDER_DEBUG=1` to trace the stage search.
