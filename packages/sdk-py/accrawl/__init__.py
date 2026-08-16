"""accrawl — official Python client for the Accrawl Data API. Stdlib-only (no dependencies).

    from accrawl import AccrawlClient
    accrawl = AccrawlClient(base_url="https://accrawl.example.com", api_key=os.environ["ACCRAWL_KEY"])
    connections = accrawl.list_connections()
    accounts = accrawl.list_accounts(connections[0].id)

The API reads the data Accrawl has already retrieved. Retrieval itself — running a crawl, following a
session, relaying a one-time passcode — belongs to the account owner in their own console, so no client
method exists for it.
"""

from .client import ACCRAWL_ENDPOINTS, AccrawlClient
from .errors import AccrawlApiError
from .models import (
    ConnectionSummary,
    ContractAccount,
    ContractBalance,
    ContractHolding,
    ContractPage,
    ContractSecurity,
    ContractTransaction,
    CreditCardLiability,
    CrawlWebhookPayload,
    HoldingsPage,
    PensionDetail,
    TransactionSyncPage,
)
from .oauth import (
    AccrawlOAuthClient,
    PkcePair,
    StartedAuthorization,
    generate_pkce,
)
from .webhooks import (
    compute_webhook_signature,
    parse_webhook_payload,
    verify_webhook_signature,
)

__all__ = [
    "AccrawlClient",
    "ACCRAWL_ENDPOINTS",
    "AccrawlApiError",
    # Normalized data contract (v1)
    "ContractAccount",
    "ContractBalance",
    "CreditCardLiability",
    "PensionDetail",
    "ContractTransaction",
    "ContractSecurity",
    "ContractHolding",
    "ContractPage",
    "HoldingsPage",
    "TransactionSyncPage",
    "ConnectionSummary",
    "CrawlWebhookPayload",
    # OAuth
    "AccrawlOAuthClient",
    "generate_pkce",
    "PkcePair",
    "StartedAuthorization",
    # Webhooks
    "verify_webhook_signature",
    "compute_webhook_signature",
    "parse_webhook_payload",
]

__version__ = "0.1.0"
