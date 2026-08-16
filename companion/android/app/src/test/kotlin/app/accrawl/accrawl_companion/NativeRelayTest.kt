package app.accrawl.accrawl_companion

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic unit tests for the native SMS 2FA relay. These exercise the Android-free core of NativeRelay:
 * the accepted-only claim ledger (a PENDING entry never suppresses; an ACCEPTED or legacy bare-long entry
 * does) and the literal sender match — the sender logic kept in step with the Dart `senderMatches` tested in
 * companion/test/client_test.dart, so the background relay and the UI agree. The OTP code is no longer parsed
 * on the device (the LLM extracts it server-side from the raw body), so there is no extractOtp test.
 *
 * The dedupe-ledger keys are opaque to the pure functions; we use the new episode-scoped key shape
 * (sender|sessionId|otpRequestEpoch|sha256(body)) so the constants mirror what claimPending now builds.
 */
class NativeRelayTest {

    private val key = "18005550123|sess_1|7|abc"
    private val ttl = 5 * 60 * 1000L

    private fun stateOf(ledgerJson: String, k: String): String? =
        JSONObject(ledgerJson).optJSONObject(k)?.optString("state")

    // --- DEFECT 3 + 4: accepted-only ledger (PENDING never suppresses) + legacy bare-long tolerance ---

    @Test fun `first claim is fresh and recorded pending`() {
        val (after, fresh) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        assertTrue("a first, unseen claim must be fresh -> the caller POSTs", fresh)
        assertEquals(NativeRelay.STATE_PENDING, stateOf(after, key))
    }

    @Test fun `DEFECT 3 a PENDING sibling does NOT suppress a second POST (server idempotency dedupes)`() {
        val (afterFirst, _) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        // A racing/duplicate worker claims the same SMS while the first is mid-POST. It must NOT be suppressed:
        // it re-POSTs with the SAME idempotency key and the server no-ops it. This is what stops a failed first
        // POST from stranding the code — the second post still lands.
        val (afterSecond, fresh) = NativeRelay.claimPendingPure(afterFirst, key, 2_000L)
        assertTrue("a PENDING sibling must NOT suppress — the concurrent worker still POSTs", fresh)
        assertEquals(NativeRelay.STATE_PENDING, stateOf(afterSecond, key))
    }

    @Test fun `DEFECT 3 an ACCEPTED claim DOES suppress a later duplicate within TTL`() {
        val (afterClaim, _) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        val accepted = NativeRelay.markAcceptedPure(afterClaim, key, 2_000L)
        assertEquals(NativeRelay.STATE_ACCEPTED, stateOf(accepted, key))
        val (_, fresh) = NativeRelay.claimPendingPure(accepted, key, 3_000L)
        assertFalse("a duplicate of an ACCEPTED code must be suppressed (pure efficiency: don't re-POST)", fresh)
    }

    @Test fun `DEFECT 4 a legacy bare-long entry counts as ACCEPTED and suppresses`() {
        // An older build stored `key -> firstSeenMillis` (a bare long). After an upgrade, optJSONObject can't
        // read it — the OLD code therefore re-posted the same SMS. It must now be honoured as an accepted
        // claim and suppress. `at` is the bare long itself; keep it fresh so prune doesn't drop it first.
        val legacy = JSONObject().put(key, 2_000L).toString()
        val (_, fresh) = NativeRelay.claimPendingPure(legacy, key, 3_000L)
        assertFalse("a legacy bare-long entry must suppress the re-post (treated as accepted)", fresh)
    }

    @Test fun `DEFECT 4 a STALE legacy bare-long entry is pruned and no longer blocks`() {
        // A legacy entry older than the TTL is pruned away, so the same SMS much later is treated as new.
        val legacy = JSONObject().put(key, 1_000L).toString()
        val (after, fresh) = NativeRelay.claimPendingPure(legacy, key, 1_000L + ttl + 1)
        assertTrue("a legacy entry past the TTL must not block a later relay", fresh)
        assertEquals(NativeRelay.STATE_PENDING, stateOf(after, key))
    }

    @Test fun `clearing a claim leaves no entry so a redelivery retries`() {
        val (afterClaim, firstFresh) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        assertTrue(firstFresh)
        // POST failed (exception / non-2xx): the pending claim is dropped (it wouldn't have suppressed anyway).
        val cleared = NativeRelay.clearClaimPure(afterClaim, key, 2_000L)
        assertNull("a cleared claim must leave no entry", stateOf(cleared, key))
        // Carrier redelivers the SAME SMS within the TTL — it must be allowed through (a legit code).
        val (afterRetry, retryFresh) = NativeRelay.claimPendingPure(cleared, key, 3_000L)
        assertTrue("a redelivery after a failed POST must retry, not be refused", retryFresh)
        assertEquals(NativeRelay.STATE_PENDING, stateOf(afterRetry, key))
    }

