#!/bin/bash
# The medium challenges of FIRST to LAST picked again: web/tools/dailies/medium.sh FIRST LAST
# The computer of the analysis and of compare mode plays every graded seed
# (medium3.txt, medium4.txt) as the web game plays it (computer.mjs, with
# static/spider.wasm: build that first if the player has changed), and
# `dailies medium` gives each day the next medium deal that it wins. The
# days before FIRST are kept as they are, and FIRST must be after today in
# Pacific time: a challenge that can be played already does not change.
# (A few minutes, in 8 processes: a game won takes half a second or more.)
set -e
cd "$(dirname "$0")"
first=${1:?usage: medium.sh FIRST LAST (dates as YYYY-MM-DD)}
last=${2:?usage: medium.sh FIRST LAST (dates as YYYY-MM-DD)}
today=$(TZ=America/Los_Angeles date +%F)
if [[ ! "$first" > "$today" ]]; then
  echo "FIRST must be after today ($today in Pacific time)" >&2
  exit 1
fi
for suits in 3 4; do
  for part in 0 1 2 3 4 5 6 7; do
    SPIDER_PART=$part/8 node computer.mjs $suits medium$suits.txt > computer$suits.$part &
  done
  wait
  sort -n -k2 computer$suits.[0-7] > computer$suits.txt
  rm computer$suits.[0-7]
  test "$(wc -l < computer$suits.txt)" = "$(grep -c '^seed' medium$suits.txt)"
done
awk -v first="$first" '/^#/ || $1 < first' ../../medium-challenges.txt > medium-challenges.tmp
mv medium-challenges.tmp ../../medium-challenges.txt
cargo run --release -- medium "$first" "$last"
