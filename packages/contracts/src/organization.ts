import type {
  ContractHolding,
  ContractSecurity,
  ContractTransaction,
} from './contract';

export const ORGANIZATION_SHARE_SCOPES = [
  'balances',
  'transactions',
  'holdings',
] as const;

export type OrganizationShareScope =
  (typeof ORGANIZATION_SHARE_SCOPES)[number];

/** JSON representation returned by the organization API. */
export interface OrganizationApiView {
  id: string;
  name: string;
  disabledAt: string | null;
}

/** JSON representation returned by the owner sharing API. */
export interface OrganizationShareApiView {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerSubject: string;
  ownerEmail: string;
  scopes: OrganizationShareScope[];
  connectionGrants: string[];
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreateOrganizationShareInput {
  organizationId: string;
  reviewedOwnerEmail: string;
  scopes: OrganizationShareScope[];
  connectionGrants: string[];
  durationDays: number;
  expiresAt?: string;
}

export interface SharedBalanceAccountApiView {
  institutionName: string | null;
  nickname: string | null;
  accountName: string;
  accountType: string;
  currency: string;
  balance: number;
  lastSeenAt: string;
}

export interface SharedBalanceOwnerApiView {
  ownerEmail: string;
  shareId: string;
  expiresAt: string;
  accounts: SharedBalanceAccountApiView[];
}

export interface SharedConnectionApiView {
  id: string;
  institutionId: string;
  institutionName: string | null;
  nickname: string | null;
}

export interface SharedConnectionOwnerApiView {
  ownerEmail: string;
  shareId: string;
  scopes: OrganizationShareScope[];
  expiresAt: string;
  connections: SharedConnectionApiView[];
}

export interface SharedTransactionsPageApiView {
  items: ContractTransaction[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

export interface SharedHoldingsPageApiView {
  holdings: ContractHolding[];
  securities: ContractSecurity[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
