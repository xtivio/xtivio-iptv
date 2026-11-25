package com.xtivio.iptv

import android.app.Activity
import android.graphics.Color
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.DefaultHlsExtractorFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory

/**
 * Owns the native ExoPlayer and the SurfaceView it renders into.
 *
 * SURFACE LIFECYCLE (the thing that was broken before):
 * A SurfaceView only has a real underlying Surface while it is VISIBLE and
 * attached. Earlier builds created it View.GONE and called setVideoSurfaceView
 * once — so ExoPlayer was bound to a Surface that never existed (audio decoded,
 * video frames went nowhere = "sound, no picture"). Fix: keep the SurfaceView
 * VISIBLE and drive ExoPlayer's output via SurfaceHolder.Callback — bind the
 * holder in surfaceCreated, clear it in surfaceDestroyed. If play() is called
 * before the surface exists, queue it and start on surfaceCreated.
 *
 * COMPOSITING: the SurfaceView sits at index 0 (behind the WebView). For the
 * video to show through, BOTH the WebView background AND the Activity WINDOW
 * background must be transparent (the window bg is opaque by theme default and
 * otherwise covers the surface). MainActivity sets both. The web layer clears
 * its own backgrounds (punch-through CSS, html[data-exo-active]) during playback
 * so the web overlays paint over the live video. No setZOrderMediaOverlay (that
 * orders one SurfaceView vs another and, with no base surface, punches no hole).
 *
 * All ExoPlayer access is on the main thread; the JS bridge marshals calls here
 * via Activity.runOnUiThread.
 */
