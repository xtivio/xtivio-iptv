# Xtivio — Android TV / Google TV (build android06, TV-ONLY)

TV-only Android build. One native Kotlin shell + WebView + native ExoPlayer
(Media3) for MKV/HEVC/AC3. Restricted to Android TV / Google TV devices on the
Play Store.

## What changed vs android05

Mobile (phone/tablet) support is **deferred** — the mobile UI needs dedicated,
device-in-the-loop design work and isn't ready. This build makes the app TV-only
so the finished TV product can ship without waiting on mobile:

- **Manifest: `leanback` required = true** → Play restricts the app to Android TV
  / Google TV; phones/tablets can't install it. The plain `LAUNCHER` intent is
  removed (leanback launcher only).
- **Orientation** fixed to landscape in the manifest.
- **`platform()` locked to `"android-tv"`** → the web layer's `Mobile.isMobile()`
  is always false, so the app uses the TV (D-pad) UI exclusively.

The mobile web layer (mobile.js/css etc.) is **still bundled but dormant** —
gated off at runtime. Re-enabling the unified TV+mobile build later is a small
manifest + `platform()` change (documented inline in AndroidBridge.kt), not a
rebuild. Nothing about the mobile work is lost.

## Toolchain (unchanged)

Media3 1.11 requires compileSdk 36: AGP 8.11.0, compileSdk/targetSdk 36,
build-tools 36, Gradle 8.13, Kotlin 2.0.21, minSdk 24. versionName and
versionCode are derived — see Versioning below.

## Versioning

One shared public version (`x.y.z`) across Android, webOS and Tizen, plus an
internal build digit (`0`-`9`) that only Android deltas use.

| Thing             | Value / where it lives                                                   |
|-------------------|--------------------------------------------------------------------------|
| versionName       | `1.0.12` — `xtivioVersion` in `app/build.gradle`; also `appinfo.json` and `tizen/config.xml` (x.y.z only) |
| Internal build    | `xtivioInternalBuild` in `app/build.gradle` (0-9); resets to 0 at each release |
| Build id          | `xtivio-<versionName>.<internal build>` — `INSTALL_TOKEN` in `config.js` must match exactly |
| versionCode       | Derived, never hand-set: major*1000000 + minor*10000 + patch*100 + internal build. Play requires it strictly increasing. |
| Web `APP_VERSION` | `config.js`; shown in Settings > About (default text in `index.html` kept in step) |
| User-agent        | WebView: `XtivioTV/<versionName>` appended in `MainActivity.kt`. ExoPlayer: generic `Player (Linux; Android <release>)` by default; `EXO_UA_BRANDED` in `ExoController.kt` switches to `XtivioTV/<versionName> (ExoPlayer)` |

Only the versionName row carries a literal number; `version-bump-check.py` verifies it
and every other place above against `app/build.gradle`.

The public `x.y.z` changes only at a real store release. Between releases bump
only the internal digit; past 9, bump the patch number and reset it to 0.
`version-bump-check.py` verifies the manifests agree and the version moved forward.

## Requirements changed

- **minSdk is now 24 (Android 7.0)** — Google Play's automatic protection requires
  24 (Play Console rejected an upload with minSdk 23); Media3 1.11 itself needs 23.
  (android01 was 21.) Real-world impact: ~none; virtually no Android TV device is
  below 7.0.
- New dependency: **androidx.media3 1.11.0** (exoplayer + exoplayer-hls +
  datasource + common). All media3 modules must stay on the same version.

## Build

Requires Android Studio / SDK 34, JDK 17. First sync downloads Media3 from
Google's Maven (network needed).

```bash
./gradlew assembleRelease   # -> app/build/outputs/apk/release/xtivio-android02-release.apk
./gradlew bundleRelease     # -> .aab for Play upload (preferred)
./gradlew assembleDebug     # -> device testing build
```

Signing: reads `XTIVIO_KEYSTORE` / `_PW` / `_KEY_ALIAS` / `_KEY_PW` from
`gradle.properties` or env; otherwise assembles unsigned (use Play App Signing on
the `.aab`).

## Testing checklist (real device)

- [ ] **MKV** VOD plays (native ExoPlayer path).
- [ ] **HEVC/H.265** stream plays; **AC3/EAC3** audio has sound.
- [ ] H.264 MP4 and HLS still play via the WebView path (no regression).
- [ ] Transparent hand-off is clean: no black flash, overlays visible over video.
- [ ] Pause/resume, D-pad seek (left/right), and stop work on a native stream.
- [ ] On a deliberately bad URL, it falls back without dead-ending.
- [ ] Back exits at root; D-pad drives all screens.

## If a format still won't play

ExoPlayer covers the vast majority of IPTV formats via device hardware decoders.
For exotic software-only codecs, add the Media3 **FFmpeg audio extension** (built
separately, not on Maven) — this is the escape hatch, not needed for MKV/HEVC/AC3
which the hardware handles.
