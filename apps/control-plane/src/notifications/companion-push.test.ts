import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { sendCompanionWake } from './companion-push';
import { FcmSendError } from './fcm-v1';

describe('Companion data-only wake delivery', () => {
  it('sends the exact OTP payload at high priority only to FCM targets', async () => {
    const sendFcm = vi.fn(async () => 'message-id');
    const clearRejectedToken = vi.fn(async () => true);
    const data = {
      sessionId: 'session-1',
      institutionId: 'bank-one',
      institutionName: 'Bank One',
      connectionName: 'Daily account',
      otpSenderPattern: 'BANKONE',
      otpRequestEpoch: '4',
    };

    const result = await sendCompanionWake({} as Db, {
      ownerSubject: 'account-user:owner',
      connectionId: 'connection-1',
      data,
    }, {
      listTargets: async () => [
        { id: 'device-1', pushTransport: 'fcm', pushToken: 'fcm-token' },
        { id: 'device-2', pushTransport: 'unifiedpush', pushToken: 'endpoint' },
      ],
      clearRejectedToken,
      sendFcm,
      warn: vi.fn(),
    });

    expect(sendFcm).toHaveBeenCalledOnce();
    expect(sendFcm).toHaveBeenCalledWith({
      token: 'fcm-token',
      data,
      android: { priority: 'high' },
    });
    expect(clearRejectedToken).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 1, delivered: 1, invalidated: 0 });
  });

  it('compare-clears an unregistered FCM token', async () => {
    const clearRejectedToken = vi.fn(async () => true);
    const sendFcm = vi.fn(async () => {
      throw new FcmSendError('unregistered', 'FCM send returned HTTP 404', 404);
    });

    await expect(sendCompanionWake({} as Db, {
      ownerSubject: 'account-user:owner',
      connectionId: 'connection-1',
      data: { sessionId: 'session-1' },
    }, {
      listTargets: async () => [{
        id: 'device-1', pushTransport: 'fcm', pushToken: 'registration-token',
      }],
      clearRejectedToken,
      sendFcm,
      warn: vi.fn(),
    })).resolves.toEqual({ attempted: 1, delivered: 0, invalidated: 1 });
    expect(clearRejectedToken).toHaveBeenCalledWith(
      {} as Db,
      'device-1',
      'account-user:owner',
      'registration-token',
    );
  });

  it('clears only registration-token failures and never logs a token', async () => {
    const warn = vi.fn();
    const clearRejectedToken = vi.fn(async () => true);
    const invalid = new FcmSendError('invalid-token', 'FCM send returned HTTP 400', 400);
    const sendFcm = vi.fn()
      .mockRejectedValueOnce(invalid)
      // An outage is not a dead registration: the device stays registered.
      .mockRejectedValueOnce(new FcmSendError('unavailable', 'FCM send returned HTTP 503', 503));

    const result = await sendCompanionWake({} as Db, {
      ownerSubject: 'account-user:owner',
      connectionId: 'connection-1',
      data: { type: 'tunnel', sessionId: 'session-2' },
    }, {
      listTargets: async () => [
        { id: 'invalid-device', pushTransport: 'fcm', pushToken: 'invalid-secret-token' },
        { id: 'retry-device', pushTransport: 'fcm', pushToken: 'retry-secret-token' },
      ],
      clearRejectedToken,
      sendFcm,
      warn,
    });

    expect(clearRejectedToken).toHaveBeenCalledOnce();
    expect(clearRejectedToken).toHaveBeenCalledWith(
      {} as Db,
      'invalid-device',
      'account-user:owner',
      'invalid-secret-token',
    );
    expect(result).toEqual({ attempted: 2, delivered: 0, invalidated: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('invalid-secret-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('retry-secret-token');
  });
});
