# Build Tauri 2 Android APK + AAB from a Windows host.
#
# Usage:
#   docker build -f docker/android.Dockerfile -t taffy-studio-android .
#   docker run --rm -v ${PWD}/dist-out/android:/out taffy-studio-android
#
# Output: /out/*.apk, /out/*.aab.
#
# Image is heavy (~6 GB) because it bundles Android SDK + NDK. First build
# downloads them once and caches them in a build stage; later builds reuse.

FROM ubuntu:22.04 AS build

ARG NODE_MAJOR=20
ARG RUST_VERSION=1.95.0
ARG PNPM_VERSION=9
ARG ANDROID_API=34
ARG ANDROID_BUILD_TOOLS=34.0.0
ARG NDK_VERSION=27.0.12077973
ARG CMDLINE_TOOLS_VERSION=11076708
# Android SDK download mirror. Default = Tencent mirror: in mainland China it
# serves the NDK at ~9 MB/s vs dl.google.com's ~70 KB/s (≈130× faster).
# Override for international builds:
#   --build-arg ANDROID_MIRROR=https://dl.google.com/android/repository
ARG ANDROID_MIRROR=https://mirrors.cloud.tencent.com/AndroidSDK

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
# Only the two ABIs we ship: aarch64 (all modern real devices) + x86_64
# (emulators). Dropping armv7/i686 (old 32-bit) roughly halves the Rust build.
RUN rustup target add \
    aarch64-linux-android \
    x86_64-linux-android

# --- Android cmdline-tools + SDK + NDK ---
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
 && cd /tmp \
 && wget -q "${ANDROID_MIRROR}/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" -O cmdline-tools.zip \
 && unzip -q cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
 && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
 && rm cmdline-tools.zip

ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

# Small components via sdkmanager (~125 MB total, still from Google).
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager \
    "platform-tools" \
    "platforms;android-${ANDROID_API}" \
    "build-tools;${ANDROID_BUILD_TOOLS}"

# The NDK (~630 MB) is the bottleneck — pull it from the mirror and unpack it into
# the same layout sdkmanager would have produced. android-ndk-r27-linux.zip is the
# exact artifact behind "ndk;27.0.12077973"; it unzips to android-ndk-r27/.
RUN wget -q "${ANDROID_MIRROR}/android-ndk-r27-linux.zip" -O /tmp/ndk.zip \
 && unzip -q /tmp/ndk.zip -d /tmp/ndk \
 && mkdir -p "${ANDROID_HOME}/ndk" \
 && mv /tmp/ndk/android-ndk-r27 "${ANDROID_HOME}/ndk/${NDK_VERSION}" \
 && rm -rf /tmp/ndk.zip /tmp/ndk

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

# `tauri android init` writes its OWN default Tauri launcher icons into
# gen/android and ignores src-tauri/icons/android — so without this overlay the
# installed app shows the generic orange Tauri logo instead of the Taffy mark.
# Copy our real launcher icons (raster mipmaps + adaptive background colour) over
# the generated ones before the APK is packaged.
RUN set -eux; \
    res=src-tauri/gen/android/app/src/main/res; \
    for d in src-tauri/icons/android/mipmap-*; do \
      n=$(basename "$d"); mkdir -p "$res/$n"; cp -f "$d"/* "$res/$n/"; \
    done; \
    cp -f src-tauri/icons/android/values/ic_launcher_background.xml "$res/values/" || true

# Throwaway keystore for signing. These are "debug-style" creds: sideload
# installs only require *a* signature, not a trusted one. Swap in a real
# keystore here for Play Store distribution.
RUN keytool -genkeypair \
      -keystore /app/src-tauri/gen/android/release.jks \
      -storepass android -keypass android -alias taffy \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Taffy Studio, O=Taffy, C=US"

# Release build (no --debug): optimised + symbol-stripped native libs → roughly
# an order of magnitude smaller than the old --debug build. --target limits the
# ABIs to the two we ship.
RUN pnpm android:build --apk --target aarch64 x86_64

# Tauri's release APK comes out UNSIGNED (it does not auto-read keystore.properties
# in this CLI version), so sign it explicitly with apksigner — the deterministic,
# template-independent path. zipalign first, then a v2/v3 signature so it installs
# on Android 11+. The signed APK lands next to the unsigned one for the export stage.
RUN set -eux; \
    BT="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)"; \
    find src-tauri/gen/android -name '*-release-unsigned.apk' | while read -r apk; do \
      signed="${apk%-unsigned.apk}.apk"; \
      "${BT}zipalign" -f -p 4 "$apk" "/tmp/aligned.apk"; \
      "${BT}apksigner" sign --ks /app/src-tauri/gen/android/release.jks \
        --ks-pass pass:android --key-pass pass:android \
        --out "$signed" "/tmp/aligned.apk"; \
      rm -f "$apk"; \
    done

FROM ubuntu:22.04 AS export
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates rsync && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/src-tauri/gen/android/app/build/outputs /outputs
VOLUME ["/out"]
CMD ["sh", "-c", "find /outputs -name '*.apk' -o -name '*.aab' | xargs -I {} rsync -a {} /out/ && ls -lah /out"]
