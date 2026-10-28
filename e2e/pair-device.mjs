import crypto from 'node:crypto';

/**
 * Pairs a device through the control plane's pairing flow — intent, claim, operator approval, completion — granted
 * the given connection, and returns its device token. `api(method, path, body)` is the runner's operator client,
 * resolving to { status, json }.
 */
export async function pairDevice(api, name, connectionId) {
  const intent = await api('POST', '/api/devices/pairing-intents', { name, connectionGrants: [connectionId] });
  if (intent.status < 200 || intent.status >= 300) {
    throw new Error(`pairing intent failed: ${intent.status} ${JSON.stringify(intent.json)}`);
  }
  const claim = `acclaim_${crypto.randomBytes(32).toString('base64url')}`;
  const claimed = await api('POST', '/api/devices/pairing/claim', { pairingCode: intent.json.pairingCode, claim });
  if (claimed.status < 200 || claimed.status >= 300 || !claimed.json?.verificationCode) {
    throw new Error(`pairing claim failed: ${claimed.status} ${JSON.stringify(claimed.json)}`);
  }
  const approval = await api('POST', `/api/devices/pairing-intents/${intent.json.id}/approve`);
  if (approval.status < 200 || approval.status >= 300) {
    throw new Error(`pairing approval failed: ${approval.status} ${JSON.stringify(approval.json)}`);
  }
  const completed = await api('POST', '/api/devices/pairing/complete', { pairingCode: intent.json.pairingCode, claim });
  if (completed.status < 200 || completed.status >= 300 || !completed.json?.deviceToken) {
    // Never echo the body: on success it carries the device credential itself.
    throw new Error(`pairing completion failed: HTTP ${completed.status}`);
  }
  return completed.json.deviceToken;
}
