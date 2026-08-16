/**
 * OpenAPI 3.1 description of the public PROVIDER API — the surface an integrating app (a consumer) uses via a
 * scoped API key: read the accounts, transactions and holdings Accrawl already retrieved. Served at
 * GET /api/openapi.json for docs + client-SDK generation.
 *
 * READ-ONLY AND CRAWL-FREE. Every documented endpoint is a GET. Retrieval — running a crawl, watching a
 * session, relaying a one-time passcode — is the deployment owner's own surface (their console, their paired
 * companion, and each connection's schedule) and appears nowhere in this contract. A consumer takes freshness
 * from the data itself: `lastSyncedAt` on a connection, `asOf` on a balance.
 *
 * This is HAND-AUTHORED (the routes validate with per-endpoint Zod, not Fastify schemas), so a route-drift
 * test (spec.test.ts) injects every documented path to prove none is a phantom, and asserts the known consumer
 * endpoints are all present — keeping the spec honest against the real routes.
 *
 * Operator-only endpoints (setup, login, api-key + webhook management, institutions/connections CRUD, crawl,
 * sessions, cancel, SSE) are intentionally NOT documented here: this file is the CONSUMER contract, not the
 * owner's console. Outbound webhooks are an owner feature too — only the owner can register one — and are
 * specified in docs/spec-data-api.md.
 */

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const pageParams = [
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
];

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Accrawl Data API',
    version: '2.0.0',
    description:
      'The consumer-facing API of an Accrawl deployment. It reads the account data Accrawl has already ' +
      'collected, and does nothing else: every endpoint is a GET, and there is no way through it to start a ' +
      'refresh, watch one in progress, or submit a one-time passcode. Those acts belong to the person whose ' +
      'accounts these are, and happen only in Accrawl itself.\n\n' +
      'Authenticate with a scoped API key or an OAuth access token; both are sent as ' +
      '`Authorization: Bearer acck_…`. A credential carries the `read:data` scope and a set of connection ' +
      'grants, and may read only the connections it was granted.\n\n' +
      'Typical flow: list the connections you were granted, then read their accounts, transactions (in full ' +
      'or by change cursor) and holdings. Connections refresh on their own schedule, so check how current ' +
      'the data is before you show it: `lastSyncedAt` on a connection, `asOf` on a balance.',
  },
  servers: [{ url: '/', description: 'This Accrawl deployment (front-door base URL).' }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'A scoped Accrawl credential: a manually issued API key or an OAuth access token, both sent as `Authorization: Bearer acck_…`. Missing/invalid → 401; valid but lacking `read:data` → 403; valid but not granted the connection → 403.',
      },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },

      // ── Normalized data contract (v1) — see docs/spec-data-api.md. Retrieval-neutral shapes. ──
      ContractBalance: {
        type: 'object',
        description: 'Native-currency balance. For credit accounts `current` is the amount owed (positive = debt).',
        properties: {
          current: { type: 'number', description: 'Booked/current balance.' },
          available: { type: 'number', description: 'Spendable incl. pending & overdraft/credit, when known.' },
          limit: { type: 'number', description: 'Credit limit / arranged overdraft, when known.' },
          asOf: { type: 'string', format: 'date-time', description: 'When the institution said this balance was observed. Absent when it did not say.' },
        },
        required: ['current'],
      },
      ContractAccount: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Accrawl-minted stable id.' },
          connectionId: { type: 'string' },
          type: { type: 'string', enum: ['depository', 'credit', 'investment', 'pension', 'loan', 'other'] },
          subtype: { type: 'string', description: 'Subtype scoped to `type` (e.g. current, credit_card, brokerage, defined_contribution).' },
          name: { type: 'string' },
          description: { type: 'string' },
          currency: { type: 'string', description: 'ISO 4217.' },
          balance: { $ref: '#/components/schemas/ContractBalance' },
          status: { type: 'string', enum: ['active', 'inactive'] },
          creditCardLiability: {
            type: 'object',
            description: 'Optional overlay, credit accounts only.',
            properties: {
              aprs: { type: 'array', items: { type: 'object', properties: { percentage: { type: 'number' }, type: { type: 'string', enum: ['purchase', 'cash', 'balance_transfer', 'penalty', 'other'] } }, required: ['percentage'] } },
              lastStatementDate: { type: 'string' },
              lastStatementBalance: { type: 'number' },
              minimumPaymentAmount: { type: 'number' },
              nextPaymentDueDate: { type: 'string' },
            },
          },
          pensionDetail: {
            type: 'object',
            description: 'Optional overlay, pension accounts only.',
            properties: {
              scheme: { type: 'string', enum: ['defined_benefit', 'defined_contribution', 'provident_fund', 'study_fund', 'other'] },
              employer: { type: 'string' },
              contributionsToDate: { type: 'number' },
              vestedValue: { type: 'number' },
            },
          },
        },
        required: ['id', 'connectionId', 'type', 'subtype', 'name', 'currency', 'balance', 'status'],
      },
      ContractTransaction: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Accrawl-minted stable id.' },
          accountId: { type: ['string', 'null'], description: 'Owning account id — the ContractAccount.id (minted), joins to the accounts endpoint; null if unlinked.' },
          providerTransactionId: { type: ['string', 'null'], description: 'Institution-supplied id, passthrough only.' },
          bookingDate: { type: 'string', description: 'YYYY-MM-DD.' },
          amount: { type: 'number', description: 'Signed, native currency; negative = outflow (bank-statement convention).' },
          currency: { type: 'string' },
          description: { type: 'string' },
          merchant: { type: 'string' },
          status: { type: 'string', enum: ['posted', 'pending'] },
          category: { type: 'object', properties: { primary: { type: 'string' }, detailed: { type: 'string' } }, required: ['primary'] },
          providerCategory: { type: 'string', description: 'Raw institution category label.' },
        },
        required: ['id', 'bookingDate', 'amount', 'currency', 'description', 'status'],
      },
      ContractSecurity: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable security id (ISIN › ticker+exchange › provider id).' },
          name: { type: 'string' },
          isin: { type: 'string' },
          ticker: { type: 'string' },
          exchange: { type: 'string', description: 'MIC or market code.' },
          securityType: { type: 'string', enum: ['equity', 'etf', 'mutual_fund', 'bond', 'cash', 'crypto', 'derivative', 'other'] },
        },
        required: ['id', 'name', 'securityType'],
      },
      ContractHolding: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          accountId: { type: ['string', 'null'], description: 'Owning account id — the ContractAccount.id (minted), joins to the accounts endpoint; null if unlinked.' },
          securityId: { type: 'string', description: 'References a ContractSecurity.id.' },
          quantity: { type: 'number' },
          value: { type: 'number', description: 'Market value, native currency.' },
          costBasis: { type: 'number' },
          currency: { type: 'string' },
        },
        required: ['id', 'securityId', 'quantity', 'value', 'currency'],
      },
      V1PaginatedAccounts: {
        type: 'object',
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ContractAccount' } }, hasMore: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
        required: ['items', 'hasMore', 'limit', 'offset'],
      },
      V1PaginatedTransactions: {
        type: 'object',
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ContractTransaction' } }, hasMore: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
        required: ['items', 'hasMore', 'limit', 'offset'],
      },
      V1Holdings: {
        type: 'object',
        properties: {
          holdings: { type: 'array', items: { $ref: '#/components/schemas/ContractHolding' } },
          securities: { type: 'array', items: { $ref: '#/components/schemas/ContractSecurity' } },
          hasMore: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' },
        },
        required: ['holdings', 'securities', 'hasMore', 'limit', 'offset'],
      },
      TransactionSyncPage: {
        type: 'object',
        description: 'Change cursor page. `removed` is always empty (transactions are upsert-only, never hard-deleted).',
        properties: {
          added: { type: 'array', items: { $ref: '#/components/schemas/ContractTransaction' } },
          modified: { type: 'array', items: { $ref: '#/components/schemas/ContractTransaction' } },
          removed: { type: 'array', items: { type: 'string' } },
          nextCursor: { type: 'string' },
          hasMore: { type: 'boolean' },
        },
        required: ['added', 'modified', 'removed', 'nextCursor', 'hasMore'],
      },
      ConnectionSummary: {
        type: 'object',
        description: 'One entry in the connection directory: the institution it links to (name, type and logo, ready to display), the connection’s status and nickname, and the day it last synced.',
        properties: {
          id: { type: 'string' },
          institutionId: { type: 'string', description: 'Stable slug — a lookup key, never a label to show a person.' },
          institutionName: { type: 'string', description: 'The institution’s display name.' },
          institutionType: { type: 'string', enum: ['bank', 'broker', 'retirement'] },
          institutionLogoUrl: { type: 'string', nullable: true, description: 'Institution logo URL, or null. Third-party content: Accrawl checks only that it is a well-formed URL. Use it as an image source; do not fetch it server-side or treat what it returns as trusted.' },
          status: { type: 'string', enum: ['connecting', 'connected', 'syncing', 'needs_reauth', 'error', 'disabled'] },
          nickname: { type: 'string', nullable: true },
          lastSyncedAt: { type: 'string', nullable: true, description: 'The UTC day (YYYY-MM-DD) this connection last synced successfully, or null if none has. Use it to show your users how current the data is.' },
        },
        required: ['id', 'institutionId', 'institutionName', 'institutionType', 'institutionLogoUrl', 'status', 'nickname', 'lastSyncedAt'],
      },
      V1ConnectionsList: {
        type: 'object',
        description: 'The connections this credential may read: only the ones it was granted.',
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ConnectionSummary' } } },
        required: ['items'],
      },
    },
  },
  paths: {
    // ── Normalized data contract (v1) — docs/spec-data-api.md. The whole public API. ──
    '/api/v1/connections': {
      get: {
        summary: 'List connections (directory)',
        description: 'The connections this credential may read: only the ones it was granted. Each entry carries the connection id, its institution’s name, type and logo, the status, the nickname, and the day it last synced. Requires read:data.',
        responses: {
          '200': { description: 'The connection directory.', content: { 'application/json': { schema: { $ref: '#/components/schemas/V1ConnectionsList' } } } },
          '401': errorResponse('Missing/invalid credentials.'),
          '403': errorResponse('Missing read:data scope.'),
        },
      },
    },
    '/api/v1/connections/{id}/accounts': {
      get: {
        summary: 'List a connection’s accounts (normalized)',
        description: 'Two-level type+subtype, balance triple, optional credit-card/pension overlays. Requires read:data and a grant for this connection.',
        parameters: [idParam, ...pageParams],
        responses: {
          '200': { description: 'A page of normalized accounts.', content: { 'application/json': { schema: { $ref: '#/components/schemas/V1PaginatedAccounts' } } } },
          '400': errorResponse('Invalid pagination.'),
          '401': errorResponse('Missing/invalid credentials.'),
          '403': errorResponse('Missing read:data scope, or the key does not grant this connection.'),
        },
      },
    },
    '/api/v1/connections/{id}/transactions': {
      get: {
        summary: 'List a connection’s transactions (normalized)',
        description: 'Offset-paginated, optionally windowed by from/to (YYYY-MM-DD, inclusive) on bookingDate. Requires read:data and a grant.',
        parameters: [
          idParam,
          { name: 'from', in: 'query', required: false, schema: { type: 'string' }, description: 'Inclusive lower bound on bookingDate (YYYY-MM-DD).' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string' }, description: 'Inclusive upper bound on bookingDate (YYYY-MM-DD).' },
          ...pageParams,
        ],
        responses: {
          '200': { description: 'A page of normalized transactions.', content: { 'application/json': { schema: { $ref: '#/components/schemas/V1PaginatedTransactions' } } } },
          '400': errorResponse('Invalid pagination or date.'),
          '401': errorResponse('Missing/invalid credentials.'),
          '403': errorResponse('Missing read:data scope, or the key does not grant this connection.'),
        },
      },
    },
    '/api/v1/connections/{id}/transactions/sync': {
      get: {
        summary: 'Transaction change cursor',
        description: 'Delta feed. Omit `cursor` for the full history; then chain `nextCursor`. Returns added/modified transactions and removed ids (always empty — transactions are never hard-deleted). Requires read:data and a grant.',
        parameters: [
          idParam,
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from a prior response’s nextCursor.' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': { description: 'A page of changes.', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionSyncPage' } } } },
          '400': errorResponse('Invalid cursor/limit.'),
          '401': errorResponse('Missing/invalid credentials.'),
          '403': errorResponse('Missing read:data scope, or the key does not grant this connection.'),
        },
      },
    },
    '/api/v1/connections/{id}/holdings': {
      get: {
        summary: 'List a connection’s holdings + securities',
        description: 'Holdings (account-linked) plus the de-duplicated securities they reference. Requires read:data and a grant.',
        parameters: [idParam, ...pageParams],
        responses: {
          '200': { description: 'A page of holdings + their securities.', content: { 'application/json': { schema: { $ref: '#/components/schemas/V1Holdings' } } } },
          '400': errorResponse('Invalid pagination.'),
          '401': errorResponse('Missing/invalid credentials.'),
          '403': errorResponse('Missing read:data scope, or the key does not grant this connection.'),
        },
      },
    },
  },
} as const;

/**
 * The consumer endpoints the spec MUST document — the drift test cross-checks these against paths.
 *
 * Every entry is a GET, and the drift test asserts that: the public API reads already-retrieved data and
 * never writes. Adding a non-GET entry here is a contract change, not a routine addition.
 */
export const DOCUMENTED_CONSUMER_ENDPOINTS: ReadonlyArray<{ method: 'get'; path: string }> = [
  { method: 'get', path: '/api/v1/connections' },
  { method: 'get', path: '/api/v1/connections/{id}/accounts' },
  { method: 'get', path: '/api/v1/connections/{id}/transactions' },
  { method: 'get', path: '/api/v1/connections/{id}/transactions/sync' },
  { method: 'get', path: '/api/v1/connections/{id}/holdings' },
];
