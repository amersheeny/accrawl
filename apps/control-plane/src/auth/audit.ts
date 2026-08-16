/**
 * Append-only audit trail for sensitive admin actions.
 *
 * `writeAudit` records WHO did WHAT to WHICH target from WHERE, into the write-only `audit_log` table. It is
 * BEST-EFFORT: the audit write must never fail (or delay) the action it records, so a failed insert is
 * caught and logged — never thrown and never silently swallowed. Callers `await` it so the row is on disk
 * before the response when the DB is healthy, but a DB hiccup still lets the main action's result stand.
 */
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  /** Who acted: an operator, paired device, API key, OAuth client, or internal system task. */
  actorType: 'operator' | 'device' | 'api_key' | 'oauth_client' | 'system';
  /** The actor's id when one exists (device id, api-key id); null for the single anonymous operator. */
  actorId?: string | null;
  /** Dotted action name, e.g. 'connection.create', 'api_key.revoke', 'session.cancel'. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** The proxied client IP (req.ip — trustProxy-resolved). */
  sourceIp?: string | null;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      sourceIp: entry.sourceIp ?? null,
    });
  } catch (err) {
    // Never block the audited action on the audit write, but surface the failure (no silent swallow).
    // eslint-disable-next-line no-console
    console.warn(`[audit] failed to record ${entry.action}:`, err);
  }
}
