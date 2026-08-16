import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FcmSendError,
  registerFcmCredentials,
  resetFcmCredentialsForTest,
  sendFcmDataMessage,
  serviceAccountFileCredentials,
  type FcmCredentials,
} from './fcm-v1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'accrawl-fcm-')), 'key.json');
writeFileSync(KEY_FILE, JSON.stringify({
  type: 'service_account',
  project_id: 'accrawl-example',
  client_email: 'wake@accrawl-example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
}));

const MESSAGE = {
  token: 'device-registration-token',
  data: { sessionId: 'session-1' },
  android: { priority: 'high' as const },
};

/** Credentials a case can hand in directly, when what it is testing is the send rather than the
 *  proving. */
const suppliedCredentials: FcmCredentials = {
  async projectId() {
    return 'accrawl-example';
  },
  async accessToken() {
    return { token: 'access-token', expiresAt: Date.now() + 3_600_000 };
  },
};

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  resetFcmCredentialsForTest();
  delete process.env.FCM_PROJECT_ID;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

afterEach(() => {
  resetFcmCredentialsForTest();
});

function accepted(): Response {
  return new Response(JSON.stringify({ name: 'projects/accrawl-example/messages/1' }), { status: 200 });
}

function refused(status: number, errorCode?: string): Response {
  return new Response(JSON.stringify({
    error: {
      status: 'NOT_FOUND',
      ...(errorCode ? { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } : {}),
    },
  }), { status });
}

describe('sending a Companion wake', () => {
  it('posts the data message to the project, as the identity it proved', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());

    const name = await sendFcmDataMessage(MESSAGE, {
      credentials: suppliedCredentials,
      fetchImpl,
    });

    expect(name).toBe('projects/accrawl-example/messages/1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://fcm.googleapis.com/v1/projects/accrawl-example/messages:send');
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer access-token');
    expect(JSON.parse(String(init!.body))).toEqual({
      message: {
        token: 'device-registration-token',
        data: { sessionId: 'session-1' },
        android: { priority: 'HIGH' },
      },
    });
  });

  it('names a dead registration as one, so the device can be cleared', async () => {
    const unregistered = sendFcmDataMessage(MESSAGE, {
      credentials: suppliedCredentials,
      fetchImpl: async () => refused(404, 'UNREGISTERED'),
    });
    await expect(unregistered).rejects.toMatchObject({ failure: 'unregistered' });

    const invalid = sendFcmDataMessage(MESSAGE, {
      credentials: suppliedCredentials,
      fetchImpl: async () => refused(400, 'INVALID_ARGUMENT'),
    });
    await expect(invalid).rejects.toMatchObject({ failure: 'invalid-token' });
  });

  it('does not mistake an outage or a rejected sender for a dead registration', async () => {
    // Clearing a device on either of these would unregister every Companion during an incident.
    for (const [status, failure] of [[503, 'unavailable'], [429, 'unavailable'], [403, 'unauthorized']] as const) {
      await expect(sendFcmDataMessage(MESSAGE, {
        credentials: suppliedCredentials,
        fetchImpl: async () => refused(status),
      })).rejects.toMatchObject({ failure });
    }
  });

  it('reuses one access token across sends, and drops it when it is refused', async () => {
    const accessToken = vi.fn(async () => ({ token: 'access-token', expiresAt: Date.now() + 3_600_000 }));
    const credentials: FcmCredentials = { projectId: async () => 'accrawl-example', accessToken };

    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
    await sendFcmDataMessage(MESSAGE, { credentials, fetchImpl });
    await sendFcmDataMessage(MESSAGE, { credentials, fetchImpl });
    expect(accessToken).toHaveBeenCalledOnce();

    await expect(sendFcmDataMessage(MESSAGE, {
      credentials,
      fetchImpl: async () => refused(401),
    })).rejects.toBeInstanceOf(FcmSendError);
    // A refused token is worthless; the next send must mint a fresh one rather than replay it.
    await sendFcmDataMessage(MESSAGE, { credentials, fetchImpl });
    expect(accessToken).toHaveBeenCalledTimes(2);
  });

  it('expires a token before it actually lapses', async () => {
    const accessToken = vi.fn(async () => ({ token: 'about-to-lapse', expiresAt: Date.now() + 30_000 }));
    const credentials: FcmCredentials = { projectId: async () => 'accrawl-example', accessToken };
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());

    await sendFcmDataMessage(MESSAGE, { credentials, fetchImpl });
    await sendFcmDataMessage(MESSAGE, { credentials, fetchImpl });

    expect(accessToken).toHaveBeenCalledTimes(2);
  });

  it('uses the credentials the deployment registered', async () => {
    const accessToken = vi.fn(async () => ({ token: 'from-the-runtime', expiresAt: Date.now() + 3_600_000 }));
    registerFcmCredentials({ projectId: async () => 'registered-project', accessToken });
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());

    await sendFcmDataMessage(MESSAGE, { fetchImpl });

    expect(String(fetchImpl.mock.calls[0]![0]))
      .toBe('https://fcm.googleapis.com/v1/projects/registered-project/messages:send');
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization'))
      .toBe('Bearer from-the-runtime');
  });
});

describe('proving the sender with a service-account key file', () => {
  it('signs an assertion the issuer can verify, and swaps it for a token', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = KEY_FILE;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ access_token: 'minted', expires_in: 3600 }),
      { status: 200 },
    ));

    const credentials = serviceAccountFileCredentials(fetchImpl);
    expect(await credentials.projectId()).toBe('accrawl-example');
    const token = await credentials.accessToken();
    expect(token.token).toBe('minted');
    expect(token.expiresAt).toBeGreaterThan(Date.now());

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    // The assertion is a real RS256 JWT over the claims the token endpoint checks.
    const assertion = form.get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const parsedClaims = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(parsedClaims).toMatchObject({
      iss: 'wake@accrawl-example.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect(parsedClaims.exp - parsedClaims.iat).toBe(3600);
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url')),
    ).toBe(true);
  });

  it('says what to configure when nothing proves the sender', async () => {
    const credentials = serviceAccountFileCredentials(vi.fn<typeof fetch>());
    await expect(credentials.accessToken())
      .rejects.toThrow(/GOOGLE_APPLICATION_CREDENTIALS|registerFcmCredentials/);
  });
});
