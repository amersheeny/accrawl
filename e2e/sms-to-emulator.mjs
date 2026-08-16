/**
 * SMS → emulator bridge for the companion end-to-end run.
 *
 * The fake bank "sends" a 2FA code by exposing it at GET /_relay/last-sms (its simulated carrier). This
 * bridge polls that endpoint and, on each NEW message, injects it into a running Android emulator via the
 * emulator console (`adb -s <serial> emu sms send <from> <body>`) — exactly as a real carrier would deliver
 * it to the phone. The Accrawl Companion app on the emulator captures it and relays the raw body to the
 * control-plane on its own (device-authenticated); the control-plane extracts and submits the code —
 * proving the real relay path, not a stub.
 *
 * Usage: node e2e/sms-to-emulator.mjs <fakeBankUrl> <emulatorSerial> [pollMs]
 * It runs until killed; the harness starts it alongside the crawl and stops it after.
 */
import { execFile } from 'node:child_process';

const BANK = process.argv[2] || 'http://127.0.0.1:4103';
const SERIAL = process.argv[3];
if (!SERIAL) throw new Error('an emulator serial from the current lease is required');
const LEASE_SCRIPT = process.env.EMULATOR_LEASE_SCRIPT;
if (!LEASE_SCRIPT) {
  throw new Error('EMULATOR_LEASE_SCRIPT is required so every adb action is ownership-checked');
}
const POLL_MS = parseInt(process.argv[4] || '1500', 10);
const FROM = process.env.SMS_FROM || '18005550123';
// The fake bank "sends" ONE SMS per login. On a loaded host the companion's SmsReceiver can miss that single
// broadcast during the app's cold-start window, and it is never redelivered → the crawl's OTP wait times out.
// Re-deliver the SAME message a bounded number of times to cover that window. Safe: the companion de-dupes an
// already-accepted (sender|sessionId|body) within an OTP episode, so a redelivery can't burn a second attempt.
const REINJECTS = parseInt(process.env.SMS_REINJECTS || '10', 10);

function adbSms(from, body) {
  return new Promise((resolve, reject) => {
    // `emu sms send` takes the sender then the message; the body may contain spaces (passed as one arg).
    execFile(LEASE_SCRIPT, ['adb', '--', 'emu', 'sms', 'send', from, body], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve((stdout || '').trim());
    });
  });
}

let lastTs = null;
let injects = 0; // how many times the CURRENT message has been delivered
let running = true;
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

async function tick() {
  try {
    const res = await fetch(`${BANK}/_relay/last-sms`);
    if (res.ok) {
      const sms = await res.json();
      if (sms && sms.body && sms.ts) {
        if (sms.ts !== lastTs) { lastTs = sms.ts; injects = 0; } // a genuinely new message resets the counter
        if (injects < REINJECTS) {
          await adbSms(sms.from && /^\+?\d+$/.test(sms.from) ? sms.from : FROM, sms.body);
          injects++;
          console.log(
            `[sms-bridge] delivered message to ${SERIAL} (#${injects}/${REINJECTS}, ${sms.body.length} characters)`,
          );
        }
      }
    }
  } catch (e) {
    console.error(`[sms-bridge] ${e.message}`);
  }
}

console.log(`[sms-bridge] polling ${BANK}/_relay/last-sms -> ${SERIAL} every ${POLL_MS}ms`);
while (running) {
  await tick();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.log('[sms-bridge] stopped');