    @Test fun `an expired claim no longer blocks a fresh relay`() {
        val (afterClaim, _) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        val accepted = NativeRelay.markAcceptedPure(afterClaim, key, 1_000L)
        // Well past the TTL: prune drops it, so the same SMS much later is treated as new.
        val (after, fresh) = NativeRelay.claimPendingPure(accepted, key, 1_000L + ttl + 1)
        assertTrue("a claim older than the TTL must not block a later relay", fresh)
    }

    @Test fun `a different session for the same code is never blocked`() {
        val (afterClaim, _) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        val accepted = NativeRelay.markAcceptedPure(afterClaim, key, 1_000L)
        val otherKey = "18005550123|sess_2|7|abc"
        val (_, fresh) = NativeRelay.claimPendingPure(accepted, otherKey, 2_000L)
        assertTrue("the SAME body must still relay to a DIFFERENT session", fresh)
    }

    @Test fun `the SAME body in a NEW request episode is never blocked (epoch is in the key)`() {
        // After an accepted relay in episode 7, the engine re-arms for a fresh code (epoch 8). The companion's
        // key folds in the epoch, so the SAME body now carries a different key and is relayed — not mistaken
        // for the previous-episode duplicate.
        val (afterClaim, _) = NativeRelay.claimPendingPure("{}", key, 1_000L)
        val accepted = NativeRelay.markAcceptedPure(afterClaim, key, 1_000L)
        val nextEpochKey = "18005550123|sess_1|8|abc"
        val (_, fresh) = NativeRelay.claimPendingPure(accepted, nextEpochKey, 2_000L)
        assertTrue("the SAME body in a NEW episode must relay (a resend / fresh identical code)", fresh)
    }

    @Test fun `a corrupt ledger string is tolerated, not fatal`() {
        val (after, fresh) = NativeRelay.claimPendingPure("not json {", key, 1_000L)
        assertTrue(fresh)
        assertEquals(NativeRelay.STATE_PENDING, stateOf(after, key))
    }

    // --- DEFECT 1: EXACT literal sender match, no regex, no substring, min length ---

    @Test fun `senderMatches is an EXACT literal match, never a regex`() {
        assertTrue(NativeRelay.senderMatches("NORTHWIND", "northwind"))
        assertTrue(NativeRelay.senderMatches("  NORTHWIND  ", "NORTHWIND")) // trimmed
        // A numeric literal sender (as the e2e uses) matches by exact equality.
        assertTrue(NativeRelay.senderMatches("18005550123", "18005550123"))
        // Too-broad regex-like patterns must NOT match.
        assertFalse(NativeRelay.senderMatches("SOMEOTHERSVC", ".*"))
        assertFalse(NativeRelay.senderMatches("SOMEOTHERSVC", ".+"))
        assertFalse(NativeRelay.senderMatches("SOMEOTHERSVC", "NORTH|.*"))
        // …but a literal that EQUALS the sender matches (proving it's a literal equality test).
        assertTrue(NativeRelay.senderMatches("NORTH|.*", "NORTH|.*"))
    }

    @Test fun `senderMatches rejects a SUBSTRING (the whole fix — a spoofed sender cannot piggyback)`() {
        // Under the old contains() these were TRUE; an exact match rejects them.
        assertFalse(NativeRelay.senderMatches("FAKE-BANKCO", "BANKCO")) // spoofed prefix
        assertFalse(NativeRelay.senderMatches("18005550123", "1800555")) // partial number
        assertFalse(NativeRelay.senderMatches("Northwind Bank", "NORTHWIND")) // pattern only a substring
    }

    @Test fun `senderMatches rejects too-short and empty patterns`() {
        assertFalse(NativeRelay.senderMatches("1", "1"))
        assertFalse(NativeRelay.senderMatches("18", "18")) // 2 chars even though equal
        assertTrue(NativeRelay.senderMatches("180", "180")) // 3-char floor, exact
        assertFalse(NativeRelay.senderMatches("NORTHWIND", null))
        assertFalse(NativeRelay.senderMatches("NORTHWIND", "   "))
        assertFalse(NativeRelay.senderMatches("", "northwind"))
    }
}
