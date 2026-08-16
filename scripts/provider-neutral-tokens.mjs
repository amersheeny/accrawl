/**
 * What this repository must not name, shared by the two checks that look for it.
 *
 * A plain module rather than a test file, so importing it from either check does not also register the
 * other's cases: one file asks about the working tree, the other about history, and a run of either
 * should report only what it asked.
 */
/** Vocabulary that belongs to a provider rather than to this product. */
export const PROVIDER_TOKENS = [
  // The provider's own name. Absent until an outside audit pointed out that a list of its products was
  // being mistaken for a search for the provider — every compound below was here, and the one word they
  // are all built from was not, so anything that said it plainly went unread.
  'google',
  'firebase',
  'firestore',
  'gcloud',
  'google-cloud',
  'google.gms',
  'google-services',
  'googleapis',
  'cloud run',
  'cloud-run',
  'cloud tasks',
  'cloud-tasks',
  'secret manager',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
];

/**
 * One deployment's own identity. These are never allowed anywhere, under any exception: a reader who
 * clones this repository must not learn which project runs the hosted service.
 */
export const DEPLOYMENT_IDENTIFIERS = [
  // The hosted deployment's project NAMES are deliberately not written here.
  //
  // They were, for about an hour, and the private repository's own boundary check rejected this file
  // for containing them — correctly. A list of private strings cannot live in the repository the
  // strings are being kept out of: publishing it publishes them. Nor can they be caught by shape,
  // because roughly fifteen legitimate accrawl-prefixed identifiers appear here (accrawl-e2e,
  // accrawl-worker, accrawl-companion, several request headers), and a rule broad enough to catch a
  // project name catches all of those too.
  //
  // So the names live in the private repository's scanner, which already reads this tree and this
  // history and is what caught the mistake. What is listed below is what a deployment's identity looks
  // like regardless of what it is called — which also catches a project nobody has listed anywhere.
  // Nothing here is a name. Writing one down to search for it puts it in the tree it is being kept out
  // of, and the only way to keep the scan green after that is to stop scanning this file — which is what
  // happened, and it made every identifier below unenforceable in the one file that listed them.
  /accrawl-e2e-[0-9]+/iu,
  // Project numbers are NOT listed by prefix. Two shapes here used to begin with the real leading four
  // digits of two real projects, so a file whose whole purpose is to avoid writing an identity down was
  // publishing eight digits of one — in a public repository, to catch a hypothetical future project in
  // the same range. The private scanner holds the actual numbers and reads this tree and this history;
  // that is where a value belongs. A generic twelve-digit shape is not written here either: it matches
  // timestamps and record ids by the thousand, so it would fail constantly and be switched off, which
  // is the same as not having it.
  // Anything shaped like a client id for one of those projects. All-zero forms are excluded: the
  // install guide has to show the shape of the value a reader must go and find, and a placeholder is
  // by construction not anybody's identifier.
  /\b1:(?!0+:)[0-9]{10,14}:android:(?!0+\b)[0-9a-f]{8,}\b/iu,
  // A storage bucket is named after the project that owns it, so the host gives the project away even
  // when the project is never mentioned. Only the bucket host is matched: the other suffix these
  // projects use is a public one, and the anti-phishing code has to name it to explain why a bank
  // hosted on a shared suffix must anchor to its own tenant rather than the suffix.
  /\b[a-z0-9][a-z0-9-]{4,28}[a-z0-9]\.firebasestorage\.app\b/iu,
];

export function matches(haystack, token) {
  return token instanceof RegExp
    ? token.test(haystack)
    : haystack.toLowerCase().includes(token.toLowerCase());
}

/**
 * Where a provider may be named, and why. Each entry is one token and the files that may carry it.
 *
 * The two that are product decisions rather than mechanics:
 *
 * 1. The model the product uses to read a bank page. It is the model's API, not infrastructure, and it
 *    has no substitute behind a port.
 * 2. The Companion's push transport. A background wake on Android is delivered by the platform's own
 *    push service, and that service has no identity that is not the provider's: the sender id *is* a
 *    cloud project number, and the pre-provider way of obtaining one was withdrawn in 2018 and removed
 *    from service in 2024. Every alternative costs the person using it something real — a second
 *    application on their phone, or typing each code by hand. The transport is named here; no
 *    deployment's project is, because the Companion is told which one to use when it is paired.
 */
