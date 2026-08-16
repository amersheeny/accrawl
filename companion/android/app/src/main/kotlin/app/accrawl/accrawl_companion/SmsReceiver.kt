package app.accrawl.accrawl_companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Relays each incoming bank SMS to the control-plane NATIVELY — no Flutter engine or activity required. The
 * session-bound foreground service registers this receiver only while a live crawl is waiting, so 2FA works
 * with the UI backgrounded without leaving an idle receiver or service running. NativeRelay reads the pairing
 * straight from SharedPreferences; Dart remains the pairing/status UI and reads the rolling native log.
 */
class SmsReceiver(
    private val onSmsReceived: (
        sender: String,
        body: String,
        receivedAtMillis: Long,
        onComplete: () -> Unit,
    ) -> Unit,
) : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return
        val sender = messages[0].displayOriginatingAddress ?: ""
        val body = messages.joinToString("") { it.displayMessageBody ?: "" }
        // This is the service-centre/PDU timestamp that Android exposes as DATE_SENT in the SMS provider. Using
        // the same value lets the broadcast and ContentObserver paths share an exact physical-message identity.
        val providerTimestampMillis = messages[0].timestampMillis

        // The relay does blocking network; a BroadcastReceiver must not do that on the main thread and returns
        // quickly. goAsync() holds the broadcast alive (~10s budget) while we relay off-thread, then finish().
        val pending = goAsync()
        val completed = AtomicBoolean(false)
        val complete = { if (completed.compareAndSet(false, true)) pending.finish() }
        try {
            onSmsReceived(sender, body, providerTimestampMillis, complete)
        } catch (error: RuntimeException) {
            Log.e(TAG, "SMS broadcast dispatch failed", error)
            complete()
        }
    }

    private companion object {
        const val TAG = "SmsReceiver"
    }
}
