"""The "Connect with Accrawl" OAuth 2.0 client — the server side of the Authorization-Code + PKCE flow a
third-party app uses to get an access token for a user's Accrawl connections.

The dance (see docs/spec-oauth.md):
  1. ``start_authorization()`` → redirect the user's browser to the returned ``url`` (Accrawl's consent page).
     Persist the returned ``state`` + ``code_verifier`` against the user's session.
  2. Accrawl redirects back to your redirect_uri with ``?code&state``. Check ``state`` matches, then
     ``exchange_code(code, code_verifier)`` → a dict with access_token / refresh_token / expires_in / scope.
  3. The access_token IS an Accrawl API key (``acck_…``) — hand it to ``AccrawlClient(api_key=...)`` to read
     the consented data. When it nears expiry, ``refresh(refresh_token)`` rotates the pair.
  4. On disconnect, ``revoke(token)`` the refresh token to drop the whole grant.

PKCE (S256) is MANDATORY for every client — Accrawl rejects an authorize request without a code_challenge.
Because the code exchange presents the client_secret, this helper is SERVER-SIDE: a secret must never reach a
browser. A public client omits ``client_secret``.

Stdlib-only: HTTP via urllib, PKCE via hashlib/secrets. Pass a custom ``transport`` to inject one (e.g. tests).
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import urllib.parse
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from .client import Transport, _default_transport, _safe_json
from .errors import AccrawlApiError


@dataclass
class PkcePair:
    """A PKCE pair: keep ``code_verifier`` server-side; send ``code_challenge`` (+ method) at authorize."""

    code_verifier: str
    code_challenge: str
    code_challenge_method: str  # "S256"


@dataclass
class StartedAuthorization:
    """What ``start_authorization`` returns: the URL to redirect the browser to, plus the two values you must
    persist against the user's session to complete the flow (``state`` for CSRF, ``code_verifier`` to exchange)."""

    url: str
    state: str
    code_verifier: str


def generate_pkce() -> PkcePair:
    """Generate a PKCE pair: a high-entropy verifier (43-char base64url, the RFC 7636 unreserved set) and its
    S256 challenge. Exported standalone so a caller can drive ``build_authorization_url`` manually."""
    code_verifier = secrets.token_urlsafe(32)  # 32 bytes → 43 base64url chars, unreserved
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return PkcePair(code_verifier=code_verifier, code_challenge=code_challenge, code_challenge_method="S256")


def _scope_to_str(scope: Union[str, List[str], None]) -> str:
    if scope is None:
        return "read:data"
    if isinstance(scope, (list, tuple)):
        return " ".join(scope)
    return scope


class AccrawlOAuthClient:
    def __init__(
        self,
        base_url: str,
        client_id: str,
        redirect_uri: str,
        client_secret: Optional[str] = None,
        transport: Optional[Transport] = None,
    ) -> None:
        if not base_url:
            raise ValueError("AccrawlOAuthClient: base_url is required")
        if not client_id:
            raise ValueError("AccrawlOAuthClient: client_id is required")
        if not redirect_uri:
            raise ValueError("AccrawlOAuthClient: redirect_uri is required")
        self._base_url = base_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._redirect_uri = redirect_uri
        self._transport = transport or _default_transport

    def start_authorization(
        self,
        scope: Union[str, List[str], None] = None,
        state: Optional[str] = None,
    ) -> StartedAuthorization:
        """Begin an authorization: generate PKCE + a CSRF ``state`` and build the /oauth/authorize URL to
        redirect the browser to. Returns the URL plus the ``state`` and ``code_verifier`` you MUST persist
        (keyed to the user's session) so ``exchange_code`` can complete the flow on the redirect back."""
        pkce = generate_pkce()
        st = state if state is not None else secrets.token_urlsafe(16)
        url = self.build_authorization_url(
            state=st, code_challenge=pkce.code_challenge, scope=scope,
            code_challenge_method=pkce.code_challenge_method,
        )
        return StartedAuthorization(url=url, state=st, code_verifier=pkce.code_verifier)

    def build_authorization_url(
        self,
        state: str,
        code_challenge: str,
        scope: Union[str, List[str], None] = None,
        code_challenge_method: str = "S256",
    ) -> str:
        """Lower-level: build the /oauth/authorize URL from an explicit challenge + state (use when you manage
        PKCE and state yourself). Prefer ``start_authorization``, which generates and returns them for you."""
        params = {
            "response_type": "code",
            "client_id": self._client_id,
            "redirect_uri": self._redirect_uri,
            "scope": _scope_to_str(scope),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }
        return f"{self._base_url}/oauth/authorize?{urllib.parse.urlencode(params)}"

    def exchange_code(self, code: str, code_verifier: str, redirect_uri: Optional[str] = None) -> Dict[str, Any]:
        """Exchange the single-use authorization ``code`` for tokens (RFC 6749 §4.1.3). Presents the
        client_secret (confidential clients) and the PKCE ``code_verifier`` that pairs with the challenge you
        sent at authorize. ``redirect_uri`` defaults to the one this client was constructed with; Accrawl
        requires it to match the authorize request exactly."""
        return self._form_post(
            "/oauth/token",
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri if redirect_uri is not None else self._redirect_uri,
                "code_verifier": code_verifier,
            },
        )

    def refresh(self, refresh_token: str) -> Dict[str, Any]:
        """Rotate the token pair (RFC 6749 §6). Returns a NEW access + refresh token; the presented refresh
        token is consumed. Replaying a consumed refresh token is treated as theft and revokes the whole grant."""
        return self._form_post("/oauth/token", {"grant_type": "refresh_token", "refresh_token": refresh_token})

    def revoke(self, token: str, token_type_hint: Optional[str] = None) -> None:
        """Revoke a token (RFC 7009). Revoking a refresh token drops the whole grant (its access + refresh
        tokens); revoking an access token drops just that token. Returns for any well-formed request — the
        endpoint gives no token-existence oracle — so success does not confirm the token existed."""
        fields = {"token": token}
        if token_type_hint:
            fields["token_type_hint"] = token_type_hint
        self._form_post("/oauth/revoke", fields)

    def _form_post(self, path: str, fields: Dict[str, str]) -> Dict[str, Any]:
        """urlencoded POST to an OAuth endpoint with client_secret_post auth; raises AccrawlApiError on non-2xx."""
        payload = dict(fields)
        payload["client_id"] = self._client_id
        # client_secret_post: confidential clients present the secret in the body; public clients present none.
        if self._client_secret:
            payload["client_secret"] = self._client_secret
        body = urllib.parse.urlencode(payload).encode("utf-8")
        headers = {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"}
        status, text = self._transport("POST", f"{self._base_url}{path}", headers, body)
        parsed = _safe_json(text) if text else None
        if status < 200 or status >= 300:
            # OAuth errors are ``{ error, error_description }`` (RFC 6749 §5.2) — surface the description.
            message = f"Accrawl OAuth error (HTTP {status})"
            if isinstance(parsed, dict):
                if isinstance(parsed.get("error_description"), str):
                    message = parsed["error_description"]
                elif isinstance(parsed.get("error"), str):
                    message = parsed["error"]
            raise AccrawlApiError(status, message, parsed)
        return parsed if isinstance(parsed, dict) else {}
