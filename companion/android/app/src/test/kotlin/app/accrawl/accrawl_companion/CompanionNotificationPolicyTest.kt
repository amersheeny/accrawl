package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionNotificationPolicyTest {
    @Test fun `only live OTP and tunnel sessions produce notifications`() {
        assertEquals(
            CompanionNotificationDecision.None,
            CompanionNotificationPolicy.decide(CompanionNotificationEvent.OtpSessions(0)),
        )
        assertEquals(
            CompanionNotificationDecision.OtpForeground(2),
            CompanionNotificationPolicy.decide(CompanionNotificationEvent.OtpSessions(2)),
        )
        assertEquals(
            CompanionNotificationDecision.None,
            CompanionNotificationPolicy.decide(CompanionNotificationEvent.TunnelSessions(0)),
        )
        assertEquals(
            CompanionNotificationDecision.TunnelForeground(3),
            CompanionNotificationPolicy.decide(CompanionNotificationEvent.TunnelSessions(3)),
        )
    }

    @Test fun `relay events remain in the app log and never post another notification`() {
        for (event in CompanionNotificationEvent.LogOnly.entries) {
            assertEquals(
                "$event must remain log-only",
                CompanionNotificationDecision.None,
                CompanionNotificationPolicy.decide(event),
            )
        }
    }

    @Test fun `notification surface exposes no transient post or cancel branch`() {
        val methods = CompanionNotifications::class.java.declaredMethods.map { it.name }
        assertFalse(methods.any { it.startsWith("post") })
        assertFalse(methods.any { it.startsWith("cancel") })
        assertTrue(methods.contains("relayServiceNotification"))
        assertTrue(methods.contains("proxyServiceNotification"))
    }
}
