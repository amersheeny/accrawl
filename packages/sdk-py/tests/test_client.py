import json
import unittest
from urllib.parse import parse_qs, urlparse

from accrawl import AccrawlApiError, AccrawlClient
from accrawl.models import ConnectionSummary, ContractAccount, ContractBalance, ContractTransaction


def make_transport(status, body):
    calls = []
    text = body if isinstance(body, str) else json.dumps(body)

    def transport(method, url, headers, payload):
        calls.append({"method": method, "url": url, "headers": headers, "body": payload})
        return status, text

    transport.calls = calls
    return transport


def client(transport):
    return AccrawlClient(base_url="https://acc.example.com/", api_key="acck_test", transport=transport)


def q(url):
    return parse_qs(urlparse(url).query)


class TestConstruction(unittest.TestCase):
    def test_requires_base_url_and_key(self):
        with self.assertRaises(ValueError):
            AccrawlClient(base_url="", api_key="k")
        with self.assertRaises(ValueError):
            AccrawlClient(base_url="https://x", api_key="")


class TestReadOnlySurface(unittest.TestCase):
    """The client reads already-retrieved data. Starting a retrieval, following a session and relaying a
    passcode are the account owner's, in their own console — there is no method for any of them, and every
    request the client can make is a GET."""

    def test_offers_no_retrieval_surface(self):
        c = client(make_transport(200, {}))
        for gone in ("trigger_crawl", "get_session", "submit_otp", "refresh_connection", "get_sync"):
            self.assertFalse(hasattr(c, gone), gone)

    def test_every_request_is_a_get_without_a_body(self):
        t = make_transport(200, {"items": [], "holdings": [], "securities": [], "hasMore": False, "limit": 50, "offset": 0})
        c = client(t)
        c.list_connections()
        c.list_accounts("c")
        c.list_transactions("c")
        c.list_holdings("c")
        self.assertEqual(len(t.calls), 4)
        for call in t.calls:
            self.assertEqual(call["method"], "GET")
            self.assertIsNone(call["body"])
        self.assertEqual(t.calls[0]["headers"]["authorization"], "Bearer acck_test")
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections")  # no double slash

    def test_url_encodes_path_ids(self):
        t = make_transport(200, {"items": [], "hasMore": False, "limit": 50, "offset": 0})
        client(t).list_accounts("a/b?x=1")
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections/a%2Fb%3Fx%3D1/accounts")


class TestConnections(unittest.TestCase):
    def test_list_connections_returns_typed_summaries(self):
        body = {"items": [
            {"id": "c1", "institutionId": "bk", "institutionName": "Bank Co", "institutionType": "bank",
             "institutionLogoUrl": "https://cdn.example/bk.svg", "status": "connected", "nickname": "Everyday",
             "lastSyncedAt": "2026-07-01"},
            {"id": "c2", "institutionId": "bk", "institutionName": "Bank Co", "institutionType": "bank",
             "institutionLogoUrl": None, "status": "needs_reauth", "nickname": None, "lastSyncedAt": None},
        ]}
        t = make_transport(200, body)
        conns = client(t).list_connections()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections")
        self.assertEqual(len(conns), 2)
        self.assertIsInstance(conns[0], ConnectionSummary)
        self.assertEqual(conns[0].id, "c1")
        self.assertEqual(conns[0].institution_id, "bk")  # camelCase wire → snake_case attr
        self.assertEqual(conns[0].status, "connected")
        self.assertEqual(conns[0].last_synced_at, "2026-07-01")
        # What a consumer displays: the institution's name, never its slug.
        self.assertEqual(conns[0].institution_name, "Bank Co")
        self.assertEqual(conns[0].institution_type, "bank")
        self.assertEqual(conns[0].institution_logo_url, "https://cdn.example/bk.svg")
        self.assertIsNone(conns[1].institution_logo_url)
        self.assertIsNone(conns[1].nickname)
        self.assertIsNone(conns[1].last_synced_at)

    def test_list_connections_malformed_items_raises(self):
        t = make_transport(200, {"items": "nope"})
        with self.assertRaises(ValueError):
            client(t).list_connections()


class TestAccounts(unittest.TestCase):
    def test_accounts_flat_records_with_nested_balance_and_overlays(self):
        page = {
            "items": [
                {
                    "id": "a1", "connectionId": "c", "type": "credit", "subtype": "credit_card", "name": "Card",
                    "currency": "GBP", "status": "active",
                    "balance": {"current": 1200.5, "available": 300.0, "limit": 1500.0, "asOf": "2026-07-01T00:00:00Z"},
                    "creditCardLiability": {"aprs": [{"percentage": 19.9, "type": "purchase"}], "minimumPaymentAmount": 25.0},
                },
            ],
            "hasMore": True, "limit": 10, "offset": 20,
        }
        t = make_transport(200, page)
        r = client(t).list_accounts("conn_1", limit=10, offset=20)
        self.assertTrue(r.has_more)
        self.assertEqual(r.limit, 10)
        self.assertEqual(r.offset, 20)
        acct = r.items[0]
        self.assertIsInstance(acct, ContractAccount)
        self.assertEqual(acct.id, "a1")  # the id is inline on the record (no {id, data} wrapper)
        self.assertEqual(acct.type, "credit")
        self.assertEqual(acct.subtype, "credit_card")
        self.assertIsInstance(acct.balance, ContractBalance)
        self.assertEqual(acct.balance.current, 1200.5)
        self.assertEqual(acct.balance.as_of, "2026-07-01T00:00:00Z")
        self.assertEqual(acct.credit_card_liability.minimum_payment_amount, 25.0)
        self.assertEqual(acct.credit_card_liability.aprs, [{"percentage": 19.9, "type": "purchase"}])  # aprs stay plain dicts
        self.assertIsNone(acct.pension_detail)  # absent overlay → None
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections/conn_1/accounts?limit=10&offset=20")

    def test_accounts_no_pagination_args_omits_query(self):
        t = make_transport(200, {"items": [], "hasMore": False, "limit": 50, "offset": 0})
        client(t).list_accounts("c")
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections/c/accounts")


