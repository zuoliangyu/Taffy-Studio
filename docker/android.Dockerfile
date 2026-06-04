# Build Tauri 2 Android APK + AAB from a Windows host.
#
# Usage:
#   docker build -f docker/android.Dockerfile -t taffy-studio-android .
#   docker run --rm -v ${PWD}/dist-android:/out taffy-studio-android
#
# Output: /out/*.apk, /out/*.aab.
#
# Image is heavy (~6 GB) because it bundles Android SDK + NDK. First build
# downloads them once and caches them in a build stage; later builds reuse.

FROM ubuntu:22.04 AS build

ARG NODE_MAJOR=20
ARG RUST_VERSION=1.82.0
ARG PNPM_VERSION=9
ARG ANDROID_API=34
ARG ANDROID_BUILD_TOOLS=34.0.0
ARG NDK_VERSION=27.0.12077973
ARG CMDLINE_TOOLS_VERSION=11076708

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup

# --- System deps + JDK 17 (required by AGP 8.x) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    file \
    git \
    libssl-dev \
    openjdk-17-jdk \
    pkg-config \
    unzip \
    wget \
 && rm -rf /var/lib/apt/lists/*

# --- Node + pnpm ---
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}

# --- Rust + Android targets ---
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION}
ENV PATH=/root/.cargo/bin:${PATH}
RUN rustup target add \
    aarch64-linux-android \
    armv7-linux-androideabi \
    i686-linux-android \
    x86_64-linux-android

# --- Android cmdline-tools + SDK + NDK ---
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
 && cd /tmp \
 && wget -q "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" -O cmdline-tools.zip \
 && unzip -q cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
 && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
 && rm cmdline-tools.zip

ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager \
    "platform-tools" \
    "platforms;android-${ANDROID_API}" \
    "build-tools;${ANDROID_BUILD_TOOLS}" \
    "ndk;${NDK_VERSION}"

ENV NDK_HOME=${ANDROID_HOME}/ndk/${NDK_VERSION}

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch || true

COPY . .
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm build

# Tauri's Android init lays out src-tauri/gen/android. We commit the init step
# at build time so each container build is reproducible.
RUN pnpm android:init || true

# Sign-debug for sideload; release signing requires a keystore — see DOCKER.md.
RUN pnpm android:build --apk --debug

FROM ubuntu:22.04 AS export
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates rsync && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/src-tauri/gen/android/app/build/outputs /outputs
VOLUME ["/out"]
CMD ["sh", "-c", "find /outputs -name '*.apk' -o -name '*.aab' | xargs -I {} rsync -a {} /out/ && ls -lah /out"]
