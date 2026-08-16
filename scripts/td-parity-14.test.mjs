import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT_ROOT = `${REPO_ROOT}/parity/td-parity-14`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readManifest() {
  return JSON.parse(await readFile(`${CONTRACT_ROOT}/manifest.json`, 'utf8'));
}

test('TD-PARITY-14 manifest has its recorded SHA-256 identity', async () => {
  const manifestBytes = await readFile(`${CONTRACT_ROOT}/manifest.json`);
  const checksum = (await readFile(`${CONTRACT_ROOT}/manifest.sha256`, 'utf8')).trim();
  const match = checksum.match(/^([0-9a-f]{64})  manifest\.json$/);
  assert.ok(match, 'manifest.sha256 must use the conventional lowercase SHA-256 format');
  assert.equal(sha256(manifestBytes), match[1]);
});

test('TD-PARITY-14 frozen artifacts retain their recorded SHA-256 identities', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.contractId, 'td-parity-14');
  assert.equal(manifest.formatVersion, 1);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(`${REPO_ROOT}/${artifact.path}`);
    assert.equal(sha256(bytes), artifact.sha256, artifact.path);
  }
});

test('TD-PARITY-14 production source pins reject unrecorded changes', async () => {
  const manifest = await readManifest();
  for (const pin of manifest.sourcePins) {
    const bytes = await readFile(`${REPO_ROOT}/${pin.path}`);
    assert.equal(
      sha256(bytes),
      pin.sha256,
      `${pin.path} changed; record the semantic delta and advance the parity contract revision`,
    );
  }
});

test('TD-PARITY-14 retains the reviewed permitted divergence catalog', async () => {
  const manifest = await readManifest();
  assert.deepEqual(manifest.allowedDivergences, {
    transactionHistoryWindow: {
      laterCrawlUtcCalendarDays: 7,
      comparisonInputUtcCalendarDays: 7,
      firstCrawlComparisonInput: 'empty',
    },
    syntheticTransactionIdentity: {
      additionalAcceptedPrefix: 'occurrence:',
    },
    modelContext: {
      exactProviderAccountIdContext: true,
      accountScopedPositionIdentity: true,
    },
    securityAdaptations: {
      serverSideRawSmsExtraction: true,
      senderActiveSessionAndRequestEpochBinding: true,
      ambiguousSmsSessionRefusal: true,
      symmetricCrossSourceRawMessageDedupe: true,
      genericActiveCountNotificationCopy: true,
      permissionSourceRegistrationAfterMidSessionGrant: true,
      authoritativeActiveSessionPollingRecovery: true,
      deviceApiReauthorizationBeforeServiceStart: true,
      urlAndSecretRedactionBeforeTelemetryOrMemory: true,
      factOnlyOtpTelemetry: true,
      dnsAndMutationNavigationSafety: true,
      downloadArtifactCleanup: true,
    },
    executionArchitecture: {
      fullCrawlWithoutScopeParameter: true,
      singleExecutionCancellationAndSessionFencing: true,
      transactionHistoryIntegrityTransport: true,
    },
    modelControls: {
      gemini3Temperature: 0,
      optionalPerCrawlThinkingOverride: true,
    },
    normalizedAccountExtensions: [
      'available',
      'limit',
      'creditCardLiability',
      'pensionDetail',
    ],
  });
});

test('TD-PARITY-14 carries shared semantic vectors for each restored behavior', async () => {
  const vectors = JSON.parse(await readFile(`${CONTRACT_ROOT}/engine-vectors.json`, 'utf8'));
  assert.deepEqual(Object.keys(vectors.sharedSemanticVectors).sort(), [
    'defaultThinking',
    'positionBalanceReconciliation',
    'positionValueDescription',
    'receivedHistoryOrder',
    'recoveryAccumulation',
    'tickerInferenceDescription',
  ]);
  assert.equal(
    vectors.sharedSemanticVectors.positionValueDescription.pinned,
    'Current market value of THIS single holding only, in its native currency (approximately quantity × current unit price), read from this row\'s own value cell. NEVER the account or portfolio total — if several rows would share one identical value, you are copying the wrong cell. Not a per-unit price, not profit/loss.',
  );
  assert.deepEqual(
    vectors.sharedSemanticVectors.positionValueDescription.allowedTransformations,
    [],
  );
  assert.deepEqual(
    vectors.sharedSemanticVectors.recoveryAccumulation.allowedTransformations,
    [],
  );
  assert.deepEqual(
    vectors.sharedSemanticVectors.recoveryAccumulation.expected,
    {
      resultType: 'continue',
      stored: [
        {
          account: 'account-a',
          id: 'NONE',
          date: '2026-07-29',
          amount: -10,
          existingCanonicalId: null,
          count: null,
        },
        {
          account: 'account-a',
          id: 'NONE',
          date: '2026-07-30',
          amount: -25,
          existingCanonicalId: null,
          count: null,
        },
      ],
      demotedIdentityKeys: [],
      signals: [],
    },
  );
  assert.match(
    (await readManifest()).generatedArtifactDigests.sharedSemanticResults,
    /^[0-9a-f]{64}$/,
  );
});

test('TD-PARITY-14 retains the neutral baseline source identities', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.baselineRevision, 'ee1f6bf05dae9c6deb856cd6703fd00f463338b5');
  assert.deepEqual(manifest.baselineSourceDigests, {
    transactionPrompt: 'f3b4a27eb90dfd67b77c651dc81f0d2e56cba223d202bb17b4d67b9f0c969f0c',
    transactionSchema: 'ac8425da7d1b66a66668f21f0c109e7c680b5d147a886ccc64b76396224e0425',
    transactionAccumulator: 'cea1d2df73873797f5ab39b2a0dc8ea28ece49cb6467b2e689e7ac6617d59a52',
    errorRecoveryAccumulator: '060f1374da4554fa122ca6c5cfdc5e10abb940a63b79e8f136fdf7b8e2afba36',
    otpWakeSender: '03ddd702ed37688c71f9042537deb32ef8ada571b1e0c4d00e9e3ab7a96a8129',
    nativePushReceiver: '7aa3a3ed28eaae42cb8cee18f77ffa138d3b873071b8ff823f9d359a7aa012f5',
    otpServiceLifecycle: 'f1d34eefb6758b48aebe656243544b8d7244a69eca0a1a6ce87875349db10bbd',
    tunnelServiceLifecycle: '923ecdbf938ea592da4f431c18d898e5357def0e874f088ec438c8e151895ded',
  });
});
