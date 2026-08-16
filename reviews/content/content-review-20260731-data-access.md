# Content-strategist review: Data access

- Run ID: `content-review-20260731-data-access`
- Primary review session: `019fb8c7-6132-7d42-91b9-03be2ce9ab86`
- Permissions follow-up: `019fb8cb-0666-7da1-a46c-66baaf8d8e45`
- Surface: user-facing access management for organisation-initiated OAuth

The reviewer was told that an organisation or app initiates authorization by
sending the user to Accrawl. The user signs in, reviews the requested access,
selects connections, and approves or declines. The in-app page must list only
access the user actually approved and must never invite the user to select an
organisation or initiate a share.

## Approved strings

- Navigation: `Data access`
- Heading: `Organisations and apps with access`
- Intro: `Review the organisations and apps that currently have access to your Accrawl data. You can revoke access at any time.`
- Section: `Active access`
- Empty heading: `No active access`
- Empty body: `No organisations or apps currently have access to your Accrawl data.`
- Connections label: `Connections shared`
- Permissions label: `Permissions`
- Read permission: `Read your shared accounts, balances, transactions and holdings`
- Crawl permission: `Trigger crawls of your connected institutions`
- One-time passcode permission: `Submit one-time passcodes during a crawl`
- Access date: `Access granted`
- Expiry date: `Access ends`
- Status: `Active`
- Revoke action: `Revoke access`
- Revoke heading: `Revoke access for {organisationName}?`
- Revoke body: `This will stop {organisationName} from accessing data from the connections you shared. You’ll need to approve access again to restore it.`
- Revoke success: `{organisationName} no longer has access.`
- Load error: `We couldn’t load your active access. Try again.`
- Revoke error: `We couldn’t revoke access. Try again.`
- Missing-name fallback: `Unknown organisation`

The existing exact legacy-share permission labels remain approved by review
`019f9d70-c77f-7bd2-a863-a4483a4e05d9`: `Account names and balances`,
`Transactions`, and `Investment holdings`.
