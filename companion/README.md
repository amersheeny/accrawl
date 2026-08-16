# Accrawl Companion (Android)

Accrawl Companion is an optional Android app for a self-hosted Accrawl deployment. It shows accounts,
balances, and transactions for connections selected during pairing, relays bank SMS one-time codes, and
can route selected crawls through the phone's network.

Android is required for automatic SMS relay because iOS does not allow third-party apps to read incoming
SMS. The app communicates only with the Accrawl console and crawl engine configured by the operator.

## Security model

- The Accrawl console creates a pairing request limited to the selected connections; the request expires
  after five minutes.
- The QR contains only the Accrawl console address and the short-lived request secret. It never contains a
  final relay or financial credential.
- The phone claims the request, and the Accrawl console and Companion display the same six-digit comparison
  code. After the operator approves the match, Companion receives the relay credential and financial
  credential in a one-time response.
- The financial credential is protected by Android screen-lock authentication. Financial API responses are
  kept in memory, remain available during active use and brief interruptions, and are cleared after five
  minutes of inactivity.
- Production financial and pairing requests require HTTPS. The secure build rejects cleartext HTTP.
- Android backup and device-to-device transfer are disabled for Companion data. The secure build applies
  `FLAG_SECURE`, which blocks screenshots and non-secure display capture.
- Revocation invalidates the relay credential and financial credential and stops active crawls routed
  through that phone.
- Every device is limited to the exact connections selected at pairing. Wildcard grants are not accepted.

The relay credential remains available to the native foreground services so SMS relay and device-proxy
crawls can continue when the Flutter activity is closed. The services run only while Companion is handling
live crawl sessions. Pairing alone does not start a service, and when no crawl session is active, no
foreground-service notification is shown. The credential is protected by Android's application sandbox,
excluded from backup and device transfer, and independently revocable. The separate financial credential
is screen-lock-bound and is never available to those services.

## Pairing

1. Open **Companion** in the Accrawl console.
2. Name the phone and select the exact connections it may access.
3. Create a pairing request.
4. In the Android app, scan the QR or enter the HTTPS console address and `acpair_…` code.
5. Compare the six-digit code shown on both devices and approve it in the Accrawl console.
6. Complete the Android screen-lock prompt. After a phone is paired, Accrawl Companion asks for SMS access
   and notification access, then asks Android to turn off battery optimization for the app.

If the request expires, is cancelled, or is already used, create a new request. A consumed request cannot
return either credential again.

## Financial data

Companion shows accounts and keyset-paginated transactions only for connections granted during pairing.
Transactions within a granted connection remain visible even when they are not assigned to an account.
Transactions are never merged merely because they share an amount, merchant, description, or date.
Tap a recent crawl to open its recorded steps, captured screenshots, and extracted accounts, transactions,
and positions.

For credit accounts, Companion displays debt as a positive value labelled **Amount owed** while preserving
the signed stored/API value. Amount privacy removes monetary amounts from the rendered UI and accessibility
semantics.

Financial data remains available while you use the app and during brief interruptions, such as opening the
notification shade. After five minutes of inactivity, Companion clears the financial credential and response
objects from process memory. The next time you open a financial view, you must authenticate with the phone's
screen lock again.

## SMS relay and device proxy

When a crawl needs OTP relay or a device-proxy tunnel, the control plane requests a high-priority, data-only
FCM wake-up. The wake-up is a hint, not authorization: Companion checks the exact session through the
paired-device API and starts a foreground service only if that session is still live. Tunnel credentials
are returned only by that authenticated session check and never travel through FCM. If a push is missed,
Accrawl Companion performs the same one-shot recovery when the app opens or resumes, or when its paired-device
API poll reports an active OTP-relay or device-proxy session.

While at least one live OTP-relay or device-proxy session is active, the only session notification is the
foreground-service notification Android requires. OTP-relay and device-proxy outcomes and errors appear in
the **Activity** section, not as separate notifications.

