import { describe, expect, it } from 'vitest';
import { HOSTED_COPY } from '@accrawl/contracts';
import { decideCrawlAdmission, type CrawlAdmissionInput } from './crawl-admission';

const admissible = (
  overrides: Partial<CrawlAdmissionInput> = {},
): CrawlAdmissionInput => ({
  connection: {
    status: 'connected',
    loginDomainVerified: true,
    verifiedTrustFingerprint: 'fp-1',
    hasUsername: true,
    hasPassword: true,
  },
  institution: {
    trustFingerprint: 'fp-1',
    canonicalDomain: 'bank.example',
    scanStatus: 'passed',
  },
  loginOverrideWithinDomain: true,
  ...overrides,
});

describe('deciding whether a crawl may start', () => {
  it('admits a verified connection to a checked institution', () => {
    expect(decideCrawlAdmission(admissible())).toEqual({ admitted: true });
  });

  it('does not count a refusal the connection is not to blame for', () => {
    // Already failing or mid-crawl: retrying on schedule is right, so this must not burn the retry budget.
    expect(decideCrawlAdmission(admissible({
      connection: { ...admissible().connection, status: 'disconnected' },
    }))).toEqual({
      admitted: false,
      error: HOSTED_COPY.crawlConnectionNotReady,
      countsAsFailure: false,
    });
  });

  it('refuses an address the operator never verified', () => {
    expect(decideCrawlAdmission(admissible({
      connection: { ...admissible().connection, loginDomainVerified: false },
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.crawlLoginDomainUnverified,
      countsAsFailure: true,
    });
  });

  it('refuses when the institution identity changed since it was verified', () => {
    // Driving a browser at a login page whose identity moved is how credentials reach a phishing page.
    expect(decideCrawlAdmission(admissible({
      institution: { ...admissible().institution, trustFingerprint: 'fp-2' },
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.crawlLoginDomainUnverified,
    });
  });

  it('refuses an override address that leaves the institution domain', () => {
    expect(decideCrawlAdmission(admissible({
      connection: { ...admissible().connection, loginUrlOverride: 'https://elsewhere.example/login' },
      loginOverrideWithinDomain: false,
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.crawlLoginAddressMismatch,
    });
  });

  it('refuses an institution whose recipe has not passed its safety check', () => {
    expect(decideCrawlAdmission(admissible({
      institution: { ...admissible().institution, scanStatus: 'pending' },
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.crawlSafetyCheckBlocked,
    });
  });

  it('refuses when the crawl would need a phone to route through and this runner has none', () => {
    expect(decideCrawlAdmission(admissible({
      institution: { ...admissible().institution, useDeviceProxy: true },
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.crawlPhoneRoutingNotConfigured,
    });
  });

  it('refuses when the stored credentials are missing', () => {
    expect(decideCrawlAdmission(admissible({
      connection: { ...admissible().connection, hasPassword: false },
    }))).toMatchObject({
      admitted: false,
      error: HOSTED_COPY.connectionCredentialsUnavailable,
    });
  });
});
