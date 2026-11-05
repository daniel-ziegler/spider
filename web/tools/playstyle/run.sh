#!/bin/bash
# The playstyle analysis from the live database to a page: web/tools/playstyle/run.sh DIR
# (about 30 core-hours of games and searches: see web/README.md for a rented box.)
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:?usage: run.sh DIR}
mkdir -p "$dir/db"
(cd "$dir/db" && rm -f spider.db spider.db-wal && fly ssh sftp get /data/spider.db spider.db -a spider-friends && fly ssh sftp get /data/spider.db-wal spider.db-wal -a spider-friends; sqlite3 spider.db 'PRAGMA wal_checkpoint(TRUNCATE)' > /dev/null)
node "$here/step1.mjs" "$dir/db/spider.db" "$dir"
node "$here/step2.mjs" "$dir/db/spider.db" "$dir"
python3 "$here/fit.py" "$dir"
node "$here/analyze.mjs" "$dir"
node "$here/page.mjs" "$dir"
