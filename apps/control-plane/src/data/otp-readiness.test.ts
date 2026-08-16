import { describe, expect, it } from 'vitest';
import { otpRelayModeFor, otpRelaySatisfied } from './otp-readiness';

describe('otpRelayModeFor', () => {
  it('asks the operator only when no phone is authorized at all', () => {
    expect(otpRelayModeFor({ authorizedDeviceCount: 0 })).toBe('manual');
  });

  it('keeps the Companion handshake whenever any authorized phone exists', () => {
    // A phone that is merely paired might still be running and polling, and a relayed code always beats
    // asking a human to read one off a screen — so one is enough to keep waiting for the confirmation.
    expect(otpRelayModeFor({ authorizedDeviceCount: 1 })).toBe('companion');
    expect(otpRelayModeFor({ authorizedDeviceCount: 5 })).toBe('companion');
  });
});

describe('otpRelaySatisfied', () => {
  it('waits while a Companion is expected and has not confirmed', () => {
    expect(otpRelaySatisfied({ relayReady: false, mode: 'companion' })).toBe(false);
    expect(otpRelaySatisfied({ relayReady: false, mode: null })).toBe(false);
    expect(otpRelaySatisfied({ relayReady: false, mode: undefined })).toBe(false);
  });

  it('stops waiting once a phone has confirmed live SMS access', () => {
    expect(otpRelaySatisfied({ relayReady: true, mode: 'companion' })).toBe(true);
  });

  it('stops waiting immediately when nothing can ever confirm', () => {
    expect(otpRelaySatisfied({ relayReady: false, mode: 'manual' })).toBe(true);
  });
});
