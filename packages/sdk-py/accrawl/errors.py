"""Error raised for any non-2xx Accrawl API response."""

from __future__ import annotations

from typing import Any, Optional


class AccrawlApiError(Exception):
    """A non-2xx response. ``status`` is the HTTP status; ``body`` is the parsed JSON error body if present
    (typically ``{"error": str}``)."""

    def __init__(self, status: int, message: str, body: Optional[Any] = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body

    def __str__(self) -> str:
        return f"AccrawlApiError({self.status}): {super().__str__()}"
