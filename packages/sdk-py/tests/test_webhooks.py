import json
import unittest

from accrawl import (
    compute_webhook_signature,
    parse_webhook_payload,
    verify_webhook_signature,
)

SECRET = "whsec_test"
TS = "1782000000"
BODY = json.dumps({"event": "crawl.completed", "connectionId": "c1", "sessionId": "s1", "status": "completed", "occurredAt": "2026-07-01T10:00:00Z"})


class TestCompute(unittest.TestCase):
    def test_format_and_determinism(self):
        sig = compute_webhook_signature(SECRET, TS, BODY)
        self.assertRegex(sig, r"^sha256=[0-9a-f]{64}$")
        self.assertEqual(compute_webhook_signature(SECRET, TS, BODY), sig)
        self.assertNotEqual(compute_webhook_signature(SECRET, "1782000001", BODY), sig)  # timestamp bound in


class TestVerify(unittest.TestCase):
    def setUp(self):
        self.sig = compute_webhook_signature(SECRET, TS, BODY)

    def test_accepts_authentic(self):
        self.assertTrue(verify_webhook_signature(SECRET, BODY, self.sig, TS))

    def test_rejects_tamper(self):
        self.assertFalse(verify_webhook_signature(SECRET, BODY + " ", self.sig, TS))
        self.assertFalse(verify_webhook_signature("other", BODY, self.sig, TS))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, "1782000001"))

    def test_malformed_signature_returns_false(self):
        self.assertFalse(verify_webhook_signature(SECRET, BODY, "sha256=deadbeef", TS))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, "", TS))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, None, TS))  # type: ignore[arg-type]

    def test_non_ascii_signature_returns_false_not_raises(self):
        # hmac.compare_digest on a non-ASCII str raises TypeError; a hostile non-ASCII signature header must
        # fail verification, never crash the receiver.
        self.assertFalse(verify_webhook_signature(SECRET, BODY, "sha256=éé", TS))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, "sha256=" + "ф" * 64, TS))

    def test_replay_window(self):
        now = 1782000000
        self.assertTrue(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=300, now_seconds=now + 100))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=300, now_seconds=now + 3600))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, "not-a-number", tolerance_seconds=300, now_seconds=now))

    def test_fail_closed_on_non_finite_window(self):
        now = 1782000000
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=float("nan"), now_seconds=now + 3600))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=300, now_seconds=float("nan")))
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=float("inf"), now_seconds=now + 3600))

    def test_non_numeric_window_returns_false_not_raises(self):
        now = 1782000000
        # A non-numeric tolerance/now (e.g. an unparsed string / None) must fail verification, not crash it.
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds="oops", now_seconds=now))  # type: ignore[arg-type]
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds=300, now_seconds="oops"))  # type: ignore[arg-type]
        # A NUMERIC string is coerced and still enforced (300s window, 1hr-stale → rejected).
        self.assertFalse(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds="300", now_seconds=now + 3600))  # type: ignore[arg-type]
        self.assertTrue(verify_webhook_signature(SECRET, BODY, self.sig, TS, tolerance_seconds="300", now_seconds=now + 10))  # type: ignore[arg-type]


class TestParse(unittest.TestCase):
    def test_valid(self):
        p = parse_webhook_payload(BODY)
        self.assertEqual(p.event, "crawl.completed")
        self.assertEqual(p.session_id, "s1")

    def test_invalid_json_and_shape(self):
        with self.assertRaises(ValueError):
            parse_webhook_payload("{not json")
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({"event": "nope", "connectionId": "c", "sessionId": "s", "status": "completed", "occurredAt": "x"}))
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({"event": "crawl.completed", "sessionId": "s", "status": "completed", "occurredAt": "x"}))  # no connectionId

    def test_rejects_event_status_mismatch(self):
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({"event": "crawl.completed", "connectionId": "c", "sessionId": "s", "status": "failed", "occurredAt": "x"}))
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({"event": "crawl.failed", "connectionId": "c", "sessionId": "s", "status": "completed", "occurredAt": "x"}))
        self.assertEqual(parse_webhook_payload(json.dumps({"event": "crawl.failed", "connectionId": "c", "sessionId": "s", "status": "failed", "occurredAt": "x"})).status, "failed")

    def test_snake_case_twin_cannot_overwrite_validated_value(self):
        # A payload smuggling a snake_case twin (institution_id) next to the real camelCase key must not let
        # the twin (which validation didn't check) win — _from_wire reads only the camelCase wire key.
        p = parse_webhook_payload(json.dumps({
            "event": "crawl.failed", "connectionId": "c", "sessionId": "s", "status": "failed", "occurredAt": "x",
            "institutionId": "real", "institution_id": 456,
        }))
        self.assertEqual(p.institution_id, "real")  # the validated camelCase value, not the int twin

    def test_rejects_non_string_optional_fields(self):
        base = {"event": "crawl.failed", "connectionId": "c", "sessionId": "s", "status": "failed", "occurredAt": "x"}
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({**base, "error": 123}))
        with self.assertRaises(ValueError):
            parse_webhook_payload(json.dumps({**base, "institutionId": 456}))
        # Absent optionals are fine.
        self.assertIsNone(parse_webhook_payload(json.dumps(base)).error)
        # An EXPLICIT JSON null for an optional field is valid ("no value") and maps to None, exactly like
        # an absent field — rejecting it would break interop with serializers that emit null for optionals.
        p = parse_webhook_payload(json.dumps({**base, "error": None, "institutionId": None}))
        self.assertIsNone(p.error)
        self.assertIsNone(p.institution_id)


if __name__ == "__main__":
    unittest.main()
