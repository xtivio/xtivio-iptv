# Third-party notices

The Xtivio package for Samsung TVs includes the following third-party components. Each stays under its own licence. The full texts are in the [LICENSES](LICENSES) folder and are also shipped inside the package.

| Component | Version | Licence | Use in Xtivio |
|---|---|---|---|
| [hls.js](https://github.com/video-dev/hls.js) | 1.6.15 | Apache-2.0 | HLS playback where the TV's own player is not used. Bundled unmodified. |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | MIT AND Zlib | Decompresses gzip data (for example compressed guide files). |
| [Noto Sans](https://github.com/notofonts) (Latin, Latin Extended, Cyrillic, Greek, Arabic) | as bundled | SIL Open Font License 1.1 | Interface fonts. |

Licence files: [hls.js-Apache-2.0.txt](LICENSES/hls.js-Apache-2.0.txt), [pako-MIT-and-Zlib.txt](LICENSES/pako-MIT-and-Zlib.txt), [NotoSans-OFL-1.1.txt](LICENSES/NotoSans-OFL-1.1.txt).

## Loaded from the internet, not bundled

Optional account sync uses the Firebase JavaScript SDK, which is loaded from Google's servers when needed and is covered by Google's terms and the Apache-2.0 licence.

## Xtivio's own code

The QR code generator and the rest of the application are Xtivio's own work and are covered by the [Xtivio licence](LICENSE).
