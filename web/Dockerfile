# Build from the repository root (see deploy.sh): the server compiles ../src/game.rs.
FROM rust:1-bookworm AS build
WORKDIR /app
# The dependencies first, built against an empty main, so that this layer is
# cached until Cargo.toml or Cargo.lock change.
COPY web/Cargo.toml web/Cargo.lock web/
RUN mkdir web/src && echo 'fn main() {}' > web/src/main.rs && cd web && cargo build --release --locked && rm -r src
COPY src/game.rs src/game.rs
COPY web/src web/src
COPY web/challenges.txt web/medium-challenges.txt web/freecell-challenges.txt web/
COPY web/test web/test
# (COPY keeps the files' times, which can be older than the empty main's build.)
RUN cd web && touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /app/web/target/release/spider-web /app/spider-web
COPY web/static /app/static
ENV STATIC_DIR=/app/static DATABASE_PATH=/data/spider.db PORT=8080
EXPOSE 8080
CMD ["/app/spider-web"]
