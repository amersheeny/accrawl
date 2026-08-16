# Companion financial inactivity content review

- Run ID: `content-review-20260803-financial-inactivity`
- Reviewer: independent Codex content-strategist-only pass
- Scope: only the user-facing Companion and documentation wording changed for the five-minute financial
  inactivity lease. Existing review conclusions for unchanged copy carry forward.

The reviewer assessed the wording for accuracy, clarity, concision, and consistency with the implemented
behavior. Decision: **APPROVED**.

Approved app copy:

- `Financial data stays available while you’re using the app and is cleared after five minutes of inactivity. It is never saved on this phone.`

Approved documentation wording:

- `Financial access is protected by the phone's screen lock. Financial data is kept in memory, remains available during active use and brief interruptions, and is cleared after five minutes of inactivity. All production financial traffic requires HTTPS.`
- `financial access is bound to the phone's screen lock, API responses are held in memory rather than persisted, remain available during active use and brief interruptions, are cleared after five minutes of inactivity, and production financial requests require HTTPS.`
- `Unlock Accounts or Transactions with the phone's screen lock. Financial responses are kept in memory, remain available during active use and brief interruptions, and are cleared after five minutes of inactivity. Production financial traffic requires HTTPS.`
- `The financial credential is protected by Android screen-lock authentication. Financial API responses are kept in memory, remain available during active use and brief interruptions, and are cleared after five minutes of inactivity.`
- `Financial data remains available while you use the app and during brief interruptions, such as opening the notification shade. After five minutes of inactivity, Companion clears the financial credential and response objects from process memory. The next time you open a financial view, you must authenticate with the phone's screen lock again.`
- `verifies that brief interruptions do not require another unlock, verifies that financial data locks after five minutes of inactivity, and verifies credential revocation`
- `Before the crawl, the harness completes the Android screen-lock prompt once during pairing, confirms that the authenticated session opens the empty Accounts and Transactions states without another prompt, and captures both rendered states.`
- `After the crawl, if the five-minute inactivity period expired during the crawl, the harness unlocks the Accrawl financial credential again. It then verifies the real account names, balances, and transactions in both the web Accounts page and Android accessibility semantics; confirms that the web page has finished loading; and captures the rendered web page and the Android light, dark, amount-private, and large-text states. It briefly backgrounds and resumes the app to confirm that the session remains unlocked, then leaves the app inactive for five minutes to confirm that financial data is cleared and a new unlock is required.`
