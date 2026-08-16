# Crawl UI error-noun content review

Run ID: `content-review-20260731-crawl-ui-nouns`

Scope: error messages rendered on the end-user Crawl and Connections screens
when the stored public-API error uses the API noun “refresh.”

Verdict: **APPROVED**

- `We couldn't start this crawl. Try again later.` — approved unchanged from
  the existing reviewed crawl-start message.
- `We couldn't complete this crawl. Try again later.` — approved because it
  distinguishes a crawl that started but failed before completion.
- `This crawl expired before it could start. Start a new crawl.` — approved
  replacement for the proposed session-ended message. “Session” could be read
  as the user’s signed-in session; the replacement states the crawl outcome and
  the next action.

The public `/refresh` API retains its API terminology. These strings are only
the crawl UI presentation.
