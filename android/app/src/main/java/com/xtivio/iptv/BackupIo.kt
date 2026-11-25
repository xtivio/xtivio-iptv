package com.xtivio.iptv

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Backup and Restore file access for the web layer (assets/js/backup.js).
 *
 * The web layer builds and reads the backup text itself; this class only moves one text file in and out:
 *   1. System file picker (Storage Access Framework): save with ACTION_CREATE_DOCUMENT, restore with
 *      ACTION_OPEN_DOCUMENT. No permission needed, reaches internal storage, USB drives and cloud providers.
 *   2. Visible folder Download/Xtivio for boxes that have no picker. Android 10+ writes it through MediaStore
 *      (no permission). Android 11+ with "All files access" (declared only in the DIRECT build manifest overlay)
 *      and Android 9 or older with the storage permission use plain files, which also lets restore list backups
 *      that were copied in with a file manager. Without that access, listing sees only this app's own files.
 *
 * Every result goes back as window.XtivioBackup._onNative(reqId, {ok, ...}). Nothing is logged.
 */
class BackupIo(
    private val activity: Activity,
    private val webViewProvider: () -> WebView
) {
    private var pendingReq: String? = null
    private var pendingName: String = ""
    private var pendingText: String = ""

    // ---- capabilities -------------------------------------------------------------------------------------

    @Suppress("DEPRECATION")
    private fun declared(perm: String): Boolean {
        return try {
            val pm = activity.packageManager
            val flags = PackageManager.GET_PERMISSIONS
            val perms: Array<String>? = if (Build.VERSION.SDK_INT >= 33)
                pm.getPackageInfo(activity.packageName, PackageManager.PackageInfoFlags.of(flags.toLong())).requestedPermissions
            else
                pm.getPackageInfo(activity.packageName, flags).requestedPermissions
            perms?.contains(perm) == true
        } catch (e: Exception) { false }
    }

    private fun canResolve(i: Intent): Boolean = i.resolveActivity(activity.packageManager) != null

    /** "granted": plain file access to Download works. "ask": the user can grant it. "none": MediaStore and picker only. */
    private fun fileAccess(): String {
        val sdk = Build.VERSION.SDK_INT
        if (sdk >= 30) {
            if (!declared("android.permission.MANAGE_EXTERNAL_STORAGE")) return "none"
            return if (Environment.isExternalStorageManager()) "granted" else "ask"
        }
        if (sdk <= 28) {
            val ok = activity.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED &&
                activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
            return if (ok) "granted" else "ask"
        }
        return "none"
    }

    fun caps(): String {
        val o = JSONObject()
        val open = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        val create = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json")
        o.put("picker", canResolve(open) && canResolve(create))
        o.put("files", fileAccess())
        o.put("folder", "Download/Xtivio")
        o.put("sdk", Build.VERSION.SDK_INT)
        return o.toString()
    }

    // ---- picker -------------------------------------------------------------------------------------------

    fun save(reqId: String, name: String, text: String) {
        activity.runOnUiThread {
            try {
                pendingReq = reqId; pendingName = name; pendingText = text
                val i = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json").putExtra(Intent.EXTRA_TITLE, name)
                activity.startActivityForResult(i, RC_SAVE)
            } catch (e: Exception) { pendingReq = null; pendingText = ""; emit(reqId, fail("nopicker")) }
        }
    }

    fun pick(reqId: String) {
        activity.runOnUiThread {
            try {
                pendingReq = reqId
                val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                activity.startActivityForResult(i, RC_PICK)
            } catch (e: Exception) { pendingReq = null; emit(reqId, fail("nopicker")) }
        }
    }

    /** Called from MainActivity.onActivityResult. Returns true when the result belonged to this class. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != RC_SAVE && requestCode != RC_PICK && requestCode != RC_ALL) return false
        val req = pendingReq
        if (requestCode == RC_ALL) {
            val r = req ?: return true
            pendingReq = null
            emit(r, JSONObject(caps()).put("ok", true))
            return true
        }
        pendingReq = null
        if (req == null) return true
        val text = pendingText
        pendingText = ""
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) { emit(req, fail("cancelled")); return true }
        Thread {
            try {
                if (requestCode == RC_SAVE) {
                    activity.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    emit(req, JSONObject().put("ok", true).put("name", displayName(uri)))
                } else {
                    val body = readUri(uri)
                    if (body == null) emit(req, fail("toolarge"))
                    else emit(req, JSONObject().put("ok", true).put("name", displayName(uri)).put("text", body))
                }
            } catch (e: Exception) { emit(req, fail("io")) }
        }.start()
        return true
    }

    private fun displayName(uri: Uri): String {
        try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0) ?: ""
            }
        } catch (e: Exception) { }
        return uri.lastPathSegment ?: ""
    }

    // ---- Download/Xtivio ----------------------------------------------------------------------------------

    private fun downloads(): File = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)

    fun saveFolder(reqId: String, name: String, text: String) {
        Thread {
            try {
                val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_")
                val access = fileAccess()
                if (access == "granted") {
                    val dir = File(downloads(), "Xtivio")
                    if (!dir.exists()) dir.mkdirs()
                    File(dir, safe).writeText(text, Charsets.UTF_8)
                    emit(reqId, JSONObject().put("ok", true).put("name", "Download/Xtivio/$safe"))
                } else if (Build.VERSION.SDK_INT >= 29) {
                    val v = ContentValues()
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    v.put(MediaStore.Downloads.MIME_TYPE, "application/json")
                    v.put(MediaStore.Downloads.RELATIVE_PATH, "Download/Xtivio")
                    val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)
                    if (uri == null) { emit(reqId, fail("io")); return@Thread }
                    activity.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    emit(reqId, JSONObject().put("ok", true).put("name", "Download/Xtivio/$safe"))
                } else {
                    emit(reqId, fail("permission"))
                }
            } catch (e: Exception) { emit(reqId, fail("io")) }
        }.start()
    }

    fun list(reqId: String) {
        Thread {
            try {
                val arr = JSONArray()
                if (fileAccess() == "granted") {
                    val seen = HashSet<String>()
                    val dirs = listOf(File(downloads(), "Xtivio"), downloads())
                    for (d in dirs) {
                        val fs = d.listFiles() ?: continue
                        for (f in fs) {
                            val n = f.name.lowercase()
                            if (!f.isFile || !n.endsWith(".json") || (d.name != "Xtivio" && !n.contains("xtivio"))) continue
                            if (!seen.add(f.absolutePath)) continue
                            arr.put(JSONObject().put("id", f.absolutePath).put("name", f.name).put("size", f.length()).put("mod", f.lastModified()))
                        }
                    }
                } else if (Build.VERSION.SDK_INT >= 29) {
                    val proj = arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME, MediaStore.Downloads.SIZE, MediaStore.Downloads.DATE_MODIFIED)
                    activity.contentResolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, proj,
                        MediaStore.Downloads.RELATIVE_PATH + " LIKE ?", arrayOf("Download/Xtivio%"), MediaStore.Downloads.DATE_MODIFIED + " DESC")?.use { c ->
                        while (c.moveToNext() && arr.length() < 60) {
                            val u = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0))
                            arr.put(JSONObject().put("id", u.toString()).put("name", c.getString(1) ?: "").put("size", c.getLong(2)).put("mod", c.getLong(3) * 1000L))
                        }
                    }
                }
                emit(reqId, JSONObject().put("ok", true).put("files", arr))
            } catch (e: Exception) { emit(reqId, fail("io")) }
        }.start()
    }

    fun read(reqId: String, id: String) {
        Thread {
            try {
                val body: String? = if (id.startsWith("content://")) {
                    readUri(Uri.parse(id))
                } else {
                    val f = File(id).canonicalFile
                    if (!f.path.startsWith(downloads().canonicalPath + File.separator) || !f.isFile || f.length() > MAX_BYTES) null
                    else f.readText(Charsets.UTF_8)
                }
                if (body == null) emit(reqId, fail("toolarge")) else emit(reqId, JSONObject().put("ok", true).put("text", body))
            } catch (e: Exception) { emit(reqId, fail("io")) }
        }.start()
    }

    private fun readUri(uri: Uri): String? {
        activity.contentResolver.openInputStream(uri)!!.use { ins ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(65536)
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_BYTES) return null
            }
            return out.toString("UTF-8")
        }
    }

    // ---- file access permission ---------------------------------------------------------------------------

    fun askAccess(reqId: String) {
        activity.runOnUiThread {
            try {
                pendingReq = reqId
                if (Build.VERSION.SDK_INT >= 30 && declared("android.permission.MANAGE_EXTERNAL_STORAGE")) {
                    try {
                        activity.startActivityForResult(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + activity.packageName)), RC_ALL)
                    } catch (e: Exception) {
                        activity.startActivityForResult(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), RC_ALL)
                    }
                } else if (Build.VERSION.SDK_INT <= 28) {
                    activity.requestPermissions(arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE, android.Manifest.permission.WRITE_EXTERNAL_STORAGE), RC_PERM)
                } else {
                    pendingReq = null
                    emit(reqId, fail("unavailable"))
                }
            } catch (e: Exception) { pendingReq = null; emit(reqId, fail("unavailable")) }
        }
    }

    /** Called from MainActivity.onRequestPermissionsResult (Android 9 and older). */
    fun onPermissionResult(requestCode: Int): Boolean {
        if (requestCode != RC_PERM) return false
        val r = pendingReq ?: return true
        pendingReq = null
        emit(r, JSONObject(caps()).put("ok", true))
        return true
    }

    // ---- helpers ------------------------------------------------------------------------------------------

    private fun fail(code: String): JSONObject = JSONObject().put("ok", false).put("code", code)

    private fun emit(reqId: String, o: JSONObject) {
        val json = o.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        val js = "window.XtivioBackup&&window.XtivioBackup._onNative('" + reqId.replace(Regex("[^A-Za-z0-9_-]"), "") + "'," + json + ");"
        val wv = webViewProvider()
        wv.post { wv.evaluateJavascript(js, null) }
    }

    companion object {
        private const val RC_SAVE = 7101
        private const val RC_PICK = 7102
        private const val RC_PERM = 7103
        private const val RC_ALL = 7104
        private const val MAX_BYTES = 8 * 1024 * 1024
    }
}
