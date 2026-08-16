import type { Sql } from 'postgres';

/**
 * PostgreSQL requires an enum value to be committed before a later statement
 * can use it in an index predicate. Drizzle batches every pending migration in
 * one transaction, so an incremental 0012 -> latest upgrade cannot rely on the
 * 0013/0014 file boundary alone. Commit the additive value before invoking the
 * migrator; fresh databases do not have the type yet and safely skip this.
 */
export async function prepareSessionStatusEnum(sql: Sql): Promise<void> {
  await sql.unsafe(`
    DO $accrawl$
    BEGIN
      IF to_regtype('public.session_status') IS NOT NULL THEN
        ALTER TYPE public.session_status ADD VALUE IF NOT EXISTS 'cancelling';
      END IF;
    END
    $accrawl$;
  `);
}