@UnstableApi
class ExoController(
    private val activity: Activity,
    private val rootProvider: () -> ViewGroup,
    private val webViewProvider: () -> View,
    private val toWeb: (String, String) -> Unit   // (event, jsonDetail)
) : ExoControllerHandle {

    private var player: ExoPlayer? = null
    /** HLS source factory with the broadcast-TV key frame handling (see createPlayer). Null until a player exists. */
    private var hlsSourceFactory: HlsMediaSource.Factory? = null
    private var surfaceView: SurfaceView? = null
    private var shutterView: View? = null
    private var backingView: View? = null
    private val backingHole = android.graphics.Rect()
    private var isSurfaceReady = false
    // Picture-in-picture bookkeeping. lastRect remembers the confined/scaled rect the web
    // layer asked for (l, t, w, h) and lastRectIsBounds says which call set it, so leaving PiP
    // can put the surface back exactly where it was.
    private var lastRect: IntArray? = null
    private var lastRectIsBounds = false
    private var inPip = false
    private var videoW = 0
    private var videoH = 0
    private var pendingUrl: String? = null
    private var pendingStartMs: Long = 0
    private var pendingLive: Boolean = true
    private var timeTicker: Runnable? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    // ExoPlayer's HTTP User-Agent: generic by default, branded when this is true
    // (see createPlayer). The branded string carries the app version.
    private val EXO_UA_BRANDED = false
    private val EXO_UA_BRAND = "XtivioTV/1.0.13 (ExoPlayer)"

    private fun ensurePlayer() {
        if (player != null) return

        val root = rootProvider()

        // VISIBLE from the start so Android creates the Surface.
        val sv = SurfaceView(activity).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.VISIBLE
        }

        sv.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                isSurfaceReady = true
                player?.setVideoSurfaceHolder(holder)
                // If a play was queued before the surface existed, start it now.
                pendingUrl?.let { url ->
                    val startMs = pendingStartMs
                    pendingUrl = null
                    play(url, startMs, pendingLive)
                }
            }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                isSurfaceReady = false
                player?.clearVideoSurfaceHolder(holder)
            }
        })

        root.addView(sv, 0)   // behind the WebView

        // 4K H.264 streams failed with ERROR_CODE_DECODER_INIT_FAILED even though
        // the device supports the codec (not a hardware/codec capability limit):
        // the previous fix for the
        // stale-frame leak (see stop(), below) called Canvas.lockCanvas()/
        // unlockCanvasAndPost() directly on THIS SAME Surface to blank it.
        // That's a real, self-inflicted regression — locking a software
        // Canvas onto a Surface changes its buffer-producer wiring, and
        // stricter OEM MediaCodec implementations (Samsung/Exynos has a
        // documented history here) can then fail configure() against that
        // same Surface for a subsequent hardware decode session, on ANY
        // candidate codec — which is exactly why enabling decoder fallback
        // didn't help either. Replaced with the same "shutter view" pattern
        // Media3's own PlayerView uses internally (see
        // androidx.media3.ui.PlayerView's onRenderedFirstFrame): a plain
        // opaque View with zero Surface/Canvas involvement, sitting directly
        // above the video SurfaceView, hidden once a real frame is confirmed
        // rendered.
        val shutter = View(activity).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.BLACK)
            visibility = View.VISIBLE
        }
        root.addView(shutter, 1)  // above the video surface, still behind the WebView
        shutterView = shutter
        surfaceView = sv

        // Mini player with ExoPlayer (sound but no picture): the CSS punch-
        // through for the mini player (html[data-exo-mini-active], see
        // screens.css) has to clear the WHOLE ancestor chain (html/body/#app),
        // not just the mini frame — CSS can't reveal what's behind the whole
        // page through a transparent descendant while its ancestors still
        // paint opaque backgrounds underneath it. But clearing the whole
        // chain makes the ENTIRE Live TV screen transparent, not just the
        // small confined mini rect — everywhere else would fall through to
        // whatever's behind the Activity itself (launcher, black) since the
        // SurfaceView is confined to a small rect and doesn't cover the rest.
        // This opaque "backing" view sits above the surface+shutter but below
        // the WebView, paints the normal page backdrop color everywhere, and
        // punches an actual hole (Canvas.clipOutRect) exactly matching the
        // confined video rect — restoring the solid backdrop CSS alone can no
        // longer provide once it's clearing the full chain, while still
        // leaving the real video rect see-through. Only relevant/visible
        // while the mini player is actively confining exo (setBounds());
        // GONE otherwise, including for ordinary fullscreen exo playback,
        // which doesn't use this mechanism at all.
        val backing = object : View(activity) {
            override fun onDraw(canvas: android.graphics.Canvas) {
                if (!backingHole.isEmpty) {
                    if (android.os.Build.VERSION.SDK_INT >= 26) {
                        canvas.clipOutRect(backingHole)
                    } else {
                        @Suppress("DEPRECATION")
                        canvas.clipRect(backingHole, android.graphics.Region.Op.DIFFERENCE)
                    }
                }
                drawGradientBackdrop(canvas, width, height)
            }
        }.apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
        }
        root.addView(backing, 2)  // above surface+shutter, still behind the WebView
        backingView = backing

        createPlayer(desiredLive)
    }

    /** Which buffering profile the CURRENT player was built with, and which one
     *  the next play() wants. A DefaultLoadControl cannot be changed once built, so
     *  switching between live TV and VOD rebuilds the ExoPlayer instance (the views
     *  and surface are kept). Zapping between live channels never rebuilds. */
    private var playerLive = true
    private var desiredLive = true

    /** "Playback buffer" setting, in seconds (0 = standard profile). It is fixed into the
     *  LoadControl when the player is built, so a change takes effect on the next play(),
     *  which rebuilds the ExoPlayer instance (views and surface stay). */
    private var bufferReserveSec = 0
    private var builtReserveSec = 0

    override fun setBufferReserve(seconds: Int) {
        bufferReserveSec = if (seconds < 0) 0 else if (seconds > 120) 120 else seconds
    }

    /** "Match frame rate" setting: 0 = off, 1 = only when the display can change rate without a blank
     *  screen (what ExoPlayer did before this setting existed, so it is the default), 2 = always: the
     *  display mode is switched to one that matches the video (a 24, 25 or 50 Hz mode for 24, 25 or 50
     *  fps), which can blank the screen for a second on some TVs. Applied from the next play(). */
    private var afrMode = 1
    private var modeSwitched = false
    private var measuring = false
    private val fpsSamples = LongArray(64)
    private var fpsCount = 0

    override fun setFrameRateMatching(mode: Int) {
        afrMode = if (mode < 0) 0 else if (mode > 2) 2 else mode
    }

    private val FPS_STANDARD = floatArrayOf(23.976f, 24f, 25f, 29.97f, 30f, 48f, 50f, 59.94f, 60f, 119.88f, 120f)

    /** The nearest broadcast rate when the value is within 2% of one, so 23.98 and 24.0 both read as a
     *  real rate and a measured 24.97 becomes 25. Anything else is returned unchanged. */
    private fun snapFps(f: Float): Float {
        var best = f
        var bestErr = 0.02f
        for (c in FPS_STANDARD) {
            val e = Math.abs(f - c) / c
            if (e < bestErr) { bestErr = e; best = c }
        }
        return best
    }

    /** Frame times of the pictures about to be shown, used to measure the rate when the stream does not
     *  declare it (most live MPEG-TS). Runs on the playback thread, so it only stores a number. */
    private val frameListener = androidx.media3.exoplayer.video.VideoFrameMetadataListener { presentationTimeUs, _, _, _ ->
        if (measuring && fpsCount < fpsSamples.size) {
            fpsSamples[fpsCount++] = presentationTimeUs
            if (fpsCount == fpsSamples.size) handler.post { finishMeasure() }
        }
    }

    private fun startMeasure(p: ExoPlayer) {
        if (measuring) return
        fpsCount = 0
        measuring = true
        try { p.setVideoFrameMetadataListener(frameListener) } catch (e: Exception) { measuring = false }
    }

    private fun stopMeasure() {
        measuring = false
        fpsCount = 0
        try { player?.clearVideoFrameMetadataListener(frameListener) } catch (e: Exception) {}
    }

    private fun finishMeasure() {
        if (!measuring) return
        val n = fpsCount
        val t = fpsSamples.copyOf(n)
        stopMeasure()
        if (n < 16) return
        t.sort()
        val d = LongArray(n - 1) { t[it + 1] - t[it] }
        d.sort()
        val median = d[d.size / 2]
        if (median <= 0L) return
        deliverFps(1_000_000f / median.toFloat(), true)
    }

    private fun deliverFps(raw: Float, measured: Boolean) {
        if (raw <= 0f) return
        val fps = snapFps(raw)
        toWeb("videofps", "{\"fps\":$fps,\"measured\":$measured}")
        if (afrMode == 2) applyDisplayMode(fps)
    }

    /** Frame rate the stream declares, else measure it from the first pictures. */
    private fun reportFrameRate(p: ExoPlayer) {
        val declared = p.videoFormat?.frameRate ?: -1f
        if (declared > 0f) { stopMeasure(); deliverFps(declared, false) } else startMeasure(p)
    }

    /** "Always" mode: ask the display for the mode of the same size whose refresh rate is the closest whole
     *  multiple of the video's rate (24 fps -> 24 Hz, else 48 or 120). Nothing happens when no mode is within
     *  1%, or the display is already in it. The window's preferred mode is put back when playback stops. */
    private fun applyDisplayMode(fps: Float) {
        handler.post {
            try {
                val window = activity.window ?: return@post
                @Suppress("DEPRECATION")
                val display = if (android.os.Build.VERSION.SDK_INT >= 30) activity.display else window.windowManager.defaultDisplay
                if (display == null) return@post
                val cur = display.mode
                var best: android.view.Display.Mode? = null
                var bestErr = Float.MAX_VALUE
                var bestK = Int.MAX_VALUE
                for (m in display.supportedModes) {
                    if (m.physicalWidth != cur.physicalWidth || m.physicalHeight != cur.physicalHeight) continue
                    val k = Math.round(m.refreshRate / fps)
                    if (k < 1 || k > 5) continue
                    val err = Math.abs(m.refreshRate - k * fps) / fps
                    if (err < bestErr - 0.0005f || (Math.abs(err - bestErr) <= 0.0005f && k < bestK)) { best = m; bestErr = err; bestK = k }
                }
                if (best == null || bestErr > 0.01f || best.modeId == cur.modeId) return@post
                val lp = window.attributes
                lp.preferredDisplayModeId = best.modeId
                window.attributes = lp
                modeSwitched = true
            } catch (e: Exception) {
                android.util.Log.d("XtivioWeb", "display mode switch failed: ${e.message}")
            }
        }
    }

    private fun restoreDisplayMode() {
        if (!modeSwitched) return
        modeSwitched = false
        handler.post {
            try {
                val lp = activity.window.attributes
                lp.preferredDisplayModeId = 0
                activity.window.attributes = lp
            } catch (e: Exception) {}
        }
    }

    /** Buffer sizes for a chosen reserve of `sec` seconds. The byte cap wins over the time
     *  target (prioritizeTimeOverSizeThresholds = false), and it is a fraction of the
     *  app's heap class, so a high-bitrate stream on a small device simply buffers fewer
     *  seconds than asked instead of running the app out of memory. Start-up stays fast
     *  (bufferForPlaybackMs is unchanged); after a stall it waits for more media. */
    private fun reserveLoadControl(live: Boolean, sec: Int): DefaultLoadControl {
        val ms = sec * 1000
        val am = activity.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val capBytes = (am.memoryClass.toLong() * 1048576L / 4L)
            .coerceIn(24L * 1048576L, 96L * 1048576L).toInt()
        val afterStall = (ms / 4).coerceIn(3000, 10000)
        val b = DefaultLoadControl.Builder()
            .setBufferDurationsMs(ms, ms, if (live) 150 else 1000, afterStall)
            .setTargetBufferBytes(capBytes)
            .setPrioritizeTimeOverSizeThresholds(false)
        if (!live) b.setBackBuffer(30000, true)
        return b.build()
    }

    private fun createPlayer(live: Boolean) {
        playerLive = live
        builtReserveSec = bufferReserveSec
        // 4K H.264 decoder failure (ERROR_CODE_DECODER_INIT_FAILED
        // with format_supported=YES): ExoPlayer.Builder(activity).build() alone
        // uses a DefaultRenderersFactory with decoder fallback OFF. On some
        // devices — Samsung/Exynos MediaCodec implementations are the most
        // commonly reported case — MediaCodecUtil's static capability query
        // says a format IS supported, the first-choice hardware decoder gets
        // selected, and its actual MediaCodec.configure() call then fails
        // anyway for that specific stream. Without fallback enabled, that
        // failure is immediately fatal — ExoPlayer never tries the next
        // candidate decoder for the same MIME type (e.g. a secondary hardware
        // decoder entry, or the software c2.android.avc.decoder), even though
        // one might actually work. This is a well-documented, known gap (see
        // e.g. google/ExoPlayer#9396, #9644; flutter/packages#12837) with an
        // official opt-in fix: enable fallback so a bad first candidate isn't
        // the end of the road.
        val renderersFactory = DefaultRenderersFactory(activity)
            .setEnableDecoderFallback(true)
            // FFmpeg audio extension (AC3/EAC3/DTS/TrueHD/etc — codecs AOSP
            // ships no MediaCodec decoder for on most devices at all, not
            // just a compatibility gap): EXTENSION_RENDERER_MODE_ON prefers
            // the platform MediaCodec decoder when one exists and only falls
            // back to FfmpegAudioRenderer when it doesn't, rather than
            // PREFER (which would use FFmpeg even when hardware/software
            // MediaCodec decode is already available and working). Safe to
            // enable unconditionally regardless of whether the FFmpeg module
            // is actually linked yet (see the build
            // script) — with no FfmpegAudioRenderer present to find, this is
            // a no-op; MediaCodec-only playback is completely unaffected.
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)

        // No HTTP configuration at all previously — ExoPlayer's
        // native network requests are a completely separate stack from the
        // WebView's (the "XtivioTV/<version>" UA appended in MainActivity only
        // covers the WebView's own JS-side XHR/fetch calls, never touches
        // this). Three real gaps for the IPTV-panel use case specifically:
        //  - No custom User-Agent: some panels allow/block by UA, and
        //    ExoPlayer's raw request looked nothing like what a sibling app
        //    or the WebView itself sends.
        //  - Cross-protocol redirects (http->https or vice versa) were
        //    BLOCKED by default — ExoPlayer refuses these unless explicitly
        //    allowed, and IPTV panels commonly redirect to a different CDN
        //    across protocols.
        //  - Default connect/read timeouts are 8s each — short for the
        //    flaky/slow shared-VPS panels this app talks to. The JS side
        //    already budgets much longer for exactly this reason (e.g.
        //    hls.js's manifestLoadingMaxRetryTimeout: 20000); the native
        //    layer had no equivalent allowance.
        // User-Agent: a packet capture of an app that plays a token-protected
        // live .ts link which Xtivio could not showed identical headers
        // (Icy-MetaData, Accept-Encoding: identity, Keep-Alive) except the UA,
        // "Player (Linux; Android 16)". Panels that lock a token to, or allow-list,
        // the requesting UA reject the unknown "XtivioTV/..." string. So ExoPlayer
        // now sends that generic player UA. EXO_UA_BRANDED is the one-line switch
        // back to the branded string.
        val exoUserAgent = if (EXO_UA_BRANDED) EXO_UA_BRAND
            else "Player (Linux; Android " + android.os.Build.VERSION.RELEASE + ")"
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(exoUserAgent)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(15000)
        // Broadcast-derived H.264 (most IPTV) often starts its pictures with a plain I-frame, not an IDR
        // frame, and has no recovery-point markers. ExoPlayer's default only treats IDR frames as places
        // to start, so such a stream sat on "loading" forever with no error (VLC and mpv start on the
        // I-frame). Treat I-frames as key frames, for MPEG-TS read directly and for HLS segments.
        val tsFlags = DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or
            DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS
        val mediaSourceFactory = DefaultMediaSourceFactory(
            activity, DefaultExtractorsFactory().setTsExtractorFlags(tsFlags)
        ).setDataSourceFactory(httpDataSourceFactory)
        hlsSourceFactory = HlsMediaSource.Factory(httpDataSourceFactory)
            .setExtractorFactory(DefaultHlsExtractorFactory(tsFlags, false))

        // INVESTIGATION (Xtivio buffers more than other IPTV apps on the same
        // network/stream): no custom LoadControl was ever set, so the default
        // applied. My first assumption — that a large default
        // bufferForPlaybackAfterRebufferMs was the culprit — turned out to be
        // wrong once actually checked against the version in use here
        // (media3 1.11.0): that default is already a fairly snappy 2000ms.
        // What actually stood out: the default minBufferMs/maxBufferMs are
        // BOTH 50000 — ExoPlayer continuously tries to hold a full 50 SECONDS
        // of buffered media at all times, network permitting. That's a VOD-
        // sized buffer window applied uniformly to live TV too (this app has
        // no separate config per content type). For an unbounded live
        // progressive TS source specifically, a 50s buffer target means the
        // player keeps eagerly downloading and holding far more data than a
        // live viewer needs, which both wastes bandwidth/memory AND lets
        // actual playback drift further behind the true live edge the longer
        // you watch (nothing forces it back closer once it's happily sitting
        // on a big buffer) — which reads exactly like "buffers more than
        // other apps" even though no single rebuffer event is individually
        // slower. Capping the buffer window is standard practice for
        // ExoPlayer live streaming specifically; keeping it here uniformly is
        // fine for VOD too (15s of lookahead is still plenty smooth).
        // Two profiles (a LoadControl is fixed once built, see playerLive above).
        //  - LIVE (progressive .ts, live HLS handed to exo): the small 15 s ceiling
        //    stops the player drifting behind the live edge. Start fast (0.8 s) but
        //    resume after a stall only once 3 s is buffered: resuming at 1.5 s on a
        //    marginal connection just stalls again (visible stutter loop).
        //  - VOD (MKV/AVI/HEVC over HTTP): a deeper 40 s lookahead absorbs a slow
        //    panel's hiccups without stalling, resume after a stall at 4 s, and keep
        //    30 s of already-played media so the rewind button does not re-download.
        // The time thresholds win over the size cap (prioritizeTimeOverSize default),
        // and the VOD minimum (15 s) is the same lookahead the old single profile
        // held at its maximum, so peak memory for high-bitrate files does not grow.
        val loadControl = if (bufferReserveSec > 0) {
            reserveLoadControl(live, bufferReserveSec)
        } else if (live) {
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    8000,   // minBufferMs
                    15000,  // maxBufferMs
                    150,    // bufferForPlaybackMs (was 800: live starts sooner)
                    3000    // bufferForPlaybackAfterRebufferMs (was 1500)
                )
                .build()
        } else {
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    15000,  // minBufferMs
                    40000,  // maxBufferMs
                    1000,   // bufferForPlaybackMs (was 1500)
                    2000    // bufferForPlaybackAfterRebufferMs (was 4000)
                )
                .setBackBuffer(30000, true)   // keep 30 s behind the playhead for rewind
                .build()
        }

        val exo = ExoPlayer.Builder(activity, renderersFactory, mediaSourceFactory)
            .setLoadControl(loadControl)
            .build()
        // Match frame rate: Off sends the display no hint; Seamless and Always let the platform switch when it can
        // do so without a blank screen (Always then also picks a display mode itself, see applyDisplayMode).
        exo.setVideoChangeFrameRateStrategy(
            if (afrMode == 0) androidx.media3.common.C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF
            else androidx.media3.common.C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS
        )

        // No audio focus handling at all — another app's audio
        // (or a phone call) would keep getting talked over by Xtivio instead
        // of Xtivio ducking/pausing, and Xtivio never paused for calls either.
        // USAGE_MEDIA is required for handleAudioFocus=true (media3 throws for
        // any other usage).
        exo.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            /* handleAudioFocus= */ true
        )
        // Unplugging headphones/disconnecting Bluetooth didn't
        // pause playback — audio would suddenly blast out the speaker. This
        // is standard, official Android guidance for any video/audio player.
        exo.setHandleAudioBecomingNoisy(true)

        // If the surface already exists at this point, bind it immediately.
        val existing = surfaceView?.holder?.surface
        if (existing != null && existing.isValid) {
            isSurfaceReady = true
            surfaceView?.holder?.let { exo.setVideoSurfaceHolder(it) }
        }

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_BUFFERING -> toWeb("buffering", "{\"buffering\":true}")
                    Player.STATE_READY -> {
                        toWeb("buffering", "{\"buffering\":false}")
                        toWeb("ready", "{}")
                    }
                    Player.STATE_ENDED -> toWeb("ended", "{}")
                    Player.STATE_IDLE -> { /* stopped */ }
                }
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // Tell the web layer the real play/pause state: it only guessed it
                // from its own button presses, so a pause it didn't cause (audio
                // focus lost to another app) left the overlay showing the wrong
                // icon, and the first press seemed to do nothing.
                toWeb("playstate", "{\"paused\":${!playWhenReady}}")
            }
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                // Picture size for the web layer's video scaling (the rect it
                // computes depends on the aspect ratio). Width is corrected for
                // non-square pixels.
                val w = Math.round(videoSize.width * videoSize.pixelWidthHeightRatio)
                videoW = w
                videoH = videoSize.height
                toWeb("videosize", "{\"width\":$w,\"height\":${videoSize.height}}")
                reportFrameRate(exo)
            }
            override fun onRenderedFirstFrame() {
                // The actual signal a real video frame is on screen — hide the
                // shutter (see ensurePlayer() above). More precise than
                // STATE_READY, which can fire a frame or two early.
                shutterView?.visibility = View.GONE
            }
            override fun onPlayerError(error: PlaybackException) {
                shutterView?.visibility = View.VISIBLE   // never leave a kept frame behind an error
                val msg = (error.errorCodeName + ": " + (error.message ?: "error"))
                    .replace("\"", "'")
                // DIAGNOSTIC (for a 4K decoder-init
                // failure that survived enableDecoderFallback): dump every
                // codec this device actually reports for video/avc, so we can
                // see empirically whether fallback had a second candidate to
                // try at all, or whether every listed codec caps out below
                // this stream's resolution — rather than guessing further.
                // Sent through the same toWeb("error", ...) channel so it
                // lands in the chrome://inspect console already being used,
                // no adb/logcat needed.
                var codecDump = ""
                if (error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED) {
                    codecDump = dumpCodecsFor("video/avc")
                }
                val fullMsg = (msg + (if (codecDump.isNotEmpty()) " || CODECS: $codecDump" else ""))
                    .replace("\"", "'")
                toWeb("error", "{\"detail\":\"$fullMsg\"}")
            }

            // MKV/AVI (and
            // other content ExoController handles that the WebView can't)
            // previously had no audio-track picker support at all — the
            // WebView's own <video> element never sees this content, since
            // it renders on a native SurfaceView behind it (see the class doc
            // comment above). onTracksChanged is the standard Media3 signal
            // that the current media's track set is known/changed; sending
            // it here, through the exact same toWeb(event, json) pipe every
            // other native event already uses (buffering/ready/ended/error
            // above), rather than inventing a new native<->web channel.
            //
            // RISK NOTE (this method has not been compiled or run — no
            // Android toolchain in the environment that wrote it): the
            // specific API surface used here — Tracks.Group.mediaTrackGroup,
            // Tracks.Group.isTrackSelected(i), Format.language/label — is
            // standard, stable Media3 (non-@UnstableApi) as of the
            // media3_version pinned in build.gradle, but if this fails to
            // compile, this function and setAudioTrack() below (which uses
            // the matching TrackSelectionOverride/TrackSelectionParameters
            // API) are the first and only place to look — nothing elsewhere
            // in this file depends on them.
            override fun onTracksChanged(tracks: Tracks) {
                // A kept last frame (direct zap, see play()) must not stay up behind a stream
                // that has no video: radio, or video the device cannot decode.
                if (!tracks.isTypeSelected(androidx.media3.common.C.TRACK_TYPE_VIDEO) && tracks.groups.isNotEmpty()) {
                    shutterView?.visibility = View.VISIBLE
                }
                sendAudioTracks(tracks)
                reportUnplayableVideo(tracks)
            }
        })
        player = exo
        playerLive = live
    }

    /* The file has a video track but the device can play none of its video
     * tracks (no decoder for that codec, or the container's codec id is one
     * ExoPlayer cannot map). ExoPlayer does NOT raise an error for this: it
     * quietly skips the video and plays the sound, which is the sound-only
     * symptom. Tell the web layer once per play, with the codec name and size,
     * so it can show the real reason instead of a blank screen. */
    private var noVideoReported = false
    private fun reportUnplayableVideo(tracks: Tracks) {
        if (noVideoReported) return
        var hasVideo = false
        var selected = false
        var desc = ""
        for (group in tracks.groups) {
            if (group.type != androidx.media3.common.C.TRACK_TYPE_VIDEO) continue
            for (i in 0 until group.length) {
                hasVideo = true
                if (group.isTrackSelected(i)) selected = true
                if (desc.isEmpty()) {
                    val f = group.getTrackFormat(i)
                    desc = (f.sampleMimeType ?: f.codecs ?: "unknown") + " " + f.width + "x" + f.height
                }
            }
        }
        if (hasVideo && !selected) {
            noVideoReported = true
            toWeb("error", "{\"detail\":\"ERROR_CODE_DECODING_FORMAT_UNSUPPORTED: no playable video track (" +
                desc.replace("\"", "'") + ")\"}")
        }
    }

    /* Flattens every AUDIO-type track across every track group into a single
     * JSON array, sent to the web layer as-is (PlayerExo._onNative caches it;
     * see that file's own comment). index is 0-based across ALL audio tracks
     * in encounter order — the SAME order setAudioTrack() below walks — so an
     * index the web layer was given always means the same track here, even
     * though a real device's tracks are not guaranteed to start audio
     * numbering at 0 the way this flat list does (video/text tracks can sit
     * at lower indices in the player's own numbering; that mismatch is
     * exactly the bug already found and fixed once on the Tizen/avplay side
     * of this same feature — see player.js's onSelect comment — so this
     * flattens on purpose rather than exposing the player's raw indices). */
    private fun sendAudioTracks(tracks: Tracks) {
        val arr = org.json.JSONArray()
        var idx = 0
        for (group in tracks.groups) {
            if (group.type != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                val format = group.getTrackFormat(i)
                val obj = org.json.JSONObject()
                obj.put("index", idx)
                obj.put("language", format.language ?: "")
                obj.put("label", format.label ?: "")
                obj.put("selected", group.isTrackSelected(i))
                arr.put(obj)
                idx++
            }
        }
        toWeb("audioTracks", arr.toString())
    }

    /* Select one of the flat audio-track indices sendAudioTracks() reported.
     * Re-derives the CURRENT tracks fresh from the player rather than reusing
     * any stored list, and walks them in the identical order sendAudioTracks
     * uses, so the two can never drift out of sync with each other even if
     * called well after the track list was last reported. A TrackSelectionOverride
     * is keyed by the specific TrackGroup instance from THIS snapshot, so
     * this is safe to call any time after tracks are known; an index beyond
     * what currently exists (e.g. a stale value from a just-ended stream) is
     * simply a no-op, never a crash. */
    override fun setAudioTrack(index: Int) {
        val p = player ?: return
        val tracks = p.currentTracks
        var idx = 0
        for (group in tracks.groups) {
            if (group.type != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                if (idx == index) {
                    val override = TrackSelectionOverride(group.mediaTrackGroup, i)
                    p.trackSelectionParameters = p.trackSelectionParameters
                        .buildUpon()
                        .setOverrideForType(override)
                        .build()
                    return
                }
                idx++
            }
        }
    }

    /** Old entry point (no content-type flag): keeps the live profile, which is what
     *  every call used before the live/VOD split. */
    override fun play(url: String, startMs: Long) {
        play(url, startMs, true)
    }

    override fun play(url: String, startMs: Long, live: Boolean) {
        desiredLive = live
        ensurePlayer()
        // Switching between live and VOD needs the other buffering profile: rebuild
        // the player instance (views and surface stay; only the ExoPlayer changes).
        if (player != null && (playerLive != live || builtReserveSec != bufferReserveSec)) {
            stopTicker()
            player?.release()
            player = null
            createPlayer(live)
        }
        val p = player ?: return

        // Clear any audio-track override left from a PREVIOUS stream before
        // starting this one. A TrackSelectionOverride is keyed by the
        // specific TrackGroup instance it was built against, so one from
        // different content simply wouldn't match anything here and would
        // already be harmless — but re-tuning to the SAME channel/content
        // reuses matching TrackGroup identities, where a stale override
        // could otherwise silently force last time's track again instead of
        // the stream's own default. Cheap and unconditional, so this never
        // depends on remembering to clear it from any one specific call site.
        p.trackSelectionParameters = p.trackSelectionParameters
            .buildUpon()
            .clearOverridesOfType(androidx.media3.common.C.TRACK_TYPE_AUDIO)
            .build()

        // Re-arm the shutter for THIS transition too, not just stop()'s: a
        // direct channel-to-channel switch calls play() again without a
        // separate stop() in between, and without this the previous channel's
        // last frame would sit on screen through the new stream's buffering
        // gap — the same leak stop() guards against, just via a different path.
        // On a direct channel-to-channel switch (a picture is on screen and the player
        // is active) keep the last frame instead of the black shutter, so zapping shows the old
        // channel until the new picture arrives. Everything else (first play, after stop(), a
        // player that is idle) keeps the shutter. onTracksChanged puts it back if the new stream
        // turns out to have no video (radio), and onPlayerError does too.
        val directSwitch = shutterView?.visibility == View.GONE &&
            p.playbackState != Player.STATE_IDLE && p.playbackState != Player.STATE_ENDED
        if (!directSwitch) shutterView?.visibility = View.VISIBLE

        // Queue if the surface isn't ready yet; surfaceCreated will replay it.
        if (!isSurfaceReady) {
            pendingUrl = url
            pendingStartMs = startMs
            pendingLive = live
            return
        }

        // setMediaItem() below replaces the queue and resets the position by itself, so
        // the extra stop()/clearMediaItems() only tore the decoder down and forced a new MediaCodec
        // start for every zap. Kept for the idle / ended cases and when the surface was lost.
        if (!directSwitch) {
            p.stop()
            p.clearMediaItems()
        }
        // With a reserve chosen, ask live HLS to play that far behind the live edge so the
        // reserve exists to be filled (ExoPlayer clamps it to the stream's own window and
        // eases the speed by up to 3% to reach it). Progressive TS and VOD ignore this.
        val item = if (bufferReserveSec > 0 && live) {
            MediaItem.Builder()
                .setUri(url)
                .setLiveConfiguration(
                    MediaItem.LiveConfiguration.Builder()
                        .setTargetOffsetMs(bufferReserveSec * 1000L)
                        .build()
                )
                .build()
        } else {
            MediaItem.fromUri(url)
        }
        noVideoReported = false
        val hlsFactory = hlsSourceFactory
        if (hlsFactory != null && Regex("\\.m3u8(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(url)) {
            p.setMediaSource(hlsFactory.createMediaSource(item))
        } else {
            p.setMediaItem(item)
        }
        p.setPlaybackSpeed(1f)  // a new video always starts at normal speed (the page resets its Speed label too)
        p.prepare()
        if (startMs > 0) p.seekTo(startMs)
        p.playWhenReady = true
        startTicker()
    }

    /** Lists every codec this device reports for [mimeType] (hardware/software,
     *  and — where the platform exposes it — the actual supported resolution
     *  range), so a decoder-init failure can be cross-checked against reality
     *  instead of guessed at. Best-effort: wrapped in try/catch per-entry since
     *  capability queries can themselves throw on odd OEM codec entries. */
    /**
     * Approximates #app's CSS background (main.css) for the backing view —
     * two soft radial glows over a vertical linear gradient — instead of the
     * flat --bg-0 color it used before. That flat color was a real, visible
     * regression: the intended gradient is a deliberate part of the app's
     * visual design, and losing it specifically whenever the mini player
     * uses exo was conspicuous enough to plausibly read as a bug once live.
     *
     * Not pixel-perfect — CSS's radial-gradient(<lengthX> <lengthY> at
     * <x%> <y%>, ...) elliptical two-axis sizing has no direct Android
     * equivalent (RadialGradient is circular, single radius); approximated
     * here via a circular gradient with a Matrix that stretches it into an
     * ellipse with the right aspect ratio. Close visual match, not a
     * byte-for-byte reproduction of the CSS rendering.
     *
     * CSS source values (main.css #app), scaled from CSS px to device px
     * with the same panelWidthPx/1920 factor MainActivity's own
     * setInitialScale already establishes as canonical for this app (see
     * AndroidBridge.exoSetBounds's doc) — NOT devicePixelRatio, which
     * doesn't apply here:
     *   radial-gradient(1200px 800px at 12% -10%,  rgba(124,92,255,0.15), transparent 60%),
     *   radial-gradient(900px  700px at 110% 110%, rgba(58,209,255,0.08), transparent 55%),
     *   linear-gradient(180deg, #0c1020 0%, #080c18 100%)
     */
    private val cssPxScale: Float by lazy {
        val panelW = activity.resources.displayMetrics.widthPixels.toFloat()
        if (panelW > 0f) panelW / 1920f else 1f
    }

    private fun drawGradientBackdrop(canvas: android.graphics.Canvas, w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        val basePaint = android.graphics.Paint()
        basePaint.shader = android.graphics.LinearGradient(
            0f, 0f, 0f, h.toFloat(),
            0xFF0C1020.toInt(), 0xFF080C18.toInt(),
            android.graphics.Shader.TileMode.CLAMP
        )
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), basePaint)

        drawEllipticalGlow(
            canvas, w, h,
            cxFrac = 0.12f, cyFrac = -0.10f,
            rxCss = 1200f, ryCss = 800f,
            color = android.graphics.Color.argb(38, 124, 92, 255)
        )
        drawEllipticalGlow(
            canvas, w, h,
            cxFrac = 1.10f, cyFrac = 1.10f,
            rxCss = 900f, ryCss = 700f,
            color = android.graphics.Color.argb(20, 58, 209, 255)
        )
    }

    private fun drawEllipticalGlow(
        canvas: android.graphics.Canvas, w: Int, h: Int,
        cxFrac: Float, cyFrac: Float, rxCss: Float, ryCss: Float, color: Int
    ) {
        val cx = w * cxFrac
        val cy = h * cyFrac
        val rx = rxCss * cssPxScale
        val ry = ryCss * cssPxScale
        if (rx <= 0f || ry <= 0f) return
        val shader = android.graphics.RadialGradient(
            0f, 0f, rx,
            intArrayOf(color, android.graphics.Color.TRANSPARENT),
            floatArrayOf(0f, 1f),
            android.graphics.Shader.TileMode.CLAMP
        )
        // Gradient is defined circular at the local origin, then squashed
        // vertically to the right rx:ry aspect ratio and moved to (cx, cy) —
        // keeps the actual drawRect() below simple (just the view's own
        // bounds, no oversized-rect workaround needed for transform pivots).
        val matrix = android.graphics.Matrix()
        matrix.setScale(1f, ry / rx)
        matrix.postTranslate(cx, cy)
        shader.setLocalMatrix(matrix)
        val paint = android.graphics.Paint()
        paint.shader = shader
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
    }

    private fun dumpCodecsFor(mimeType: String): String {
        val out = StringBuilder()
        try {
            val infos = MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
            for (info in infos) {
                if (info.isEncoder) continue
                val types = try { info.supportedTypes } catch (e: Exception) { emptyArray<String>() }
                if (!types.any { it.equals(mimeType, ignoreCase = true) }) continue
                val hw = try {
                    if (android.os.Build.VERSION.SDK_INT >= 29) info.isHardwareAccelerated else true
                } catch (e: Exception) { null }
                var resRange = "?"
                try {
                    val caps = info.getCapabilitiesForType(mimeType)
                    val vc = caps.videoCapabilities
                    if (vc != null) {
                        resRange = "w[${vc.supportedWidths.lower}-${vc.supportedWidths.upper}]" +
                            " h[${vc.supportedHeights.lower}-${vc.supportedHeights.upper}]"
                    }
                } catch (e: Exception) { /* some entries refuse this query for this mime */ }
                out.append(info.name).append("(hw=").append(hw).append(" ").append(resRange).append(") ")
            }
        } catch (e: Exception) {
            out.append("codec-list-query-failed:").append(e.message)
        }
        return out.toString().trim()
    }

    override fun stop() {
        stopTicker()
        // Clear any queued play so that if the user hit Back before the surface
        // was created, playback doesn't spontaneously start when surfaceCreated
        // fires later.
        pendingUrl = null
        player?.let {
            it.playWhenReady = false
            it.stop()
            it.clearMediaItems()
        }
        // Leak: a SurfaceView's Surface is a persistent buffer — it
        // keeps showing the last decoded frame after ExoPlayer.stop() until
        // something new is drawn to it. Since we deliberately keep the
        // SurfaceView VISIBLE (see comment below), that stale frame was
        // bleeding through any WebView layer that wasn't fully opaque above
        // it (e.g. the mini-player's "Stream unavailable" state), painting
        // over the UI. Re-arm the shutter view (see ensurePlayer()) instead of
        // touching the Surface's own pixels — covers the same stale frame
        // without any Canvas/Surface interaction that could disturb the next
        // MediaCodec session (see the decoder-init regression this
        // replaced).
        videoW = 0
        videoH = 0
        stopMeasure()
        restoreDisplayMode()
        shutterView?.visibility = View.VISIBLE
        // Safety net: if stop() is what ends a mini-player session (rather
        // than going through clearBounds() via stopExoBoundsTracking()),
        // don't leave the backing view sitting there opaque.
        backingHole.setEmpty()
        backingView?.visibility = View.GONE
        // Do NOT hide the SurfaceView — keeping it VISIBLE preserves the Surface
        // so the next play has a valid output handle.
    }

    /** Keeps pitch at normal (PlaybackParameters pitch 1) so faster or slower speech does not change voice. */
    override fun setSpeed(speed: Float) { player?.setPlaybackSpeed(speed.coerceIn(0.25f, 2f)) }

    override fun pause() { player?.playWhenReady = false }
    override fun resume() { player?.playWhenReady = true }

    override fun seekRelative(deltaMs: Long) {
        val p = player ?: return
        val dur = p.duration
        var target = p.currentPosition + deltaMs
        if (target < 0) target = 0
        if (dur > 0 && target > dur) target = dur
        p.seekTo(target)
        pushTime(target)
    }

    /** Tell the web layer the position (and duration) right now. The 1 s ticker
     *  only reports while playing, so a seek made while PAUSED left the elapsed
     *  time and seek bar on the old position until play was pressed. */
    private fun pushTime(posMs: Long) {
        val p = player ?: return
        val dur = if (p.duration > 0) p.duration else 0
        toWeb("time", "{\"positionMs\":$posMs,\"durationMs\":$dur}")
    }

    override fun seekTo(absoluteMs: Long) {
        val p = player ?: return
        val dur = p.duration
        var target = absoluteMs
        if (target < 0) target = 0
        if (dur > 0 && target > dur) target = dur
        p.seekTo(target)
        pushTime(target)
    }

    /** See AndroidBridge.exoSetBounds's doc for why this exists (mini player +
     *  exo). Applies the same rect to both the SurfaceView and the shutter
     *  view so they stay aligned — the shutter still needs to cover exactly
     *  the visible video area, not the old fullscreen one. */
    override fun setBounds(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int) {
        val sv = surfaceView ?: return
        val sh = shutterView
        val w = if (widthPx > 0) widthPx else 1
        val h = if (heightPx > 0) heightPx else 1
        lastRect = intArrayOf(leftPx, topPx, w, h)
        lastRectIsBounds = true
        if (inPip) return
        val svLp = FrameLayout.LayoutParams(w, h)
        svLp.leftMargin = leftPx
        svLp.topMargin = topPx
        svLp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
        sv.layoutParams = svLp
        // Defensive belt-and-suspenders: View.setLayoutParams() already
        // triggers a layout pass internally, but an explicit requestLayout()
        // costs nothing and rules out any coalesced/skipped-request edge case
        // as a factor if bounds still don't visibly apply.
        sv.requestLayout()
        if (sh != null) {
            val shLp = FrameLayout.LayoutParams(w, h)
            shLp.leftMargin = leftPx
            shLp.topMargin = topPx
            shLp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
            sh.layoutParams = shLp
            sh.requestLayout()
        }
        // See ensurePlayer()'s backing-view comment: makes the backdrop
        // visible with a hole punched exactly at this rect, restoring the
        // solid page background the CSS alone can no longer provide now that
        // it clears the whole ancestor chain for the mini player.
        backingHole.set(leftPx, topPx, leftPx + w, topPx + h)
        backingView?.apply {
            visibility = View.VISIBLE
            invalidate()
        }
    }

    /** Fullscreen video scaling: place the surface (and the shutter, so it
     *  covers exactly the picture area) at the rect the web layer computed for
     *  the chosen scaling mode. Unlike setBounds this does not touch the backing
     *  view, which only the confined mini player uses. */
    override fun setVideoRect(leftPx: Int, topPx: Int, widthPx: Int, heightPx: Int) {
        val sv = surfaceView ?: return
        val w = if (widthPx > 0) widthPx else 1
        val h = if (heightPx > 0) heightPx else 1
        lastRect = intArrayOf(leftPx, topPx, w, h)
        lastRectIsBounds = false
        if (inPip) return
        val svLp = FrameLayout.LayoutParams(w, h)
        svLp.leftMargin = leftPx
        svLp.topMargin = topPx
        svLp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
        sv.layoutParams = svLp
        sv.requestLayout()
        shutterView?.let { sh ->
            val shLp = FrameLayout.LayoutParams(w, h)
            shLp.leftMargin = leftPx
            shLp.topMargin = topPx
            shLp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
            sh.layoutParams = shLp
            sh.requestLayout()
        }
    }

    /** Restore the surface (and shutter) to fullscreen — the normal state for
     *  the main player screen. */
    override fun clearBounds() {
        lastRect = null
        if (inPip) return
        val sv = surfaceView ?: return
        val sh = shutterView
        val fullLp = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        sv.layoutParams = fullLp
        if (sh != null) {
            sh.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        // Only the mini player uses the backing view — ordinary fullscreen
        // exo playback (the far more common path) relies on html[data-exo-active]
        // clearing the chain itself with nothing else needed, so hide this
        // rather than leave an opaque view sitting there for no reason.
        backingHole.setEmpty()
        backingView?.visibility = View.GONE
    }

    /** True when a real picture is playing (not paused, not audio only). */
    fun isPlayingVideo(): Boolean {
        val p = player ?: return false
        return p.playWhenReady && videoW > 0 && videoH > 0 &&
            p.playbackState != Player.STATE_IDLE && p.playbackState != Player.STATE_ENDED
    }
    fun videoWidth(): Int = videoW
    fun videoHeight(): Int = videoH
    fun isInPip(): Boolean = inPip

    /** Picture-in-picture: the window is now tiny, so the surface (and shutter) fill it. */
    fun enterPip() {
        inPip = true
        val sv = surfaceView ?: return
        sv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        shutterView?.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        backingView?.visibility = View.GONE
    }

    /** Back to the full window: re-apply whatever rect the web layer last asked for. */
    fun exitPip() {
        inPip = false
        val r = lastRect
        if (r != null) {
            if (lastRectIsBounds) setBounds(r[0], r[1], r[2], r[3]) else setVideoRect(r[0], r[1], r[2], r[3])
        } else {
            clearBounds()
        }
    }

    // Option 3 uses transparent compositing (no swap), so nothing to toggle.
    override fun showUi(visible: Boolean) {}

    fun release() {
        stopTicker()
        stopMeasure()
        restoreDisplayMode()
        player?.release()
        player = null
        surfaceView?.let { sv ->
            (sv.parent as? ViewGroup)?.removeView(sv)
        }
        surfaceView = null
        shutterView?.let { sh ->
            (sh.parent as? ViewGroup)?.removeView(sh)
        }
        shutterView = null
        backingView?.let { bv ->
            (bv.parent as? ViewGroup)?.removeView(bv)
        }
        backingView = null
        isSurfaceReady = false
        pendingUrl = null
    }

    private fun startTicker() {
        stopTicker()
        val r = object : Runnable {
            override fun run() {
                val p = player
                // Report while playing, and also while paused / seeking (READY or
                // BUFFERING), so a paused seek is reflected without pressing play.
                if (p != null && (p.isPlaying || p.playbackState == Player.STATE_READY || p.playbackState == Player.STATE_BUFFERING)) {
                    val pos = p.currentPosition
                    val dur = if (p.duration > 0) p.duration else 0
                    val ahead = p.totalBufferedDuration.coerceAtLeast(0L)
                    toWeb("time", "{\"positionMs\":$pos,\"durationMs\":$dur,\"bufferedAheadMs\":$ahead}")
                }
                handler.postDelayed(this, 1000)
            }
        }
        timeTicker = r
        handler.postDelayed(r, 1000)
    }

    private fun stopTicker() {
        timeTicker?.let { handler.removeCallbacks(it) }
        timeTicker = null
    }
}
