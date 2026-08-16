package app.accrawl.accrawl_companion

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TdParity14HarnessTest {
    private val vectorBytes: ByteArray by lazy {
        checkNotNull(javaClass.classLoader?.getResourceAsStream(VECTOR_RESOURCE)) {
            "missing $VECTOR_RESOURCE"
        }.use { it.readBytes() }
    }

    private val vectors: JSONObject by lazy {
        JSONObject(vectorBytes.toString(Charsets.UTF_8))
    }

    @Test
    fun `the Companion lifecycle vectors retain their recorded SHA-256 identity`() {
        assertEquals(VECTOR_SHA256, vectorBytes.sha256())
    }

    @Test
    fun `data-only wake payloads route exactly and malformed payloads are rejected`() {
        vectors.getJSONArray("wakeRouting").forEachObject { vector ->
            val parsed = CompanionWakeMessage.parse(vector.getJSONObject("payload").toStringMap())
            if (vector.isNull("expected")) {
                assertNull(vector.getString("id"), parsed)
                return@forEachObject
            }

            val expected = vector.getJSONObject("expected")
            when (expected.getString("kind")) {
                "otp" -> {
                    assertTrue(vector.getString("id"), parsed is CompanionWakeMessage.Otp)
                    parsed as CompanionWakeMessage.Otp
                    assertEquals(expected.getString("sessionId"), parsed.sessionId)
                    assertEquals(expected.getString("institutionId"), parsed.institutionId)
                    assertEquals(expected.getString("institutionName"), parsed.institutionName)
                    assertEquals(expected.nullableString("connectionName"), parsed.connectionName)
                    assertEquals(expected.nullableString("otpSenderPattern"), parsed.otpSenderPattern)
                    assertEquals(expected.getInt("otpRequestEpoch"), parsed.otpRequestEpoch)
                }
                "tunnel" -> {
                    assertTrue(vector.getString("id"), parsed is CompanionWakeMessage.Tunnel)
                    parsed as CompanionWakeMessage.Tunnel
                    assertEquals(expected.getString("sessionId"), parsed.sessionId)
                    assertEquals(expected.getString("institutionId"), parsed.institutionId)
                    assertEquals(expected.getString("institutionName"), parsed.institutionName)
                    assertEquals(expected.nullableString("connectionName"), parsed.connectionName)
                }
                else -> error("unknown expected wake kind in ${vector.getString("id")}")
            }
        }
    }

    @Test
    fun `OTP sessions reject duplicates and malformed starts, serialize by institution, and tear down`() {
        val vector = vectors.getJSONObject("otpQueue")
        val sessionDefinitions = vector.getJSONObject("sessions")
        val queue = OtpSessionQueue()

        vector.getJSONArray("operations").forEachObject { operation ->
            when (operation.getString("op")) {
                "add" -> {
                    val session = sessionDefinitions.getJSONObject(operation.getString("session")).toOtpSession()
                    assertEquals(
                        operation.getString("expectedResult"),
                        queue.add(session).name,
                    )
                }
                "finish" -> {
                    val result = queue.finish(operation.getString("sessionId"))
                    assertEquals(operation.nullableString("expectedFinished"), result?.finished?.sessionId)
                    assertEquals(operation.nullableString("expectedPromoted"), result?.promoted?.sessionId)
                }
                else -> error("unknown OTP queue operation ${operation.getString("op")}")
            }
            val expectedActive = operation.getJSONArray("expectedActive").toStringList()
            val expectedPending = operation.getJSONArray("expectedPending").toStringList()
            assertEquals(expectedActive, queue.activeSessions().map { it.sessionId })
            assertEquals(expectedPending, queue.pendingSessions().map { it.sessionId })
            assertEquals(expectedActive.size + expectedPending.size, queue.size)
        }

        assertTrue(queue.activeSessions().isEmpty())
        assertTrue(queue.pendingSessions().isEmpty())
    }

    @Test
    fun `tunnel sessions reject duplicate and stale callbacks and remove the final session`() {
        val registry = TunnelSessionRegistry<String>()
        vectors.getJSONArray("tunnelRegistry").forEachObject { operation ->
            val actual: Any? = when (operation.getString("op")) {
                "add" -> registry.add(operation.getString("sessionId"), operation.getString("value"))
                "remove" -> registry.remove(operation.getString("sessionId"), operation.getString("value"))
                else -> error("unknown tunnel registry operation ${operation.getString("op")}")
            }
            val expected = operation.opt("expected").takeUnless { it === JSONObject.NULL }
            assertEquals(expected, actual)
            assertEquals(operation.getJSONArray("expectedValues").toStringList(), registry.values())
        }
        assertTrue(registry.isEmpty())
    }

    @Test
    fun `an SMS is eligible only for sessions active when the provider timestamp says it arrived`() {
        vectors.getJSONArray("smsEligibility").forEachObject { vector ->
            val sessions = mutableListOf<OtpSessionQueue.Session>()
            val startedAtMillis = mutableMapOf<String, Long>()
            vector.getJSONArray("sessions").forEachObject { row ->
                val sessionId = row.getString("sessionId")
                sessions += otpSession(sessionId)
                if (!row.isNull("startedAtMillis")) {
                    startedAtMillis[sessionId] = row.getLong("startedAtMillis")
                }
            }
            assertEquals(
                vector.getJSONArray("expectedSessionIds").toStringList().toSet(),
                eligibleSmsSessionIds(
                    activeSessions = sessions,
                    startedAtMillis = startedAtMillis,
                    smsReceivedAtMillis = vector.getLong("smsReceivedAtMillis"),
                ),
            )
        }
    }

    @Test
    fun `the two Android SMS signals pair without suppressing real redelivery or later sessions`() {
        vectors.getJSONArray("smsDeliveryDeduplication").forEachObject { vector ->
            val deduplicator = SmsDeliveryDeduplicator(windowMillis = 30_000L)
            vector.getJSONArray("operations").forEachObject { operation ->
                when (operation.getString("op")) {
                    "attempt" -> {
                        val source = when (operation.getString("source")) {
                            "broadcast" -> SmsDeliverySource.BROADCAST
                            "observer" -> SmsDeliverySource.OBSERVER
                            else -> error("unknown SMS source ${operation.getString("source")}")
                        }
                        assertEquals(
                            "${vector.getString("id")}: ${operation.getString("source")}",
                            operation.getBoolean("expected"),
                            deduplicator.shouldAttempt(
                                source = source,
                                delivery = operation.toRoutedSmsDelivery(),
                                nowMillis = operation.getLong("nowMillis"),
                            ),
                        )
                    }
                    "accept" -> {
                        val source = when (operation.getString("source")) {
                            "broadcast" -> SmsDeliverySource.BROADCAST
                            "observer" -> SmsDeliverySource.OBSERVER
                            else -> error("unknown SMS source ${operation.getString("source")}")
                        }
                        deduplicator.recordAccepted(
                            source = source,
                            delivery = operation.toRoutedSmsDelivery(),
                            nowMillis = operation.getLong("nowMillis"),
                        )
                    }
                    "clear" -> deduplicator.clear()
                    else -> error("unknown SMS deduplication operation ${operation.getString("op")}")
                }
            }
        }
    }

    @Test
    fun `only active foreground services produce a notification decision`() {
        vectors.getJSONArray("notificationPolicy").forEachObject { vector ->
            val event = when (vector.getString("event")) {
                "otp" -> CompanionNotificationEvent.OtpSessions(vector.getInt("activeCount"))
                "tunnel" -> CompanionNotificationEvent.TunnelSessions(vector.getInt("activeCount"))
                "relay-accepted" -> CompanionNotificationEvent.LogOnly.RELAY_ACCEPTED
                "relay-failed" -> CompanionNotificationEvent.LogOnly.RELAY_FAILED
                "access-invalid" -> CompanionNotificationEvent.LogOnly.ACCESS_INVALID
                "otp-waiting" -> CompanionNotificationEvent.LogOnly.OTP_WAITING
                "proxy-unavailable" -> CompanionNotificationEvent.LogOnly.PROXY_UNAVAILABLE
                else -> error("unknown notification event ${vector.getString("event")}")
            }
            val actual = when (val decision = CompanionNotificationPolicy.decide(event)) {
                is CompanionNotificationDecision.OtpForeground -> "otp:${decision.activeCount}"
                is CompanionNotificationDecision.TunnelForeground -> "tunnel:${decision.activeCount}"
                CompanionNotificationDecision.None -> "none"
            }
            assertEquals(vector.getString("expected"), actual)
        }
    }

    private fun JSONObject.toOtpSession(): OtpSessionQueue.Session = OtpSessionQueue.Session(
        sessionId = getString("sessionId"),
        institutionId = getString("institutionId"),
        institutionName = getString("institutionName"),
        connectionName = nullableString("connectionName"),
        senderPattern = nullableString("senderPattern"),
        otpRequestEpoch = getInt("otpRequestEpoch"),
        status = optString("status", "starting"),
    )

    private fun otpSession(sessionId: String): OtpSessionQueue.Session = OtpSessionQueue.Session(
        sessionId = sessionId,
        institutionId = "institution-$sessionId",
        institutionName = "Institution $sessionId",
        connectionName = null,
        senderPattern = "BANK$sessionId",
        otpRequestEpoch = 1,
        status = "waiting_for_otp",
    )

    private fun JSONObject.toRoutedSmsDelivery(): RoutedSmsDelivery = RoutedSmsDelivery(
        sender = getString("sender"),
        body = getString("body"),
        receivedAtMillis = getLong("receivedAtMillis"),
        sessionId = getString("sessionId"),
        otpRequestEpoch = getInt("otpRequestEpoch"),
    )

    private fun JSONObject.toStringMap(): Map<String, String> = keys().asSequence()
        .associateWith { key -> getString(key) }

    private fun JSONObject.nullableString(key: String): String? =
        if (!has(key) || isNull(key)) null else getString(key)

    private fun JSONArray.toStringList(): List<String> =
        (0 until length()).map(::getString)

    private inline fun JSONArray.forEachObject(block: (JSONObject) -> Unit) {
        for (index in 0 until length()) block(getJSONObject(index))
    }

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString("") { byte -> "%02x".format(byte) }

    private companion object {
        const val VECTOR_RESOURCE = "td-parity-14/companion-lifecycle-vectors.json"
        const val VECTOR_SHA256 = "660bc75f6d00838bacb33e7fa686cdab146b846d38ff8c266579eb4aac816a8b"
    }
}