class TestTransactions(unittest.TestCase):
    def test_transactions_window_and_mapping(self):
        page = {
            "items": [{"id": "t1", "accountId": None, "providerTransactionId": "p9", "bookingDate": "2026-03-02", "amount": -42.5, "currency": "GBP", "description": "Coffee", "status": "posted", "category": {"primary": "food"}}],
            "hasMore": False, "limit": 100, "offset": 0,
        }
        t = make_transport(200, page)
        r = client(t).list_transactions("c", limit=100, from_="2026-01-01", to="2026-06-30")
        txn = r.items[0]
        self.assertIsInstance(txn, ContractTransaction)
        self.assertEqual(txn.amount, -42.5)
        self.assertIsNone(txn.account_id)
        self.assertEqual(txn.provider_transaction_id, "p9")
        self.assertEqual(txn.category, {"primary": "food"})
        # from_/to map to the wire keys `from`/`to`
        query = q(t.calls[0]["url"])
        self.assertEqual(query["limit"], ["100"])
        self.assertEqual(query["from"], ["2026-01-01"])
        self.assertEqual(query["to"], ["2026-06-30"])
        self.assertTrue(urlparse(t.calls[0]["url"]).path.endswith("/api/v1/connections/c/transactions"))


class TestSync(unittest.TestCase):
    def test_sync_cursor_page(self):
        body = {
            "added": [{"id": "t1", "bookingDate": "2026-03-02", "amount": 10.0, "currency": "GBP", "description": "x", "status": "posted"}],
            "modified": [], "removed": ["gone-1"], "nextCursor": "cur_2", "hasMore": True,
        }
        t = make_transport(200, body)
        r = client(t).sync_transactions("c", cursor="cur_1", limit=50)
        self.assertEqual(r.next_cursor, "cur_2")
        self.assertTrue(r.has_more)
        self.assertEqual(len(r.added), 1)
        self.assertIsInstance(r.added[0], ContractTransaction)
        self.assertEqual(r.removed, ["gone-1"])
        query = q(t.calls[0]["url"])
        self.assertEqual(query["cursor"], ["cur_1"])
        self.assertEqual(query["limit"], ["50"])
        self.assertTrue(urlparse(t.calls[0]["url"]).path.endswith("/api/v1/connections/c/transactions/sync"))

    def test_sync_first_page_omits_cursor(self):
        t = make_transport(200, {"added": [], "modified": [], "removed": [], "nextCursor": "cur_1", "hasMore": False})
        client(t).sync_transactions("c")
        self.assertEqual(urlparse(t.calls[0]["url"]).query, "")


class TestHoldings(unittest.TestCase):
    def test_holdings_and_securities(self):
        body = {
            "holdings": [{"id": "h1", "accountId": "a1", "securityId": "s1", "quantity": 3.0, "value": 300.0, "currency": "USD", "costBasis": 250.0}],
            "securities": [{"id": "s1", "name": "Acme", "securityType": "equity", "ticker": "ACME", "isin": "US000"}],
            "hasMore": False, "limit": 50, "offset": 0,
        }
        t = make_transport(200, body)
        r = client(t).list_holdings("c")
        self.assertEqual(r.holdings[0].security_id, "s1")
        self.assertEqual(r.holdings[0].cost_basis, 250.0)
        self.assertEqual(r.securities[0].security_type, "equity")
        self.assertEqual(r.securities[0].ticker, "ACME")
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/api/v1/connections/c/holdings")


class TestErrors(unittest.TestCase):
    def test_maps_non_2xx_json_error(self):
        t = make_transport(403, {"error": "missing read:data scope"})
        with self.assertRaises(AccrawlApiError) as ctx:
            client(t).list_accounts("c")
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn("missing read:data", str(ctx.exception))
        self.assertEqual(ctx.exception.body, {"error": "missing read:data scope"})

    def test_non_json_error_body_generic_message(self):
        t = make_transport(500, "internal server error")
        with self.assertRaises(AccrawlApiError) as ctx:
            client(t).list_connections()
        self.assertEqual(ctx.exception.status, 500)
        self.assertIn("HTTP 500", str(ctx.exception))

    def test_malformed_page_missing_items_raises_not_silent_empty(self):
        # A paginated response missing "items" must surface, not look like "0 records".
        t = make_transport(200, {"hasMore": False, "limit": 10, "offset": 0})
        with self.assertRaises(KeyError):
            client(t).list_accounts("c")
        t2 = make_transport(200, {"items": "not-a-list", "hasMore": False, "limit": 10, "offset": 0})
        with self.assertRaises(ValueError):
            client(t2).list_transactions("c")
        # A stringly-typed hasMore ("false" is truthy) must be rejected, not coerced to has_more=True.
        t3 = make_transport(200, {"items": [], "hasMore": "false", "limit": 10, "offset": 0})
        with self.assertRaises(ValueError):
            client(t3).list_accounts("c")

    def test_holdings_missing_securities_surfaces(self):
        t = make_transport(200, {"holdings": [], "hasMore": False, "limit": 10, "offset": 0})
        with self.assertRaises(KeyError):
            client(t).list_holdings("c")


if __name__ == "__main__":
    unittest.main()
