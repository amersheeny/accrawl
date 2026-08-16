package app.accrawl.accrawl_companion

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.atomic.AtomicLong

/**
 * The device-proxy tunnel, in pure Kotlin — the phone is the EXIT node of a SOCKS5 bridge the engine runs.
 *
 * A self-host crawl that needs the user's residential IP parks on the engine and wakes this phone for one
 * concrete session. The authenticated recovery path obtains the short-lived tunnel credentials, then this
 * foreground service opens that session's WebSocket. Over that WS it speaks the engine's wire
 * protocol: the engine sends {connect|data|close}, we open/relay/close a REAL java.net.Socket to (host,port)
 * — so the bank sees THIS phone's IP — and answer with {connected|data|close|error}. All socket + network
 * I/O runs off the main thread; the Dart side reads this object's rolling log to show tunnel status.
 *
 * Prefs + auth plumbing mirror NativeRelay exactly (flutter.baseUrl, flutter.deviceToken, Bearer auth, the
 * `flutter.`-prefixed rolling log read straight from SharedPreferences by the Flutter UI).
 */
class TunnelService : Service() {
    private data class ActiveTunnel(
        val sessionId: String,
        val label: String,
        val tunnel: Tunnel,
        var timeout: ScheduledFuture<*>? = null,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val sessions = TunnelSessionRegistry<ActiveTunnel>()
    private val timeoutExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "tunnel-timeouts").apply { isDaemon = true }
    }
    private var foregroundStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID)?.trim()?.takeIf(String::isNotEmpty)
        val tunnelToken = intent?.getStringExtra(EXTRA_TUNNEL_TOKEN)?.trim()?.takeIf(String::isNotEmpty)
        val engineWsUrl = intent?.getStringExtra(EXTRA_ENGINE_WS_URL)?.trim()?.takeIf(String::isNotEmpty)
        val label = intent?.getStringExtra(EXTRA_LABEL)?.trim().orEmpty()
        if (sessionId == null || tunnelToken == null || engineWsUrl == null) {
            Log.w(TAG, "ignoring tunnel start without a concrete authorized session")
            if (sessions.isEmpty()) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        if (sessions.get(sessionId) != null) {
            Log.w(TAG, "tunnel session $sessionId is already active")
            return START_NOT_STICKY
        }
        val separator = if (engineWsUrl.contains('?')) '&' else '?'
        val tunnel = Tunnel(
            sessionId,
            "${engineWsUrl}${separator}sessionId=$sessionId",
            tunnelToken,
            generation,
        )
        val active = ActiveTunnel(sessionId, label, tunnel)
        if (!sessions.add(sessionId, active)) return START_NOT_STICKY
        updateForeground()
        log("opening tunnel for session $sessionId")
        active.timeout = timeoutExecutor.schedule(
            { mainHandler.post { closeSession(sessionId, tunnel) } },
            TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
        )
        Thread({
            tunnel.runBlocking()
            mainHandler.post { closeSession(sessionId, tunnel) }
        }, "tunnel-session-$sessionId").apply { isDaemon = true; start() }
        return START_NOT_STICKY
    }

    private fun updateForeground() {
        val active = sessions.values()
        val labels = active.map { it.label }.filter(String::isNotBlank).sorted().joinToString(", ")
        if (active.isEmpty()) {
            if (foregroundStarted) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                foregroundStarted = false
            }
            return
        }
        val notification = CompanionNotifications.proxyServiceNotification(
            this,
            labels,
            active.size,
        )
        if (!foregroundStarted) {
            startForeground(CompanionNotifications.ID_PROXY_SERVICE, notification)
            foregroundStarted = true
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(CompanionNotifications.ID_PROXY_SERVICE, notification)
    }

    private fun closeSession(sessionId: String, expected: Tunnel? = null) {
        val active = sessions.get(sessionId) ?: return
        if (expected != null && active.tunnel !== expected) return
        if (sessions.remove(sessionId, active) == null) return
        active.timeout?.cancel(false)
        active.tunnel.close()
        if (sessions.isEmpty()) {
            updateForeground()
            stopSelf()
        } else {
            updateForeground()
        }
    }

    override fun onDestroy() {
        sessions.keys().forEach { closeSession(it) }
        timeoutExecutor.shutdownNow()
        super.onDestroy()
    }

    /** Lifecycle of one relayed connection: connecting → open → closed. CLOSED is terminal. */
    private enum class ConnState { CONNECTING, OPEN, CLOSED }

    /**
     * The whole state of one relayed connId, guarded by its own [lock]. `socket` is set BEFORE the blocking
     * connect() so a close can abort it; `writer` is the lazily-created ordered {data} writer. Never hold [lock]
     * while doing blocking socket I/O (connect/read/write) — only state/field mutations run under it.
     */
    private class Conn {
        val lock = Any()
        var state = ConnState.CONNECTING
        var socket: Socket? = null
        var writer: ExecutorService? = null
    }

    /**
     * One live tunnel: the engine WebSocket plus the map of connId → per-connection state machine it has us open.
     * Implements the phone side of the wire protocol.
     *
     * Threading model (off the main thread; OkHttp WS callbacks run on OkHttp's dispatcher, never main):
     *   - ALL per-connection state lives in ONE structure: `conns[connId]` → a [Conn] guarding its own state,
     *     socket, and ordered writer under a single per-conn lock. There is no separate sockets map, writers map,
     *     or closed-set: every check + mutation for a connId happens under that one lock, so there is no window
     *     between "is this conn closed?" and "publish its socket" for a {close} to slip through (the old TOCTOU).
     *   - Each connId gets ONE single-thread executor (`Conn.writer`). Every {data} frame for that connId is
     *     decoded and written to the socket on that one thread, so writes execute in the order the frames arrived
     *     (OkHttp delivers onMessage sequentially, so submission order == frame order). The writer is created lazily
     *     on the first frame and shut down by [finishConn]/[close], so it can never outlive teardown.
     *   - Blocking {connect}s run on a shared BOUNDED pool (`connectPool`) rather than a raw Thread each. The socket
     *     is tracked in its [Conn] BEFORE the blocking connect() starts, so a {close} (or tunnel teardown) closes
     *     that socket and aborts the blocked connect() — no leak, no orphaned pump.
     *   - [finishConn] removes the connId from `conns`, so the map can't grow unbounded over a long tunnel.
     */
    private inner class Tunnel(
        private val sessionId: String,
        private val wsUrl: String,
        private val tunnelToken: String,
        // The pairing generation live when this tunnel was opened. A later unpair bumps the shared counter, so this
        // tunnel's late callbacks can tell they belong to a torn-down pairing and drop their log writes (tlog).
        private val openGen: Int,
    ) : WebSocketListener() {
        private val client = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS) // keep the WS alive through carrier NAT idle timeouts
            .readTimeout(0, TimeUnit.MILLISECONDS) // a tunnel is long-lived; no read timeout
            .build()
        // The ONLY per-connection structure: connId → its state machine. Every socket/writer/closed check + mutation
        // for a connId happens under that Conn's own lock, so the lifecycle has no gaps for a race to slip through.
        private val conns = ConcurrentHashMap<Int, Conn>()
        // Shared bounded pool for the blocking connect handshakes — bounds the connect path instead of a raw
        // Thread per {connect}. SynchronousQueue + maximumPoolSize is the capped equivalent of a cached pool:
        // each connect hands off to an idle thread or spawns a new one up to MAX_CONNECT_THREADS, recycling idle
        // ones after 30s; beyond the cap a submit is REJECTED (we then fail that connect, never block the WS thread).
        // (An unbounded queue would be the classic pitfall — it would never grow past corePoolSize, here 0.)
        private val connectPool: ThreadPoolExecutor = ThreadPoolExecutor(
            0, MAX_CONNECT_THREADS, 30L, TimeUnit.SECONDS, SynchronousQueue(),
        ) { r -> Thread(r).apply { isDaemon = true; name = "tunnel-connect" } }
        // Relay volume, for the on-device tunnel-status log (observability): engine→bank request bytes and
        // bank→engine response bytes. Incremented from many worker threads, so atomic.
        private val bytesToBank = AtomicLong(0)
        private val bytesFromBank = AtomicLong(0)
        private val done = CountDownLatch(1)
        @Volatile private var finished = false
        @Volatile private var ws: WebSocket? = null

        val isOpen: Boolean get() = !finished

        /** Open the WS and block the caller until the tunnel ends (engine close, error, or service shutdown). */
        fun runBlocking() {
            val request = Request.Builder()
                .url(wsUrl)
                .header("Authorization", "Bearer $tunnelToken")
                .build()
            ws = client.newWebSocket(request, this)
            try {
                done.await()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            close()
        }

        /**
         * Tear everything down: every relayed connection (open OR still connecting), the connect pool, the WS, and
         * the OkHttp dispatcher; clear the conn map so nothing leaks past the tunnel. Idempotent.
         */
        fun close() {
            finish()
            // Drain via remove() so each Conn is closed exactly once and the map empties as we go. Closing the
            // socket aborts a blocked connect() OR closes an open socket; done under the conn lock so a
            // connect/data task sees CLOSED consistently. A connect task that races in AFTER finish() set
            // `finished` checks the flag (onConnect + the connect task both do) and self-closes without
            // blocking, so the map self-empties even if a late insert slips past this drain.
            for (id in conns.keys.toList()) {
                val conn = conns.remove(id) ?: continue
                val sock = synchronized(conn.lock) {
                    conn.state = ConnState.CLOSED
                    conn.writer?.shutdownNow()
                    conn.writer = null
                    conn.socket
                }
                sock?.let { closeQuietly(it) }
            }
            conns.clear()
            connectPool.shutdownNow()
            try {
                ws?.close(1000, "tunnel closed")
            } catch (e: Exception) {
                Log.w(TAG, "ws close failed", e)
            }
            client.dispatcher.executorService.shutdown()
        }

        private fun finish() {
            synchronized(done) {
                if (finished) return
                finished = true
                done.countDown()
            }
        }

        /**
         * Log a tunnel event ONLY while this tunnel still belongs to the LIVE pairing. Two guards, both required:
         *   - generation: an unpair bumps the shared counter synchronously in stop() (before Dart wipes the log and
         *     can re-pair), so a still-open OLD tunnel's late onClosed/onFailure — delivered on an OkHttp thread,
         *     possibly AFTER a new baseUrl is written — fails `openGen == generation` and is dropped, never leaking
         *     a stray "tunnel closed…" into the new pairing's log. stopService() is async, so this synchronous bump
         *     (not the instance/field state, which onDestroy only clears later) is what closes the re-pair window.
         *   - this is still the session map's tunnel: drops a stray callback after that session was replaced.
         * A NORMAL engine-initiated close still logs: onClosed writes its line BEFORE finish() unblocks runBlocking,
         * so both guards hold (this is still the live tunnel, generation unchanged) at log time.
         */
        private fun tlog(message: String) {
            if (openGen != generation || sessions.get(sessionId)?.tunnel !== this) return
            log(message)
        }

        // ── Engine → phone ──────────────────────────────────────────────

        override fun onOpen(webSocket: WebSocket, response: Response) {
            tlog("tunnel up for session $sessionId")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (e: Exception) {
                Log.w(TAG, "invalid tunnel message", e)
                return
            }
            when (msg.optString("type")) {
                "connect" -> onConnect(webSocket, msg.getInt("connId"), msg.getString("host"), msg.getInt("port"))
                "data" -> onData(msg.getInt("connId"), msg.getString("data"))
                "close" -> onClose(msg.getInt("connId"))
                else -> Log.w(TAG, "unknown tunnel message type: ${msg.optString("type")}")
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // The wire protocol is JSON text frames only; treat a binary frame as its UTF-8 text.
            onMessage(webSocket, bytes.utf8())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            tlog("tunnel closed for session $sessionId ($code) — relayed ${bytesToBank.get() / 1024}KB↑ ${bytesFromBank.get() / 1024}KB↓")
            finish()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.e(TAG, "tunnel ws failure for session $sessionId", t)
            tlog("tunnel error for session $sessionId: ${t.message ?: t.javaClass.simpleName}")
            finish()
        }

        /**
         * Engine asked us to open a TCP connection to (host, port). Register the connId's [Conn] first, then open
         * the REAL socket on a bounded worker pool — connecting can block — answer {connected} and pump the socket
         * → WS as {data, base64}. The socket's local IP is THIS phone, which is the whole point: the bank sees the
         * residential IP. The socket is tracked in its Conn BEFORE connect() blocks, so a {close}/teardown can abort it.
         */
        private fun onConnect(webSocket: WebSocket, connId: Int, host: String, port: Int) {
            if (finished) return // tunnel tearing down — refuse new connects so teardown can't miss/orphan one
            val conn = Conn()
            if (conns.putIfAbsent(connId, conn) != null) return // duplicate connId — ignore
            val task = Runnable {
                val s = Socket()
                // Track the socket BEFORE connecting so a {close}/teardown that lands while connect() blocks can
                // close it (which aborts the blocked connect). If we're already CLOSED, drop it and bail.
                // Check `finished` too: a teardown that started after our putIfAbsent may have missed this Conn
                // (the map drain is weakly-consistent), so bail BEFORE connect() blocks — otherwise we'd hold a
                // socket teardown can no longer reach until connect times out.
                val aborted = synchronized(conn.lock) {
                    if (finished || conn.state == ConnState.CLOSED) {
                        true
                    } else {
                        conn.socket = s
                        false
                    }
                }
                if (aborted) {
                    closeQuietly(s)
                    finishConn(connId) // remove the stale Conn so the map self-empties even if teardown missed it
                    return@Runnable
                }
                try {
                    // Blocking connect runs OUTSIDE the lock; a concurrent close()/onClose closes `s` to abort it.
                    s.connect(java.net.InetSocketAddress(host, port), SOCKET_CONNECT_TIMEOUT_MS)
                } catch (e: Exception) {
                    Log.w(TAG, "connect $host:$port failed", e)
                    closeQuietly(s)
                    finishConn(connId)
                    sendError(connId, e.message ?: e.javaClass.simpleName)
                    return@Runnable
                }
                // Flip to OPEN under the lock; if a close raced in while we connected, we're CLOSED — drop + bail.
                val open = synchronized(conn.lock) {
                    if (finished || conn.state == ConnState.CLOSED) {
                        false
                    } else {
                        conn.state = ConnState.OPEN
                        true
                    }
                }
                if (!open) {
                    closeQuietly(s)
                    finishConn(connId)
                    return@Runnable
                }
                tlog("relaying → $host:$port")
                // If the {connected} frame didn't go out (backpressure/closing), the engine never learns this conn
                // opened — relaying on would leave a live socket + pump the engine can't address. Tear down instead.
                if (!send(JSONObject().put("type", "connected").put("connId", connId))) {
                    finishConn(connId)
                    closeQuietly(s)
                    return@Runnable
                }
                pumpSocketToWs(connId, conn, s)
            }
            try {
                connectPool.execute(task)
            } catch (e: RejectedExecutionException) {
                if (connectPool.isShutdown) {
                    // The tunnel is tearing down — nothing to do; the engine half is gone.
                    Log.w(TAG, "connect $host:$port rejected (tunnel closing)", e)
                    finishConn(connId)
                } else {
                    // Saturated at MAX_CONNECT_THREADS — fail this connect so the engine's SOCKS5 doesn't hang.
                    Log.w(TAG, "connect $host:$port rejected (connect pool saturated)", e)
                    finishConn(connId)
                    sendError(connId, "connect pool saturated")
                }
            }
        }

        /**
         * Read the target socket until EOF/error and relay each chunk back to the engine as a data frame. Owns the
         * socket while this conn is OPEN; on any exit it closes the socket + [finishConn]s the conn. A read error or
         * EOF after the engine already closed its half (state flipped to CLOSED) is silent — that's expected.
         */
        private fun pumpSocketToWs(connId: Int, conn: Conn, socket: Socket) {
            try {
                val input: InputStream = socket.getInputStream()
                val buf = ByteArray(SOCKET_READ_BUFFER)
                while (!finished) {
                    val n = input.read(buf)
                    if (n == -1) break // remote EOF
                    bytesFromBank.addAndGet(n.toLong())
                    val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                    // ws.send returns false on backpressure/closing — those bytes did NOT go out. Silently reading
                    // on would drop them and corrupt the stream, so tear down THIS connection instead.
                    if (!send(JSONObject().put("type", "data").put("connId", connId).put("data", b64))) {
                        if (markClosed(conn)) {
                            Log.w(TAG, "ws send backpressure for conn $connId — tearing down")
                            sendError(connId, "ws send failed (backpressure)") // best-effort; WS may be closing
                        }
                        return
                    }
                }
                // Clean EOF → tell the engine to close its half (only if it hadn't already closed it).
                if (markClosed(conn)) {
                    send(JSONObject().put("type", "close").put("connId", connId)) // tolerate a false send: tunnel ending
                }
            } catch (e: Exception) {
                // Only surface an error if the engine half is still open (not already closed by an engine 'close').
                if (markClosed(conn)) {
                    Log.w(TAG, "socket read error for conn $connId", e)
                    sendError(connId, e.message ?: e.javaClass.simpleName)
                }
            } finally {
                closeQuietly(socket)
                finishConn(connId)
            }
        }

        /**
         * Flip a conn to CLOSED, returning true only if THIS call did the flip (it was still OPEN). A false return
         * means the engine (or teardown) already closed it, so the caller must NOT send a redundant close/error.
         */
        private fun markClosed(conn: Conn): Boolean = synchronized(conn.lock) {
            if (conn.state == ConnState.CLOSED) {
                false
            } else {
                conn.state = ConnState.CLOSED
                true
            }
        }

        /**
         * Engine relayed bytes for an open connection — decode and write them to the target socket. Submitted to
         * this connId's single-thread writer so frames are written in arrival order (OkHttp delivers onMessage
         * sequentially, so submission order == frame order). A per-frame Thread used to let two frames race the
         * OutputStream and write out of order. The writer is created lazily under the conn lock and shut down by
         * [finishConn]/[close], so it can never be created after teardown nor outlive it.
         */
        private fun onData(connId: Int, dataB64: String) {
            val conn = conns[connId] ?: return
            // Under the lock: only an OPEN conn accepts data; lazily create its one ordered writer. Doing both under
            // the lock means a writer is never created for a CLOSED conn (so it can't be leaked past teardown).
            val w = synchronized(conn.lock) {
                if (conn.state != ConnState.OPEN) return
                conn.writer ?: Executors.newSingleThreadExecutor { r ->
                    Thread(r).apply { isDaemon = true; name = "tunnel-writer-$connId" }
                }.also { conn.writer = it }
            }
            try {
                w.execute {
                    // Re-read the socket under the lock inside the task: it may have CLOSED between submit and run.
                    val sock = synchronized(conn.lock) { if (conn.state != ConnState.OPEN) null else conn.socket }
                        ?: return@execute
                    try {
                        val bytes = Base64.decode(dataB64, Base64.DEFAULT)
                        bytesToBank.addAndGet(bytes.size.toLong())
                        val out: OutputStream = sock.getOutputStream()
                        out.write(bytes)
                        out.flush()
                    } catch (e: Exception) {
                        if (markClosed(conn)) {
                            Log.w(TAG, "socket write error for conn $connId", e)
                            sendError(connId, e.message ?: e.javaClass.simpleName)
                            closeQuietly(sock)
                            finishConn(connId)
                        }
                    }
                }
            } catch (e: RejectedExecutionException) {
                // The writer was shut down (connection/tunnel tearing down) — the socket is already gone.
                Log.w(TAG, "data for conn $connId rejected (closing)", e)
            }
        }

        /**
         * Engine closed its half — flip the conn to CLOSED and close its socket. Closing the socket aborts a connect
         * still BLOCKING in connect() (its socket was tracked in the Conn BEFORE connect started) OR closes an open
         * socket (the pump then sees the read error/close and exits). All under the conn lock — there is no window
         * for a connect to publish a fresh socket after we've decided to close, so nothing leaks or keeps pumping.
         */
        private fun onClose(connId: Int) {
            val conn = conns[connId] ?: return
            val sock = synchronized(conn.lock) {
                conn.state = ConnState.CLOSED
                conn.socket
            }
            sock?.let { closeQuietly(it) }
            finishConn(connId)
        }

        /**
         * Fully tear down one connId: remove it from the conn map (bounding memory) and shut its ordered writer.
         * Idempotent — the second call finds nothing in the map and returns. Does NOT close the socket (the caller
         * that owns this terminal path already closed it); only the writer + map entry are cleaned here.
         */
        private fun finishConn(connId: Int) {
            val conn = conns.remove(connId) ?: return
            synchronized(conn.lock) {
                conn.state = ConnState.CLOSED
                conn.writer?.shutdownNow()
                conn.writer = null
            }
        }

        // ── Phone → engine ──────────────────────────────────────────────

        private fun sendError(connId: Int, message: String) {
            send(JSONObject().put("type", "error").put("connId", connId).put("message", message))
        }

        /**
         * Send a frame to the engine. Returns whether OkHttp accepted it: WebSocket.send returns false on
         * backpressure or while closing, meaning the bytes did NOT go out. Callers relaying DATA must act on a
         * false return (stop + tear down the connection) rather than silently dropping the bytes.
         */
        private fun send(msg: JSONObject): Boolean {
            if (finished) return false
            return ws?.send(msg.toString()) ?: false
        }

        private fun closeQuietly(socket: Socket) {
            try {
                socket.close()
            } catch (e: Exception) {
                Log.w(TAG, "socket close failed", e)
            }
        }
    }

    /**
     * Append one entry to the rolling tunnel log (newest first, capped). Stored as a JSON string under the
     * `flutter.`-prefixed key so the Dart UI reads it straight from SharedPreferences with getString — the same
     * convention as NativeRelay's relay log.
     */
    @Synchronized
    private fun log(message: String) {
        val prefs = getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        // Gate EVERY write on the live pairing. log() is the one choke point all writers funnel through — the poll
        // thread AND the tunnel's WebSocket callbacks (onOpen/onClosed/onFailure), which fire on OkHttp threads.
        // Once an unpair clears the pairing, a late callback (e.g. an onClosed delivered after teardown) must not
        // resurrect a "tunnel closed…" line on the freshly-unpaired screen. Dropping the write here — under log()'s
        // own monitor — makes the suppression thread-agnostic: it holds no matter which thread is writing. Gate on
        // baseUrl only (not the token), so a genuine "token rejected" while STILL paired is preserved.
        if (prefs.getString(KEY_BASE_URL, null)?.trim().isNullOrEmpty()) return
        val arr = try {
            JSONArray(prefs.getString(KEY_TUNNEL_LOG, "[]"))
        } catch (e: Exception) {
            JSONArray()
        }
        // Coalesce a run of the SAME message into a single entry whose timestamp advances. The poll loop runs
        // every few seconds, so a persistent condition (the console unreachable, or the token rejected) would
        // otherwise append an identical "failed to connect" line on every tick and flood the activity list —
        // burying real events and making a temporarily-offline console look like a broken app. Newest is at [0].
        val newest = if (arr.length() > 0) arr.optJSONObject(0) else null
        if (newest != null && newest.optString("message") == message) {
            newest.put("at", System.currentTimeMillis())
            prefs.edit().putString(KEY_TUNNEL_LOG, arr.toString()).apply()
            Log.i(TAG, message)
            return
        }
        val entry = JSONObject().put("at", System.currentTimeMillis()).put("message", message)
        val trimmed = JSONArray().put(entry)
        for (i in 0 until minOf(arr.length(), MAX_LOG_ENTRIES - 1)) trimmed.put(arr.get(i))
        prefs.edit().putString(KEY_TUNNEL_LOG, trimmed.toString()).apply()
        Log.i(TAG, message)
    }

    companion object {
        private const val TAG = "TunnelService"
        // Same SharedPreferences file + key prefix the Flutter shared_preferences (legacy API) uses.
        private const val PREFS_FILE = "FlutterSharedPreferences"
        private const val KEY_BASE_URL = "flutter.baseUrl"
        private const val KEY_DEVICE_TOKEN = "flutter.deviceToken"
        // Rolling tunnel-status log, `flutter.`-prefixed so the Dart UI reads it as a plain String pref.
        private const val KEY_TUNNEL_LOG = "flutter.nativeTunnelLog"
        private const val MAX_LOG_ENTRIES = 50

        private const val TIMEOUT_SECONDS = 600L
        private const val SOCKET_CONNECT_TIMEOUT_MS = 15_000
        private const val SOCKET_READ_BUFFER = 16 * 1024
        // Cap on concurrent blocking connect handshakes (one bounded shared pool, not a Thread per {connect}). A
        // browser fans out a handful of sockets per page; this comfortably covers that without unbounded growth.
        private const val MAX_CONNECT_THREADS = 32

        // Monotonic pairing generation, bumped synchronously in stop() (unpair). A Tunnel captures the generation
        // it was opened under; its late WebSocket callbacks log ONLY while that generation is still live (see
        // Tunnel.tlog). This is what tells an old-pairing tunnel apart from one opened after an immediate re-pair —
        // the stopService() that tears the old one down is async, so the field/instance check alone has a window.
        @Volatile
        private var generation = 0

        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_LABEL = "label"
        private const val EXTRA_TUNNEL_TOKEN = "tunnel_token"
        private const val EXTRA_ENGINE_WS_URL = "engine_ws_url"

        internal fun start(ctx: Context, session: CompanionSessionRecovery.AwaitingTunnel) {
            if (session.sessionId.isBlank() || session.tunnelToken.isBlank() || session.engineWsUrl.isBlank()) return
            val i = Intent(ctx, TunnelService::class.java).apply {
                putExtra(EXTRA_SESSION_ID, session.sessionId)
                putExtra(EXTRA_LABEL, session.label)
                putExtra(EXTRA_TUNNEL_TOKEN, session.tunnelToken)
                putExtra(EXTRA_ENGINE_WS_URL, session.engineWsUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            // Invalidate every tunnel opened under the CURRENT pairing BEFORE the (async) stopService lands. The
            // unpair path awaits this call, then wipes the log and may immediately re-pair; bumping here —
            // synchronously, on the platform thread, before we return to Dart — guarantees a still-open old
            // tunnel's late onClosed/onFailure (delivered on an OkHttp thread, possibly after a new baseUrl is
            // written) fails its generation check and is dropped, instead of writing a stray "tunnel closed…" into
            // the new pairing's log. A tunnel opened AFTER the re-pair captures the new generation and logs normally.
            generation++
            ctx.stopService(Intent(ctx, TunnelService::class.java))
        }
    }
}
