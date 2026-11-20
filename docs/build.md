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

应用启动 5 秒后会静默检查更新，设置 → 通用设置里也有「检查更新」。更新信息直接读取 GitHub Release API，不再依赖 `latest.json`；API 和资产下载都按镜像优先、直连兜底。

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

脚本会读取 `src-tauri/target/release/bundle/nsis/` 下的安装包与签名，上传到对应的 Release。桌面端运行时从 Release API 找到以 `x64-setup.exe` 结尾的安装包和同名 `.sig` 签名，校验后安装。

私钥保存在 `~/.tauri/deepseek-ce.key`，**不要提交到仓库**；丢失后已发布的版本将无法接收更新。


## Android 更新机制

Android 端在设置 →「检查更新」里查询 GitHub Releases 最新版本：

1. 通过 GitHub API 读取最新 release 的版本和 APK 资产
2. 与当前安装版本（`versionName`）比较
3. 有新版本时，调用原生插件 `AppUpdater.downloadAndInstall` 下载 APK 到缓存；下载会按 `gh-proxy.com`、`ghproxy.net`、GitHub 直连等地址依次重试
4. 用 FileProvider 拉起系统安装器，用户确认后完成安装

系统要求每次安装必须由用户确认，无法静默升级。发布 Android 版本时需同时上传 APK 到 Release，文件名以 `.apk` 结尾。
