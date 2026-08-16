import type { IncomingHttpHeaders } from 'node:http';
import { INTERNAL_TENANT_HOST_HEADER } from '@accrawl/contracts';

/**
 * Select the logical tenant host without changing the transport Host used by
 * routing in front of it. The internal header is ignored unless the private core
 * explicitly enables it. Missing headers retain exact Host-based behavior;
 * ambiguous repeated internal headers fail closed.
 */
export function requestTenantHost(
  headers: IncomingHttpHeaders,
  trustInternalHeader: boolean,
): string | undefined {
  if (!trustInternalHeader) return headers.host;
  const internal = headers[INTERNAL_TENANT_HOST_HEADER];
  if (internal === undefined) return headers.host;
  return typeof internal === 'string' ? internal : undefined;
}
