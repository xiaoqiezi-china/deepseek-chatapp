package com.deepseek.chatapp;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用内更新：获取当前版本号，下载 APK 并拉起系统安装器。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    /** 返回当前安装的版本名，供前端与 GitHub Release 比较 */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            String version = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
            JSObject ret = new JSObject();
            ret.put("version", version == null ? "" : version);
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("read version failed: " + error.getMessage());
        }
    }

    /** 下载 APK 到缓存目录并拉起系统安装界面（用户仍需确认安装） */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        List<String> candidates = new ArrayList<>();
        String primary = call.getString("url");
        if (primary != null && !primary.isEmpty()) {
            candidates.add(primary);
        }
        try {
            JSONArray urls = call.getArray("urls");
            if (urls != null) {
                for (int i = 0; i < urls.length(); i += 1) {
                    String url = urls.optString(i, "");
                    if (!url.isEmpty() && !candidates.contains(url)) {
                        candidates.add(url);
                    }
                }
            }
        } catch (Exception ignored) {
            // 兼容只传 url 的旧调用
        }
        if (candidates.isEmpty()) {
            call.reject("missing url");
            return;
        }

        final Handler mainHandler = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            File apk = new File(getContext().getCacheDir(), "deepseek-ce-update.apk");
            Exception lastError = null;
            for (String url : candidates) {
                HttpURLConnection connection = null;
                try {
                    if (apk.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        apk.delete();
                    }
                    connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setInstanceFollowRedirects(true);
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(120000);
                    connection.setRequestProperty("User-Agent", "Deepseek-CE");
                    connection.connect();
                    int status = connection.getResponseCode();
                    if (status < 200 || status >= 300) {
                        throw new IllegalStateException("HTTP " + status);
                    }
                    try (InputStream input = connection.getInputStream();
                         FileOutputStream output = new FileOutputStream(apk)) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = input.read(buffer)) > 0) {
                            output.write(buffer, 0, read);
                        }
                    }
                    if (apk.length() <= 0) {
                        throw new IllegalStateException("empty apk");
                    }

                    Uri uri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            apk);
                    mainHandler.post(() -> {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW);
                            intent.setDataAndType(uri, "application/vnd.android.package-archive");
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            getContext().startActivity(intent);
                            call.resolve();
                        } catch (Exception error) {
                            call.reject("launch installer failed: " + error.getMessage());
                        }
                    });
                    return;
                } catch (Exception error) {
                    lastError = error;
                } finally {
                    if (connection != null) {
                        connection.disconnect();
                    }
                }
            }
            call.reject("download failed: " + (lastError == null ? "unknown" : lastError.getMessage()));
        }).start();
    }
}
