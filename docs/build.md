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

Tauri 使用系统 WebView2，不打包 Chromium。

```sh
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`。开发模式：

```sh
pnpm tauri dev
```

## Android APK（Capacitor）

Capacitor 使用系统 WebView，不打包浏览器引擎。

```sh
pnpm build
pnpm cap sync android
cd android
./gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/`。开发调试：

```sh
pnpm cap run android
```

## 说明

桌面端与 APK 不需要运行 `server/`。应用直接通过 Tauri IPC 或 Capacitor Filesystem 插件读写 `data/` 相同结构的数据。
