package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TunnelSessionRegistryTest {
    @Test fun `different tunnel sessions run concurrently and duplicate starts are ignored`() {
        val sessions = TunnelSessionRegistry<String>()
        assertTrue(sessions.add("session-a", "tunnel-a"))
        assertTrue(sessions.add("session-b", "tunnel-b"))
        assertFalse(sessions.add("session-a", "replacement"))
        assertEquals(setOf("tunnel-a", "tunnel-b"), sessions.values().toSet())
    }

    @Test fun `stale close cannot remove a newer tunnel for the same session`() {
        val sessions = TunnelSessionRegistry<String>()
        sessions.add("session-a", "old")
        assertEquals("old", sessions.remove("session-a", "old"))
        sessions.add("session-a", "new")
        assertNull(sessions.remove("session-a", "old"))
        assertEquals(listOf("new"), sessions.values())
    }

    @Test fun `malformed session identifier is rejected`() {
        val sessions = TunnelSessionRegistry<String>()
        assertFalse(sessions.add(" ", "tunnel"))
        assertTrue(sessions.isEmpty())
    }
}
