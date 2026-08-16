# Companion first-party download documentation review

- Run ID: `019fbc59-b262-7611-8f70-d3ca0e7615e9`
- Reviewer: independent Codex `gpt-5.6-sol`, content-strategist-only pass
- Scope: only the documentation delta introduced for the first-party Companion APK route. Existing review
  conclusions for unchanged documentation carry forward.

The reviewer assessed these exact new sentences for accuracy, clarity, concision, and terminology:

- `Both options download the official signed APK through the console’s own domain.`
- `The edge owns the three public domains, sanitizes forwarding headers, handles invite-only user
  authentication, serves the user application, preserves the long-lived tunnel WebSocket, streams the official
  Companion APK through the deployment’s own domain, and routes marketing or administrator paths to the private
  portal.`

Verdict: **APPROVED**

The direct documentation URL changed from the object store to the console's own
`/downloads/companion.apk`; that destination change adds no new interface wording.
