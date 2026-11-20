# Xtivio reference pairing server

A small Node.js (Express) service that lets a phone or browser send a playlist to a TV. The TV shows a short code,
the person types it (or scans the QR code) on a web page this server hosts, and the TV picks the playlist up on its
next poll. Nothing is stored on disk: sessions and uploads live in memory and expire after a few minutes.

This is the reference server. It covers pairing, playlist uploads and optional sign-in. The hosted service run by
the Xtivio project has extra features (sports data, subtitles, Stalker portal relay) that are not part of this
repository.

## What it does

| Endpoint | Purpose |
| --- | --- |
| `POST /api/pair` | The TV asks for a code |
| `GET /api/pair/:code` | The TV polls for the playlist |
| `DELETE /api/pair/:code` | The TV closes the session |
| `GET /api/pair/:code/info` | The web page checks a code exists |
| `POST /api/pair/:code/submit` | The web page sends the playlist (M3U, Xtream Codes or Stalker details) |
| `POST /api/upload`, `GET /uploads/:token` | Host an M3U file for a few minutes |
| `POST /api/mint-custom-token` | Optional: sign the TV in to the same cloud account (needs Firebase) |
| `GET /` , `GET /auth/action` | The pairing web page and the account email-action page |
| `GET /healthz` | Status (local requests only) |

The server does not check playlist credentials with the provider; the app does that itself.

## Run it

    npm ci
    PORT=9595 node server.js

Then set `PAIR_SERVER` in `web/assets/js/config.js` to the address of this server (it must be reachable from the TV
and from the phone). Use HTTPS in front of it (a reverse proxy such as Caddy or nginx) for anything beyond a home
network. Docker: `docker compose up -d` (see `docker-compose.yml`).

    npm test        # starts the server and runs one pairing round trip

## Optional: accounts and cloud sync (Firebase)

Without Firebase the pairing page still works. Sign-in, account creation and cloud sync need your own Firebase
project. Do not reuse anyone else's.

1. Create a Firebase project, enable Email/Password sign-in and a Realtime Database. `firebase-rules.json` has the
   database rules; `PRELAUNCH.md` walks through the console settings (authorised domains, action URL, billing cap).
2. Service account (secret): Project settings > Service accounts > Generate new private key. Save it as
   `firebase-service-account.json` next to `server.js`, or set `FIREBASE_SERVICE_ACCOUNT_PATH`. Never commit it.
3. Web config (public identifiers): Project settings > Your apps > Web app. Give the JSON to the server as one line in
   `FIREBASE_WEB_CONFIG`, or save it as `firebase-web-config.json` next to `server.js`.
4. Put the same web config in the app's `web/assets/js/config.js` and set `enabled` to `true`.

`/healthz` shows `firebaseAuthReady: true` when the service account loaded.

## Settings (environment)

* `PORT` (default 9595), `HOST` (default 0.0.0.0)
* `FIREBASE_SERVICE_ACCOUNT_PATH`, `FIREBASE_WEB_CONFIG`: see above
* `CORS_ALLOWED_ORIGINS`: comma-separated browser origins, besides localhost, that may call the API from another
  origin. The pairing page itself is same-origin and does not need it.

## Licence

GNU Affero General Public License v3.0 or later. If you run a modified version as a network service, the AGPL
requires you to offer your users the source of your changes.
