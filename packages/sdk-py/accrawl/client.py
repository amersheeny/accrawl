"""The Accrawl Data API client. Authenticate with a scoped API key (``acck_…``) — obtained directly by the
operator, or via the "Connect with Accrawl" OAuth flow (see ``accrawl.AccrawlOAuthClient``). The credential
carries the read:data SCOPE and CONNECTION GRANTS; a call it isn't authorized for raises AccrawlApiError
(401 bad key / 403 missing scope or grant). Typical flow: list_connections → list_accounts /
list_transactions or sync_transactions / list_holdings.

READ-ONLY. This client reads the data Accrawl has already retrieved and offers nothing else — no way to start
a retrieval, follow one, or relay a one-time passcode. Those belong to the person whose accounts these are,
in their own Accrawl console. Connections refresh on their own schedule; ``last_synced_at`` on a connection
and ``as_of`` on a balance say how current the data is.

Stdlib-only: HTTP via urllib. Pass a custom ``transport`` to inject one (e.g. for tests).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

from .errors import AccrawlApiError
from .models import (
    ConnectionSummary,
    ContractPage,
    HoldingsPage,
    TransactionSyncPage,
    _account,
    _connection_summary,
    _holdings_page,
    _page,
    _sync_page,
    _transaction,
)

# The consumer endpoints this client implements — kept in sync with the OpenAPI spec. This mirrors the
# TypeScript SDK's identical manifest (packages/sdk-ts/src/client.ts), which a control-plane cross test checks
# against the spec, so the two SDKs cannot silently diverge from each other or from the API surface.
# All GET: the API only reads.
ACCRAWL_ENDPOINTS = (
    ("get", "/api/v1/connections"),
    ("get", "/api/v1/connections/{id}/accounts"),
    ("get", "/api/v1/connections/{id}/transactions"),
    ("get", "/api/v1/connections/{id}/transactions/sync"),
    ("get", "/api/v1/connections/{id}/holdings"),
)

# transport(method, url, headers, body) -> (status_code, response_text)
Transport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, str]]


def _default_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Tuple[int, str]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 (https enforced by baseUrl usage)
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:  # non-2xx: the error body carries the JSON { error }
        return exc.code, exc.read().decode("utf-8")


class AccrawlClient:
    def __init__(self, base_url: str, api_key: str, transport: Optional[Transport] = None) -> None:
        if not base_url:
            raise ValueError("AccrawlClient: base_url is required")
        if not api_key:
            raise ValueError("AccrawlClient: api_key is required")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._transport = transport or _default_transport

    # ── Normalized data contract (v1) — the read surface (needs read:data + a grant) ──

    def list_connections(self) -> "list[ConnectionSummary]":
        """List the connections this credential may read (grant-scoped; all for the operator) — the entry
        point for discovering what you can read. Each is a crawl-free summary: id, institution name/type/logo,
        status, nickname, last sync day."""
        resp = self._request("GET", "/api/v1/connections")
        items = resp.get("items") if isinstance(resp, dict) else None
        if not isinstance(items, list):
            raise ValueError("connections response 'items' is not a list")
        return [_connection_summary(it) for it in items]

    def list_accounts(self, connection_id: str, limit: Optional[int] = None, offset: Optional[int] = None) -> ContractPage:
        """List a connection's accounts: two-level ``type``+``subtype``, a balance triple, and optional
        credit-card / pension overlays. ``page.items`` are ContractAccount records (each carries its ``id``)."""
        qs = _qs(limit=limit, offset=offset)
        return _page(self._request("GET", f"/api/v1/connections/{_enc(connection_id)}/accounts{qs}"), _account)

    def list_transactions(
        self,
        connection_id: str,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        from_: Optional[str] = None,
        to: Optional[str] = None,
    ) -> ContractPage:
        """List a connection's transactions, optionally windowed by booking date (``from_``/``to``, inclusive,
        YYYY-MM-DD). ``page.items`` are ContractTransaction records."""
        qs = _qs(limit=limit, offset=offset, **{"from": from_, "to": to})
        return _page(self._request("GET", f"/api/v1/connections/{_enc(connection_id)}/transactions{qs}"), _transaction)

    def sync_transactions(self, connection_id: str, cursor: Optional[str] = None, limit: Optional[int] = None) -> TransactionSyncPage:
        """Fetch a page of the transaction change cursor (added/modified/removed). Omit ``cursor`` for the
        first call; pass the returned ``next_cursor`` back until ``has_more`` is False."""
        qs = _qs(cursor=cursor, limit=limit)
        return _sync_page(self._request("GET", f"/api/v1/connections/{_enc(connection_id)}/transactions/sync{qs}"))

    def list_holdings(self, connection_id: str, limit: Optional[int] = None, offset: Optional[int] = None) -> HoldingsPage:
        """List a connection's investment holdings plus the de-duplicated securities they reference."""
        qs = _qs(limit=limit, offset=offset)
        return _holdings_page(self._request("GET", f"/api/v1/connections/{_enc(connection_id)}/holdings{qs}"))

    def _request(self, method: str, path: str) -> Any:
        headers = {"authorization": f"Bearer {self._api_key}", "accept": "application/json"}
        status, text = self._transport(method, f"{self._base_url}{path}", headers, None)
        parsed = _safe_json(text) if text else None
        if status < 200 or status >= 300:
            message = parsed["error"] if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) else f"Accrawl API error (HTTP {status})"
            raise AccrawlApiError(status, message, parsed)
        return parsed


def _enc(segment: str) -> str:
    return urllib.parse.quote(segment, safe="")


def _qs(**params: Any) -> str:
    """Build a ``?a=1&b=2`` query string, skipping None values and URL-encoding each."""
    pairs = {k: v for k, v in params.items() if v is not None}
    return f"?{urllib.parse.urlencode(pairs)}" if pairs else ""


def _safe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text
