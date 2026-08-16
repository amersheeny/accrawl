/** Independently reviewed institution ownership and publication copy.
 * Review: 019fb192-cfef-7562-903e-410b3bffd4e3. */
export const INSTITUTION_COPY = {
  publishedBadge: 'Published',
  privateYoursBadge: 'Private · yours',
  privateAnotherUsersBadge: 'Private · another user’s',
  publishAction: 'Publish a copy',
  publishHeading: (institutionName: string) =>
    `Publish a copy of ${institutionName}?`,
  publishBody:
    'This creates a separate published copy that everyone signed in to this Accrawl workspace can use. The original private institution remains private and unchanged. Other users cannot edit the published copy.',
  confirmPublish: 'Publish copy',
  publishSuccess: (institutionName: string) =>
    `A copy of ${institutionName} is now published for everyone in this Accrawl workspace.`,
  publishFailure: (institutionName: string) =>
    `Couldn’t publish a copy of ${institutionName}.`,
  alreadyPublished: 'This institution is already published.',
  duplicatePublishedCopy: (institutionName: string) =>
    `A published copy of ${institutionName} already exists in this Accrawl workspace.`,
} as const;

/** Static review catalogue used by the copy gate, including template forms. */
export const REVIEWED_INSTITUTION_COPY = {
  publishedBadge: INSTITUTION_COPY.publishedBadge,
  privateYoursBadge: INSTITUTION_COPY.privateYoursBadge,
  privateAnotherUsersBadge: INSTITUTION_COPY.privateAnotherUsersBadge,
  publishAction: INSTITUTION_COPY.publishAction,
  publishHeading: INSTITUTION_COPY.publishHeading('{institution name}'),
  publishBody: INSTITUTION_COPY.publishBody,
  confirmPublish: INSTITUTION_COPY.confirmPublish,
  publishSuccess: INSTITUTION_COPY.publishSuccess('{institution name}'),
  publishFailure: INSTITUTION_COPY.publishFailure('{institution name}'),
  alreadyPublished: INSTITUTION_COPY.alreadyPublished,
  duplicatePublishedCopy:
    INSTITUTION_COPY.duplicatePublishedCopy('{institution name}'),
} as const;
