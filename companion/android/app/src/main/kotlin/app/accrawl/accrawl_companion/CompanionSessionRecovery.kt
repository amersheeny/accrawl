package app.accrawl.accrawl_companion

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One-shot missed-push recovery. A push is only a wake-up hint; every service start is reconstructed from
 * the paired-device API so a stale message cannot revive an ended crawl and tunnel credentials never travel
 * in FCM.
 */
object CompanionSessionRecovery {
    internal data class AwaitingTunnel(
        val sessionId: String,
        val label: String,
        val tunnelToken: String,
        val engineWsUrl: String,
    )

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "companion-session-recovery").apply { isDaemon = true }
    }
    private val recovering = AtomicBoolean(false)

    fun recoverAllAsync(context: Context) {
        if (!recovering.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        executor.execute {
            try {
                recoverAll(appContext)
            } catch (error: Exception) {
                Log.w(TAG, "pending-session recovery failed", error)
            } finally {
                recovering.set(false)
            }
        }
    }

    /** Called synchronously from FirebaseMessagingService while its delivery lease is still alive. */
    fun recoverWake(context: Context, wake: CompanionWakeMessage) {
        try {
            val pairing = NativeRelay.pairing(context) ?: return
            when (wake) {
                is CompanionWakeMessage.Otp -> {
                    val sessions = NativeRelay.fetchAwaiting(pairing.baseUrl, pairing.deviceToken)
                        ?: return rejectPairing(context)
                    val session = sessions.singleOrNull {
                        it.id == wake.sessionId && it.otpRequestEpoch == wake.otpRequestEpoch
                    } ?: return
                    if (NativeRelay.pairing(context) != pairing) return
                    RelayService.start(context, session)
                }
                is CompanionWakeMessage.Tunnel -> {
                    val sessions = fetchAwaitingTunnels(pairing.baseUrl, pairing.deviceToken)
                        ?: return rejectPairing(context)
                    val session = sessions.singleOrNull { it.sessionId == wake.sessionId } ?: return
                    if (NativeRelay.pairing(context) != pairing) return
                    TunnelService.start(context, session)
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "wake recovery failed for ${wake.sessionId}", error)
        }
    }

    private fun recoverAll(context: Context) {
        val pairing = NativeRelay.pairing(context) ?: return
        val otpSessions = NativeRelay.fetchAwaiting(pairing.baseUrl, pairing.deviceToken)
            ?: return rejectPairing(context)
        val tunnelSessions = fetchAwaitingTunnels(pairing.baseUrl, pairing.deviceToken)
            ?: return rejectPairing(context)
        if (NativeRelay.pairing(context) != pairing) return
        otpSessions.forEach { RelayService.start(context, it) }
        tunnelSessions.forEach { TunnelService.start(context, it) }
    }

    internal fun fetchAwaitingTunnels(
        baseUrl: String,
        deviceToken: String,
    ): List<AwaitingTunnel>? {
        val conn = open(baseUrl, "/api/sessions/awaiting-tunnel", deviceToken)
        try {
            conn.requestMethod = "GET"
            val status = conn.responseCode
            if (status == 401) return null
            if (status != 200) throw RuntimeException("awaiting-tunnel HTTP $status: ${readError(conn)}")
            val body = JSONObject(readBody(conn))
            val sessions = body.optJSONArray("sessions") ?: JSONArray()
            return (0 until sessions.length()).mapNotNull { index ->
                val row = sessions.optJSONObject(index) ?: return@mapNotNull null
                val sessionId = row.optString("sessionId").trim()
                val tunnelToken = row.optString("tunnelToken").trim()
                val engineWsUrl = row.optString("engineWsUrl").trim()
                if (sessionId.isEmpty() || tunnelToken.isEmpty() || engineWsUrl.isEmpty()) return@mapNotNull null
                AwaitingTunnel(
                    sessionId = sessionId,
                    label = row.optString("label").trim(),
                    tunnelToken = tunnelToken,
                    engineWsUrl = engineWsUrl,
                )
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun rejectPairing(context: Context) {
        Log.w(TAG, "paired-device access was rejected; no Companion session was started")
    }

    private fun open(baseUrl: String, path: String, deviceToken: String): HttpURLConnection =
        (URL("${baseUrl.trimEnd('/')}$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("authorization", "Bearer $deviceToken")
            setRequestProperty("accept", "application/json")
        }

    private fun readBody(conn: HttpURLConnection): String =
        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use(BufferedReader::readText)

    private fun readError(conn: HttpURLConnection): String =
        conn.errorStream?.let {
            BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use(BufferedReader::readText)
        }.orEmpty()

    private const val TAG = "CompanionRecovery"
    private const val CONNECT_TIMEOUT_MS = 4_000
    private const val READ_TIMEOUT_MS = 4_000
}
