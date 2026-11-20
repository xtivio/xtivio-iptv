# Third-party notices

Xtivio includes or uses the following. Each keeps its own licence. Full texts are in `licenses/`.

## Bundled with the web app (`web/`)

| Component | Version | Licence | Copyright |
| --- | --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | 1.6.15 | Apache-2.0 | Copyright 2017 Dailymotion and contributors |
| [pako](https://github.com/nodeca/pako) (inflate) | 2.1.0 | MIT AND Zlib | (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin; zlib parts (C) 1995-2013 Jean-loup Gailly and Mark Adler |
| Noto Sans (latin, latin-ext, cyrillic, greek) | as bundled | SIL Open Font License 1.1 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| Noto Sans Arabic | as bundled | SIL Open Font License 1.1 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic) |

`qrcode.js` is original to this project.

## Used by the Android app

| Component | Version | Licence |
| --- | --- | --- |
| AndroidX Activity, Core KTX | 1.9.3, 1.13.1 | Apache-2.0 |
| AndroidX Media3 (ExoPlayer, HLS, datasource, common) | 1.11.0 | Apache-2.0 |
| Kotlin standard library | as resolved by Gradle | Apache-2.0 |

## Loaded at run time (not redistributed)

The Firebase JavaScript SDK (9.23.0: app, auth, database) is loaded from Google's CDN for optional cloud sync.
It is licensed under Apache-2.0 and is not part of this repository.

## Pairing server (`server/`)

express, cors, express-rate-limit, helmet, https-proxy-agent and socks-proxy-agent are MIT licensed.
firebase-admin is Apache-2.0. Their transitive dependencies are installed with `npm install` and carry their own
licences.

## Font licence note

The fonts are used unmodified under the SIL Open Font License 1.1 and are not sold on their own.
The Reserved Font Names are those declared by the Noto Project.
