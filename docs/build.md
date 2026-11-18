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
