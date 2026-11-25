# Xtivio

Xtivio is a free IPTV player for Android and Android TV, LG webOS and Samsung Tizen TVs. It plays the playlists
you already have (Xtream Codes, M3U and Stalker/MAG portals), with live TV, an EPG, movies, series and catch-up.

**Xtivio contains no channels, streams or playlists.** It is a player only. You bring your own subscription or
playlist from a provider you are entitled to use.

## Platforms

| Platform | What it is |
| --- | --- |
| Android, Android TV | A native Kotlin shell (WebView + ExoPlayer) around the shared web app |
| LG webOS | The shared web app plus a small JavaScript service that sends the HTTP headers a Stalker portal expects |
| Samsung Tizen | The shared web app as a Tizen web application |

All three run the same ES5 web code in `web/`. The platform folders only hold what is specific to that platform.

## Repository layout

```
web/       shared web app (HTML, ES5 JavaScript, CSS, translations)
android/   Gradle project and Kotlin sources
webos/     webOS manifests and the Luna service (webos/service)
tizen/     Tizen config.xml
server/    optional reference pairing server (Node.js, Express)
tools/     the quality gates the project is checked with
```

## Building

* **Android:** open `android/` in Android Studio, or run `./gradlew assembleRelease` there. Gradle copies `web/` into the
  APK's assets on every build. Release signing is read from the `XTIVIO_KEYSTORE*` properties (see `android/README.md`).
* **webOS:** `sh webos/build.sh` (or `sh webos/build.sh 720` for a 1280x720 manifest) assembles `dist/webos`; then
  `ares-package dist/webos webos/service`. See `webos/README.md`.
* **Tizen:** `sh tizen/build.sh` assembles `dist/tizen`; package it with Tizen Studio or the tizen CLI.
* **Gates:** `NM=/path/to/node_modules bash tools/run-gates.sh` runs the checks (ES5 only, translations, CSS, boot
  smoke test). It needs Node.js, Python 3 and the small `acorn` and `css-tree` packages.

## Configuration

Edit `web/assets/js/config.js`. It ships blank, so the app runs without any server:

* `PAIR_SERVER` is the address of the pairing server you run (it lets someone add a playlist from a phone by
  typing a code shown on the TV). Leave it empty if you do not run one.
* The Firebase block is only needed for optional cloud sync. Create your own Firebase project, paste its web app
  config and set `enabled` to `true`. The pairing server needs the same config (see `server/README.md`).

## Pairing server

`server/` is a small reference server (Node.js, Express) that lets a phone or browser send a playlist to a TV by typing a
code. It is optional, and it has an optional Firebase sign-in that you configure with your own project. The hosted
service run by the Xtivio project has extra features (sports data, subtitles, a portal relay) that are not in this
repository; without them the app falls back to its built-in behaviour. It is licensed separately, under the AGPL
(see below). See `server/README.md`.

## Licence

* The apps (`web/`, `android/`, `webos/`, `tizen/`, `tools/`): GNU General Public License v3.0 or later. See `LICENSE`.
* The pairing server (`server/`): GNU Affero General Public License v3.0 or later. See `server/LICENSE`.
* Third-party code and fonts keep their own licences. See `THIRD-PARTY-NOTICES.md`.

Copyright (C) 2026 The Xtivio authors.

The licence covers the code. The name "Xtivio" and its logos identify the official app: if you publish a modified
version, please give it your own name and logo so people can tell the two apart.

## Contributing

See `CONTRIBUTING.md`.
