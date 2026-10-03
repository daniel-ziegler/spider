#!/bin/sh
# Deploy to Fly.io. The Docker build context is the repository root, because
# the server compiles the terminal game's rules (src/game.rs).
set -e
cd "$(dirname "$0")/.."
exec fly deploy . --config web/fly.toml --dockerfile web/Dockerfile "$@"
