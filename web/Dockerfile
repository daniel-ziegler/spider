# Build from the repository root (see deploy.sh): the server compiles ../src/game.rs.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY src/game.rs src/game.rs
COPY web/Cargo.toml web/Cargo.lock web/
COPY web/src web/src
COPY web/test web/test
RUN cd web && cargo build --release

FROM debian:bookworm-slim
COPY --from=build /app/web/target/release/spider-web /app/spider-web
COPY web/static /app/static
ENV STATIC_DIR=/app/static DATABASE_PATH=/data/spider.db PORT=8080
EXPOSE 8080
CMD ["/app/spider-web"]
