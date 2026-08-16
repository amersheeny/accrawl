import base64
import hashlib
import json
import unittest
from urllib.parse import parse_qs, urlparse

from accrawl import AccrawlApiError, AccrawlOAuthClient, generate_pkce


def make_transport(status, body):
    calls = []
    text = body if isinstance(body, str) else json.dumps(body)

    def transport(method, url, headers, payload):
        calls.append({"method": method, "url": url, "headers": headers, "body": payload})
        return status, text

    transport.calls = calls
    return transport


def oauth(transport, client_secret="acls_secret"):
    return AccrawlOAuthClient(
        base_url="https://acc.example.com/",
        client_id="accl_test",
        client_secret=client_secret,
        redirect_uri="https://app.example.com/callback",
        transport=transport,
    )


def body_params(call):
    return parse_qs(call["body"].decode("utf-8"))


class TestGeneratePkce(unittest.TestCase):
    def test_verifier_is_43_char_base64url_and_challenge_is_its_s256(self):
        p = generate_pkce()
        self.assertEqual(p.code_challenge_method, "S256")
        self.assertRegex(p.code_verifier, r"^[A-Za-z0-9_-]{43}$")
        expected = base64.urlsafe_b64encode(hashlib.sha256(p.code_verifier.encode("ascii")).digest()).rstrip(b"=").decode()
        self.assertEqual(p.code_challenge, expected)

    def test_random_per_call(self):
        self.assertNotEqual(generate_pkce().code_verifier, generate_pkce().code_verifier)


class TestConstruction(unittest.TestCase):
    def test_requires_base_url_client_id_redirect_uri(self):
        with self.assertRaises(ValueError):
            AccrawlOAuthClient(base_url="", client_id="c", redirect_uri="r")
        with self.assertRaises(ValueError):
            AccrawlOAuthClient(base_url="https://x", client_id="", redirect_uri="r")
        with self.assertRaises(ValueError):
            AccrawlOAuthClient(base_url="https://x", client_id="c", redirect_uri="")


