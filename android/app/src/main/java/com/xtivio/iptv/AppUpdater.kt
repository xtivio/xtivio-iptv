package com.xtivio.iptv

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Direct (sideload) build only: downloads the update APK inside the app, checks its
 * SHA-256 against latest.json and hands it to the system package installer.
 *
 * The install permission and the FileProvider live in app/direct-overlay/AndroidManifest.xml,
 * which Gradle merges only when app/direct.flag exists. A store build has neither, so
 * supported() is false there and nothing here ever runs.
 *
 * Events go to the page as window.XtivioUpdate._onNative(evt, json):
 *   progress {pct}   verify {}   needperm {}   installing {}   error {code}
 * error codes: "net" (download failed), "hash" (does not match latest.json), "args", "install".
 */
class AppUpdater(
    private val activity: Activity,
    private val webViewProvider: () -> WebView
) {
    @Volatile private var cancelled = false
    @Volatile private var running = false

    fun supported(): Boolean {
        return try {
            val pi = activity.packageManager.getPackageInfo(
                activity.packageName, PackageManager.GET_PERMISSIONS
            )
            pi.requestedPermissions?.contains("android.permission.REQUEST_INSTALL_PACKAGES") == true
        } catch (e: Exception) {
            false
        }
    }

    fun cancel() { cancelled = true }

    fun start(url: String, sha256: String) {
        if (running) return
        val want = sha256.trim().lowercase(java.util.Locale.ROOT)
        if (!supported() || !url.startsWith("https://") || !Regex("^[0-9a-f]{64}$").matches(want)) {
            emit("error", "{\"code\":\"args\"}")
            return
        }
        if (!activity.packageManager.canRequestPackageInstalls()) {
            // First use: send the user to the "install unknown apps" switch for this app.
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) { /* page still shows the explanation */ }
            emit("needperm", "{}")
            return
        }
        cancelled = false
        running = true
        Thread {
            try {
                download(url, want)
            } catch (e: Exception) {
                if (!cancelled) emit("error", "{\"code\":\"net\"}")
            } finally {
                running = false
            }
        }.start()
    }

    private fun download(url: String, want: String) {
        val dir = File(activity.cacheDir, "updates")
        if (!dir.exists()) dir.mkdir()
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "xtivio-update.apk")
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = true
        if (conn.responseCode != 200) { conn.disconnect(); throw java.io.IOException("http") }
        val total = conn.contentLengthLong
        val md = MessageDigest.getInstance("SHA-256")
        var done = 0L
        var lastPct = -1
        conn.inputStream.use { ins ->
            out.outputStream().use { os ->
                val buf = ByteArray(65536)
                while (true) {
                    if (cancelled) { out.delete(); return }
                    val n = ins.read(buf)
                    if (n < 0) break
                    os.write(buf, 0, n)
                    md.update(buf, 0, n)
                    done += n
                    if (total > 0) {
                        val pct = (done * 100 / total).toInt()
                        if (pct != lastPct) { lastPct = pct; emit("progress", "{\"pct\":$pct}") }
                    }
                }
            }
        }
        conn.disconnect()
        emit("verify", "{}")
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (got != want) { out.delete(); emit("error", "{\"code\":\"hash\"}"); return }
        if (cancelled) { out.delete(); return }
        install(out)
    }

    private fun install(apk: File) {
        activity.runOnUiThread {
            try {
                val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", apk)
                val i = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(i)
                emit("installing", "{}")
            } catch (e: Exception) {
                emit("error", "{\"code\":\"install\"}")
            }
        }
    }

    private fun emit(evt: String, json: String) {
        val js = "window.XtivioUpdate&&window.XtivioUpdate._onNative('$evt',$json);"
        val wv = webViewProvider()
        wv.post { wv.evaluateJavascript(js, null) }
    }
}
