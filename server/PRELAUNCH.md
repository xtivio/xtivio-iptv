# Pre-launch checklist — Firebase

Before you publish the TV app to any app store or share the pairing
URL widely, work through this list in the Firebase Console. Every item
is something you have to do once in the web UI; nothing here can be
set automatically by the pairing server.

Project: **your own Firebase project**
Console: <https://console.firebase.google.com/>

---

## 1. Apply the Realtime Database security rules

**Why**: without these, every signed-in user can read or write every
other user's data. The default rules during development are usually
"signed-in users can do anything", which is fine for prototyping and
disastrous in production.

1. Open Firebase Console → **Realtime Database** → **Rules** tab.
2. Open `server/firebase-rules.json` from this repo.
3. Copy the entire file's contents into the rules editor.
4. Press **Publish**.
5. Verify the read/write tests in the Rules Playground:
   - As an anonymous user, `users/anything` → should be DENIED
   - As user A (uid `abc`), `users/abc/data` → should be ALLOWED
   - As user A (uid `abc`), `users/xyz/data` → should be DENIED

If Firebase rejects the JSON because it contains `_comment_*` fields,
strip those lines and republish. (Newer Firebase projects accept
comments; older ones don't.)

## 2. Authorize the pairing-server domain for Firebase Auth

**Why**: by default, Firebase Auth refuses sign-in requests from any
domain not on its allowlist. The pairing page is hosted at
`pair.example.com`, so until that's allowlisted, every sign-in
attempt from the page will fail with `auth/unauthorized-domain`.

1. Firebase Console → **Authentication** → **Settings** tab → **Authorized domains** section.
2. Click **Add domain**.
3. Add `pair.example.com` (or whatever domain the pairing server is
   served from).
4. Save.

Localhost is already authorized by default, so local dev still works
without adding anything.

## 3. Enable Email/Password as a sign-in method

**Why**: needs to be turned on once per project. If it's already on for
the TV app, skip this.

1. Firebase Console → **Authentication** → **Sign-in method** tab.
2. Find **Email/Password** in the list of providers.
3. Click it, enable the toggle, save.
4. Leave **Email link (passwordless sign-in)** OFF unless you want to
   support that flow (the TV app and pairing page don't use it).

## 4. Customise the verification email template (optional but recommended)

**Why**: by default the email comes from `noreply@<project>.firebaseapp.com`
with generic copy. A branded template improves deliverability (less
likely to land in spam) and builds trust.

1. Firebase Console → **Authentication** → **Templates** tab.
2. Click **Email address verification**.
3. Edit the sender name, subject, and body. You can use `%LINK%`,
   `%DISPLAY_NAME%`, `%EMAIL%` placeholders.
4. Optionally set a custom **action URL** that redirects to your own
   "you verified" page after the user clicks the link. If you skip
   this, they'll see Firebase's generic "Email verified" page and
   manually return to the pairing tab — which is fine.

### 4a. Set the custom action URL

The pairing server now hosts a branded action handler at
`/auth/action` that processes verification, password reset, and
email-recovery links with the same look-and-feel as the rest of the
pairing UI. To route Firebase's emails through it:

1. Firebase Console → **Authentication** → **Templates** tab.
2. For each template (Email verification, Password reset, Email
   address change), click the pencil/edit icon at the top right.
3. Click **Customize action URL** (small link beneath the email
   preview).
4. Replace the default URL with `https://pair.example.com/auth/action`
   (or whatever your pairing-server domain is).
5. Save the change. Repeat for each template — the action URL is
   per-template, not global.

After this, the verification email link will go to your branded page
instead of `<project>.firebaseapp.com/__/auth/action`. You can test
by triggering a new verification email from the pairing page sign-up
flow — the link in the email should now contain
`pair.example.com/auth/action` rather than `firebaseapp.com`.

If you skip this step, sign-up + verification still works — users
just see the default Firebase-hosted confirmation page. The custom
page is a polish item, not a correctness requirement.

## 5. Enable App Check (strongly recommended)

**Why**: App Check binds Firebase requests to your specific apps. Even
if your Firebase API key leaks (which is fine — it's public by design),
attackers can't use it from arbitrary clients to hammer your project.

For the **web** (pairing page):
1. Firebase Console → **App Check** → **Apps** tab → find your Web app.
2. Register it with **reCAPTCHA v3** (free, invisible to users) or
   reCAPTCHA Enterprise (better but billed).
3. Copy the site key into the pairing-server source — there's a TODO
   comment in `server.js` near the `FIREBASE_CFG` block. Add an
   `appCheck.activate(siteKey)` call right after `firebase.initializeApp`.

For each **TV platform** (WebOS, Tizen, etc.):
- App Check on native apps requires the DeviceCheck/Play Integrity
  attestation flow, which TV platforms don't natively expose. The
  practical fallback is **debug tokens** registered manually per TV
  device, or skipping App Check on TV and relying on the security rules
  alone. The TV app already runs locally; it's not the attack surface.

For now, enabling App Check on the **web (pairing page) only** gives
you the most value for the least work — that's where exposed API keys
get abused.

After enabling, set the **enforcement mode** for Realtime Database to
**Enforced** in App Check settings. Until you do this, App Check is
collecting metrics only and not blocking anything.

## 6. Set a Firebase billing cap

**Why**: Spark (free) tier has hard limits, so you're safe by default.
If you've upgraded to Blaze (pay-as-you-go) — for App Check or any
other reason — set a budget alert and a quota cap so a runaway attack
can't run up an unbounded bill.

1. Google Cloud Console (linked from Firebase) → **Billing** → **Budgets & alerts**.
2. Create a budget for the project with whatever monthly cap you're
   comfortable with (e.g. £10/month).
3. Set alert thresholds at 50%, 90%, 100%.
4. Optionally cap **per-service** quotas at Firebase Console → **Usage and billing** → **Details & settings**.

## 7. Verify the pairing server has the service account

**Why**: the `/api/mint-custom-token` endpoint can't function without
a Firebase service account credential. If it's missing, the server
boots fine and serves playlists, but sign-in from the pairing page
returns 503.

1. SSH to your VPS.
2. Confirm `firebase-service-account.json` is present in the
   pairing-server volume / working directory.
3. `curl https://pair.example.com/healthz` — `firebaseAuthReady` must
   be `true`.
4. If false, `firebaseInitError` in the response tells you why.

See the README's "Configuring Firebase auth" section for setup details.

## 8. Smoke-test the full flow

Once the above are done, walk through this once before going public:

1. From a phone (different from the TV), open the pairing URL.
2. Tap **Create an account**, sign up with a real email.
3. Receive the verification email; click the link.
4. Return to the pairing tab, tap **I've verified — continue to pair**.
5. Note the pairing code on the TV (Settings → Pair this device, or
   whatever the user-facing path is in your build).
6. Enter the code, submit a playlist.
7. Confirm on the TV that the playlist loaded AND the account is
   signed in (Settings → Cloud Sync should show the email).
8. Open another TV / reinstall the app on the same TV, sign in directly
   with the same email + password on the TV. Confirm playlists,
   favourites, etc. all come back.

If any step fails, the error message on the pairing page tells you
which Firebase setting was missed.
