/**
 * Per-deployment IMAP config for the email-OTP tier. Single row (id=1). The IMAP password is envelope-
 * encrypted at rest (AAD-bound to this config field, so its ciphertext can't be copied elsewhere) and is
 * decrypted ONLY for the watcher via getEmailOtpConfigWithPassword — the operator-facing view never carries it.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailOtpConfig } from '../db/schema';
import { encryptSecret, decryptSecret } from '../crypto/cipher';

const CTX = { connectionId: 'email-otp-config', field: 'imap-password' } as const;

export interface EmailOtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folder?: string;
  enabled?: boolean;
}

/** Operator-facing view — NEVER includes the password (not even the ciphertext). */
export interface EmailOtpConfigView {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  folder: string;
  enabled: boolean;
  updatedAt: Date;
}

/** The watcher's view — includes the DECRYPTED password. */
export interface EmailOtpConfigWithPassword extends EmailOtpConfigView {
  password: string;
}

function toView(row: typeof emailOtpConfig.$inferSelect): EmailOtpConfigView {
  return { host: row.host, port: row.port, secure: row.secure, username: row.username, folder: row.folder, enabled: row.enabled, updatedAt: row.updatedAt };
}

export async function setEmailOtpConfig(db: Db, input: EmailOtpConfigInput): Promise<EmailOtpConfigView> {
  const passwordCt = encryptSecret(input.password, CTX);
  const folder = input.folder ?? 'INBOX';
  const enabled = input.enabled ?? true;
  const [row] = await db
    .insert(emailOtpConfig)
    .values({ id: 1, host: input.host, port: input.port, secure: input.secure, username: input.username, passwordCt, folder, enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: emailOtpConfig.id,
      set: { host: input.host, port: input.port, secure: input.secure, username: input.username, passwordCt, folder, enabled, updatedAt: new Date() },
    })
    .returning();
  return toView(row);
}

export async function getEmailOtpConfigView(db: Db): Promise<EmailOtpConfigView | null> {
  const [row] = await db.select().from(emailOtpConfig).where(eq(emailOtpConfig.id, 1)).limit(1);
  return row ? toView(row) : null;
}

/** For the watcher only: decrypts the password. Returns null if not configured. */
export async function getEmailOtpConfigWithPassword(db: Db): Promise<EmailOtpConfigWithPassword | null> {
  const [row] = await db.select().from(emailOtpConfig).where(eq(emailOtpConfig.id, 1)).limit(1);
  if (!row) return null;
  return { ...toView(row), password: decryptSecret(row.passwordCt, CTX) };
}

export async function deleteEmailOtpConfig(db: Db): Promise<boolean> {
  const deleted = await db.delete(emailOtpConfig).where(eq(emailOtpConfig.id, 1)).returning({ id: emailOtpConfig.id });
  return deleted.length > 0;
}
