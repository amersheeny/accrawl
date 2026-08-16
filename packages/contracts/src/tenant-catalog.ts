import { z } from 'zod';

export const CellTenantEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  hosts: z.array(z.string().min(1)).min(1),
  databaseUrl: z.string().min(1).optional(),
  databaseUrlFile: z.string().min(1).optional(),
  engineUrl: z.string().url().optional(),
  engineWsUrl: z.string().url().optional(),
  engineSharedSecret: z.string().min(1).optional(),
  engineSharedSecretFile: z.string().min(1).optional(),
  engineDatabasePassword: z.string().min(1).optional(),
  engineDatabasePasswordFile: z.string().min(1).optional(),
  engineDatabaseRole: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).optional(),
  identityAssertionSecret: z.string().min(1).optional(),
  identityAssertionSecretFile: z.string().min(1).optional(),
  administrativeIdentityAssertionSecret: z.string().min(1).optional(),
  administrativeIdentityAssertionSecretFile: z.string().min(1).optional(),
  credentialEncryptionKey: z.string().min(1).optional(),
  credentialEncryptionKeyFile: z.string().min(1).optional(),
  screenshotDir: z.string().min(1).optional(),
  screenshotBucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/).optional(),
  screenshotPrefix: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).optional(),
  workerSecretName: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).optional(),
  workerSecretProviderClass: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).optional(),
  workerServiceAccount: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).optional(),
  workerNamespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).optional(),
  cloudSqlInstance: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z0-9-]+:[a-z][a-z0-9-]{0,96}$/).optional(),
  jobEncryptionKey: z.string().min(1).optional(),
  jobEncryptionKeyFile: z.string().min(1).optional(),
  /** Closed wrappers can add identity/billing placement metadata without forking this contract. */
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((entry, ctx) => {
  for (const pair of [
    ['databaseUrl', 'databaseUrlFile'],
    ['engineSharedSecret', 'engineSharedSecretFile'],
    ['engineDatabasePassword', 'engineDatabasePasswordFile'],
    ['identityAssertionSecret', 'identityAssertionSecretFile'],
    [
      'administrativeIdentityAssertionSecret',
      'administrativeIdentityAssertionSecretFile',
    ],
    ['credentialEncryptionKey', 'credentialEncryptionKeyFile'],
    ['jobEncryptionKey', 'jobEncryptionKeyFile'],
  ] as const) {
    const [inline, file] = pair;
    if (entry[inline] && entry[file]) {
      ctx.addIssue({
        code: 'custom',
        path: [inline],
        message: `at most one of ${inline} or ${file} is allowed`,
      });
    }
  }
  if (entry.workerSecretName && entry.workerSecretProviderClass) {
    ctx.addIssue({
      code: 'custom',
      path: ['workerSecretName'],
      message: 'at most one of workerSecretName or workerSecretProviderClass is allowed',
    });
  }
});

export const CellTenantCatalogSchema = z.object({
  version: z.literal(1),
  tenants: z.array(CellTenantEntrySchema).min(1),
}).strict();

export type CellTenantEntry = z.infer<typeof CellTenantEntrySchema>;
export type CellTenantCatalog = z.infer<typeof CellTenantCatalogSchema>;
