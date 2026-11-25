package com.xtivio.iptv

import android.app.Activity
import android.app.UiModeManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.webkit.JavascriptInterface

/**
 * Native bridge exposed to the web layer as window.AndroidBridge.
 *
 * Three responsibilities:
 *   1. Form-factor: platform() reports "android-tv" or "android-mobile" based on
 *      the RUNTIME device type (UiModeManager). This is what makes ONE APK adapt
 *      to both TVs and phones — the web layer's Mobile.isMobile() reads this to
 *      choose the TV or mobile UI. Detected at runtime, not hardcoded, so the
 *      same build installs and behaves correctly on a Google TV and on a phone.
 *   2. App lifecycle: exitApp() lets the web layer's tryExitApp() finish the
 *      Activity when Back is pressed at the app root (a Play TV requirement).
 *   3. Native playback: exoPlay/exoStop/exoPause/exoResume/exoSeekRelative are
 *      called by assets/js/player-exo.js (PlayerExo) to hand MKV/HEVC/AC3 (and
 *      other WebView-incompatible) streams to the native ExoPlayer. Its presence
 *      (typeof AndroidBridge.exoPlay === 'function') is also how the web layer
 *      knows the native player exists.
 *
 * The web layer calls these from a WebView JS thread; every ExoPlayer touch is
 * marshalled onto the UI thread here, since ExoPlayer must be accessed on the
 * main thread.
 */
