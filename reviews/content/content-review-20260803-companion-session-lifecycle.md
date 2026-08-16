# Companion session-lifecycle content review

- Run ID: `content-review-20260803-companion-session-lifecycle`
- Reviewer: independent Companion content strategist
- Scope: only the Companion documentation added for event-driven OTP relay and device-proxy sessions,
  active-only foreground services, Firebase Installation ID (FID) registration,
  `CONTROL_PLANE_INTERNAL_ORIGIN`, plus the Android device-proxy notification-channel description. Existing
  review conclusions for unchanged copy carry forward.

The content strategist checked the wording for accuracy, clarity, consistency with Accrawl terminology, and
removal of the obsolete standby-service framing. Decision: **APPROVED**.

Approved Android notification-channel description:

- `Routing status while crawls use this phone's network.`

The final native catalogue retains only the previously approved active OTP-relay and device-proxy
foreground-service copy. The previously reviewed transient waiting, relay-outcome, relay-error, access, and
proxy-off strings were removed with their notification branches. No new unreviewed native copy was
introduced.

Approved documentation states that pairing alone does not start a foreground service; when no crawl session
is active, no foreground-service notification is shown; a data-only FCM wake-up or one-shot app recovery is
re-authorized through the paired-device API; the FID is only a wake-up delivery address; tunnel credentials,
SMS content, and financial response data do not travel in FCM; non-Docker engines use
`CONTROL_PLANE_INTERNAL_ORIGIN` for authenticated OTP-wake requests; different institutions can wait
concurrently; and same-institution OTP requests are served in order.

Approved active-notification paragraph in `DEPLOY.md`:

> While at least one live OTP-relay or device-proxy session is active, the only session notification is the
> foreground-service notification Android requires. OTP-relay and device-proxy outcomes and errors appear in
> Companion's **Activity** section, not as separate notifications.

Approved active-notification paragraph in `companion/README.md`:

> While at least one live OTP-relay or device-proxy session is active, the only session notification is the
> foreground-service notification Android requires. OTP-relay and device-proxy outcomes and errors appear in
> the **Activity** section, not as separate notifications.

Approved transaction-delta capability bullet in `apps/engine/README.md`:

> - **Occurrence-preserving transaction deltas.** The first crawl extracts transactions from the preceding
>   90 days. Later crawls receive the complete stored seven-day window and match transactions semantically,
>   one to one, including pending-to-posted transitions and reference updates. Genuinely identical
>   transactions are represented with an explicit `count`, preserving their multiplicity. Repeated model
>   output collapses as a stutter, while transactions with distinct real bank references remain distinct.
