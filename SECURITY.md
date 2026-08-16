# Security

Accrawl signs into real bank and brokerage accounts with real credentials. A defect here costs
somebody their money or their financial history, so please treat a suspected vulnerability as
something to report privately rather than to open as an issue.

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/amersheeny/accrawl/security/advisories/new)**
on this repository. It reaches the maintainers and nobody else.

Please include what you need to make the problem reproducible: the version or commit, the
configuration, the steps, and what you observed versus what you expected. A proof of concept helps
enormously; a description of the mechanism is fine when a proof of concept is awkward to share.

**Do not** open a public issue, a discussion, or a pull request for an unfixed vulnerability, and
please do not test against anyone else's deployment.

You will get an acknowledgement that the report arrived, an assessment once it has been reproduced or
ruled out, and notice when a fix ships. If you would like credit in the release notes, say so and how
you would like to be named.

## What is in scope

This repository: the engine, the control-plane, the web console, the Companion app, the SDKs, the
deploy scripts, and the container images built from them.

Findings that carry particular weight, because of what this product holds:

- anything that discloses stored credentials, decrypts them, or recovers them from logs, screenshots,
  telemetry, or model context;
- anything that lets the crawl agent change state at an institution — move money, place a trade, add a
  payee, alter an account — rather than only read;
- anything that gets data out of the browser to a host the institution's own domain pin should have
  blocked;
- anything that lets one operator, API key, OAuth grant, or paired device reach another's data;
- anything that turns a hostile institution page, a malicious institution config, or a crafted model
  response into code execution or into an authorization decision;
- anything that lets a request forge an identity the control-plane trusts.

## What is out of scope

- Findings against a **deployment** you do not run. This is self-hosted software; a misconfigured
  instance belongs to whoever configured it.
- The plain-HTTP localhost default. It is documented, and `DEPLOY.md` covers going beyond localhost.
- Anything requiring an attacker who already has the host, the database, or the operator's session.
- The model provider's own infrastructure. Page content and extracted data go to it by design, which
  is stated in `README.md` and `DEPLOY.md`.
- Reports produced only by an automated scanner, with no demonstrated impact.
- Dependency advisories with no reachable path in this code. A reachable one is very much in scope.

## Supported versions

Accrawl is in active development and has no long-term support branches yet. Fixes land on `master`;
run a current checkout.

## Design notes worth reading first

`DEPLOY.md` has a **Security model** section describing what protects a deployment and, as
importantly, what does not — including the browser sandbox downgrade the container makes and the fact
that the model sits inside the trust boundary. A report that engages with those stated limits is much
more useful than one that rediscovers them.