class TestStartAuthorization(unittest.TestCase):
    def test_builds_authorize_url_with_pkce_and_returns_state_and_verifier(self):
        started = oauth(make_transport(200, {})).start_authorization(scope="read:data", state="st-123")
        u = urlparse(started.url)
        self.assertEqual(f"{u.scheme}://{u.netloc}{u.path}", "https://acc.example.com/oauth/authorize")  # slash stripped
        q = parse_qs(u.query)
        self.assertEqual(q["response_type"], ["code"])
        self.assertEqual(q["client_id"], ["accl_test"])
        self.assertEqual(q["redirect_uri"], ["https://app.example.com/callback"])
        self.assertEqual(q["scope"], ["read:data"])
        self.assertEqual(q["state"], ["st-123"])
        self.assertEqual(q["code_challenge_method"], ["S256"])
        expected = base64.urlsafe_b64encode(hashlib.sha256(started.code_verifier.encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(q["code_challenge"], [expected])

    def test_joins_list_scopes_and_autogenerates_state(self):
        started = oauth(make_transport(200, {})).start_authorization(scope=["read:data", "write:otp"])
        q = parse_qs(urlparse(started.url).query)
        self.assertEqual(q["scope"], ["read:data write:otp"])
        self.assertRegex(started.state, r"^[A-Za-z0-9_-]+$")
        self.assertGreater(len(started.state), 10)

    def test_defaults_scope_to_read_data(self):
        started = oauth(make_transport(200, {})).start_authorization()
        self.assertEqual(parse_qs(urlparse(started.url).query)["scope"], ["read:data"])


TOKEN_BODY = {
    "access_token": "acck_abc",
    "token_type": "Bearer",
    "expires_in": 7776000,
    "refresh_token": "acrt_xyz",
    "scope": "read:data",
}


class TestExchangeCode(unittest.TestCase):
    def test_posts_form_authorization_code_with_secret_and_verifier(self):
        t = make_transport(200, TOKEN_BODY)
        tok = oauth(t).exchange_code(code="the-code", code_verifier="the-verifier")
        self.assertEqual(tok, TOKEN_BODY)
        c = t.calls[0]
        self.assertEqual(c["url"], "https://acc.example.com/oauth/token")
        self.assertEqual(c["method"], "POST")
        self.assertEqual(c["headers"]["content-type"], "application/x-www-form-urlencoded")
        p = body_params(c)
        self.assertEqual(p["grant_type"], ["authorization_code"])
        self.assertEqual(p["code"], ["the-code"])
        self.assertEqual(p["code_verifier"], ["the-verifier"])
        self.assertEqual(p["redirect_uri"], ["https://app.example.com/callback"])  # constructor default
        self.assertEqual(p["client_id"], ["accl_test"])
        self.assertEqual(p["client_secret"], ["acls_secret"])

    def test_public_client_sends_no_secret(self):
        t = make_transport(200, TOKEN_BODY)
        oauth(t, client_secret=None).exchange_code(code="c", code_verifier="v")
        p = body_params(t.calls[0])
        self.assertEqual(p["client_id"], ["accl_test"])
        self.assertNotIn("client_secret", p)

    def test_honours_explicit_redirect_uri(self):
        t = make_transport(200, TOKEN_BODY)
        oauth(t).exchange_code(code="c", code_verifier="v", redirect_uri="https://other/cb")
        self.assertEqual(body_params(t.calls[0])["redirect_uri"], ["https://other/cb"])

    def test_raises_with_error_description(self):
        t = make_transport(400, {"error": "invalid_grant", "error_description": "authorization code expired"})
        with self.assertRaises(AccrawlApiError) as ctx:
            oauth(t).exchange_code(code="c", code_verifier="v")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(str(ctx.exception), "AccrawlApiError(400): authorization code expired")


class TestRefresh(unittest.TestCase):
    def test_posts_refresh_token_grant(self):
        t = make_transport(200, {**TOKEN_BODY, "access_token": "acck_new", "refresh_token": "acrt_new"})
        tok = oauth(t).refresh(refresh_token="acrt_old")
        self.assertEqual(tok["access_token"], "acck_new")
        p = body_params(t.calls[0])
        self.assertEqual(t.calls[0]["url"], "https://acc.example.com/oauth/token")
        self.assertEqual(p["grant_type"], ["refresh_token"])
        self.assertEqual(p["refresh_token"], ["acrt_old"])
        self.assertEqual(p["client_secret"], ["acls_secret"])

    def test_reuse_detection_raises(self):
        t = make_transport(400, {"error": "invalid_grant", "error_description": "refresh token reuse detected; grant revoked"})
        with self.assertRaises(AccrawlApiError) as ctx:
            oauth(t).refresh(refresh_token="acrt_replayed")
        self.assertEqual(ctx.exception.status, 400)


class TestRevoke(unittest.TestCase):
    def test_posts_token_and_hint(self):
        t = make_transport(200, {})
        oauth(t).revoke(token="acrt_x", token_type_hint="refresh_token")
        c = t.calls[0]
        self.assertEqual(c["url"], "https://acc.example.com/oauth/revoke")
        p = body_params(c)
        self.assertEqual(p["token"], ["acrt_x"])
        self.assertEqual(p["token_type_hint"], ["refresh_token"])
        self.assertEqual(p["client_id"], ["accl_test"])

    def test_omits_hint_when_absent(self):
        t = make_transport(200, {})
        oauth(t).revoke(token="acck_y")
        self.assertNotIn("token_type_hint", body_params(t.calls[0]))

    def test_raises_on_non_2xx(self):
        t = make_transport(401, {"error": "invalid_client", "error_description": "bad client credentials"})
        with self.assertRaises(AccrawlApiError) as ctx:
            oauth(t).revoke(token="t")
        self.assertEqual(ctx.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
