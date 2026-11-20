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

## Install

**Samsung TVs:** install Xtivio through Apps2Samsung.

1. Follow the Apps2Samsung setup for your TV.
2. Choose Xtivio from its list.

You can also download the `.wgt` from [Releases](../../releases) and check the SHA-256 shown in the release notes
against the file. A `.wgt` has to be signed with your own Samsung certificate to install on a TV, which is what
Apps2Samsung does for you.

**Android, Android TV and LG webOS:** build from this repository (see Building below).

## Screenshots

See the [screenshots](screenshots) folder.

## Support and bug reports

Open an [issue](../../issues/new/choose). Please include your TV model and year, the Xtivio version (Settings > About)
and what you were doing. Do not post your playlist URL, username, password or MAC address.

Contact: dev@xtivio.vip

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

Xtivio is not affiliated with or endorsed by Samsung, LG or Google. Samsung, Tizen, LG, webOS and Android are trademarks of their owners.

**Artwork is not part of the GPL grant.** The Xtivio name, logos, app icons, launcher banner, splash image and the
donation QR code (`web/icon.png`, `web/splash.png`, `web/assets/img/`, and the icon and banner images under
`android/app/src/main/res/`) are Copyright (C) 2026 The Xtivio authors, all rights reserved. They are included so the
project builds and runs, and you may use them unmodified when you build and run this code for yourself. You may not use
them to publish a modified version or another app, or to suggest that something is the official Xtivio app. If you
publish a modified version, give it your own name, logo and icons. The donation QR code belongs to the project and
must not be reused. The code stays under the licences above.

## Contributing

See `CONTRIBUTING.md`.