export const EXCEPTIONS = [
  {
    token: 'google',
    reason: 'the browser the crawler drives; a program this product runs, not a service it depends on',
    paths: [
      'apps/engine/Dockerfile',
      'apps/engine/README.md',
      'apps/engine/.env.example',
      'apps/engine/package.json',
      'apps/engine/src/browser/chromium-environment.test.ts',
      'docker-compose.yml',
      'e2e/run-e2e-tunnel-device.mjs',
      'README.md',
      'DEPLOY.md',
    ],
  },
  {
    token: 'google',
    reason: 'where a reader goes to get the model key, and what the key is for; the model, not a deployment',
    paths: [
      '.env.example',
      'apps/control-plane/src/config.ts',
      'setup.sh',
      'README.md',
      'DEPLOY.md',
    ],
  },
  {
    token: 'google',
    reason: 'the messaging app the end-to-end run clears on the device it drives',
    paths: ['e2e/run-e2e.mjs'],
  },
  {
    token: 'google',
    reason: 'refuses the provider metadata address a hijacked page could reach; naming it is the defence',
    paths: [
      'apps/control-plane/src/lib/ssrf.ts',
      'apps/engine/src/utils/url-safety.ts',
      'apps/engine/src/utils/url-safety.test.ts',
    ],
  },
  {
    token: 'google',
    reason: 'third-party plugin source vendored verbatim; editing it would fork someone else\'s package',
    paths: ['companion/vendor/'],
  },
  {
    token: 'google',
    reason: 'the machinery that hunts for these words has to spell them out to look for them',
    paths: [
      'scripts/provider-neutral-policy.test.mjs',
      'scripts/provider-neutral-history.test.mjs',
      'scripts/cloud-sdk-policy.test.mjs',
      'scripts/companion-release-policy.test.mjs',
      'scripts/check-latest-dependencies.mjs',
      'scripts/latest-dependency-policy.mjs',
      'scripts/latest-dependency-policy.test.mjs',
    ],
  },
  {
    token: 'google',
    reason: 'the same model client and push transport already excepted below, under the provider\'s own name',
    paths: [
      'apps/engine/src/ai/',
      'apps/control-plane/package.json',
      'apps/control-plane/src/authoring/draft-config.ts',
      'apps/control-plane/src/config-scan/malice-scan.ts',
      'apps/control-plane/src/data/otp-extract.ts',
      'apps/control-plane/src/notifications/fcm-v1.ts',
      'apps/control-plane/src/notifications/fcm-v1.test.ts',
      'companion/android/app/build.gradle.kts',
      'companion/android/app/src/main/AndroidManifest.xml',
      'companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/CompanionFcmService.kt',
      'companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/PushRegistration.kt',
      'companion/android/.gitignore',
      'pnpm-workspace.yaml',
    ],
  },
  {
    token: 'google',
    reason: 'the package repository every Android library resolves through, including the framework\'s own',
    paths: [
      'companion/android/build.gradle.kts',
      'companion/android/settings.gradle.kts',
    ],
  },
  {
    token: '@google/genai',
    reason: 'the model that reads a bank page; a product capability, not infrastructure',
    paths: [
      'apps/engine/package.json',
      'apps/engine/src/ai/',
      'apps/control-plane/package.json',
      'pnpm-lock.yaml',
    ],
  },
  {
    token: 'firebase',
    reason: 'the platform push service that wakes the Companion; no non-provider identity exists',
    paths: [
      'apps/control-plane/src/notifications/fcm-v1.ts',
      'companion/android/app/build.gradle.kts',
      'companion/android/app/src/main/AndroidManifest.xml',
      'companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/CompanionFcmService.kt',
      'companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/PushRegistration.kt',
      'companion/android/app/src/main/kotlin/app/accrawl/accrawl_companion/CompanionSessionRecovery.kt',
      'scripts/provider-neutral-policy.test.mjs',
    ],
  },
  {
    token: 'googleapis',
    reason: 'the push service endpoint the wake is sent to',
    paths: ['apps/control-plane/src/notifications/fcm-v1.ts'],
  },
  // Someone standing this up has to create a push project of their own and cannot use the one in the
  // published app. Telling them so is the difference between working wake-ups and a Companion that
  // silently never comes online, so these three name the service they must go and set up.
  {
    token: 'firebase',
    reason: 'the setup a self-hoster must actually perform to get Companion wake-ups working',
    paths: ['README.md', 'DEPLOY.md', 'companion/README.md'],
  },
  // The test for the wake transport exercises the transport, so it names its endpoints and error
  // shapes exactly as the service returns them.
  ...['firebase', 'googleapis', 'GOOGLE_APPLICATION_CREDENTIALS'].map((token) => ({
    token,
    reason: 'the wake transport\'s own test, which asserts the real endpoints and error codes',
    paths: ['apps/control-plane/src/notifications/fcm-v1.test.ts'],
  })),
  // The browser environment is built from an allowlist, and this test proves that a deployment's cloud
  // credentials and job metadata do not reach the page. Naming realistic variables is what makes it
  // evidence of that rather than evidence that an invented variable is unknown.
  ...['firebase', 'GOOGLE_APPLICATION_CREDENTIALS', 'cloud run'].map((token) => ({
    token,
    reason: 'names the credentials it proves never reach the browser; inventing them would prove less',
    paths: ['apps/engine/src/browser/chromium-environment.test.ts'],
  })),
  // The ignore rule has to name the file it keeps out of the repository. Without the name it protects
  // nothing, and what it protects against is a real project's identifiers being committed by accident —
  // which happened once, and was caught by this check.
  {
    token: 'google-services',
    reason: 'an ignore rule must name the file it keeps out, or it keeps nothing out',
    paths: ['companion/android/.gitignore'],
  },
  // A check that forbids something must be able to name it. These are the other policies that do the
  // same job as this one from a different angle — an installed client library, a stale release, a
  // release artifact — and each has to write down what it is looking for.
  ...['firebase', 'google-cloud', 'googleapis'].map((token) => ({
    token,
    reason: 'a policy that forbids or looks up a provider has to name it in order to find it',
    paths: [
      'scripts/cloud-sdk-policy.test.mjs',
      'scripts/latest-dependency-policy.mjs',
      'scripts/latest-dependency-policy.test.mjs',
      'scripts/companion-release-policy.test.mjs',
    ],
  })),
  // Third-party source vendored into this repository, carried as published. Rewriting someone else's
  // code to suit this product's vocabulary would make it something other than the release it claims
  // to be, and would have to be redone on every update.
  ...['firebase', 'firestore', 'googleapis', 'google-cloud'].map((token) => ({
    token,
    reason: 'vendored third-party source, kept byte-for-byte as its author published it',
    paths: ['companion/vendor/'],
  })),
  // The transport still answers to the setting names it had before the product stopped naming it in
  // configuration, so an install that already set them keeps working. Both go when the window closes.
  ...['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'].map((token) => ({
    token,
    reason: 'the previous name of a setting, still answered to for one release after the rename',
    paths: ['apps/control-plane/src/notifications/fcm-v1.ts'],
  })),
  // A field name kept for exactly one release, because a release updates workers before the control
  // plane and the old name is what a not-yet-updated sender emits. The parity contract records the
  // change, so it quotes it too.
  // A review that records a rename has to quote the name that was replaced, or it documents nothing
  // and cannot be checked by whoever reads it next. These are the reviews the copy gate points at as
  // the provenance of a decision, so they are named one by one rather than by directory: a review
  // written later gets no free pass from an entry made for these.
  ...['firebase', 'firestore', 'cloud-run', 'cloud run'].map((token) => ({
    token,
    reason: 'a recorded review the copy gate points at as the provenance of a decision it enforces',
    paths: [
      'reviews/content/content-review-20260814-capability-named-settings.md',
      'reviews/content/content-review-20260814-integration-contract.md',
      'reviews/content/content-review-20260803-companion-session-lifecycle.md',
      'reviews/content/content-review-B4214F7D-50EA-455A-910E-F962EFD3EFDB.md',
    ],
  })),
];

/**
 * Files that are not this product's vocabulary.
 *
 * The lockfile records the resolved name of every dependency, including the transitive closure of an
 * excepted one, and is not written by hand. This file has to name what it forbids in order to look for
 * it, so scanning itself would report every token it knows.
 */
export const NOT_PROSE = new Set([
  'pnpm-lock.yaml',
  'scripts/provider-neutral-policy.test.mjs',
  'scripts/provider-neutral-history.test.mjs',
  // The list itself. It has to spell out every token it looks for, so scanning it would report each one
  // and nothing else would ever be reported again.
  'scripts/provider-neutral-tokens.mjs',
]);

export function excepted(relativePath, token) {
  return EXCEPTIONS.some(
    (exception) => exception.token.toLowerCase() === String(token).toLowerCase()
      && exception.paths.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix)),
  );
}
