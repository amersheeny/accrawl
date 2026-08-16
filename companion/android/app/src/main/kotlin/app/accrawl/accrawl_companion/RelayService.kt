package app.accrawl.accrawl_companion

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Session-bound OTP relay lifecycle: different institutions run concurrently; sessions for
 * the same institution queue; the dynamic SMS receiver, inbox observer fallback, and foreground notification
 * exist only while at least one live crawl is being served; every session ends on submission, server terminal
 * state, or timeout.
 */
class RelayService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val sessions = OtpSessionQueue()
    private val timeouts = mutableMapOf<String, ScheduledFuture<*>>()
    private var executor: ScheduledExecutorService? = null
    private var smsExecutor: ExecutorService? = null
    private var smsReceiver: SmsReceiver? = null
    private var smsObserver: SmsContentObserver? = null
    private val smsDeliveryDeduplicator = SmsDeliveryDeduplicator()
    private val sessionStartedAtMillis = ConcurrentHashMap<String, Long>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        CompanionNotifications.ensureChannels(this)
        executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "otp-session-watch").apply { isDaemon = true }
        }.also { scheduled ->
            scheduled.scheduleWithFixedDelay(::sync, POLL_SECONDS, POLL_SECONDS, TimeUnit.SECONDS)
        }
        smsExecutor = Executors.newFixedThreadPool(2) { runnable ->
            Thread(runnable, "otp-sms-relay").apply { isDaemon = true }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val session = intent?.toSession()
        if (session == null) {
            Log.w(TAG, "ignoring relay start without a concrete session")
            if (sessions.size == 0) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        when (sessions.add(session)) {
            OtpSessionQueue.AddResult.START -> startServing(session)
            OtpSessionQueue.AddResult.QUEUE -> {
                confirmStatus(session.sessionId, ready = false)
                updateForeground()
            }
            OtpSessionQueue.AddResult.DUPLICATE -> Unit
            OtpSessionQueue.AddResult.REJECTED -> {
                Log.w(TAG, "rejecting malformed relay session ${session.sessionId}")
                if (sessions.size == 0) stopSelfResult(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun startServing(session: OtpSessionQueue.Session) {
        timeouts.remove(session.sessionId)?.cancel(false)
        timeouts[session.sessionId] = executor?.schedule(
            { mainHandler.post { finishSession(session.sessionId) } },
            TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
        ) ?: return
        sessionStartedAtMillis[session.sessionId] = System.currentTimeMillis()
        updateForeground()
        registerSmsSourcesIfNeeded()
        confirmStatus(session.sessionId, ready = true)
    }

    private fun registerSmsSourcesIfNeeded() {
        if (smsReceiver == null && hasPermission(Manifest.permission.RECEIVE_SMS)) {
            val receiver = SmsReceiver { sender, body, receivedAtMillis, complete ->
                dispatchSms(SmsDeliverySource.BROADCAST, sender, body, receivedAtMillis, complete)
            }
            val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION).apply {
                priority = IntentFilter.SYSTEM_HIGH_PRIORITY
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    registerReceiver(receiver, filter)
                }
                smsReceiver = receiver
            } catch (error: RuntimeException) {
                Log.e(TAG, "SMS broadcast receiver registration failed", error)
            }
        }

        if (smsObserver == null && hasPermission(Manifest.permission.READ_SMS)) {
            val observer = SmsContentObserver(mainHandler, this) { sender, body, receivedAtMillis ->
                dispatchSms(SmsDeliverySource.OBSERVER, sender, body, receivedAtMillis)
            }
            if (observer.initialize()) {
                try {
                    contentResolver.registerContentObserver(SmsContentObserver.SMS_INBOX_URI, true, observer)
                    smsObserver = observer
                } catch (error: RuntimeException) {
                    Log.e(TAG, "SMS inbox observer registration failed", error)
                }
            }
        }
    }

    private fun dispatchSms(
        source: SmsDeliverySource,
        sender: String,
        body: String,
        receivedAtMillis: Long,
        onComplete: () -> Unit = {},
    ) {
        val worker = smsExecutor
        if (worker == null || worker.isShutdown) {
            onComplete()
            return
        }
        try {
            worker.execute {
                try {
                    NativeRelay.handleSms(
                        applicationContext,
                        source,
                        sender,
                        body,
                        receivedAtMillis,
                        smsDeliveryDeduplicator,
                    )
                } finally {
                    onComplete()
                }
            }
        } catch (error: RejectedExecutionException) {
            Log.e(TAG, "SMS relay worker rejected a delivery", error)
            onComplete()
        }
    }

    private fun unregisterSmsSources() {
        smsReceiver?.let { receiver ->
            try {
                unregisterReceiver(receiver)
            } catch (error: IllegalArgumentException) {
                Log.w(TAG, "SMS receiver was already unregistered", error)
            }
        }
        smsReceiver = null
        smsObserver?.let { observer ->
            try {
                contentResolver.unregisterContentObserver(observer)
            } catch (error: RuntimeException) {
                Log.w(TAG, "SMS inbox observer was already unregistered", error)
            }
        }
        smsObserver = null
        smsDeliveryDeduplicator.clear()
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasSmsAccess(): Boolean =
        hasPermission(Manifest.permission.RECEIVE_SMS) && hasPermission(Manifest.permission.READ_SMS)

    private fun updateForeground() {
        val activeCount = sessions.activeSessions().size
        if (activeCount == 0) return
        startForeground(
            CompanionNotifications.ID_RELAY_SERVICE,
            CompanionNotifications.relayServiceNotification(this, activeCount),
        )
    }

    private fun confirmStatus(sessionId: String, ready: Boolean) {
        executor?.execute {
            val pairing = NativeRelay.pairing(this) ?: return@execute
            try {
                NativeRelay.markRelayStatus(
                    pairing.baseUrl,
                    pairing.deviceToken,
                    sessionId,
                    hasSmsAccess(),
                    ready,
                )
            } catch (error: Exception) {
                Log.w(TAG, "relay status failed for $sessionId", error)
            }
        }
    }

    private fun sync() {
        val pairing = NativeRelay.pairing(this)
        if (pairing == null) {
            mainHandler.post(::finishAll)
            return
        }
        try {
            val awaiting = NativeRelay.fetchAwaiting(pairing.baseUrl, pairing.deviceToken)
            if (awaiting == null) {
                Log.w(TAG, "paired-device access was rejected; stopping OTP relay")
                mainHandler.post(::finishAll)
                return
            }
            if (NativeRelay.pairing(this) != pairing) return
            mainHandler.post { reconcile(awaiting) }
        } catch (error: Exception) {
            Log.w(TAG, "OTP session watch failed", error)
        }
    }

    private fun reconcile(awaiting: List<NativeRelay.Awaiting>) {
        val liveById = awaiting.associateBy { it.id }
        for (tracked in sessions.allSessions()) {
            val live = liveById[tracked.sessionId]
            if (live == null || live.otpRequestEpoch != tracked.otpRequestEpoch) {
                finishSession(tracked.sessionId)
                continue
            }
            val updated = live.toQueueSession()
            sessions.update(updated)
        }
        for (live in awaiting) {
            if (!sessions.contains(live.id)) {
                onStartCommand(intentFor(this, live), 0, 0)
            }
        }
        val activeIds = sessions.activeSessions().mapTo(mutableSetOf()) { it.sessionId }
        for (tracked in sessions.allSessions()) {
            confirmStatus(tracked.sessionId, ready = tracked.sessionId in activeIds)
        }
        if (sessions.size == 0) stopWhenEmpty() else updateForeground()
    }

    private fun finishSession(sessionId: String) {
        val result = sessions.finish(sessionId) ?: return
        sessionStartedAtMillis.remove(result.finished.sessionId)
        timeouts.remove(result.finished.sessionId)?.cancel(false)
        result.promoted?.let(::startServing)
        if (sessions.size == 0) stopWhenEmpty() else updateForeground()
    }

    private fun finishAll() {
        sessions.clear().forEach { session ->
            timeouts.remove(session.sessionId)?.cancel(false)
        }
        sessionStartedAtMillis.clear()
        stopWhenEmpty()
    }

    private fun stopWhenEmpty() {
        unregisterSmsSources()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        unregisterSmsSources()
        smsExecutor?.shutdownNow()
        smsExecutor = null
        executor?.shutdownNow()
        executor = null
        timeouts.values.forEach { it.cancel(false) }
        timeouts.clear()
        sessions.clear()
        sessionStartedAtMillis.clear()
        super.onDestroy()
    }

    private fun Intent.toSession(): OtpSessionQueue.Session? {
        val sessionId = getStringExtra(EXTRA_SESSION_ID)?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val institutionId = getStringExtra(EXTRA_INSTITUTION_ID)?.trim().orEmpty()
        val institutionName = getStringExtra(EXTRA_INSTITUTION_NAME)?.trim().orEmpty()
        val epoch = getIntExtra(EXTRA_OTP_REQUEST_EPOCH, -1)
        if ((institutionId.isEmpty() && institutionName.isEmpty()) || epoch < 0) return null
        return OtpSessionQueue.Session(
            sessionId = sessionId,
            institutionId = institutionId,
            institutionName = institutionName,
            connectionName = getStringExtra(EXTRA_CONNECTION_NAME),
            senderPattern = getStringExtra(EXTRA_SENDER_PATTERN),
            otpRequestEpoch = epoch,
            status = getStringExtra(EXTRA_STATUS).orEmpty().ifBlank { "starting" },
        )
    }

    private fun NativeRelay.Awaiting.toQueueSession() = OtpSessionQueue.Session(
        sessionId = id,
        institutionId = institutionId,
        institutionName = name.orEmpty(),
        connectionName = connectionName,
        senderPattern = otpSenderPattern,
        otpRequestEpoch = otpRequestEpoch,
        status = status,
    )

    companion object {
        private const val TAG = "RelayService"
        private const val POLL_SECONDS = 4L
        private const val TIMEOUT_SECONDS = 180L
        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_INSTITUTION_ID = "institution_id"
        private const val EXTRA_INSTITUTION_NAME = "institution_name"
        private const val EXTRA_CONNECTION_NAME = "connection_name"
        private const val EXTRA_SENDER_PATTERN = "sender_pattern"
        private const val EXTRA_OTP_REQUEST_EPOCH = "otp_request_epoch"
        private const val EXTRA_STATUS = "status"

        @Volatile private var instance: RelayService? = null

        internal fun start(context: Context, session: NativeRelay.Awaiting) {
            if (session.id.isBlank() || (session.institutionId.isBlank() && session.name.isNullOrBlank())) return
            val intent = intentFor(context, session)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        private fun intentFor(context: Context, session: NativeRelay.Awaiting): Intent =
            Intent(context, RelayService::class.java).apply {
                putExtra(EXTRA_SESSION_ID, session.id)
                putExtra(EXTRA_INSTITUTION_ID, session.institutionId)
                putExtra(EXTRA_INSTITUTION_NAME, session.name.orEmpty())
                putExtra(EXTRA_CONNECTION_NAME, session.connectionName)
                putExtra(EXTRA_SENDER_PATTERN, session.otpSenderPattern)
                putExtra(EXTRA_OTP_REQUEST_EPOCH, session.otpRequestEpoch)
                putExtra(EXTRA_STATUS, session.status)
            }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayService::class.java))
        }

        fun otpSubmitted(sessionId: String) {
            val service = instance ?: return
            service.mainHandler.post { service.finishSession(sessionId) }
        }

        fun activeSessionIds(smsReceivedAtMillis: Long): Set<String> {
            val service = instance ?: return emptySet()
            return eligibleSmsSessionIds(
                service.sessions.activeSessions(),
                service.sessionStartedAtMillis,
                smsReceivedAtMillis,
            )
        }

        fun permissionsChanged() {
            val service = instance ?: return
            service.mainHandler.post {
                service.registerSmsSourcesIfNeeded()
                service.sessions.allSessions().forEach { tracked ->
                    service.confirmStatus(
                        tracked.sessionId,
                        ready = service.sessions.activeSessions().any { it.sessionId == tracked.sessionId },
                    )
                }
            }
        }
    }
}
