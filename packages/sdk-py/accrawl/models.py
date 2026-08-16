"""Typed models mirroring the Accrawl Provider API schemas (apps/control-plane/src/openapi/spec.ts).

The wire is camelCase JSON; these dataclasses expose Pythonic snake_case attributes. ``_from_wire`` maps the
JSON keys and IGNORES unknown fields (forward-compatible if the API adds one). Optional fields default to
None; a missing REQUIRED field surfaces as a KeyError/TypeError rather than being silently defaulted.

The data surface is the crawl-free **normalized contract** (docs/spec-data-api.md): accounts carry a two-level
``type`` + ``subtype`` and a current/available/limit balance triple, investments split into holdings + a
de-duplicated securities list, and transactions expose a Plaid-style change cursor. Nested objects that are
themselves records (balance, the credit-card / pension overlays) are typed dataclasses; small free-form bags
(a transaction's ``category``, an APR entry, sync ``counts``) stay plain dicts to avoid over-modeling — exactly
mirroring the TypeScript SDK's inline object literals.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, List, Optional, Type, TypeVar

T = TypeVar("T")


def _snake_to_camel(name: str) -> str:
    """A snake_case field name → its camelCase wire key. provider_account_id → providerAccountId; a single
    word (isin, name) is unchanged. A trailing underscore (from_ → from) is stripped first so a Python-keyword
    field name can still map to its wire key."""
    name = name.rstrip("_")
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _from_wire(cls: Type[T], data: dict) -> T:
    """Construct a dataclass by reading each field's EXACT expected camelCase wire key. Reading the wire key
    per-field (rather than converting arbitrary input keys to snake_case) means a snake_case twin in the input
    (e.g. an ``account_id`` alongside ``accountId``) can't be picked up to overwrite the validated value —
    construction and any prior validation read the same key. Unknown wire keys are ignored. Nested record
    fields are handled by the explicit builders below (this shallow map leaves them as raw dicts)."""
    mapped = {}
    for f in fields(cls):  # type: ignore[arg-type]
        wire_key = _snake_to_camel(f.name)
        if wire_key in data:
            mapped[f.name] = data[wire_key]
    return cls(**mapped)  # type: ignore[call-arg]


@dataclass
class ConnectionSummary:
    """A connection directory entry (GET /api/v1/connections) — the crawl-free projection a consumer sees.

    ``institution_id`` is a lookup key, never a label to show a person — use ``institution_name``.
    ``institution_logo_url`` is untrusted display content: render it, never fetch-and-trust it.
    """

    id: str
    institution_id: str
    status: str  # connecting|connected|syncing|needs_reauth|error|disabled
    institution_name: Optional[str] = None
    institution_type: Optional[str] = None  # bank|broker|retirement
    institution_logo_url: Optional[str] = None
    nickname: Optional[str] = None
    last_synced_at: Optional[str] = None  # YYYY-MM-DD of the last successful sync, or None


# ─── Outbound webhook bodies ─────────────────────────────────────────────────
# Webhooks are an OWNER feature: only the deployment owner can register an endpoint. These bodies (and the
# verify helpers) are here for whoever writes that receiver — they are not part of the read API surface.


@dataclass
class CrawlWebhookPayload:
    event: str  # crawl.completed | crawl.failed
    connection_id: str
    session_id: str
    status: str  # completed | failed
    occurred_at: str
    institution_id: Optional[str] = None
    error: Optional[str] = None


# ─── Normalized data contract (v1) ───────────────────────────────────────────


@dataclass
class ContractBalance:
    """Native-currency balance triple. For credit accounts ``current`` is the amount owed (positive = debt)."""

    current: float
    available: Optional[float] = None
    limit: Optional[float] = None
    as_of: Optional[str] = None  # ISO 8601


@dataclass
class CreditCardLiability:
    """Optional overlay on credit accounts. ``aprs`` entries stay plain dicts ({percentage, type?})."""

    aprs: Optional[List[dict]] = None
    last_statement_date: Optional[str] = None  # YYYY-MM-DD
    last_statement_balance: Optional[float] = None
    minimum_payment_amount: Optional[float] = None
    next_payment_due_date: Optional[str] = None  # YYYY-MM-DD


@dataclass
class PensionDetail:
    """Optional overlay on pension accounts."""

    scheme: Optional[str] = None  # defined_benefit | defined_contribution | provident_fund | study_fund | other
    employer: Optional[str] = None
    contributions_to_date: Optional[float] = None
    vested_value: Optional[float] = None


@dataclass
class ContractAccount:
    id: str  # Accrawl-minted stable id
    connection_id: str
    type: str  # depository | credit | investment | pension | loan | other
    subtype: str  # scoped to type (e.g. current, credit_card, brokerage, defined_contribution)
    name: str
    currency: str  # ISO 4217
    balance: ContractBalance
    status: str  # active | inactive
    description: Optional[str] = None
    credit_card_liability: Optional[CreditCardLiability] = None
    pension_detail: Optional[PensionDetail] = None


@dataclass
class ContractTransaction:
    id: str  # Accrawl-minted stable id
    booking_date: str  # YYYY-MM-DD
    amount: float  # signed, native currency; negative = outflow (bank-statement convention)
    currency: str
    description: str
    status: str  # posted | pending
    account_id: Optional[str] = None  # owning ContractAccount.id (minted), or None if unlinked
    provider_transaction_id: Optional[str] = None  # institution-supplied id, passthrough only
    merchant: Optional[str] = None
    category: Optional[dict] = None  # { primary, detailed? } — plain dict
    provider_category: Optional[str] = None  # raw institution category label


@dataclass
class ContractSecurity:
    id: str  # stable security id (ISIN › ticker+exchange › provider id)
    name: str
    security_type: str  # equity | etf | mutual_fund | bond | cash | crypto | derivative | other
    isin: Optional[str] = None
    ticker: Optional[str] = None
    exchange: Optional[str] = None  # MIC or market code


@dataclass
class ContractHolding:
    id: str
    security_id: str  # references a ContractSecurity.id
    quantity: float
    value: float  # market value, native currency
    currency: str
    account_id: Optional[str] = None  # owning ContractAccount.id (minted), or None if unlinked
    cost_basis: Optional[float] = None


@dataclass
class ContractPage:
    """A page of contract records. Each record carries its own ``id`` inline (there is no {id, data} wrapper).
    ``has_more`` is True if more exist past this page."""

    items: List[Any]
    has_more: bool
    limit: int
    offset: int


@dataclass
class HoldingsPage:
    """The holdings endpoint returns holdings + the de-duplicated securities they reference, in one page."""

    holdings: List[ContractHolding]
    securities: List[ContractSecurity]
    has_more: bool
    limit: int
    offset: int


@dataclass
class TransactionSyncPage:
    """One page of the transaction change cursor. ``removed`` carries ids only (transactions are upsert-only,
    never hard-deleted, so in practice it is always empty)."""

    added: List[ContractTransaction]
    modified: List[ContractTransaction]
    removed: List[str]
    next_cursor: str
    has_more: bool


# ─── Builders (recursive; the shallow _from_wire can't assemble nested records) ──


def _balance(d: dict) -> ContractBalance:
    return ContractBalance(current=d["current"], available=d.get("available"), limit=d.get("limit"), as_of=d.get("asOf"))


def _credit_card(d: dict) -> CreditCardLiability:
    return CreditCardLiability(
        aprs=d.get("aprs"),
        last_statement_date=d.get("lastStatementDate"),
        last_statement_balance=d.get("lastStatementBalance"),
        minimum_payment_amount=d.get("minimumPaymentAmount"),
        next_payment_due_date=d.get("nextPaymentDueDate"),
    )


def _pension(d: dict) -> PensionDetail:
    return PensionDetail(
        scheme=d.get("scheme"),
        employer=d.get("employer"),
        contributions_to_date=d.get("contributionsToDate"),
        vested_value=d.get("vestedValue"),
    )


def _account(d: dict) -> ContractAccount:
    return ContractAccount(
        id=d["id"],
        connection_id=d["connectionId"],
        type=d["type"],
        subtype=d["subtype"],
        name=d["name"],
        currency=d["currency"],
        balance=_balance(d["balance"]),
        status=d["status"],
        description=d.get("description"),
        credit_card_liability=_credit_card(d["creditCardLiability"]) if "creditCardLiability" in d else None,
        pension_detail=_pension(d["pensionDetail"]) if "pensionDetail" in d else None,
    )


def _transaction(d: dict) -> ContractTransaction:
    return _from_wire(ContractTransaction, d)


def _security(d: dict) -> ContractSecurity:
    return _from_wire(ContractSecurity, d)


def _holding(d: dict) -> ContractHolding:
    return _from_wire(ContractHolding, d)


def _connection_summary(d: dict) -> ConnectionSummary:
    return _from_wire(ConnectionSummary, d)


def _require_list(d: dict, key: str) -> list:
    """Bracket-access a required array field: a response missing it (or with a non-list) is malformed and must
    surface, never look like an empty result."""
    v = d[key]
    if not isinstance(v, list):
        raise ValueError(f"response field '{key}' is not a list")
    return v


def _require_bool(d: dict, key: str) -> bool:
    v = d[key]
    if not isinstance(v, bool):
        # bool("false") is True — never coerce a stringly-typed flag; a real response sends a JSON boolean.
        raise ValueError(f"response field '{key}' is not a boolean")
    return v


def _page(d: dict, item_fn) -> ContractPage:
    items = [item_fn(it) for it in _require_list(d, "items")]
    return ContractPage(items=items, has_more=_require_bool(d, "hasMore"), limit=int(d["limit"]), offset=int(d["offset"]))


def _holdings_page(d: dict) -> HoldingsPage:
    return HoldingsPage(
        holdings=[_holding(h) for h in _require_list(d, "holdings")],
        securities=[_security(s) for s in _require_list(d, "securities")],
        has_more=_require_bool(d, "hasMore"),
        limit=int(d["limit"]),
        offset=int(d["offset"]),
    )


def _sync_page(d: dict) -> TransactionSyncPage:
    return TransactionSyncPage(
        added=[_transaction(t) for t in _require_list(d, "added")],
        modified=[_transaction(t) for t in _require_list(d, "modified")],
        removed=[str(x) for x in _require_list(d, "removed")],
        next_cursor=d["nextCursor"],
        has_more=_require_bool(d, "hasMore"),
    )
