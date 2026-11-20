# Xtivio webOS portal service (com.xtivio.iptv.service)

A small Node JS service that ships INSIDE the webOS app. It makes the Stalker / MAG portal requests for the page
(with Cookie, User-Agent, Referer, which a web page cannot send), and returns the answer in pieces over a Luna
subscription. The page side is `assets/js/portal-net.js` (webOS backend); the portal logic is the same
`stalker-direct.js` the Android app uses. If the service is missing or does not answer, the app uses the pairing
server exactly as before.

The folder `com.xtivio.iptv.service/` holds three files and needs no `npm install` (Node core modules only):
`service.js`, `services.json`, `package.json`.

## Packaging (webOS only)

The service id must start with the app id (`com.xtivio.iptv`). Package the app and the service together:

    ares-package dist/webos webos/service
    ares-install --device <tv> com.xtivio.iptv_<version>_all.ipk

Do this for both IPKs (1920x1080 and the 720 manifest). The service folder is not part of the web folder. Android and Tizen builds do not use it.
