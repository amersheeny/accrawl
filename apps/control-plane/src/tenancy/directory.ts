/**
 * Cell tenant directory.
 *
 * Self-hosted mode has one implicit tenant and needs no directory. Hosted cell mode
 * reads a root-owned JSON file populated by the proprietary provisioner. Secret
 * values may be supplied through sibling files so they never appear in the catalog.
 * Unknown hosts fail closed before authentication or database access.
 */
import { readFileSync } from 'node:fs';
import {
  CellTenantCatalogSchema,
  normalizeTenantHost,
  type CellTenantEntry,
} from '@accrawl/contracts';
import { config } from '../config';
import { selfHostedTenant, type TenantRuntime } from './context';

function readTrimmed(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`Tenant secret file is empty: ${path}`);
  return value;
}

function optionalSecret(
  inline: string | undefined,
  file: string | undefined,
): string | undefined {
  return inline ?? (file ? readTrimmed(file) : undefined);
}

function requiredSecret(
  tenantId: string,
  name: string,
  inline: string | undefined,
  file: string | undefined,
): string {
  const value = optionalSecret(inline, file);
  if (!value) {
    throw new Error(`Tenant ${tenantId} requires ${name} for the selected runtime`);
  }
  return value;
}

function requiredValue(
  tenantId: string,
  name: string,
  value: string | undefined,
): string {
  if (!value) {
    throw new Error(`Tenant ${tenantId} requires ${name} for the selected runtime`);
  }
  return value;
}

/** Normalize a Host header without ever accepting a path, userinfo, or malformed port. */
export function normalizeHost(raw: string): string | null {
  return normalizeTenantHost(raw);
}

export class TenantDirectory {
  private readonly byHost = new Map<string, TenantRuntime>();
  readonly tenants: readonly TenantRuntime[];

  constructor(tenants: readonly TenantRuntime[]) {
    const ids = new Set<string>();
    const identityTrustKeys = new Map<string, string>();
    for (const tenant of tenants) {
      if (ids.has(tenant.id)) throw new Error(`Duplicate tenant id: ${tenant.id}`);
      for (const [trustDomain, value] of [
        ['user', tenant.identityAssertionSecret],
        ['administrative', tenant.administrativeIdentityAssertionSecret],
      ] as const) {
        if (!value) continue;
        const owner = identityTrustKeys.get(value);
        if (owner) {
          throw new Error(
            `Identity assertion trust keys must be globally distinct; ${tenant.id}:${trustDomain} duplicates ${owner}`,
          );
        }
        identityTrustKeys.set(value, `${tenant.id}:${trustDomain}`);
      }
      ids.add(tenant.id);
      for (const rawHost of tenant.hosts) {
        const host = normalizeHost(rawHost);
        if (!host) throw new Error(`Invalid tenant host: ${rawHost}`);
        if (this.byHost.has(host)) throw new Error(`Duplicate tenant host: ${host}`);
        this.byHost.set(host, tenant);
      }
    }
    this.tenants = Object.freeze([...tenants]);
  }

  resolveHost(rawHost: string | undefined): TenantRuntime | null {
    if (!rawHost) return null;
    const host = normalizeHost(rawHost);
    return host ? this.byHost.get(host) ?? null : null;
  }
}

export interface TenantRuntimeSelection {
  /** The registered implementations this deployment selected. See the note in config. */
  persistenceBackend: string;
  engineDispatchMode: string;
  fallbackDatabaseUrl: string;
  fallbackEngineUrl: string;
}

export function tenantRuntimeFromCatalogEntry(
  entry: CellTenantEntry,
  selection: TenantRuntimeSelection,
): TenantRuntime {
  const usesPostgres = selection.persistenceBackend === 'postgres';
  const usesHttpEngine = selection.engineDispatchMode === 'http';
  const usesEphemeralWorker = !usesHttpEngine;
  const databaseUrl = optionalSecret(entry.databaseUrl, entry.databaseUrlFile);
  const engineSharedSecret = optionalSecret(
    entry.engineSharedSecret,
    entry.engineSharedSecretFile,
  );

  return {
    id: entry.id,
    hosts: entry.hosts.map((host) => normalizeHost(host)!),
    databaseUrl: usesPostgres
      ? requiredValue(entry.id, 'databaseUrl or databaseUrlFile', databaseUrl)
      : databaseUrl ?? selection.fallbackDatabaseUrl,
    engineUrl: entry.engineUrl ?? selection.fallbackEngineUrl,
    ...(usesHttpEngine
      ? {
        engineSharedSecret: requiredValue(
          entry.id,
          'engineSharedSecret or engineSharedSecretFile',
          engineSharedSecret,
        ),
      }
      : {}),
    engineWsUrl: entry.engineWsUrl,
    identityAssertionSecret: requiredSecret(
      entry.id,
      'identityAssertionSecret or identityAssertionSecretFile',
      entry.identityAssertionSecret,
      entry.identityAssertionSecretFile,
    ),
    administrativeIdentityAssertionSecret: requiredSecret(
      entry.id,
      'administrativeIdentityAssertionSecret or administrativeIdentityAssertionSecretFile',
      entry.administrativeIdentityAssertionSecret,
      entry.administrativeIdentityAssertionSecretFile,
    ),
    credentialEncryptionKey: requiredSecret(
      entry.id,
      'credentialEncryptionKey or credentialEncryptionKeyFile',
      entry.credentialEncryptionKey,
      entry.credentialEncryptionKeyFile,
    ),
    screenshotDir: entry.screenshotDir,
    ...(usesEphemeralWorker
      ? {
        screenshotBucket: requiredValue(
          entry.id,
          'screenshotBucket',
          entry.screenshotBucket,
        ),
        jobEncryptionKey: requiredSecret(
          entry.id,
          'jobEncryptionKey or jobEncryptionKeyFile',
          entry.jobEncryptionKey,
          entry.jobEncryptionKeyFile,
        ),
      }
      : {
        screenshotBucket: entry.screenshotBucket,
        jobEncryptionKey: optionalSecret(
          entry.jobEncryptionKey,
          entry.jobEncryptionKeyFile,
        ),
      }),
    screenshotPrefix: entry.screenshotPrefix,
  };
}

function loadDirectory(path: string): TenantDirectory {
  const parsed = CellTenantCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const tenants = parsed.tenants.map((entry) =>
    tenantRuntimeFromCatalogEntry(entry, {
      persistenceBackend: config.persistenceBackend,
      engineDispatchMode: config.engineDispatchMode,
      fallbackDatabaseUrl: config.databaseUrl,
      fallbackEngineUrl: config.engineUrl,
    }));
  return new TenantDirectory(tenants);
}

export const hostedCell = Boolean(config.tenantDirectoryFile);
export const tenantDirectory = hostedCell
  ? loadDirectory(config.tenantDirectoryFile!)
  : new TenantDirectory([selfHostedTenant()]);
export const fallbackTenant = tenantDirectory.tenants[0];
