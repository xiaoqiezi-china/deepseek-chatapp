# 构建桌面端与 APK

## 前置条件

- Node.js 22.12+、pnpm
- Windows 桌面端：Rust（rustup）、WebView2 Runtime、MSVC Build Tools
- Android：JDK 21、Android SDK（设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`）

## 网页版

```sh
pnpm install
pnpm build
pnpm start
```

## Windows 桌面端（Tauri 2）

Tauri 使用系统 WebView2，不打包 Chromium。应用启动时检测 WebView2 运行时，缺失会弹出提示并引导安装；NSIS 安装包在安装阶段也会自动补装。

```sh
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/nsis/`。开发模式：

```sh
pnpm tauri dev
```

## Android APK（Capacitor）

Capacitor 使用系统 WebView，不打包浏览器引擎。存储通过 `@capacitor/filesystem` 写入应用私有数据目录。

```sh
pnpm build
pnpm cap sync android
cd android
gradlew.bat assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。开发调试：

```sh
pnpm cap run android
```

Gradle 首次构建需要下载发行包（约 219 MB），国内网络可先通过代理下载到 `~/.gradle/wrapper/dists`。

## 说明

桌面端与 APK 都不运行 `server/`。应用直接通过 Tauri IPC 或 Capacitor Filesystem 读写与应用数据目录中 `data/` 相同结构的数据。


## 发布桌面端更新

应用启动 5 秒后会静默检查更新，设置 → 通用设置里也有「检查更新」。更新源是 GitHub Releases 的 `latest.json`。

发版流程：

1. 修改 `src-tauri/tauri.conf.json` 的 `version`（以及 `Cargo.toml`、`package.json` 保持一致）
2. 构建（必须带签名，否则 updater 无法校验）：

```sh
export TAURI_SIGNING_PRIVATE_KEY=<私钥文件路径>
pnpm tauri build
```

3. 发布到 GitHub Releases：

```sh
pnpm release:desktop v0.1.1 "本次更新说明"
```

脚本会读取 `src-tauri/target/release/bundle/nsis/` 下的安装包与签名，生成 `latest.json` 并上传到对应的 Release。

私钥保存在 `~/.tauri/deepseek-ce.key`，**不要提交到仓库**；丢失后已发布的版本将无法接收更新。
