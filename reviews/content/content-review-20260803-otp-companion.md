# Companion OTP content review

Run: `content-review-20260803-otp-companion-delta`

Scope: the Accrawl Companion System Status card, OTP watch/wait states, foreground-service status, relay outcomes, and Android notification-channel copy. The review checked clarity, truthful sequencing, actionability, consistency with the console’s “crawl” terminology, and lock-screen privacy.

Decision: APPROVED.

This incremental review covered only the copy changed after the preceding OTP Companion review and its
documentation description. Unchanged conclusions from `content-review-20260803-otp-companion` carry forward.

Approved replacements:

- `Setup needed`
- `Ready`
- `Accrawl Companion can detect and relay bank SMS codes.`
- `Allow SMS access to detect and relay bank SMS codes.`
- `Crawl and code notifications are allowed on this phone.`
- `Battery optimization`
- `Battery optimization is off for Accrawl Companion.`
- `Turn off battery optimization so SMS relay can keep working in the background.`
- `The crawl is signing in. Accrawl Companion is watching for the bank’s code.`
- `The bank has requested a code. Accrawl Companion is waiting for the bank’s SMS.`
- `The crawl is signing in. Accrawl Companion is watching for the bank's code.`
- `Accrawl Companion is checking for crawls that may need an SMS code.`
- `Crawls being watched for SMS codes: {count}.`

Approved documentation wording:

- `After a phone is paired, Accrawl Companion asks for SMS access and notification access, then asks Android to turn off battery optimization for the app.`
- `Before a crawl navigates to an institution configured for SMS-code relay, Accrawl arms the Companion. The app shows notifications while it is watching for a code, when the bank has requested one, and when the relay succeeds or needs attention.`

Key distinctions preserved:

- “Watching” means the crawl is signing in and the phone has been armed before the bank asks for a code.
- “Waiting” means the bank has asked for its code.
- SMS access is presented as required for automatic relay; notifications and unrestricted battery use are presented as background-reliability setup.
- The phone never claims that a code was relayed until the server has accepted it.
- Institution names appear only in private notification content; public lock-screen versions stay generic.

The exact reviewed sources are `companion/lib/companion_copy.dart` and `companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/NotificationCopy.kt`. Their individual Dart strings and the digest of the complete Kotlin catalogue are enforced by the copy-review gate.
