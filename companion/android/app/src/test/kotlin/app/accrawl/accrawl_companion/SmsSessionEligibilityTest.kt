package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Test

class SmsSessionEligibilityTest {
    private fun session(id: String) = OtpSessionQueue.Session(
        sessionId = id,
        institutionId = "institution-$id",
        institutionName = "Institution $id",
        connectionName = null,
        senderPattern = "BANK$id",
        otpRequestEpoch = 1,
        status = "waiting_for_otp",
    )

    @Test fun `SMS can route only to sessions that started before it arrived`() {
        assertEquals(
            setOf("older", "same-time"),
            eligibleSmsSessionIds(
                activeSessions = listOf(session("older"), session("same-time"), session("newer")),
                startedAtMillis = mapOf("older" to 1_000L, "same-time" to 2_000L, "newer" to 3_000L),
                smsReceivedAtMillis = 2_000L,
            ),
        )
    }

    @Test fun `session without a recorded active start is never eligible`() {
        assertEquals(
            emptySet<String>(),
            eligibleSmsSessionIds(
                activeSessions = listOf(session("missing")),
                startedAtMillis = emptyMap(),
                smsReceivedAtMillis = 2_000L,
            ),
        )
    }
}
