package com.xtivio.iptv

import android.annotation.SuppressLint
import android.os.Build
import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.os.Bundle
import android.util.Rational
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.media3.common.util.UnstableApi

/**
 * Xtivio Android TV / Google TV shell — HYBRID build.
 *
 * The web app (the same ~24k-line ES5 codebase that ships on webOS/Tizen) is the
 * entire UI, running in a full-screen WebView. Playback is split:
 *
 *   - Formats the WebView CAN handle (H.264 MP4, HLS via bundled hls.js) play in
 *     the WebView's own <video> element, using the existing web player code.
 *   - Formats it CANNOT (MKV/AVI containers, HEVC/H.265, AC3/EAC3/DTS) are handed
 *     to a NATIVE ExoPlayer (Media3) rendered on a SurfaceView BEHIND the
 *     WebView, via the AndroidBridge + player-exo.js contract. The web layer
 *     makes the WebView transparent while native video plays, so the web
 *     overlays (loading, subtitles, info bar) still paint on top.
 *
 * View stack (bottom to top): [ SurfaceView (ExoPlayer) ][ WebView (UI) ]
 *
 * No DRM, no bundled content: a player for user-supplied playlists.
 */
@UnstableApi
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var exo: ExoController
    // Tracks the WebView's live zoom scale — there's no public getScale() to
    // read it on demand, so it has to be captured as it changes via
    // WebViewClient.onScaleChanged below. Read by AndroidBridge to reset
    // zoom precisely (WebView.zoomBy(1/currentWebViewScale)) rather than
    // the unreliable "toggle settings and hope" approach that used to be
    // the only mechanism for this — see AndroidBridge.setZoomEnabled's own
    // comment for the full history.
    private var currentWebViewScale: Float = 1f

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Landscape on boot, for every form factor — safe starting default.
        // Now also the PERMANENT state: portrait for mobile was mechanics-
        // only and never got a real layout — decided
        // against building one, since it doesn't fit with the sidebar being
        // permanently expanded on touch devices. AndroidBridge used to
        // toggle this at runtime (setOrientationLock, since removed);
        // nothing calls requestedOrientation again after this, for touch or
        // TV alike. Set in code, not the manifest, so the manifest stays
        // form-factor-neutral.
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE

        // WINDOW background transparent. Even with a transparent WebView, the
        // Activity Window itself has an opaque background (Theme.Xtivio ->
        // windowBackground) that sits between the WebView and the SurfaceView
        // behind it, covering the video. Making the window transparent lets the
        // SurfaceView (at index 0) show through. This is the piece that was
        // missing — WebView transparency alone was not enough.
        window.setBackgroundDrawable(
            android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT)
        )
        // Translucent window pixel format: lets the window composite a
        // transparent region so the SurfaceView (behind the transparent WebView)
        // shows through. Without it, some devices force an opaque window buffer
        // that covers the video surface.
        window.setFormat(android.graphics.PixelFormat.TRANSLUCENT)

        root = FrameLayout(this)
        setContentView(root)

        webView = WebView(this)
        webView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        // WebView is transparent from creation. The native video is a
        // SurfaceView added by ExoController BEHIND this WebView (index 0). For it
        // to show through: the WebView is transparent (here), the Activity window
        // is transparent + TRANSLUCENT (onCreate above), and the web layer clears
        // its own opaque backgrounds during playback via the punch-through CSS
        // (html[data-exo-active] ...). The web overlays then paint over the live
        // video — the AVPlay-equivalent, no swap. (setZOrderMediaOverlay is NOT
        // used — it orders one SurfaceView vs another and, with no base surface,
        // punches no transparency hole.)
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        root.addView(webView)

        // Native player. Renders behind the WebView; reports state back to the
        // web layer's PlayerExo._onNative(...).
        exo = ExoController(
            activity = this,
            rootProvider = { root },
            webViewProvider = { webView },
            toWeb = { evt, json -> dispatchToWeb(evt, json) }
        )

        configureWebView(webView)
        goImmersive()

        // ALWAYS load the app. This used to be gated on savedInstanceState ==
        // null, which is wrong: that Bundle is non-null whenever Android
        // recreates the Activity after killing the backgrounded process (memory
        // pressure — likely after hours in the background) or after a system
        // change not covered by configChanges (language, font scale, display
        // size). The WebView above is a brand-new instance each time and nothing
        // here saves/restores its page (no onSaveInstanceState/restoreState), so
        // skipping loadUrl left it empty: a transparent window over nothing =
        // black screen, no JS running so Back (routed through JS) did nothing,
        // and only swiping the app out of Recents (which discards the saved
        // Bundle) recovered it. The web app keeps its own state in
        // localStorage/IndexedDB, so a fresh load loses nothing it relied on.
        webView.loadUrl(APP_URL)

        // Modern back handling. dispatchKeyEvent(KEYCODE_BACK) misses the
        // gesture-back on newer Android/phones, so register an
        // OnBackPressedCallback too — it routes Back into the web app's own
        // navigation (player -> list -> ... -> exit at root) via Remote.emit.
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{" +
                    "if(window.console)console.log('[shell] BACK (dispatcher), screen=' + (window.App&&App.activeScreenId?App.activeScreenId():'?'));" +
                    "if(window.Remote&&Remote.emit){Remote.emit('back');}" +
                    "}catch(x){if(window.console)console.log('[shell] back err '+x);}})();",
                    null
                )
            }
        })
    }

    private var lastCanvasScale = 0

    /** Pin the WebView scale so the 1920 px CSS canvas maps onto widthPx real pixels.
     *  A change of 1 % or less is ignored (rounding), so layout noise does nothing. */
    private fun applyCanvasScale(wv: WebView, widthPx: Int, reason: String) {
        if (widthPx <= 0) return
        val scalePercent = Math.round(widthPx.toDouble() / 1920.0 * 100.0).toInt()
        if (scalePercent !in 25..400) return
        if (lastCanvasScale != 0 && Math.abs(scalePercent - lastCanvasScale) <= 1) return
        val firstTime = lastCanvasScale == 0
        lastCanvasScale = scalePercent
        @Suppress("DEPRECATION")
        wv.setInitialScale(scalePercent)
        android.util.Log.d("XtivioWeb", "initialScale=$scalePercent% (widthPx=$widthPx, $reason, target canvas 1920)")
        if (!firstTime) {
            // Make the page pick up the new scale: re-assert the viewport tag, then let the
            // app re-measure (video rect etc.) through a resize event.
            wv.evaluateJavascript(
                "(function(){try{var m=document.querySelector('meta[name=viewport]');if(!m)return;" +
                "var c=m.getAttribute('content');m.setAttribute('content','width=1921, initial-scale=1.0, user-scalable=no');" +
                "setTimeout(function(){m.setAttribute('content',c);" +
                "try{window.dispatchEvent(new Event('resize'));}catch(e){}},60);}catch(e){}})();",
                null
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        // REMOTE DEBUGGING: expose this WebView to Chrome DevTools. With this on,
        // connecting `adb connect <box-ip>:5555` then opening chrome://inspect on
        // a computer shows the box's WebView with full console/network/elements —
        // the Android equivalent of webOS's :9998 inspector. This is the reliable
        // way to debug what the BOX's WebView actually does (the phone-browser
        // devtools on a test domain is a different device and doesn't reflect the
        // box). Safe to ship even on — it only enables inspection for someone
        // with adb access to the device, not the network — but gated to
        // BuildConfig.DEBUG (it must be off in any store/
        // production build) rather than hardcoded true, so this tracks the
        // actual Gradle build type automatically instead of needing to be
        // remembered and hand-toggled before every release build.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true                 // localStorage + IndexedDB
        s.databaseEnabled = true
        s.mediaPlaybackRequiresUserGesture = false // autoplay live streams
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        // CRITICAL for IPTV source loading: the app is served from a file://
        // origin (file:///android_asset/web/). By default, Android's WebView
        // blocks XHR/fetch from a file:// page to remote http(s) servers — so
        // playlists that load fine on webOS/Tizen (which allow it) silently fail
        // to fetch here. These two flags let the file://-hosted app make network
        // requests to the user's IPTV servers, matching the smart-TV behaviour.
        // (Safe here: we load ONLY our own bundled assets into this WebView; no
        // untrusted page is ever loaded, so the classic file:// XHR risk — a
        // malicious local file reading other local files — does not apply.)
        @Suppress("DEPRECATION")
        run {
            s.allowUniversalAccessFromFileURLs = true
            s.allowFileAccessFromFileURLs = true
        }
        s.javaScriptCanOpenWindowsAutomatically = true
        s.setSupportMultipleWindows(false)
        // Pinch-to-zoom (UI zoom) enabled, but WITHOUT the on-screen +/- zoom
        // buttons. setSupportZoom + builtInZoomControls gives pinch gestures;
        // displayZoomControls=false hides the button overlay.
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.cacheMode = WebSettings.LOAD_DEFAULT

        // VIEWPORT FIX (Android TV layout distortion):
        // The web app authors its CSS for a 1920-wide canvas and declares
        // <meta viewport width=1920>. But on some Android TV boxes the WebView
        // reports window.innerWidth as 1280 (or other values) instead of 1920,
        // because the device's density (devicePixelRatio, e.g. 1.5) divides the
        // physical 1920 down (1920 / 1.5 = 1280). The app then sees "1280",
        // assumes the small (720) canvas, and applies its 0.667 down-scale on top
        // of a layout that is already 1920 — double-scaling everything, which is
        // the shifted/shrunken/out-of-proportion rendering we saw.
        //
        // Fix: pin the WebView's initial scale so the declared 1920 CSS canvas
        // maps exactly onto the panel's real pixel width. initialScale is a
        // percentage; (panelWidthPx / 1920) * 100 makes 1920 CSS px == full
        // panel width, so window.innerWidth reports ~1920 and the app runs its
        // native 1920 layout with NO data-vp="720" down-scaling. useWideViewPort
        // stays true so the width=1920 meta is honoured.
        try {
            val metrics = resources.displayMetrics
            applyCanvasScale(wv, metrics.widthPixels, "startup")
        } catch (e: Exception) {
            android.util.Log.d("XtivioWeb", "initialScale calc failed: ${e.message}")
        }
        // The pinned scale above is worked out once, from the display metrics, before
        // the WebView has been laid out. When the window ends up a different width than
        // the metrics say (screen mirroring, a box on a TV, a display change that does
        // not recreate the activity) the 1920 canvas no longer fits and parts of the app
        // sit off screen. Re-work the scale from the WebView's REAL width whenever it
        // changes (including its first layout).
        wv.addOnLayoutChangeListener { v, left, _, right, _, oldLeft, _, oldRight, _ ->
            val w = right - left
            if (w > 0 && w != (oldRight - oldLeft)) {
                v.post { applyCanvasScale(wv, w, "layout") }
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        // Present a Chrome-on-Android UA so isAndroidWebView() matches (the
        // AndroidBridge object is the primary signal; UA is belt-and-braces).
        s.userAgentString = (s.userAgentString ?: "") + " XtivioTV/1.0.12"

        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true

        wv.addJavascriptInterface(AndroidBridge(this, exo, { wv }, { currentWebViewScale }), "AndroidBridge")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                // The app itself never navigates the WebView to a real page —
                // everything it needs (playlists, EPG, streams) is fetched via
                // JS XHR/fetch, not full-page navigation. So the ONLY full-page
                // navigations this WebViewClient ever sees are the donate link,
                // the bug-report mailto:, and the pairing-server URL the web
                // layer turns into a tappable <a> on touch devices — all meant
                // to open OUTSIDE the app (browser / mail client), not replace
                // our own UI inside the WebView. Previously this always
                // returned false, so target="_blank" + rel=noopener links (with
                // multi-window support off) just navigated the app's own
                // WebView to donate.xtivio.vip / a mailto: URI in place,
                // trapping the user on a page with no way back except Android
                // Back. Send http(s)/mailto/tel/sms navigations to the
                // system's own app (Chrome/Mail/Dialer/Messages) via an
                // explicit Intent instead, and swallow file:// (our own
                // assets) so the app's internal navigation is unaffected.
                val uri = request.url
                val scheme = uri?.scheme?.lowercase(java.util.Locale.ROOT)
                if (scheme == "http" || scheme == "https" || scheme == "mailto" ||
                    scheme == "tel" || scheme == "sms"
                ) {
                    try {
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, uri)
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(intent)
                    } catch (e: Exception) {
                        android.util.Log.d("XtivioWeb", "external nav failed: ${e.message}")
                    }
                    return true
                }
                return false
            }

            override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) {
                currentWebViewScale = newScale
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                android.util.Log.d("XtivioWeb", "${msg.message()} @${msg.lineNumber()}")
                return true
            }
        }
    }

    /** Push a native playback event to the web layer's PlayerExo._onNative. */
    private fun dispatchToWeb(evt: String, json: String) {
        // Use JSONObject.quote to produce a fully-escaped JS string literal
        // (handles quotes, backslashes, newlines and other control chars) — a raw
        // newline in an ExoPlayer error message would otherwise break the
        // evaluateJavascript string. quote() returns the value WITH surrounding
        // double-quotes, so we embed it directly.
        // Video size / play state changes: keep the picture-in-picture params (aspect
        // ratio, auto-enter on API 31+) current so Home can shrink the playing video.
        if (evt == "videosize" || evt == "playstate") runOnUiThread { refreshPipParams() }
        val safeEvt = org.json.JSONObject.quote(evt)
        val safeJson = org.json.JSONObject.quote(json)
        val js = "window.PlayerExo && window.PlayerExo._onNative($safeEvt,$safeJson);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                // D-pad navigation — previously left to Android's native
                // focus routing (WebView holds native View focus ->
                // Chromium's own AndroidKeyEvent->DOM translation) — the
                // same dependency the earlier native focus fix targeted.
                // Still broken on two remotes after that fix, so
                // stop depending on that pipeline for these keys too: inject
                // a synthetic DOM keydown directly, exactly like BACK and
                // the media keys above already do. This works regardless of
                // whether the WebView actually holds native focus, and
                // regardless of whether this box's particular WebView build
                // translates D-pad AndroidKeyEvents the way remote.js's own
                // comment assumed it would. Enter/DPAD_CENTER both map to
                // keyCode 13 ('ok' in remote.js's KEY_MAP) rather than 23,
                // since 13 is the canonical/primary entry there.
                KeyEvent.KEYCODE_DPAD_UP -> { injectKey(38); return true }
                KeyEvent.KEYCODE_DPAD_DOWN -> { injectKey(40); return true }
                KeyEvent.KEYCODE_DPAD_LEFT -> { injectKey(37); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { injectKey(39); return true }
                KeyEvent.KEYCODE_DPAD_CENTER -> { injectKey(13); return true }
                KeyEvent.KEYCODE_ENTER -> { injectKey(13); return true }
                KeyEvent.KEYCODE_NUMPAD_ENTER -> { injectKey(13); return true }
                KeyEvent.KEYCODE_BACK -> {
                    // Route Android Back into the web app's own back navigation
                    // (same path the TV remote's Back uses): player -> list ->
                    // ... -> exit only at root. Log so DevTools shows the path.
                    webView.evaluateJavascript(
                        "(function(){try{" +
                        "if(window.console)console.log('[shell] BACK pressed, screen=' + (window.App&&App.activeScreenId?App.activeScreenId():'?'));" +
                        "if(window.Remote&&Remote.emit){Remote.emit('back');}" +
                        "else{var e=new KeyboardEvent('keydown',{keyCode:4,which:4,bubbles:true,cancelable:true});" +
                        "Object.defineProperty(e,'keyCode',{get:function(){return 4;}});document.dispatchEvent(e);}" +
                        "}catch(x){if(window.console)console.log('[shell] back err '+x);}})();",
                        null
                    )
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PLAY -> { injectKey(415); return true }
                KeyEvent.KEYCODE_MEDIA_PAUSE -> { injectKey(19); return true }
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { injectKey(10252); return true }
                KeyEvent.KEYCODE_MEDIA_STOP -> { injectKey(413); return true }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { injectKey(417); return true }
                KeyEvent.KEYCODE_MEDIA_REWIND -> { injectKey(412); return true }
                KeyEvent.KEYCODE_CHANNEL_UP -> { injectKey(427); return true }
                KeyEvent.KEYCODE_CHANNEL_DOWN -> { injectKey(428); return true }
                KeyEvent.KEYCODE_INFO -> { injectKey(457); return true }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** Dispatch a synthetic keydown into the page so remote.js can map it. */
    private fun injectKey(keyCode: Int) {
        val js = "(function(){try{var e=new KeyboardEvent('keydown',{keyCode:$keyCode," +
                "which:$keyCode,bubbles:true,cancelable:true});" +
                "Object.defineProperty(e,'keyCode',{get:function(){return $keyCode;}});" +
                "document.dispatchEvent(e);}catch(err){}})();"
        webView.evaluateJavascript(js, null)
    }

    private fun goImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    // The manifest lists uiMode in configChanges, so a system light/dark switch does
    // not recreate the Activity; tell the web layer so "Follow System" re-evaluates.
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        webView.post {
            webView.evaluateJavascript("window.Theme&&Theme.refresh&&Theme.refresh()", null)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            goImmersive()
            // D-pad navigation didn't work AT ALL
            // on a specific device (a generic Android box running repurposed
            // phone/tablet firmware rather than a proper TV build), confirmed
            // with two different genuine D-pad remotes (the box's own and an
            // LG TV remote via HDMI-CEC), ruling out a remote-hardware
            // explanation. The web-layer JS was verified correct under both
            // touch-detection states via an actual Playwright test — this is
            // native. wv.isFocusable/isFocusableInTouchMode (set at WebView
            // setup) make the WebView ELIGIBLE to receive key-event focus, but
            // nothing ever actually called requestFocus() to ask Android to
            // grant it — eligibility isn't the same as having it. On most
            // devices Android's own initial-focus assignment (finding the
            // best focusable view when an Activity's window gains focus)
            // happens to land on the WebView anyway, in a hierarchy this
            // simple (FrameLayout > WebView) — which would explain why this
            // works on proper Android TV builds without ever being asked for
            // explicitly. Nothing guarantees that automatic assignment
            // succeeds on every device/Android build, and apparently doesn't
            // on this one: if the WebView never actually holds native view
            // focus, dispatchKeyEvent's fallthrough to
            // super.dispatchKeyEvent() has nothing focused to route D-pad
            // events to — they'd be silently swallowed before ever reaching
            // the WebView's JS layer at all, matching "can't navigate
            // anywhere, not even between basic buttons" exactly. Requesting
            // focus explicitly, every time the window gains focus (not just
            // once at startup, since Android can clear view focus when a
            // system dialog/notification shade opens and closes over the
            // Activity), removes the dependency on that automatic assignment
            // entirely.
            webView.requestFocus()
        }
    }

    override fun onPause() {
        super.onPause()
        // Tell the web layer the app is leaving the screen BEFORE the WebView is
        // paused, so a mid-load close is not mistaken for a crash on next launch.
        try {
            webView.evaluateJavascript(
                "window.PerfConfig&&PerfConfig.suspendCrashGuard&&PerfConfig.suspendCrashGuard()", null)
        } catch (_: Exception) {}
        // In picture-in-picture the activity is paused but still on screen: keep the
        // WebView running and the video playing.
        if (!isPip()) {
            webView.onPause()
            exo.pause()
        }
    }

    // ---- Picture-in-picture (Exo playback only). UNCOMPILED: device test needed. ----
    private fun isPip(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode

    private fun canPip(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(): PictureInPictureParams {
        val b = PictureInPictureParams.Builder()
        var w = exo.videoWidth()
        var h = exo.videoHeight()
        if (w <= 0 || h <= 0) { w = 16; h = 9 }
        // Android rejects ratios outside 1:2.39 .. 2.39:1.
        val r = w.toDouble() / h.toDouble()
        val rr = when {
            r > 2.39 -> Rational(239, 100)
            r < 1.0 / 2.39 -> Rational(100, 239)
            else -> Rational(w, h)
        }
        b.setAspectRatio(rr)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setAutoEnterEnabled(exo.isPlayingVideo())
            b.setSeamlessResizeEnabled(false)
        }
        return b.build()
    }

    /** Keep the auto-enter flag and aspect ratio current while a video is playing. */
    fun refreshPipParams() {
        if (!canPip()) return
        try { setPictureInPictureParams(pipParams()) } catch (_: Exception) {}
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Home pressed while a video is playing: shrink to a floating window (API 26-30;
        // on 31+ auto-enter does this and entering twice is harmless).
        if (canPip() && exo.isPlayingVideo() && !isPip()) {
            try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) {}
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (isInPictureInPictureMode) {
            exo.enterPip()
            webView.visibility = View.INVISIBLE      // web UI would be unreadable at this size
        } else {
            webView.visibility = View.VISIBLE
            exo.exitPip()
            goImmersive()
        }
        dispatchToWeb("pip", "{\"active\":$isInPictureInPictureMode}")
    }

    override fun onStop() {
        super.onStop()
        // The PiP window was closed with its X: the activity stops while still "in PiP".
        // Stop playback so audio does not keep running behind nothing.
        if (isPip()) {
            try { exo.pause() } catch (_: Exception) {}
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        refreshPipParams()
        try {
            webView.evaluateJavascript(
                "window.PerfConfig&&PerfConfig.resumeCrashGuard&&PerfConfig.resumeCrashGuard()", null)
        } catch (_: Exception) {}
        goImmersive()
    }

    override fun onDestroy() {
        try { exo.release() } catch (_: Exception) {}
        try {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (_: Exception) {}
        super.onDestroy()
    }

    companion object {
        private const val APP_URL = "file:///android_asset/web/index.html"
    }
}
