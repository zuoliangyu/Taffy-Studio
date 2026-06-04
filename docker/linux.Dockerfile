# Build Tauri 2 Linux artifacts (deb + AppImage) from a Windows host.
#
# Usage:
#   docker build -f docker/linux.Dockerfile -t taffy-studio-linux .
#   docker run --rm -v ${PWD}/dist-linux:/out taffy-studio-linux
# Or use docker-compose (see docker-compose.yml).
#
# Output: /out/{*.deb, *.AppImage, *.rpm if rpm-build is present}.

FROM ubuntu:22.04 AS build

ARG NODE_MAJOR=20
ARG RUST_VERSION=1.82.0
ARG PNPM_VERSION=9

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin

# --- System deps required by Tauri on Linux (per tauri.app/start/prerequisites) ---
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
    wget \
 && rm -rf /var/lib/apt/lists/*

# --- Node + pnpm ---
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}

# --- Rust ---
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION}

WORKDIR /app

# Layer the cache: deps first, sources after.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch || true

COPY src-tauri/Cargo.toml src-tauri/Cargo.lock* src-tauri/build.rs ./src-tauri/
# Pre-create a tiny lib.rs so cargo can resolve deps without the full sources.
RUN mkdir -p src-tauri/src && echo "pub fn run() {}" > src-tauri/src/lib.rs \
 && (cd src-tauri && cargo fetch || true)

# Now copy real sources.
COPY . .

RUN pnpm install --frozen-lockfile || pnpm install

# Two-stage: frontend, then bundle. tauri-cli runs the frontend build through
# beforeBuildCommand, but we pre-build to surface JS errors earlier.
RUN pnpm build
RUN pnpm tauri:build --bundles deb,appimage

# --- Final stage: copy the artifacts into /out at runtime ---
FROM ubuntu:22.04 AS export
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates rsync && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/src-tauri/target/release/bundle /bundle
VOLUME ["/out"]
CMD ["sh", "-c", "rsync -a /bundle/ /out/ && ls -lah /out"]
