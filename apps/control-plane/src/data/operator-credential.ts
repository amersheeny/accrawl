/**
 * Operator credential store — the single self-host admin credential set by the first-run setup flow.
 *
 * Exactly one row (id=1, DB-enforced by a CHECK). The admin password is stored ONLY as an argon2id hash,
 * never plaintext. `tokenSigningSecret` is a random secret minted at setup and used to HMAC-sign operator
 * session tokens, so re-running setup (or a future password change) invalidates outstanding tokens.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { operatorCredential } from '../db/schema';
import { hashPassword } from '../auth/password';

const SINGLETON_ID = 1;
const MIN_PASSWORD_LENGTH = 8;

export interface OperatorCredential {
  passwordHash: string;
  tokenSigningSecret: string;
}

export class OperatorSetupError extends Error {}
export class OperatorAlreadyInitializedError extends OperatorSetupError {
  constructor() {
    super('Operator is already initialized; setup can only run once.');
  }
}

/** The operator credential row, or null if first-run setup has not happened yet. */
export async function getOperatorCredential(db: Db): Promise<OperatorCredential | null> {
  const rows = await db
    .select({
      passwordHash: operatorCredential.passwordHash,
      tokenSigningSecret: operatorCredential.tokenSigningSecret,
    })
    .from(operatorCredential)
    .where(eq(operatorCredential.id, SINGLETON_ID))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether first-run setup has completed (an operator credential exists). */
export async function isOperatorInitialized(db: Db): Promise<boolean> {
  return (await getOperatorCredential(db)) !== null;
}

/**
 * First-run setup: hash the chosen password (argon2id), mint a token-signing secret, and insert the
 * singleton row. The insert is `ON CONFLICT DO NOTHING` on the primary key, so two setup requests racing
 * cannot both win — the loser gets `OperatorAlreadyInitializedError` instead of overwriting the admin
 * credential. Setup therefore runs exactly once. Returns the created credential so the caller can mint
 * the first session token.
 */
export async function initializeOperator(db: Db, password: string): Promise<OperatorCredential> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new OperatorSetupError(`Operator password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(password);
  const tokenSigningSecret = randomBytes(32).toString('hex');
  const inserted = await db
    .insert(operatorCredential)
    .values({ id: SINGLETON_ID, passwordHash, tokenSigningSecret })
    .onConflictDoNothing()
    .returning({
      passwordHash: operatorCredential.passwordHash,
      tokenSigningSecret: operatorCredential.tokenSigningSecret,
    });
  if (inserted.length === 0) {
    throw new OperatorAlreadyInitializedError();
  }
  return inserted[0];
}
