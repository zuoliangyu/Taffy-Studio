# syntax=docker/dockerfile:1
# Self-hosted web/server image for Taffy Studio.
#
# Three stages: build the React frontend (web bundle), build the taffy-web
# binary (which embeds dist/ via rust-embed), then run it on a tiny Alpine.
# This is a RUNTIME image (a server you open in a browser), distinct from the
# docker/ build images that only cross-compile desktop/Android packages.
#
# Usage: see scripts/tasks/dev-docker.ps1 / scripts/tasks/dev-docker.sh.

# ---- frontend ----
FROM node:lts AS frontend
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# No TAURI_ENV_PLATFORM here, so __IS_TAURI__ is false → web bundle (webApi).
RUN pnpm build

# ---- backend ----
FROM rust:1-alpine AS backend
# build-base = gcc + musl-dev + make, needed to compile bundled SQLite.
RUN apk add --no-cache build-base
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY src-tauri/ src-tauri/
COPY --from=frontend /app/dist ./dist
# Cache the cargo registry + target dir across builds so iterative rebuilds
# don't recompile every dependency. The target dir is a cache mount (not part
# of the layer), so copy the binary out to a real path before the stage ends.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build -p taffy-web --release && \
    cp /app/target/release/taffy-web /usr/local/bin/taffy-web

# ---- runtime ----
FROM alpine:latest
RUN apk add --no-cache ca-certificates
COPY --from=backend /usr/local/bin/taffy-web /usr/local/bin/taffy-web
EXPOSE 8787
VOLUME ["/data"]
# Provider keys come from the environment (TAFFY_API_KEY / TAFFY_OPENAI_API_KEY
# / TAFFY_ANTHROPIC_API_KEY / TAFFY_GEMINI_API_KEY); set TAFFY_TOKEN to require
# a Bearer token.
ENTRYPOINT ["taffy-web", "--host", "0.0.0.0", "--db-path", "/data/taffy.db", "--no-open"]
