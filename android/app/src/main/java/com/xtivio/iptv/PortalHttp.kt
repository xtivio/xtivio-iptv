package com.xtivio.iptv

import android.webkit.WebView
import org.json.JSONObject
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Plain HTTP GET for the web layer's direct Stalker client (assets/js/stalker-direct.js).
 *
 * A WebView cannot send the headers a MAG box sends (Cookie, Referer and User-Agent are fixed by the
 * browser), so the page hands the whole request here. This class only moves bytes: it sets the headers
 * the page gives, reads the answer as text and passes it back in chunks. All portal logic stays in the
 * page so the same client can be reused on other platforms.
 *
 * Events go to the page as window.PortalNative.onEvent(reqId, type, data):
 *   chunk  data = a piece of the body (string, at most CHUNK chars)
 *   done   data = {status} on success, {status:0, err} on failure; err is "network", "timeout" or "too-large"
 * `done` is sent exactly once per request, except after cancel() (nothing more is sent then).
 */
class PortalHttp(private val webViewProvider: () -> WebView) {

    private val pool = Executors.newFixedThreadPool(4)
    private val live = ConcurrentHashMap<String, HttpURLConnection>()

    fun fetch(reqId: String, url: String, headersJson: String, timeoutMs: Int, maxBytes: Int) {
        if (!ID_OK.matches(reqId)) return
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            emit(reqId, "done", "{\"status\":0,\"err\":\"network\"}")
            return
        }
        pool.execute { run(reqId, url, headersJson, timeoutMs.coerceIn(2000, 120000), maxBytes) }
    }

    fun cancel(reqId: String) {
        live.remove(reqId)?.disconnect()
    }

    private fun run(reqId: String, url: String, headersJson: String, timeoutMs: Int, maxBytes: Int) {
        var conn: HttpURLConnection? = null
        var cancelled = false
        try {
            conn = URL(url).openConnection() as HttpURLConnection
            live[reqId] = conn
            conn.requestMethod = "GET"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.instanceFollowRedirects = true
            conn.useCaches = false
            val hs = JSONObject(headersJson)
            val names = hs.keys()
            while (names.hasNext()) {
                val k = names.next()
                conn.setRequestProperty(k, hs.optString(k))
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            var total = 0L
            if (stream != null) {
                val reader = InputStreamReader(stream, Charsets.UTF_8)
                val buf = CharArray(CHUNK)
                while (true) {
                    if (live[reqId] !== conn) { cancelled = true; break }
                    val n = reader.read(buf)
                    if (n < 0) break
                    total += n
                    if (maxBytes > 0 && total > maxBytes) {
                        emit(reqId, "done", "{\"status\":0,\"err\":\"too-large\"}")
                        cancelled = true
                        break
                    }
                    if (n > 0) emit(reqId, "chunk", quote(String(buf, 0, n)))
                }
                try { reader.close() } catch (e: Exception) { }
            }
            if (!cancelled) emit(reqId, "done", "{\"status\":$status}")
        } catch (e: SocketTimeoutException) {
            if (live[reqId] === conn) emit(reqId, "done", "{\"status\":0,\"err\":\"timeout\"}")
        } catch (e: Exception) {
            if (live[reqId] === conn || conn == null) emit(reqId, "done", "{\"status\":0,\"err\":\"network\"}")
        } finally {
            live.remove(reqId)
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    /** A JSON string literal that is also a valid JavaScript literal on old WebViews (no raw U+2028/2029). */
    private fun quote(s: String): String =
        JSONObject.quote(s).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

    private fun emit(reqId: String, type: String, payload: String) {
        val js = "window.PortalNative&&window.PortalNative.onEvent('$reqId','$type',$payload);"
        val wv = webViewProvider()
        wv.post { wv.evaluateJavascript(js, null) }
    }

    companion object {
        private const val CHUNK = 65536
        private val ID_OK = Regex("^[A-Za-z0-9_-]{1,40}$")
    }
}
