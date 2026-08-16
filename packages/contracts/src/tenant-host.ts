import { isIP } from 'node:net';

/** A private internal caller uses this instead of overriding the transport Host. */
export const INTERNAL_TENANT_HOST_HEADER = 'x-accrawl-tenant-host';

/** Normalize an HTTP Host value without accepting paths, userinfo, or malformed ports. */
export function normalizeTenantHost(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || /[/\\@\s]/.test(value)) return null;
  const validPort = (port: string): boolean =>
    /^\d{1,5}$/.test(port) && Number.parseInt(port, 10) <= 65_535;
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    if (closing < 0) return null;
    const address = value.slice(1, closing);
    const suffix = value.slice(closing + 1);
    if (isIP(address) !== 6 || (suffix && (!suffix.startsWith(':') || !validPort(suffix.slice(1))))) {
      return null;
    }
    return address;
  }
  const colon = value.lastIndexOf(':');
  const hostname = colon > -1 ? value.slice(0, colon) : value;
  const port = colon > -1 ? value.slice(colon + 1) : undefined;
  if (port !== undefined && !validPort(port)) return null;
  if (isIP(hostname)) return hostname;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) || hostname.includes('..')) return null;
  return hostname;
}
