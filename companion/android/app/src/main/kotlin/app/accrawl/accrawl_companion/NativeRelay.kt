package app.accrawl.accrawl_companion

import android.content.Context
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The relay, in pure Kotlin — no Flutter engine or activity required. RelayService dynamically registers
 * the SMS broadcast receiver and inbox observer for each live OTP window, so doing the whole relay here makes
 * 2FA work while the UI is closed without leaving a standby service, receiver, or observer. The Dart side
 * stays the pairing/status UI; it reads this object's rolling log to show background-relay activity.
 *
 * LLM-FIRST relay: the companion no longer parses the code on the device (the old regex extractor was a
 * treadmill of edge-case bugs). It relays the RAW SMS body to the control-plane, which asks Gemini to extract
 * the code under a strict structured-output schema + a digit guard. The phone's only jobs are the sender
 * binding and the local dedupe — both of which still belong here because they gate WHETHER to spend a relay.
 *
 * Relay rule (REFUSE rather than guess — a wrong OR duplicate code burns a 2FA attempt):
 *  1. ask the control-plane which sessions are awaiting a code, each carrying its institution's learned
 *     otpSenderPattern + the current otpRequestEpoch, and relay ONLY to the session whose pattern matches THIS
 *     SMS's sender (binding the message to the bank that asked for it) — and only when EXACTLY one matches;
 *  2. POST the RAW body + sender + that session's otpRequestEpoch; the server re-validates the sender (defense
 *     in depth), LLM-extracts the code, and submits it — or, if there is no code in the body, leaves the
 *     session waiting for a manual code (a 200 we treat as "handled, nothing relayed");
 *  3. dedupe with two layers: the server derives a deterministic, EPISODE-SCOPED idempotency key
 *     (sessionId|otpRequestEpoch|sha256(body)) and no-ops a same-key retry — the correctness guarantee against
 *     a double-burn. The local ledger is pure EFFICIENCY on top: it suppresses a re-POST ONLY of an
 *     already-ACCEPTED message. A PENDING claim never suppresses, so a racing/duplicate worker still POSTs (the
 *     server dedupes) and a first worker whose POST fails can't strand the code — the other post lands. The
 *     local key folds in the provider SMS timestamp and SAME otpRequestEpoch, so a genuinely NEW message or
 *     request that reads identically is a different key and is relayed. A legacy bare-long ledger entry from
 *     an older build counts as ACCEPTED, so an upgrade never re-posts.
 */
object NativeRelay {
    private const val TAG = "NativeRelay"

    // The Flutter shared_preferences (legacy API) stores under this file with the `flutter.` key prefix.
    private const val PREFS_FILE = "FlutterSharedPreferences"
    private const val KEY_BASE_URL = "flutter.baseUrl"
    private const val KEY_DEVICE_TOKEN = "flutter.deviceToken"
    // Rolling relay log, also under the `flutter.` prefix so the Dart UI can read it as a plain String pref.
    private const val KEY_RELAY_LOG = "flutter.nativeRelayLog"
    private const val MAX_LOG_ENTRIES = 50

    // Persistent dedupe ledger: a JSON map of relay-key -> firstSeenMillis. SharedPreferences survives the
    // process, so it dedupes across the independent workers a redelivered SMS spawns (each goAsync() runs in
    // its own thread). Not `flutter.`-prefixed — internal to the native relay, never surfaced to the UI.
    private const val KEY_DEDUPE_LEDGER = "nativeRelayDedupe"
    private const val DEDUPE_TTL_MS = 5 * 60 * 1000L // 5 min — comfortably longer than any carrier redelivery
    private const val MAX_DEDUPE_ENTRIES = 200

    // BroadcastReceivers get ~10s of wall time; keep the two network calls comfortably inside that.
    private const val CONNECT_TIMEOUT_MS = 4000
    private const val READ_TIMEOUT_MS = 4000

