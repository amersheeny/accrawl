/**
 * @accrawl/sdk — official TypeScript client for the Accrawl Data API.
 *
 *   import { AccrawlClient } from '@accrawl/sdk';
 *   const accrawl = new AccrawlClient({ baseUrl: 'https://accrawl.example.com', apiKey: process.env.ACCRAWL_KEY! });
 *   const { items } = await accrawl.listConnections();
 *   const accounts = await accrawl.listAccounts(items[0].id);
 *
 * The API reads the data Accrawl has already retrieved. Retrieval itself — running a crawl, following a
 * session, relaying a one-time passcode — belongs to the account owner in their own console, so no client
 * method exists for it.
 */
export { AccrawlClient, ACCRAWL_ENDPOINTS } from './client';
export type { AccrawlClientOptions, Page, TransactionQuery, SyncCursor } from './client';
export { AccrawlOAuthClient, generatePkce } from './oauth';
export type {
  AccrawlOAuthOptions, StartAuthorizationOptions, StartedAuthorization, OAuthTokenResponse, PkcePair,
} from './oauth';
export { AccrawlApiError } from './errors';
export {
  verifyWebhookSignature, computeWebhookSignature, parseWebhookPayload, parseNormalizedWebhookPayload,
} from './webhooks';
export type { VerifyWebhookOptions } from './webhooks';
export type {
  ConnectionSummary,
  CrawlWebhookPayload,
  // Normalized data contract (v1)
  AccountType,
  SecurityType,
  CreditCardLiability,
  PensionDetail,
  ContractBalance,
  ContractAccount,
  ContractTransaction,
  ContractSecurity,
  ContractHolding,
  ContractPage,
  HoldingsPage,
  TransactionSyncPage,
  SyncWebhookPayload,
  TransactionsUpdatedPayload,
  ConnectionStatusChangedPayload,
  NormalizedWebhookPayload,
} from './types';
