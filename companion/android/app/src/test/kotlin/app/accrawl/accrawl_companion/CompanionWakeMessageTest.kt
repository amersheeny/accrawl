package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionWakeMessageTest {
    @Test fun `OTP wake requires a concrete session and epoch`() {
        val parsed = CompanionWakeMessage.parse(
            mapOf(
                "sessionId" to "session-1",
                "institutionId" to "institution-1",
                "institutionName" to "Bank",
                "connectionName" to "Daily account",
                "otpSenderPattern" to "BANK",
                "otpRequestEpoch" to "7",
            ),
        )

        assertTrue(parsed is CompanionWakeMessage.Otp)
        parsed as CompanionWakeMessage.Otp
        assertEquals("session-1", parsed.sessionId)
        assertEquals(7, parsed.otpRequestEpoch)
    }

    @Test fun `tunnel wake contains no tunnel credential or URL`() {
        val parsed = CompanionWakeMessage.parse(
            mapOf(
                "type" to "tunnel",
                "sessionId" to "session-2",
                "institutionId" to "institution-2",
                "institutionName" to "Broker",
            ),
        )

        assertEquals(
            CompanionWakeMessage.Tunnel(
                sessionId = "session-2",
                institutionId = "institution-2",
                institutionName = "Broker",
                connectionName = null,
            ),
            parsed,
        )
    }

    @Test fun `malformed unknown and stale-shaped wake payloads are rejected`() {
        assertNull(CompanionWakeMessage.parse(emptyMap()))
        assertNull(CompanionWakeMessage.parse(mapOf("sessionId" to " ", "otpRequestEpoch" to "1")))
        assertNull(CompanionWakeMessage.parse(mapOf("sessionId" to "s", "otpRequestEpoch" to "bad")))
        assertNull(CompanionWakeMessage.parse(mapOf("sessionId" to "s", "otpRequestEpoch" to "-1")))
        assertNull(CompanionWakeMessage.parse(mapOf("type" to "other", "sessionId" to "s")))
    }
}