After pairing, Accrawl Companion registers its Firebase Cloud Messaging (FCM) registration token through the
paired-device API. It refreshes the registration when Firebase delivers a replacement through `onNewToken`
and whenever the app opens. The token is only a delivery address for data-only wake-ups; it is not a device
credential, cannot authorize a crawl, and cannot bypass the active-session check that gates service startup.

While at least one OTP-relay session is active, the native Android service listens through the incoming-SMS
broadcast and a read-only inbox observer. The observer is a fallback for phones that suppress the broadcast;
messages already in the inbox when the session starts are not read or relayed. If both paths report the same
new message, Companion handles it once. It then matches the sender to the institution associated with the
request and forwards the raw message body and request epoch. The Accrawl console extracts the OTP. Companion
does not guess when sender binding is missing or ambiguous. Different institutions can wait concurrently;
requests for the same institution are served in order so one bank's message cannot be routed to two account
sign-ins.

The **System status** card shows SMS access, notification access, battery optimization, and the console
connection separately so missing setup is explicit.

A phone-network tunnel can be claimed only by a crawl session durably bound to that phone. Tunnel tokens
are short-lived and carry both identifiers; the engine also
checks the durable session binding before atomically claiming the tunnel.

## Build and install

If your deployment publishes a signed release, open **Companion** in the Accrawl console on your Android phone
and select **Download for Android**. If the console is open on another device, scan the download QR with your
phone instead. Either way the APK is served from your own console's domain, at
`/downloads/companion.apk`.

Open the downloaded APK and follow Android's prompts; if asked, allow your browser to install apps from this
source. A published release keeps one signing identity, so Android can install later releases as updates.

Locally signed builds use the same application ID but a different signing identity, so Android cannot install
one over the official release. Uninstall the existing app before switching between them, or use the separate
`qa` application for development.

To build from source, run these commands from the repository root:

```bash
./accrawl companion build
./accrawl companion install
./accrawl companion devices
```

The default source-build commands build the `secure` flavor. It is built against no push project: the app
asks the deployment it pairs with which one to register with, so the same build works against any
deployment and there is nothing to place in the source tree. What the deployment must supply is described
in [`DEPLOY.md`](../DEPLOY.md). Creating a separately signed release also requires
`companion/android/key.properties`; copy `key.properties.example` and point it at a private keystore.
Release builds fail rather than fall back to the debug signing key, and require `ACCRAWL_VERSION` to contain
the full 40-character public Git commit recorded in the packaged Android manifest.

For local emulator validation only:

```bash
cd companion
flutter build apk --flavor qa --debug
```

The `qa` flavor has a different application ID, registers with whichever push project the end-to-end
deployment hands it, permits loopback cleartext traffic, and allows screenshots so automated local E2E and rendered-state audits
can inspect the app. It is not a production artifact.

## Validate

The mandatory repository E2E starts a local Accrawl console, engine, fake bank, and PostgreSQL. It builds
and installs the QA flavor; completes pairing and device authentication; checks the rendered permission
status and OTP notifications; exercises SMS delivery through the emulator's native Android receiver and
completes a browser crawl; verifies accounts, balances, and
transactions; captures screenshots of the empty, light-theme, dark-theme, amount-privacy, and large-text
states; verifies that brief interruptions do not require another unlock, that financial data locks after
five minutes of inactivity, and that credential revocation works;
installs the secure flavor; and verifies that screenshots are blocked. Run it only through the current
session's visible emulator lease:

```bash
export EMU_SESSION="<stable-session-id>"
export EMULATOR_LEASE_SCRIPT="/absolute/path/to/emulator-lease/scripts/emu.sh"
export EMULATOR_SERIAL="$("$EMULATOR_LEASE_SCRIPT" claim)"
COMPANION_RELAY=1 e2e/run-e2e.sh
```

Unit coverage is split across Dart model/client/copy tests and Kotlin relay/tunnel tests. Production
security properties such as screenshot blocking and lifecycle locking are also checked on the emulator,
not inferred from source alone.
