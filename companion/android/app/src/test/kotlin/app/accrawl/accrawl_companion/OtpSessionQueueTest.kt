package app.accrawl.accrawl_companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OtpSessionQueueTest {
    private fun session(
        id: String,
        institutionId: String,
        institutionName: String = institutionId,
    ) = OtpSessionQueue.Session(
        sessionId = id,
        institutionId = institutionId,
        institutionName = institutionName,
        connectionName = null,
        senderPattern = null,
        otpRequestEpoch = 1,
        status = "starting",
    )

    @Test fun `same institution serializes while different institutions run concurrently`() {
        val queue = OtpSessionQueue()

        assertEquals(OtpSessionQueue.AddResult.START, queue.add(session("a1", "bank-a")))
        assertEquals(OtpSessionQueue.AddResult.QUEUE, queue.add(session("a2", "bank-a")))
        assertEquals(OtpSessionQueue.AddResult.START, queue.add(session("b1", "bank-b")))
        assertEquals(setOf("a1", "b1"), queue.activeSessions().map { it.sessionId }.toSet())
        assertEquals(listOf("a2"), queue.pendingSessions().map { it.sessionId })
    }

    @Test fun `finishing active session promotes next from same institution`() {
        val queue = OtpSessionQueue()
        queue.add(session("a1", "bank-a"))
        queue.add(session("a2", "bank-a"))
        queue.add(session("a3", "bank-a"))

        val result = queue.finish("a1")

        assertEquals("a1", result?.finished?.sessionId)
        assertEquals("a2", result?.promoted?.sessionId)
        assertEquals(listOf("a2"), queue.activeSessions().map { it.sessionId })
        assertEquals(listOf("a3"), queue.pendingSessions().map { it.sessionId })
    }

    @Test fun `duplicates and malformed sessions never enter the queue`() {
        val queue = OtpSessionQueue()
        val valid = session("a1", "bank-a")
        assertEquals(OtpSessionQueue.AddResult.START, queue.add(valid))
        assertEquals(OtpSessionQueue.AddResult.DUPLICATE, queue.add(valid))
        assertEquals(
            OtpSessionQueue.AddResult.REJECTED,
            queue.add(valid.copy(sessionId = " ")),
        )
        assertEquals(
            OtpSessionQueue.AddResult.REJECTED,
            queue.add(valid.copy(institutionId = "", institutionName = "")),
        )
        assertEquals(1, queue.size)
    }

    @Test fun `unknown and stale terminal events are ignored`() {
        val queue = OtpSessionQueue()
        queue.add(session("a1", "bank-a"))

        assertNull(queue.finish("missing"))
        assertEquals(1, queue.size)
        assertTrue(queue.contains("a1"))
    }
}