    /**
     * Run the relay for one received SMS. MUST be called off the main thread (we do blocking network here) —
     * RelayService dispatches both SMS sources through its worker pool, while SmsReceiver holds its broadcast
     * with goAsync(). Returns when the relay attempt is fully resolved so the caller can finish if needed.
     */
    internal fun handleSms(
        context: Context,
        source: SmsDeliverySource,
        sender: String,
        body: String,
        smsReceivedAtMillis: Long,
        deliveryDeduplicator: SmsDeliveryDeduplicator,
    ) {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)?.trim()
        val deviceToken = prefs.getString(KEY_DEVICE_TOKEN, null)?.trim()
        if (baseUrl.isNullOrEmpty() || deviceToken.isNullOrEmpty()) return // unpaired — nothing to relay to

        // NO local extraction: we relay the RAW body and let the control-plane LLM-extract the code. We still
        // need an awaiting session whose sender pattern matches before spending the relay, so fetch first.
        try {
            val awaiting = fetchAwaiting(baseUrl, deviceToken)
            if (awaiting == null) {
                log(context, "received an SMS from $sender but the device token was rejected — re-pair this device")
                return
            }
            val activeSessionIds = RelayService.activeSessionIds(smsReceivedAtMillis)
            val routable = awaiting.filter { it.id in activeSessionIds }
            if (routable.isEmpty()) return // no actively served crawl is waiting — ignore it silently

            // SENDER BINDING: relay ONLY to an awaiting session whose institution's learned OTP-sender pattern
            // matches THIS SMS's sender. An unrelated OTP-looking SMS (a different service's code arriving
            // mid-crawl) won't match the bank's pattern, so it is never relayed. A session whose institution
            // has no learned pattern can't be matched and is skipped — we refuse rather than guess.
            val matches = routable.filter { senderMatches(sender, it.otpSenderPattern) }
            if (matches.isEmpty()) {
                log(context, "received an SMS from $sender but no awaiting session expects that sender — not relaying (enter it manually)")
                return
            }
            if (matches.size > 1) {
                // Several awaiting sessions expect this SAME sender: we do NOT guess which the SMS belongs to
                // (a wrong code burns a 2FA attempt) — the operator disambiguates in the web UI.
                log(context, "received an SMS from $sender but ${matches.size} awaiting sessions expect it — not relaying (ambiguous)")
                return
            }
            val session = matches[0]
            val routedDelivery = RoutedSmsDelivery(
                sender = sender,
                body = body,
                receivedAtMillis = smsReceivedAtMillis,
                sessionId = session.id,
                otpRequestEpoch = session.otpRequestEpoch,
            )
            if (!deliveryDeduplicator.shouldAttempt(
                    source,
                    routedDelivery,
                    SystemClock.elapsedRealtime(),
                )
            ) {
                return
            }

            // DEDUPE — the SERVER's episode-scoped idempotency is the correctness guarantee; this local ledger
            // is pure EFFICIENCY (avoid re-POSTing a body the server already ACCEPTED). We suppress ONLY when a
            // fresh ACCEPTED claim for this (sender+body+session+episode) already exists. A PENDING claim does
            // NOT suppress: a concurrent/duplicate worker still POSTs — the server derives the SAME
            // (sessionId|epoch|sha256(body)) key and no-ops the retry (verified in submitOtpFromSms), making
            // ONE effect out of the racing posts. That fixes the old stranding bug: if the first worker's POST
            // then failed, a second worker that we'd previously suppressed-as-pending would have dropped the
            // code with no redelivery; now the second post still lands. We mark ACCEPTED (suppress a future
            // identical SMS in this episode) only once the server has accepted; a failed POST clears nothing it
            // needs to (the entry stays PENDING and is pruned at the TTL), so a carrier redelivery retries.
            val claimKey = claimPending(
                context,
                sender,
                body,
                smsReceivedAtMillis,
                session.id,
                session.otpRequestEpoch,
            )
            if (claimKey == null) {
                log(context, "received an SMS from $sender but it was already accepted moments ago — not relaying again")
                return
            }

            val status: Int
            try {
                status = relayOtpSms(baseUrl, deviceToken, session.id, body, sender, session.otpRequestEpoch)
            } catch (e: Exception) {
                // POST never completed (timeout, connectivity, process pressure): the server may not have the
                // body. The claim stays PENDING — which no longer suppresses — so a redelivery within the TTL
                // retries; we drop it explicitly too, so the slot frees immediately.
                clearClaim(context, claimKey)
                throw e
            }
            if (status in 200..299) {
                // Server handled it (202 = code extracted + submitted, or no-op'd a same-key retry; 200 = no
                // code in the body, nothing submitted): NOW mark ACCEPTED so a future identical SMS in the same
                // episode is suppressed. Only an ACCEPTED claim suppresses — PENDING never does.
                markAccepted(context, claimKey)
                deliveryDeduplicator.recordAccepted(
                    source,
                    routedDelivery,
                    SystemClock.elapsedRealtime(),
                )
            } else {
                // Non-2xx (409 not-awaiting / sender-mismatch / stale-epoch, 5xx) — not a confirmed acceptance,
                // so it must NOT suppress a redelivery; drop the pending claim so a retry goes through cleanly.
                clearClaim(context, claimKey)
            }
            log(context, when (status) {
                202 -> "relayed SMS to ${session.name ?: session.id} (code extracted + submitted)"
                200 -> "relayed SMS to ${session.name ?: session.id} but it held no code — enter it manually"
                401 -> "device token rejected — re-pair this device"
                else -> "relay returned HTTP $status"
            })
            if (status == 202) RelayService.otpSubmitted(session.id)
        } catch (e: Exception) {
            // Never swallow silently — surface to logcat AND the in-app activity log.
            Log.e(TAG, "relay failed", e)
            log(context, "relay failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    /** A session awaiting a 2FA code, as returned by GET /api/sessions/awaiting-otp. The otpSenderPattern is
     *  the institution's learned OTP-sender hint — we relay ONLY when the SMS's sender matches it. The
     *  otpRequestEpoch is the current OTP-request episode; we echo it back in the relay POST and fold it into
     *  the dedupe key so a fresh request for the same SMS body isn't suppressed as a previous-episode dup. */
    internal data class Awaiting(
        val id: String,
        val connectionId: String,
        val institutionId: String,
        val name: String?,
        val connectionName: String?,
        val otpSenderPattern: String?,
        val otpRequestEpoch: Int,
        val status: String,
    )

    internal data class Pairing(val baseUrl: String, val deviceToken: String)

    internal fun pairing(context: Context): Pairing? {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val deviceToken = prefs.getString(KEY_DEVICE_TOKEN, null)?.trim()?.takeIf(String::isNotEmpty) ?: return null
        return Pairing(baseUrl, deviceToken)
    }

    /**
     * GET <baseUrl>/api/sessions/awaiting-otp (device-authenticated). Returns the awaiting sessions, or null
     * when the token was rejected (401) so the caller can tell the user to re-pair. Other non-200s throw.
     */
    internal fun fetchAwaiting(baseUrl: String, deviceToken: String): List<Awaiting>? {
        val conn = open(baseUrl, "/api/sessions/awaiting-otp", deviceToken)
        try {
            conn.requestMethod = "GET"
            val status = conn.responseCode
            if (status == 401) return null
            if (status != 200) throw RuntimeException("awaiting-otp HTTP $status: ${readError(conn)}")
            val body = JSONObject(readBody(conn))
            val arr = body.optJSONArray("sessions") ?: JSONArray()
            return (0 until arr.length()).map { i ->
                val s = arr.getJSONObject(i)
                Awaiting(
                    s.getString("id"),
                    s.optString("connectionId"),
                    s.optString("institutionId"),
                    if (s.isNull("institutionName")) null else s.optString("institutionName"),
                    if (s.isNull("connectionName")) null else s.optString("connectionName"),
                    if (s.isNull("otpSenderPattern")) null else s.optString("otpSenderPattern"),
                    s.optInt("otpRequestEpoch", 0),
                    s.optString("status", "starting"),
                )
            }
        } finally {
            conn.disconnect()
        }
    }

    internal fun markRelayStatus(
        baseUrl: String,
        deviceToken: String,
        sessionId: String,
        smsPermission: Boolean,
        ready: Boolean,
    ) {
        val conn = open(baseUrl, "/api/sessions/$sessionId/relay-status", deviceToken)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            val payload = JSONObject()
                .put("smsPermission", smsPermission)
                .put("ready", ready)
                .toString().toByteArray(Charsets.UTF_8)
            conn.outputStream.use { it.write(payload) }
            val status = conn.responseCode
            if (status == 401) throw SecurityException("device token rejected")
            if (status != 204 && status != 404) {
                throw RuntimeException("relay-status HTTP $status: ${readError(conn)}")
            }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * POST <baseUrl>/api/sessions/<id>/otp { "smsBody": ..., "sender": ..., "otpRequestEpoch": N }. Relays the
     * RAW SMS body for the control-plane to LLM-extract the code from. Returns the HTTP status: 202 (a code was
     * extracted + submitted), 200 (no code in the body — nothing submitted), 409 (sender mismatch / stale
     * episode / not awaiting), 404 (no such session). No idempotency header is sent: the server derives an
     * episode-scoped key (sessionId|otpRequestEpoch|sha256(body)) and no-ops a same-key retry itself.
     */
    private fun relayOtpSms(baseUrl: String, deviceToken: String, sessionId: String, smsBody: String, sender: String, otpRequestEpoch: Int): Int {
        val conn = open(baseUrl, "/api/sessions/$sessionId/otp", deviceToken)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            val payload = JSONObject()
                .put("smsBody", smsBody)
                .put("sender", sender)
                .put("otpRequestEpoch", otpRequestEpoch)
                .toString().toByteArray(Charsets.UTF_8)
            conn.outputStream.use { os: OutputStream -> os.write(payload) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    /** Build a bearer-authenticated connection, trimming any trailing slashes from the base URL (as Dart does). */
    private fun open(baseUrl: String, path: String, deviceToken: String): HttpURLConnection {
        val root = baseUrl.trimEnd('/')
        val conn = URL("$root$path").openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.setRequestProperty("authorization", "Bearer $deviceToken")
        conn.setRequestProperty("accept", "application/json")
        return conn
    }

    private fun readBody(conn: HttpURLConnection): String =
        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use(BufferedReader::readText)

    private fun readError(conn: HttpURLConnection): String =
        conn.errorStream?.let { BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use(BufferedReader::readText) } ?: ""

    // Smallest pattern we'll trust to bind a code to a bank: a 1–2 char pattern matches far too many senders
    // to be a real binding, so we refuse it (the operator types the code instead).
    private const val MIN_SENDER_PATTERN_LENGTH = 3

    /**
     * Does an SMS [sender] match an institution's learned [pattern]? Mirrors Dart's senderMatches exactly: the
     * pattern is a case-insensitive LITERAL that must EXACTLY EQUAL the sender (both trimmed) — NOT a substring.
     * A substring/contains test let a spoofed sender like "FAKE-BANKCO" match the bank's "BANKCO" pattern and
     * relay a code from an attacker-controlled number (a wrong code burns a 2FA attempt); requiring exact
     * equality closes that hole. It is NEVER interpreted as a regex: a too-broad pattern like ".*", ".+", or
     * "NORTH|.*" would otherwise match and defeat the binding, and an attacker-supplied pattern could trigger
     * ReDoS. An empty/whitespace pattern, or one shorter than [MIN_SENDER_PATTERN_LENGTH] after trimming, never
     * matches — never relay to a session with no real (meaningful) sender binding.
     */
    fun senderMatches(sender: String, pattern: String?): Boolean {
        val p = pattern?.trim()
        if (p == null || p.length < MIN_SENDER_PATTERN_LENGTH) return false
        val s = sender.trim()
        if (s.isEmpty()) return false
        return s.equals(p, ignoreCase = true)
    }

    /** The local dedupe-ledger key for this provider SMS on this session and OTP episode. `sha256(body)` keeps
     *  it bounded and content-addressed; provider timestamp distinguishes separate identical messages,
     *  sessionId distinguishes queue promotion, and otpRequestEpoch distinguishes a fresh request. This is the
     *  local efficiency key only; the server owns correctness idempotency. */
    private fun relayKey(
        sender: String,
        body: String,
        smsReceivedAtMillis: Long,
        sessionId: String,
        otpRequestEpoch: Int,
    ): String = "${sender.trim()}|$smsReceivedAtMillis|$sessionId|$otpRequestEpoch|${sha256Hex(body)}"

    /**
     * Atomically record a PENDING claim for THIS (sender + body + session + episode) before the POST, and
     * return its dedupe key — or null when a fresh ACCEPTED claim already exists within [DEDUPE_TTL_MS]. Null
     * means we've already RELAYED-AND-ACCEPTED this exact SMS in this episode, so re-posting it is pure waste.
     * A merely PENDING sibling does NOT yield null: a concurrent/duplicate worker still POSTs, and the server's
     * episode-scoped same-key no-op guarantees one effect — which also means a first worker whose POST fails
     * can't strand the code, because the other post still lands.
     *
     * The local ledger is therefore EFFICIENCY, not correctness — the server idempotency key is the
     * correctness guarantee. @Synchronized + a synchronous commit() keeps the accepted-check + pending-set
     * atomic against the independent threads a redelivered broadcast spawns.
     */
    @Synchronized
    private fun claimPending(
        context: Context,
        sender: String,
        body: String,
        smsReceivedAtMillis: Long,
        sessionId: String,
        otpRequestEpoch: Int,
    ): String? {
        val key = relayKey(sender, body, smsReceivedAtMillis, sessionId, otpRequestEpoch)
        val before = readLedgerString(context)
        val (after, fresh) = claimPendingPure(before, key, System.currentTimeMillis())
        writeLedgerString(context, after)
        return if (fresh) key else null
    }

    /** Promote a pending claim to ACCEPTED (the server accepted the code) so any future duplicate is
     *  suppressed for the TTL. */
    @Synchronized
    private fun markAccepted(context: Context, key: String) {
        val after = markAcceptedPure(readLedgerString(context), key, System.currentTimeMillis())
        writeLedgerString(context, after)
    }

    /** Drop a claim entirely (the POST failed / was not accepted) so a carrier redelivery within the TTL can
     *  retry a code the server never actually received — never strand a legit code on a transient failure. */
    @Synchronized
    private fun clearClaim(context: Context, key: String) {
        val after = clearClaimPure(readLedgerString(context), key, System.currentTimeMillis())
        writeLedgerString(context, after)
    }

    private fun readLedgerString(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        return prefs.getString(KEY_DEDUPE_LEDGER, "{}") ?: "{}"
    }

    // commit() (not apply()) — a claim MUST be durable before we return and POST, so a racing worker can't
    // slip past between our return and the disk write.
    private fun writeLedgerString(context: Context, ledger: String) {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_DEDUPE_LEDGER, ledger).commit()
    }

    internal const val STATE_PENDING = "pending"
    internal const val STATE_ACCEPTED = "accepted"

    // --- Pure ledger state machine (no Android deps, so it's unit-testable). The ledger is a JSON map of
    // relay-key -> { at: millis, state: "pending"|"accepted" }. A LEGACY entry from an older build is a bare
    // long (relay-key -> millis); we tolerate it on read and treat it as ACCEPTED (see isAccepted). Every op
    // prunes expired entries first, so an aged claim never blocks a legitimate later relay of the same SMS. ---

    /** Record a PENDING claim for [key] iff no FRESH (within TTL) ACCEPTED claim already exists. Returns the
     *  new ledger string and whether the claim is fresh (true ⇒ caller POSTs; false ⇒ already accepted, suppress
     *  the re-post as waste). A merely PENDING entry does NOT suppress — a concurrent/duplicate worker re-POSTs
     *  with the same idempotency key and the server no-ops it, so the racing posts can't double-burn AND a
     *  failed first post can't strand the code (the other post lands). A legacy bare-long entry counts as
     *  ACCEPTED (suppress) so an app upgrade doesn't re-post an already-relayed code. */
    internal fun claimPendingPure(ledgerJson: String, key: String, now: Long): Pair<String, Boolean> {
        val ledger = prune(parseLedger(ledgerJson), now)
        if (isAccepted(ledger, key)) {
            // A fresh ACCEPTED claim (current-format accepted, or a legacy bare-long) — suppress this re-post.
            return ledger.toString() to false
        }
        // No accepted claim — set/refresh PENDING and go POST (even over an existing PENDING sibling).
        ledger.put(key, entry(STATE_PENDING, now))
        capLedger(ledger)
        return ledger.toString() to true
    }

    /** Is [key]'s ledger entry an ACCEPTED claim? True when the current-format entry has state == "accepted",
     *  OR when the key is present with a NON-object (legacy bare-long) value — old builds stored
     *  `key -> firstSeenMillis`, which `optJSONObject` can't read; an entry that survived pruning is, by
     *  definition, a fresh already-claimed code, so we honour it as accepted and suppress the re-post. */
    private fun isAccepted(ledger: JSONObject, key: String): Boolean {
        if (!ledger.has(key)) return false
        val obj = ledger.optJSONObject(key)
        if (obj == null) return true // legacy bare-long (non-object) value present ⇒ treat as accepted
        return obj.optString("state") == STATE_ACCEPTED
    }

    internal fun markAcceptedPure(ledgerJson: String, key: String, now: Long): String {
        val ledger = prune(parseLedger(ledgerJson), now)
        ledger.put(key, entry(STATE_ACCEPTED, now))
        capLedger(ledger)
        return ledger.toString()
    }

    internal fun clearClaimPure(ledgerJson: String, key: String, now: Long): String {
        val ledger = prune(parseLedger(ledgerJson), now)
        ledger.remove(key)
        return ledger.toString()
    }

    private fun parseLedger(ledgerJson: String): JSONObject =
        try { JSONObject(ledgerJson) } catch (_: Exception) { JSONObject() }

    private fun entry(state: String, now: Long): JSONObject =
        JSONObject().put("at", now).put("state", state)

    private fun prune(ledger: JSONObject, now: Long): JSONObject {
        val pruned = JSONObject()
        val keys = ledger.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val at = atOf(ledger, k)
            if (now - at < DEDUPE_TTL_MS) pruned.put(k, ledger.get(k))
        }
        return pruned
    }

    /** If we exceeded the cap after inserting, drop the oldest entries. */
    private fun capLedger(ledger: JSONObject) {
        if (ledger.length() <= MAX_DEDUPE_ENTRIES) return
        val byAge = ledger.keys().asSequence().sortedBy { atOf(ledger, it) }.toList()
        for (k in byAge.take(ledger.length() - MAX_DEDUPE_ENTRIES)) ledger.remove(k)
    }

    /** The timestamp of a ledger entry, tolerating the legacy bare-long format (entry was once `key -> millis`).
     *  An unparseable/missing entry maps to 0L so prune() treats it as expired. */
    private fun atOf(ledger: JSONObject, key: String): Long {
        ledger.optJSONObject(key)?.let { return it.optLong("at", 0L) }
        return ledger.optLong(key, 0L)
    }

    private fun sha256Hex(s: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * Append one entry to the rolling relay log (newest first, capped). Stored as a JSON string under the
     * `flutter.`-prefixed key so the Dart UI reads it straight from SharedPreferences with getString.
     */
    @Synchronized
    private fun log(context: Context, message: String) {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val arr = try {
            JSONArray(prefs.getString(KEY_RELAY_LOG, "[]"))
        } catch (_: Exception) {
            JSONArray()
        }
        val entry = JSONObject().put("at", System.currentTimeMillis()).put("message", message)
        // Prepend newest, drop the oldest beyond the cap.
        val trimmed = JSONArray().put(entry)
        for (i in 0 until minOf(arr.length(), MAX_LOG_ENTRIES - 1)) trimmed.put(arr.get(i))
        prefs.edit().putString(KEY_RELAY_LOG, trimmed.toString()).apply()
        Log.i(TAG, message)
    }
}
