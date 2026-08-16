import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import { armOtpRelayEpisode } from './companion-wake';

describe('OTP Companion wake context (PostgreSQL)', () => {
  let client: PGlite;
  let db: Db;
  let sessionId: string;
  let connectionId: string;

  const pairDevice = async (grants: string[]): Promise<void> => {
    await client.query(`
      insert into devices (owner_subject, name, hashed_token, connection_grants)
      values ('account-user:owner', 'Pixel', $1, $2::jsonb)
    `, [`token-${Math.random()}`, JSON.stringify(grants)]);
  };

  const armedEpisode = async (): Promise<void> => {
    await db.update(schema.sessions).set({
      otpRequested: true,
      otpRequestEpoch: 4,
    }).where(eq(schema.sessions.id, sessionId));
  };

  const storedMode = async (): Promise<string | null> => {
    const [row] = await db.select({ mode: schema.sessions.otpRelayMode })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    return row?.mode ?? null;
  };

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const directory = path.resolve(__dirname, '../../migrations');
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
  });

  afterAll(async () => client.close());

  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec(`
      insert into institutions (
        id, name, login_url, canonical_domain, type, requires_2fa,
        otp_sender_pattern
      ) values (
        'bank-one', 'Bank One', 'https://bank.example', 'bank.example',
        'bank', true, 'BANKONE'
      )
    `);
    const connection = await client.query<{ id: string }>(`
      insert into connections (
        owner_subject, institution_id, username_ct, password_ct, nickname
      ) values (
        'account-user:owner', 'bank-one', 'u', 'p', 'Primary current'
      ) returning id
    `);
    connectionId = connection.rows[0].id;
    const session = await client.query<{ id: string }>(`
      insert into sessions (
        connection_id, status, otp_requested, otp_request_epoch
      ) values ($1, 'starting', false, 3) returning id
    `, [connectionId]);
    sessionId = session.rows[0].id;
  });

  it('does not wake before the session has an active OTP request', async () => {
    const sendWake = vi.fn();
    expect(await armOtpRelayEpisode(db, sessionId, { sendWake }))
      .toEqual({ state: 'not_pending' });
    expect(sendWake).not.toHaveBeenCalled();
    expect(await storedMode()).toBeNull();
  });

  it('parks the episode for console entry when no phone is authorized', async () => {
    await armedEpisode();
    const sendWake = vi.fn();

    expect(await armOtpRelayEpisode(db, sessionId, { sendWake }))
      .toEqual({ state: 'manual' });
    // The crawl would otherwise wait out its whole readiness window for a confirmation that nothing can send.
    expect(await storedMode()).toBe('manual');
    expect(sendWake).not.toHaveBeenCalled();
  });

  it('keeps the Companion handshake when a phone is authorized but holds no push registration', async () => {
    await pairDevice([connectionId]);
    await armedEpisode();
    const sendWake = vi.fn(async () => ({ attempted: 0, delivered: 0, invalidated: 0 }));

    expect(await armOtpRelayEpisode(db, sessionId, { sendWake }))
      .toEqual({ state: 'sent', mode: 'companion', attempted: 0, delivered: 0, invalidated: 0 });
    expect(await storedMode()).toBe('companion');
  });

  it('ignores a phone paired to a different connection', async () => {
    await pairDevice(['00000000-0000-4000-8000-0000000000ff']);
    await armedEpisode();

    expect(await armOtpRelayEpisode(db, sessionId, { sendWake: vi.fn() }))
      .toEqual({ state: 'manual' });
    expect(await storedMode()).toBe('manual');
  });

  it('ignores a revoked phone', async () => {
    await pairDevice([connectionId]);
    await client.exec("update devices set revoked_at = now()");
    await armedEpisode();

    expect(await armOtpRelayEpisode(db, sessionId, { sendWake: vi.fn() }))
      .toEqual({ state: 'manual' });
    expect(await storedMode()).toBe('manual');
  });

  it('records the mode only for the episode it was decided for', async () => {
    await pairDevice([connectionId]);
    await armedEpisode();
    // A wake already in flight when the previous episode closed must not describe the next one.
    await expect(armOtpRelayEpisode(db, sessionId, {
      sendWake: vi.fn(async () => ({ attempted: 1, delivered: 1, invalidated: 0 })),
      resolveContext: async (_db, id) => ({
        sessionId: id,
        ownerSubject: 'account-user:owner',
        connectionId,
        institutionId: 'bank-one',
        institutionName: 'Bank One',
        connectionName: 'Primary current',
        otpSenderPattern: 'BANKONE',
        otpRequestEpoch: 3,
      }),
    })).resolves.toMatchObject({ state: 'sent' });
    expect(await storedMode()).toBeNull();
  });

  it('sends the exact live session metadata after the request transition', async () => {
    await pairDevice([connectionId]);
    await armedEpisode();
    const sendWake = vi.fn(async () => ({ attempted: 1, delivered: 1, invalidated: 0 }));

    expect(await armOtpRelayEpisode(db, sessionId, { sendWake }))
      .toEqual({ state: 'sent', mode: 'companion', attempted: 1, delivered: 1, invalidated: 0 });
    expect(sendWake).toHaveBeenCalledWith(db, {
      ownerSubject: 'account-user:owner',
      connectionId: expect.any(String),
      data: {
        sessionId,
        institutionId: 'bank-one',
        institutionName: 'Bank One',
        connectionName: 'Primary current',
        otpSenderPattern: 'BANKONE',
        otpRequestEpoch: '4',
      },
    });
  });
});
