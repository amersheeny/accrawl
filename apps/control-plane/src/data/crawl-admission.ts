/**
 * Whether a crawl may start at all.
 *
 * This is the gate that stands between a stored connection and someone's bank. Every clause exists because
 * of a specific way a crawl can go wrong: driving a browser at an address the operator never verified is
 * how credentials get typed into a phishing page; an institution whose recipe has not passed its safety
 * check can be asked to do anything the recipe says; a connection needing a phone to route through cannot
 * be crawled by a machine that has none.
 *
 * A refusal that reflects the connection's own state also counts against it, so a connection that can never
 * succeed stops being retried on its schedule. A refusal caused by something outside the connection does
 * not, so a temporary condition never burns down its retry budget.
 *
 * Pure: plain values in, a verdict out.
 */
import { HOSTED_COPY } from '@accrawl/contracts';
import { isRecoverableConnectionStatus } from './crawl-status';

/** What the gate needs to know about the connection. */
export interface CrawlAdmissionConnection {
  status: string;
  loginDomainVerified?: boolean;
  verifiedTrustFingerprint?: string | null;
  loginUrlOverride?: string | null;
  hasUsername: boolean;
  hasPassword: boolean;
}

/** What the gate needs to know about the institution it would crawl. */
export interface CrawlAdmissionInstitution {
  trustFingerprint: string;
  canonicalDomain: string;
  scanStatus: string;
  useDeviceProxy?: boolean;
}

export type CrawlAdmission =
  | { admitted: true }
  | {
    admitted: false;
    /** Shown to the operator; never says more about the failure than they may know. */
    error: string;
    /** True when the refusal is the connection's own fault and should count against it. */
    countsAsFailure: boolean;
  };

export interface CrawlAdmissionInput {
  connection: CrawlAdmissionConnection;
  institution: CrawlAdmissionInstitution;
  /** Whether the override address stays inside the institution's canonical domain. */
  loginOverrideWithinDomain: boolean;
}

export function decideCrawlAdmission(input: CrawlAdmissionInput): CrawlAdmission {
  const { connection, institution } = input;

  // Not the connection's fault: it is already failing or being worked on, so this does not count against it.
  if (!isRecoverableConnectionStatus(connection.status)) {
    return {
      admitted: false,
      error: HOSTED_COPY.crawlConnectionNotReady,
      countsAsFailure: false,
    };
  }
  // The operator verified an address, and the institution's identity has not changed since.
  if (
    connection.loginDomainVerified !== true
    || connection.verifiedTrustFingerprint !== institution.trustFingerprint
  ) {
    return {
      admitted: false,
      error: HOSTED_COPY.crawlLoginDomainUnverified,
      countsAsFailure: true,
    };
  }
  if (connection.loginUrlOverride && !input.loginOverrideWithinDomain) {
    return {
      admitted: false,
      error: HOSTED_COPY.crawlLoginAddressMismatch,
      countsAsFailure: true,
    };
  }
  if (institution.scanStatus !== 'passed') {
    return {
      admitted: false,
      error: HOSTED_COPY.crawlSafetyCheckBlocked,
      countsAsFailure: true,
    };
  }
  if (institution.useDeviceProxy === true) {
    return {
      admitted: false,
      error: HOSTED_COPY.crawlPhoneRoutingNotConfigured,
      countsAsFailure: true,
    };
  }
  if (!connection.hasUsername || !connection.hasPassword) {
    return {
      admitted: false,
      error: HOSTED_COPY.connectionCredentialsUnavailable,
      countsAsFailure: true,
    };
  }
  return { admitted: true };
}
