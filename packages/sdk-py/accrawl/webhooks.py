"""Verify HMAC-signed Accrawl webhooks (crawl.completed / crawl.failed).

The server signs ``X-Accrawl-Signature: sha256=<hex(hmac_sha256(secret, f"{timestamp}.{rawBody}"))>`` with
``X-Accrawl-Timestamp`` (unix seconds) — the timestamp is bound INTO the MAC so a receiver can reject replays,
and the signature is over the RAW body bytes. This mirrors the server's signWebhook exactly.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import time
from typing import Optional

from .models import CrawlWebhookPayload, _from_wire


def compute_webhook_signature(secret: str, timestamp: str, raw_body: str) -> str:
    """The signature a receiver must reproduce: ``sha256=<hex>``."""
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.{raw_body}".encode("utf-8"), hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify_webhook_signature(
    secret: str,
    raw_body: str,
    signature: str,
    timestamp: str,
    tolerance_seconds: Optional[float] = None,
    now_seconds: Optional[float] = None,
) -> bool:
    """Whether a webhook is authentic: a timing-safe match of the recomputed signature, and (if
    ``tolerance_seconds`` is set) within the replay window. Returns False — never raises — on any mismatch or
    malformed input."""
    if not isinstance(signature, str) or not isinstance(timestamp, str):
        return False

    if tolerance_seconds is not None:
        now_raw = now_seconds if now_seconds is not None else time.time()
        # Coerce every replay-window input to float INSIDE a guard: a non-numeric timestamp/now/tolerance
        # (e.g. an unparsed string or None) would otherwise raise from float()/math.isfinite and CRASH the
        # verify instead of failing it. FAIL CLOSED — reject (return False), never raise, never accept.
        try:
            ts = float(timestamp)
            now = float(now_raw)
            tol = float(tolerance_seconds)
        except (TypeError, ValueError):
            return False
        # Also reject NaN/Infinity: a NaN comparison is always False and would SILENTLY disable replay
        # protection; an infinite window is nonsensical.
        if not (math.isfinite(ts) and math.isfinite(now) and math.isfinite(tol)):
            return False
        if abs(now - ts) > tol:
            return False

    expected = compute_webhook_signature(secret, timestamp, raw_body)
    # Compare as BYTES: hmac.compare_digest on str raises TypeError for a non-ASCII string, so a hostile
    # non-ASCII signature header would crash the receiver instead of failing verification. Encoded bytes of
    # differing length simply compare unequal (still timing-safe), so a malformed signature returns False.
    return hmac.compare_digest(expected.encode("utf-8"), signature.encode("utf-8"))


def parse_webhook_payload(raw_body: str) -> CrawlWebhookPayload:
    """Parse a webhook body into a typed payload. Raises ValueError if it isn't a valid crawl webhook shape.
    Verify the signature FIRST (with the raw body), then parse."""
    try:
        obj = json.loads(raw_body)
    except (ValueError, TypeError):
        raise ValueError("webhook body is not valid JSON")

    if not isinstance(obj, dict):
        raise ValueError("webhook body is not a valid CrawlWebhookPayload")

    event = obj.get("event")
    valid_event = event in ("crawl.completed", "crawl.failed")
    # The server derives status FROM the event, so a payload whose event and status disagree is malformed.
    expected_status = "completed" if event == "crawl.completed" else "failed"

    def _opt_str(value: object) -> bool:  # optional field: absent (None) or a string
        return value is None or isinstance(value, str)

    if (
        not valid_event
        or not isinstance(obj.get("connectionId"), str)
        or not isinstance(obj.get("sessionId"), str)
        or obj.get("status") != expected_status
        or not isinstance(obj.get("occurredAt"), str)
        or not _opt_str(obj.get("error"))
        or not _opt_str(obj.get("institutionId"))
    ):
        raise ValueError("webhook body is not a valid CrawlWebhookPayload")

    return _from_wire(CrawlWebhookPayload, obj)
