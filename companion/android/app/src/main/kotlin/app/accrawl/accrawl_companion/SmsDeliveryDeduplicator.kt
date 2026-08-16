package app.accrawl.accrawl_companion

import java.util.Locale

internal enum class SmsDeliverySource {
    BROADCAST,
    OBSERVER,
}

/**
 * Uses the SMS service-centre/PDU timestamp shared by the broadcast and inbox-provider paths. Some OEM
 * providers omit DATE_SENT or persist it as zero; only in that case do we fall back to the device receipt time
 * so the observer remains a functional delivery fallback.
 */
internal fun selectSmsIdentityTimestamp(sentAtMillis: Long?, receivedAtMillis: Long): Long =
    sentAtMillis?.takeIf { it > 0L } ?: receivedAtMillis

/** Exact routed identity shared by Android's broadcast and inbox-observer signals for one physical SMS. */
internal data class RoutedSmsDelivery(
    val sender: String,
    val body: String,
    val receivedAtMillis: Long,
    val sessionId: String,
    val otpRequestEpoch: Int,
)

/**
 * Suppresses the second Android signal for an SMS only after the first signal was accepted by [NativeRelay].
 * Attempts do not create state, so a failed broadcast can never strand the inbox-observer fallback. The key
 * includes provider receipt time and the exact routed OTP episode, preventing identical messages or queued
 * sessions from sharing a marker. Concurrent signals may both proceed; server idempotency guarantees one
 * submission effect.
 */
internal class SmsDeliveryDeduplicator(
    private val windowMillis: Long = DEFAULT_WINDOW_MILLIS,
    private val maxMarkers: Int = DEFAULT_MAX_MARKERS,
) {
    private data class MessageKey(
        val sender: String,
        val body: String,
        val receivedAtMillis: Long,
        val sessionId: String,
        val otpRequestEpoch: Int,
    )
    private data class Marker(val source: SmsDeliverySource, val atMillis: Long)

    private val acceptedMarkers = mutableMapOf<MessageKey, ArrayDeque<Marker>>()

    init {
        require(windowMillis > 0)
        require(maxMarkers > 0)
    }

    @Synchronized
    fun shouldAttempt(source: SmsDeliverySource, delivery: RoutedSmsDelivery, nowMillis: Long): Boolean {
        prune(nowMillis)
        val key = delivery.key()
        val queue = acceptedMarkers[key] ?: return true
        val oppositeIndex = queue.indexOfFirst { it.source != source }
        if (oppositeIndex >= 0) {
            queue.removeAt(oppositeIndex)
            if (queue.isEmpty()) acceptedMarkers.remove(key)
            return false
        }
        return true
    }

    @Synchronized
    fun recordAccepted(source: SmsDeliverySource, delivery: RoutedSmsDelivery, nowMillis: Long) {
        prune(nowMillis)
        acceptedMarkers.getOrPut(delivery.key(), ::ArrayDeque).addLast(Marker(source, nowMillis))
        cap()
    }

    @Synchronized
    fun clear() {
        acceptedMarkers.clear()
    }

    private fun RoutedSmsDelivery.key() = MessageKey(
        sender = sender.trim().lowercase(Locale.ROOT),
        body = body,
        receivedAtMillis = receivedAtMillis,
        sessionId = sessionId,
        otpRequestEpoch = otpRequestEpoch,
    )

    private fun prune(nowMillis: Long) {
        val iterator = acceptedMarkers.iterator()
        while (iterator.hasNext()) {
            val queue = iterator.next().value
            queue.removeAll { nowMillis - it.atMillis >= windowMillis }
            if (queue.isEmpty()) iterator.remove()
        }
    }

    private fun cap() {
        while (acceptedMarkers.values.sumOf(ArrayDeque<Marker>::size) > maxMarkers) {
            val oldest = acceptedMarkers.entries
                .mapNotNull { (key, queue) -> queue.firstOrNull()?.let { key to it.atMillis } }
                .minByOrNull { it.second }
                ?: return
            val queue = acceptedMarkers[oldest.first] ?: continue
            queue.removeFirst()
            if (queue.isEmpty()) acceptedMarkers.remove(oldest.first)
        }
    }

    private companion object {
        const val DEFAULT_WINDOW_MILLIS = 30_000L
        const val DEFAULT_MAX_MARKERS = 200
    }
}
