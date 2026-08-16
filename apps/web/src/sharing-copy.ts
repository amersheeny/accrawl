/** Independently reviewed access-management copy.
 * Reviews: content-review-20260731-data-access and
 * content-review-20260731-data-access-permissions. */
export const SHARING_COPY = {
  nav: 'Data access',
  heading: 'Organisations and apps with access',
  intro: 'Review the organisations and apps that currently have access to your Accrawl data. You can revoke access at any time.',
  activeHeading: 'Active access',
  noAccessHeading: 'No active access',
  noAccessBody: 'No organisations or apps currently have access to your Accrawl data.',
  sharedConnections: 'Connections shared',
  permissions: 'Permissions',
  readDataPermission: 'Read your shared accounts, balances, transactions and holdings',
  balancesPermission: 'Account names and balances',
  transactionsPermission: 'Transactions',
  holdingsPermission: 'Investment holdings',
  accessGranted: 'Access granted',
  accessEnds: 'Access ends',
  statusActive: 'Active',
  revoke: 'Revoke access',
  revokeHeading: (organisationName: string) =>
    `Revoke access for ${organisationName}?`,
  revokeBody: (organisationName: string) =>
    `This will stop ${organisationName} from accessing data from the connections you shared. You’ll need to approve access again to restore it.`,
  confirmRevoke: 'Revoke access',
  revokeSuccess: (organisationName: string) =>
    `${organisationName} no longer has access.`,
  loadError: 'We couldn’t load your active access. Try again.',
  revokeError: 'We couldn’t revoke access. Try again.',
  unknownOrganisation: 'Unknown organisation',
} as const;

/** Static review catalogue used by the copy gate, including template forms. */
export const REVIEWED_SHARING_COPY = {
  nav: SHARING_COPY.nav,
  heading: SHARING_COPY.heading,
  intro: SHARING_COPY.intro,
  activeHeading: SHARING_COPY.activeHeading,
  noAccessHeading: SHARING_COPY.noAccessHeading,
  noAccessBody: SHARING_COPY.noAccessBody,
  sharedConnections: SHARING_COPY.sharedConnections,
  permissions: SHARING_COPY.permissions,
  readDataPermission: SHARING_COPY.readDataPermission,
  balancesPermission: SHARING_COPY.balancesPermission,
  transactionsPermission: SHARING_COPY.transactionsPermission,
  holdingsPermission: SHARING_COPY.holdingsPermission,
  accessGranted: SHARING_COPY.accessGranted,
  accessEnds: SHARING_COPY.accessEnds,
  statusActive: SHARING_COPY.statusActive,
  revoke: SHARING_COPY.revoke,
  revokeHeading: SHARING_COPY.revokeHeading('{organisationName}'),
  revokeBody: SHARING_COPY.revokeBody('{organisationName}'),
  confirmRevoke: SHARING_COPY.confirmRevoke,
  revokeSuccess: SHARING_COPY.revokeSuccess('{organisationName}'),
  loadError: SHARING_COPY.loadError,
  revokeError: SHARING_COPY.revokeError,
  unknownOrganisation: SHARING_COPY.unknownOrganisation,
} as const;
