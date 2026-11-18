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

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

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
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("missing url");
            return;
        }
        final Handler mainHandler = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                File apk = new File(getContext().getCacheDir(), "deepseek-ce-update.apk");
                if (apk.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    apk.delete();
                }
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(60000);
                connection.connect();
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException("download failed: HTTP " + status);
                }
                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) > 0) {
                        output.write(buffer, 0, read);
                    }
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
            } catch (Exception error) {
                call.reject("download failed: " + error.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }
}