class AndroidBridge(
    private val activity: Activity,
    private val exo: ExoControllerHandle,
    private val webViewProvider: () -> android.webkit.WebView,
    private val currentScaleProvider: () -> Float
) {

    // Direct build only: in-app update download (see AppUpdater). supported() is false in a
    // store build, so the page keeps its browser hand-off there.
    private val updater by lazy { AppUpdater(activity, webViewProvider) }

    // Direct Stalker portal calls: a plain GET with headers the WebView cannot send (see PortalHttp).
    // The page detects this by typeof AndroidBridge.portalFetch === 'function'.
    private val portalHttp by lazy { PortalHttp(webViewProvider) }

    // Backup and Restore file access (see BackupIo). The page detects it by typeof AndroidBridge.backupCaps === 'function'.
    internal val backupIo by lazy { BackupIo(activity, webViewProvider) }

    @JavascriptInterface
    fun backupCaps(): String = backupIo.caps()

    @JavascriptInterface
    fun backupSave(reqId: String, name: String, text: String) { backupIo.save(reqId, name, text) }

    @JavascriptInterface
    fun backupPick(reqId: String) { backupIo.pick(reqId) }

    @JavascriptInterface
    fun backupSaveFolder(reqId: String, name: String, text: String) { backupIo.saveFolder(reqId, name, text) }

    @JavascriptInterface
    fun backupList(reqId: String) { backupIo.list(reqId) }

    @JavascriptInterface
    fun backupRead(reqId: String, id: String) { backupIo.read(reqId, id) }

    @JavascriptInterface
    fun backupAskAccess(reqId: String) { backupIo.askAccess(reqId) }

    @JavascriptInterface
    fun portalFetch(reqId: String, url: String, headersJson: String, timeoutMs: Int, maxBytes: Int) {
        portalHttp.fetch(reqId, url, headersJson, timeoutMs, maxBytes)
    }

    @JavascriptInterface
    fun portalCancel(reqId: String) { portalHttp.cancel(reqId) }

    @JavascriptInterface
    fun updateSupported(): Boolean = updater.supported()

    @JavascriptInterface
    fun updateStart(url: String, sha256: String) { updater.start(url, sha256) }

    @JavascriptInterface
    fun updateCancel() { updater.cancel() }

    /** Finish the host Activity, exiting the app. Marshalled to the UI thread. */
    @JavascriptInterface
    fun exitApp() {
        activity.runOnUiThread { activity.finish() }
    }

    /**
     * Report the device form factor to the web layer.
     *
     * "android-tv"    -> the web app uses its TV (D-pad) UI and native-HLS path.
     * "android-mobile"-> the web app uses its mobile (touch) UI: bottom nav,
     *                    touch player, category bottom-sheet, file upload, etc.
     *
     * Detection: a TV reports UI_MODE_TYPE_TELEVISION via UiModeManager. As a
     * belt-and-braces fallback we also treat the device as TV if the system lacks
     * a touchscreen (real TVs do) — some boxes under-report the UI mode. Anything
     * else is treated as mobile (phone/tablet). Computed fresh each call so it is
     * always correct even if the Activity was created before this ran.
     */
    @JavascriptInterface
    fun platform(): String {
        // TV-ONLY BUILD: always report TV. The mobile web layer stays bundled but
        // dormant — because this never returns "android-mobile", Mobile.isMobile()
        // is always false and the app uses the TV (D-pad) UI exclusively. To
        // re-enable the unified TV+mobile behaviour later, restore the runtime
        // detection: `return if (isTelevision()) "android-tv" else "android-mobile"`.
        return "android-tv"
    }

    /**
     * Clipboard access for the in-app keyboard's Paste / Copy keys (touch devices).
     * WebView often blocks navigator.clipboard, so the JS asks here first.
     * getClipboardText returns "" when the clipboard is empty or not text.
     */
    @JavascriptInterface
    fun getClipboardText(): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val item = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
            item?.coerceToText(activity)?.toString() ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun setClipboardText(text: String, sensitive: Boolean) {
        try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Xtivio", text)
            if (sensitive) {
                // Android 13+: keeps the copied value out of the clipboard preview and
                // keyboard clipboard history. Older versions ignore the extra.
                clip.description.extras = android.os.PersistableBundle().apply {
                    putBoolean("android.content.extra.IS_SENSITIVE", true)
                }
            }
            cm.setPrimaryClip(clip)
        } catch (e: Exception) {
        }
    }

    /**
     * Does this device have real touchscreen hardware? Deliberately INDEPENDENT
     * of platform()/isTelevision() above: platform() is a pinned app-mode
     * decision (see its own doc comment) that says nothing about the physical
     * device, so it must never be used to answer a hardware-capability
     * question. This reuses the exact PackageManager feature check
     * isTelevision() already relies on for its own fallback, exposed directly
     * so the web layer can gate touch-only interactions (swipe gestures,
     * pinch-zoom, the touch player controls, etc.) correctly on a real phone
     * or tablet even while platform() stays pinned to "android-tv" for all
     * devices, and correctly OFF on a real TV box that has no touchscreen at
     * all — the two questions ("what UI/layout to run" vs "can this device be
     * tapped") are answered independently on purpose.
     */
    @JavascriptInterface
    fun hasTouchscreen(): Boolean = deviceHasTouchscreen()

    private fun deviceHasTouchscreen(): Boolean {
        return try {
            activity.packageManager.hasSystemFeature("android.hardware.touchscreen")
        } catch (e: Exception) {
            // Unknown: assume no touchscreen (matches isTelevision()'s own
            // conservative fallback below — safer to under-detect touch on an
            // unusual device than to wrongly enable touch gestures on a TV box).
            false
        }
    }

    private fun isTelevision(): Boolean {
        try {
            val uiModeManager = activity.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
            if (uiModeManager != null &&
                uiModeManager.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) {
                return true
            }
        } catch (e: Exception) { /* fall through to touchscreen heuristic */ }
        // Fallback: a device with NO touchscreen is a TV/box. Phones and tablets
        // always have one. This catches TV boxes that under-report their UI mode.
        if (!deviceHasTouchscreen()) return true
        return false
    }

    @JavascriptInterface
    fun buildId(): String = BuildConfig.XTIVIO_BUILD_ID

    /** True when the device's system theme is dark. The WebView's own
     *  prefers-color-scheme does not reliably follow it, so the web layer's
     *  "Follow System" theme asks here instead. Read from the activity's current
     *  configuration (uiMode is in the manifest's configChanges, so it is live). */
    @JavascriptInterface
    fun isSystemDark(): Boolean {
        val mask = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return mask == Configuration.UI_MODE_NIGHT_YES
    }

    // --- Native ExoPlayer control (called from PlayerExo) -----------------


    @JavascriptInterface
    fun exoPlay(url: String, startMs: Long) {
        activity.runOnUiThread { exo.play(url, startMs) }
    }

    /** Same as exoPlay, plus the content type so the native player can pick its
     *  buffering profile (live TV vs VOD). */
    @JavascriptInterface
    fun exoPlayEx(url: String, startMs: Long, live: Boolean) {
        activity.runOnUiThread { exo.play(url, startMs, live) }
    }

    /** "Playback buffer" setting in seconds (0 = standard). Applied from the next exoPlay*. */
    @JavascriptInterface
    fun exoSetBufferReserve(seconds: Int) {
        activity.runOnUiThread { exo.setBufferReserve(seconds) }
    }

    /** "Match frame rate" setting: 0 off, 1 seamless only (default), 2 always. Applied from the next exoPlay*. */
    @JavascriptInterface
    fun exoSetFrameRateMatching(mode: Int) {
        activity.runOnUiThread { exo.setFrameRateMatching(mode) }
    }

    @JavascriptInterface
    fun exoStop() {
        activity.runOnUiThread { exo.stop() }
    }

    @JavascriptInterface
    fun exoPause() {
        activity.runOnUiThread { exo.pause() }
    }

    @JavascriptInterface
    fun exoResume() {
        activity.runOnUiThread { exo.resume() }
    }

    /** Playback speed (0.5 to 2). The <video> element is not what plays on Android, so the page asks the player directly. */
    @JavascriptInterface
    fun exoSetSpeed(speed: Double) {
        activity.runOnUiThread { exo.setSpeed(speed.toFloat()) }
    }

    @JavascriptInterface
    fun exoSeekRelative(deltaMs: Long) {
        activity.runOnUiThread { exo.seekRelative(deltaMs) }
    }

    /**
     * Scrub-bar seeking on the exo path:
     * previously the only seek primitive exposed here was relative, so
     * player.js's seekTo(fraction) had to fake an absolute seek by computing
     * "targetMs - lastKnownPositionMs" itself and sending THAT as a relative
     * delta. lastKnownPositionMs only updates once a second (the native time
     * ticker), so during active playback it could be stale by up to ~1s —
     * meaning a drag-to-position could land up to a second off, and the
     * overlay would visibly snap back to the pre-seek position until the next
     * tick corrected it. Looked exactly like "scrubbing doesn't work" even
     * though the underlying ExoPlayer.seekTo() call was fine. A real absolute
     * seek primitive removes the staleness entirely.
     */
    @JavascriptInterface
    fun exoSeekTo(absoluteMs: Long) {
        activity.runOnUiThread { exo.seekTo(absoluteMs) }
    }

    /**
     * Select an audio track
     * by the flat index ExoController's own "audioTracks" native event
     * already reported to the web layer (see ExoController.sendAudioTracks's
     * doc comment for why that index is a flattened one, not the player's
     * raw index). Fire-and-forget, same shape as every other exo* control
     * above — no return value, because ExoController's audio-track results
     * are pushed to the web layer as they change, not pulled synchronously
     * (a JavascriptInterface call runs on a background thread, so blocking
     * it to wait on a UI-thread result is a real deadlock risk this
     * deliberately avoids, not an oversight).
     */
    @JavascriptInterface
    fun exoSetAudioTrack(index: Int) {
        activity.runOnUiThread { exo.setAudioTrack(index) }
    }

    /**
     * Confine the native exo surface (normally fullscreen, behind the WebView)
     * to a specific on-screen rect — used to make the live-TV mini player work
     * when exo is the active engine. Previously the mini player only ever
     * moved the invisible placeholder <video> element around the DOM; that
     * does nothing for exo, since exo's actual pixels come from a separate
     * native SurfaceView the mini player had no way to resize. The web layer
     * (live-top-mini.js) calls this continuously with the mini frame's current
     * getBoundingClientRect() (raw CSS pixels — no devicePixelRatio scaling,
     * see below) while it's tracking, and clearBounds() to return to
     * fullscreen. Known limitation: the native surface can't pick up the mini
     * frame's CSS border-radius (that's a DOM/WebView-layer clip, and this
     * surface sits behind the WebView entirely) — its corners stay square.
     *
     * Mini player (sound but no picture): [left/top/width/
     * height]Px arrive here as CSS pixels — getBoundingClientRect() values as
     * the page sees them, in its fixed 1920-wide viewport (see MainActivity's
     * "VIEWPORT FIX" comment). They are NOT the same as device pixels here,
     * and NOT related to window.devicePixelRatio at all: this app doesn't use
     * standard viewport scaling — it deliberately pins the WebView via
     * setInitialScale(panelWidthPx / 1920 * 100) so exactly 1920 CSS px maps
     * onto the full physical panel width, regardless of the device's real
     * density. devicePixelRatio (what live-top-mini.js used to multiply by)
     * measures something else — the display's density relative to baseline —
     * and has nothing to do with this app's own deliberate zoom. Using it
     * produced a wrong, often near-degenerate (or wildly oversized) surface
     * size, which explains video disappearing (while audio, unaffected by
     * surface geometry, kept playing fine). Converts with the SAME formula
     * MainActivity's own setInitialScale already uses, so this is the one
     * true scale factor for this app's viewport setup, not a second guess at
     * it.
     */
    @JavascriptInterface
    fun exoSetBounds(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int) {
        activity.runOnUiThread {
            try {
                val panelW = activity.resources.displayMetrics.widthPixels.toDouble()
                val scale = if (panelW > 0) panelW / 1920.0 else 1.0
                val realLeft = Math.round(leftPx * scale).toInt()
                val realTop = Math.round(topPx * scale).toInt()
                val realWidth = Math.round(widthPx * scale).toInt()
                val realHeight = Math.round(heightPx * scale).toInt()
                exo.setBounds(realLeft, realTop, realWidth, realHeight)
            } catch (e: Exception) {
                // Fall back to the raw (likely-wrong-scale but non-crashing)
                // values rather than dropping the call entirely.
                exo.setBounds(leftPx, topPx, widthPx, heightPx)
            }
        }
    }

    /**
     * Fullscreen video scaling (Settings > Video Scaling) for the native surface.
     * The web layer already works out where the picture should sit for each
     * scaling mode (App.applyVideoScale) but only ever applied it to the hidden
     * <video>, so the setting did nothing for MKV/HEVC played here. It now passes
     * that rect in CSS px of the 1920 canvas; this converts to device px exactly
     * like exoSetBounds and moves the surface and shutter. Unlike exoSetBounds it
     * leaves the mini player's backdrop alone.
     */
    @JavascriptInterface
    fun exoSetVideoRect(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int) {
        activity.runOnUiThread {
            try {
                val panelW = activity.resources.displayMetrics.widthPixels.toDouble()
                val scale = if (panelW > 0) panelW / 1920.0 else 1.0
                exo.setVideoRect(
                    Math.round(leftPx * scale).toInt(),
                    Math.round(topPx * scale).toInt(),
                    Math.round(widthPx * scale).toInt(),
                    Math.round(heightPx * scale).toInt()
                )
            } catch (e: Exception) {
                exo.setVideoRect(leftPx, topPx, widthPx, heightPx)
            }
        }
    }

    @JavascriptInterface
    fun exoClearBounds() {
        activity.runOnUiThread { exo.clearBounds() }
    }

    /**
     * Hand the current stream off to another installed app via the system's
     * own chooser — VLC, MX Player, or anything else that can handle video.
     * Fire-and-forget from the JS side (no return value/callback): mirrors
     * the existing exitApp()/exoPlay() style of just marshalling onto the UI
     * thread and letting Android own the actual UX from there. If nothing on
     * the device can handle it, Intent.createChooser's own "no apps found"
     * UI covers that — no need to plumb a failure back to the web layer.
     * Backgrounding Xtivio to launch another app's Activity already triggers
     * MainActivity's onPause() (which pauses exo) before the new app's
     * onResume() runs, per normal Android activity-lifecycle ordering — no
     * extra pause call needed here.
     */
    @JavascriptInterface
    fun openExternalPlayer(url: String) {
        activity.runOnUiThread {
            try {
                val uri = android.net.Uri.parse(url)
                val viewIntent = android.content.Intent(android.content.Intent.ACTION_VIEW)
                viewIntent.setDataAndType(uri, "video/*")
                viewIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                val chooser = android.content.Intent.createChooser(viewIntent, null)
                chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(chooser)
            } catch (e: Exception) {
                android.util.Log.d("XtivioWeb", "openExternalPlayer failed: ${e.message}")
            }
        }
    }

    /**
     * Show/hide the web UI (WebView) OVER the native video during playback.
     * The swap model hides the WebView while native video plays so the video is
     * visible. But the web UI (transport controls, info bar, loading spinner)
     * lives in the WebView — so when the app wants to show controls or a
     * buffering spinner, it calls exoShowUi(true) to bring the WebView forward
     * (opaque, over the still-playing video — audio continues), and
     * exoShowUi(false) to hide it again so the video fills the screen. Driven by
     * the web layer's existing showOverlay/hideOverlay/showLoading logic.
     */
    @JavascriptInterface
    fun exoShowUi(visible: Boolean) {
        activity.runOnUiThread { exo.showUi(visible) }
    }

    /**
     * WebView-wide pinch-to-zoom toggle (true = on, the default — an
     * accessibility affordance for the TV-scaled UI on a small phone screen).
     * This is a whole-WebView setting (WebSettings.setSupportZoom/
     * builtInZoomControls in MainActivity), not something CSS/JS can scope to
     * one screen — Android WebView's built-in pinch gesture actually ignores
     * the page's own <meta viewport user-scalable=no> (a known WebView
     * quirk; that restriction only works in real browsers). So pinching
     * anywhere, including over the player's info overlay, zoomed the whole
     * page and could shift the overlay controls out from under a finger.
     * The web layer calls this with false on entering the player screen and
     * true on leaving it, so pinch-to-zoom stays available everywhere else
     * (an intentional accessibility feature, unaffected).
     *
     * Mobile player scrollbars and video dragging: disabling zoom here stops FURTHER
     * pinching but doesn't by itself snap an ALREADY-zoomed WebView back to
     * 1:1 — if the user had pinch-zoomed while browsing the menus (pinch-
     * zoom is enabled everywhere outside the player), that zoom/pan state
     * carried straight into the player, which has no layout of its own that
     * tolerates being off-scale. Two earlier versions of this fix relied on
     * toggling WebSettings on/off and hoping that forced a reset as a side
     * effect — a known-unreliable trick (setInitialScale() in particular is
     * documented as only reliable for the INITIAL page load, not resetting
     * an already-zoomed page later) — and even after fixing that toggle's
     * own timing bug (the two states executing with no yield in between,
     * silently making it a no-op), it still wasn't reliably resetting the
     * zoom. Replaced with the actual, direct, documented API for this:
     * WebView.zoomBy(factor) explicitly asks for exactly 1.0x, computed from
     * the WebView's real live scale (tracked in MainActivity via
     * WebViewClient.onScaleChanged — there's no public getScale() to read it
     * on demand), plus scrollTo(0, 0) to reset pan position too (the
     * "player can be moved" symptom is pan, not just zoom level,
     * and zoomBy() alone doesn't reset scroll offset).
     */
    @JavascriptInterface
    fun setZoomEnabled(enabled: Boolean) {
        activity.runOnUiThread {
            try {
                val wv = webViewProvider()
                val settings = wv.settings
                if (enabled) {
                    settings.setSupportZoom(true)
                    settings.builtInZoomControls = true
                    return@runOnUiThread
                }
                // Entering the player: reset scale/pan FIRST, while zoom is
                // still enabled (zoomBy() needs it to be — make sure, in case
                // it was somehow left disabled from an earlier call), THEN
                // disable zoom controls once the reset has had a render pass
                // to actually apply.
                settings.setSupportZoom(true)
                val scale = currentScaleProvider()
                if (scale > 0f && kotlin.math.abs(scale - 1f) > 0.01f) {
                    try { wv.zoomBy(1f / scale) } catch (eZoom: Exception) { /* ignore */ }
                }
                wv.scrollTo(0, 0)
                wv.post {
                    try { finishZoomDisable(wv) } catch (e: Exception) { /* ignore */ }
                }
            } catch (e: Exception) { /* ignore */ }
        }
    }

    private fun finishZoomDisable(wv: android.webkit.WebView) {
        val settings = wv.settings
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        // Reset again in case the zoomBy() animation caused any drift after
        // the first scrollTo above.
        wv.scrollTo(0, 0)
        val metrics = activity.resources.displayMetrics
        val panelW = metrics.widthPixels
        if (panelW > 0) {
            val scalePercent = Math.round(panelW.toDouble() / 1920.0 * 100.0).toInt()
            if (scalePercent in 25..400) {
                @Suppress("DEPRECATION")
                wv.setInitialScale(scalePercent)
            }
        }
    }

    // setOrientationLock removed: portrait for mobile was mechanics-only and
    // never got a real layout —
    // decided against building one, since it doesn't fit with the sidebar
    // being permanently expanded on touch devices. MainActivity's own
    // boot-time requestedOrientation = SCREEN_ORIENTATION_LANDSCAPE (see its
    // "VIEWPORT FIX" comment) is now simply permanent — nothing ever sets it
    // to UNSPECIFIED anymore, for touch or TV alike, so there's nothing left
    // for a runtime toggle to do.
}

/**
 * Minimal interface the bridge needs from the ExoPlayer controller, so the
 * bridge does not depend on the @UnstableApi controller type directly.
 */
interface ExoControllerHandle {
    fun play(url: String, startMs: Long)
    fun play(url: String, startMs: Long, live: Boolean)
    fun stop()
    fun pause()
    fun resume()
    fun seekRelative(deltaMs: Long)
    fun seekTo(absoluteMs: Long)
    fun setSpeed(speed: Float)
    fun setBounds(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int)
    fun setVideoRect(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int)
    fun clearBounds()
    fun showUi(visible: Boolean)
    // Audio-track picker: declared here too, not just
    // implemented on ExoController directly — AndroidBridge.exo is typed as
    // this interface, not the concrete class, so a method only added to
    // ExoController is invisible through this reference. Missed on the
    // first pass and caught by a real compile, since it went unbuilt in the
    // environment that wrote it.
    fun setAudioTrack(index: Int)
    fun setBufferReserve(seconds: Int)
    fun setFrameRateMatching(mode: Int)
}
