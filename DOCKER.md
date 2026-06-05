# Docker 构建说明

> **TL;DR**：在 Windows 主机上用 Docker 构建 **Linux** 和 **Android** 发行包；**Windows 本机直构（最快）**；**macOS/iOS 必须真 Mac**（Apple EULA 禁止虚拟化）。

## 分工矩阵

| 目标 | 方式 | 命令 | 耗时（首次） |
|---|---|---|---|
| **Windows** | 本机 | `pnpm tauri:build` | 5–10 分钟 |
| **Linux deb + AppImage** | Docker | `pwsh scripts/build-linux.ps1` | 10–15 分钟 |
| **Android APK** | Docker | `pwsh scripts/build-android.ps1` | 25–45 分钟（含 SDK/NDK 下载） |
| **macOS** | 真 Mac 本机 | `pnpm tauri:build` | 5–10 分钟 |
| **iOS** | 真 Mac + Xcode | `pnpm ios:build` | 5–10 分钟 |
| **开发热重载** | 本机 | `pnpm tauri:dev` | — |

为什么 Windows 不用 Docker：在 Win11 主机上跑 Linux 容器再用 `cargo-xwin` 跨编回 Windows，比直接本机构建慢且坑多。容器里你也没法跑 GUI 调试。

为什么 macOS/iOS 必须真 Mac：Apple 的 EULA 禁止在非 Apple 硬件上虚拟化 macOS，Docker Hub 上所有"macOS image"要么违规要么是 Linux 伪装。最实用的替代是 GitHub Actions 的 `macos-14` runner（免费层够个人项目用）。

## 前置条件

1. **Docker Desktop for Windows**（启用 WSL2 backend）。
2. **PowerShell 5.1+**（系统自带）或 PowerShell 7。
3. 给 Docker 分配至少 **8 GB RAM、20 GB 磁盘**（Android 镜像很重）。

## 用法

### Linux 构建

```powershell
cd app
.\scripts\build-linux.ps1
```

产物在 `./dist-out/linux/`：
- `*.deb` —— Debian/Ubuntu 包
- `*.AppImage` —— 通用 Linux 单文件（推荐侧载）

需要 RPM 包？编辑 `docker/linux.Dockerfile` 在 `pnpm tauri:build` 加 `--bundles rpm`，并装上 `rpm-build`：
```dockerfile
RUN apt-get install -y --no-install-recommends rpm
```

### Android 构建

```powershell
cd app
.\scripts\build-android.ps1
```

**第一次会下载 ~6 GB 的 Android SDK + NDK**，之后镜像层缓存住，重建只跑 Rust + Gradle。

产物在 `./dist-out/android/`：
- `*-debug.apk` —— 直接用 `adb install` 或拉到手机点开装。

### 用 docker compose 直接跑

```powershell
docker compose run --rm linux
docker compose run --rm android
```

## 签名的 Release APK

Debug APK 用 Android Studio 自带的 debug keystore 签名，**装在普通手机上可用**，但商店不收且容易触发 Play Protect 警告。要正式签名：

1. 生成 keystore（一次性）：
   ```powershell
   keytool -genkey -v -keystore keys\release.keystore `
     -keyalg RSA -keysize 2048 -validity 10000 -alias fusion
   ```

2. 在 `docker-compose.yml` 解开 keystore 挂载注释，并设环境变量：
   ```yaml
   environment:
     KEYSTORE_PATH: /keys/release.keystore
     KEYSTORE_PASSWORD: ${KEYSTORE_PASSWORD}
     KEY_ALIAS: fusion
     KEY_PASSWORD: ${KEY_PASSWORD}
   ```

3. 修改 `src-tauri/gen/android/app/build.gradle.kts` 的 `signingConfigs` 读这些环境变量（Tauri `android init` 会生成一个空模板，按需填入）。

4. 把 `pnpm android:build --apk --debug` 改成 `pnpm android:build --apk` 或 `--aab`。

5. 用 `.env` 文件传密码，**别提交进 git**（已在 `.gitignore`）。

## 常见问题

### `docker compose build linux` 卡在 `pnpm fetch`

代理问题。给 Docker Desktop 设置 HTTP 代理（Settings → Resources → Proxies），或在 `linux.Dockerfile` 顶部加：

```dockerfile
ENV HTTP_PROXY=http://host.docker.internal:7890 \
    HTTPS_PROXY=http://host.docker.internal:7890 \
    NO_PROXY=localhost,127.0.0.1
```

### Android 构建报 `License for package … not accepted`

镜像里已经 `yes | sdkmanager --licenses`，如果你改了 API level 或 build-tools 版本要在 Dockerfile 里同步更新参数。

### 想要 ARM64 Linux 包

在 Docker Desktop 启用 QEMU，然后：
```powershell
docker buildx build --platform linux/arm64 -f docker/linux.Dockerfile -t taffy-studio-linux-arm64 .
```
慢得多（QEMU 解释执行），认真做 ARM 包建议放 CI 上用原生 ARM runner。

### 镜像很重

`docker image prune` 清理悬挂层。Android 镜像层缓存值得保留（重新下载 SDK 半小时起步）。

## 上 CI 的建议（以后再做）

GitHub Actions 一份 workflow 就够：
- `ubuntu-latest` → 跑同样的 Linux Dockerfile（CI 里其实可以脱壳直接装依赖，少一层 Docker）
- `windows-latest` → 直接 `pnpm tauri:build`
- `macos-14` → 直接 `pnpm tauri:build && pnpm ios:build`（需要 Apple Developer ID 和 provisioning profile secret）
- `ubuntu-latest` + Android Dockerfile → APK / AAB

侧载发行：把 release 产物上传到自家 OSS / GitHub Releases，`tauri.conf.json` 的 `updater.endpoints` 指过去就行。
