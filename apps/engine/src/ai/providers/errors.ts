/**
 * Typed AI-provider errors.
 *
 * ApiContractError marks a failure where the LLM provider rejected the request
 * because its request/response CONTRACT drifted (e.g. an unknown/renamed
 * parameter, an invalid_request, an unexpected shape). These are NOT transient —
 * retrying a malformed request is wasteful — and they must be classified
 * loudly (failureReason: 'api_contract_drift') so a schema-drift outage is
 * alertable immediately instead of surfacing as an opaque 400. This is the guard
 * against the tool_choice incident, where a silent schema change took every
 * crawl down with an unclassified 400.
 */

/** Signature of provider responses that indicate a request/response contract drift. */
export const API_CONTRACT_DRIFT_SIGNATURE = /unknown parameter|invalid_request|not supported|unexpected/i;

export class ApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiContractError';
  }
}

/** True when an error's message matches the contract-drift signature. */
export function isApiContractDriftMessage(message: string): boolean {
  return API_CONTRACT_DRIFT_SIGNATURE.test(message);
}
