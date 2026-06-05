# Local-CI image — mirrors the checks in .github/workflows/ci.yml.
#
# Usage:
#   docker compose run --rm ci
# Or:
#   pwsh scripts/ci-local.ps1
#
# Runs (in order, fail-fast):
#   1. pnpm install --frozen-lockfile
#   2. pnpm exec tsc -b           (frontend typecheck)
#   3. pnpm build                  (vite production build)
#   4. cargo fmt --all -- --check
#   5. cargo clippy --all-targets -- -D warnings
#   6. cargo check --all-targets

FROM ubuntu:22.04

ARG NODE_MAJOR=20
ARG RUST_VERSION=1.95.0
ARG PNPM_VERSION=9

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin

# Tauri Linux system deps + curl/git/build-essential.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    file \
    git \
    libayatana-appindicator3-dev \
    libgtk-3-dev \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    patchelf \
    pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Node + pnpm.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}

# Rust + rustfmt + clippy (matches dtolnay/rust-toolchain@stable + components).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} \
        --component rustfmt --component clippy

WORKDIR /app

# The actual sources are bind-mounted at run time (see docker-compose.yml),
# so we don't COPY anything here — that way every invocation runs against
# the current working tree, no rebuilds.

# Run script lives in /usr/local/bin so it's on PATH.
COPY docker/ci-run.sh /usr/local/bin/ci-run.sh
RUN chmod +x /usr/local/bin/ci-run.sh

CMD ["ci-run.sh"]
