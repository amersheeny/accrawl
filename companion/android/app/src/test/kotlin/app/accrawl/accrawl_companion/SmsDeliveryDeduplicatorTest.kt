package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsDeliveryDeduplicatorTest {
    private val deduplicator = SmsDeliveryDeduplicator(windowMillis = 30_000L)

    private fun delivery(
        receivedAtMillis: Long = 10_000L,
        sessionId: String = "session-1",
        otpRequestEpoch: Int = 3,
    ) = RoutedSmsDelivery(
        sender = "BANK",
        body = "Code 123456",
        receivedAtMillis = receivedAtMillis,
        sessionId = sessionId,
        otpRequestEpoch = otpRequestEpoch,
    )

    @Test fun `first source failure leaves fallback free to succeed`() {
        val sms = delivery()

        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.BROADCAST, sms, 1_000L))
        // No accepted marker is recorded because the broadcast relay failed.
        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, sms, 1_100L))

        deduplicator.recordAccepted(SmsDeliverySource.OBSERVER, sms, 1_200L)
        assertFalse(deduplicator.shouldAttempt(SmsDeliverySource.BROADCAST, sms, 1_300L))
    }

    @Test fun `queue promotion with identical SMS cannot inherit the previous session marker`() {
        val firstSession = delivery(sessionId = "session-1", otpRequestEpoch = 3)
        val promotedSession = delivery(sessionId = "session-2", otpRequestEpoch = 3)

        deduplicator.recordAccepted(SmsDeliverySource.BROADCAST, firstSession, 1_000L)

        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, promotedSession, 1_100L))
    }

    @Test fun `identical SMS with distinct provider timestamps are distinct deliveries`() {
        val firstSms = delivery(receivedAtMillis = 10_000L)
        val laterSms = delivery(receivedAtMillis = 20_000L)

        deduplicator.recordAccepted(SmsDeliverySource.BROADCAST, firstSms, 1_000L)

        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, laterSms, 1_100L))
    }

    @Test fun `successful delivery suppresses exactly one matching opposite source`() {
        val sms = delivery()

        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.BROADCAST, sms, 1_000L))
        deduplicator.recordAccepted(SmsDeliverySource.BROADCAST, sms, 1_100L)

        assertFalse(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, sms, 1_200L))
        assertTrue(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, sms, 1_300L))
    }

    @Test fun `observer uses sent time to match broadcast when device receipt time differs`() {
        val pduSentAtMillis = 10_000L
        val deviceReceivedAtMillis = 14_000L
        val broadcast = delivery(receivedAtMillis = pduSentAtMillis)
        val observer = delivery(
            receivedAtMillis = selectSmsIdentityTimestamp(
                sentAtMillis = pduSentAtMillis,
                receivedAtMillis = deviceReceivedAtMillis,
            ),
        )

        deduplicator.recordAccepted(SmsDeliverySource.BROADCAST, broadcast, 1_000L)

        assertFalse(deduplicator.shouldAttempt(SmsDeliverySource.OBSERVER, observer, 1_100L))
    }

    @Test fun `observer falls back to receipt time when sent time is unavailable`() {
        assertEquals(14_000L, selectSmsIdentityTimestamp(sentAtMillis = null, receivedAtMillis = 14_000L))
        assertEquals(14_000L, selectSmsIdentityTimestamp(sentAtMillis = 0L, receivedAtMillis = 14_000L))
    }
}
