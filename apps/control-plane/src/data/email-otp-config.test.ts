import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { setEmailOtpConfig, getEmailOtpConfigView, getEmailOtpConfigWithPassword, deleteEmailOtpConfig } from './email-otp-config';

describe('email-otp config (pglite, encrypted at rest)', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    process.env.CREDENTIAL_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); delete process.env.CREDENTIAL_ENC_KEY; });
  beforeEach(async () => { await client.exec('truncate email_otp_config'); });

  const input = { host: 'imap.example.com', port: 993, secure: true, username: 'otp@example.com', password: 'super-secret-imap-pw', folder: 'INBOX', enabled: true };

  it('stores the password ENCRYPTED (never plaintext) and round-trips it for the watcher', async () => {
    const view = await setEmailOtpConfig(db, input);
    expect(view).not.toHaveProperty('password'); // the operator view never carries the password

    // The raw column is ciphertext, not the plaintext.
    const { rows: [row] } = await client.query<{ password_ct: string }>('select password_ct from email_otp_config where id = 1');
    expect(row.password_ct).not.toContain('super-secret-imap-pw');

    // The watcher path decrypts it back exactly.
    const withPw = await getEmailOtpConfigWithPassword(db);
    expect(withPw?.password).toBe('super-secret-imap-pw');
    expect(withPw?.host).toBe('imap.example.com');
    expect(withPw?.port).toBe(993);
  });

  it('is a singleton: a second set UPDATES the one row (no duplicate)', async () => {
    await setEmailOtpConfig(db, input);
    await setEmailOtpConfig(db, { ...input, host: 'imap2.example.com', password: 'new-pw', enabled: false });
    const { rows: [{ count }] } = await client.query<{ count: string }>('select count(*)::text as count from email_otp_config');
    expect(count).toBe('1');
    const withPw = await getEmailOtpConfigWithPassword(db);
    expect(withPw?.host).toBe('imap2.example.com');
    expect(withPw?.password).toBe('new-pw');
    expect(withPw?.enabled).toBe(false);
  });

  it('getView omits the password; delete clears it', async () => {
    await setEmailOtpConfig(db, input);
    const view = await getEmailOtpConfigView(db);
    expect(view).toMatchObject({ host: 'imap.example.com', port: 993, secure: true, username: 'otp@example.com', folder: 'INBOX', enabled: true });
    expect(Object.keys(view ?? {})).not.toContain('password');

    expect(await deleteEmailOtpConfig(db)).toBe(true);
    expect(await getEmailOtpConfigView(db)).toBeNull();
    expect(await getEmailOtpConfigWithPassword(db)).toBeNull();
    expect(await deleteEmailOtpConfig(db)).toBe(false); // nothing left to delete
  });
});
