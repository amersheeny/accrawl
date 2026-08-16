package app.accrawl.accrawl_companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Active-only foreground notifications. The only notification branches are the Android-required
 * ongoing notifications for a live OTP-relay service and a live device-proxy service. Pairing, idle state,
 * relay outcomes, and errors never post another notification; those events remain visible in the app log.
 */
object CompanionNotifications {
    const val CHANNEL_RELAY = "accrawl_sms_relay"
    const val CHANNEL_PROXY = "accrawl_device_proxy"

    const val ID_PROXY_SERVICE = 2002
    const val ID_RELAY_SERVICE = 2004

    /** Extra on MainActivity launch intents: which in-app surface a notification tap should land on. */
    const val EXTRA_OPEN_TARGET = "app.accrawl.accrawl_companion.OPEN_TARGET"
    const val TARGET_RELAY = "relay"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            channel(
                CHANNEL_RELAY,
                NotificationCopy.CHANNEL_RELAY_NAME,
                NotificationCopy.CHANNEL_RELAY_DESCRIPTION,
            ),
        )
        manager.createNotificationChannel(
            channel(
                CHANNEL_PROXY,
                NotificationCopy.CHANNEL_PROXY_NAME,
                NotificationCopy.CHANNEL_PROXY_DESCRIPTION,
            ),
        )
        // Migration-only cleanup. Previous Accrawl builds created high-priority channels for transient
        // obsolete outcome/access notifications. Removing those unused channels also removes
        // any persistent legacy notification without touching either active foreground-service channel.
        manager.deleteNotificationChannel(LEGACY_CHANNEL_MANUAL)
        manager.deleteNotificationChannel(LEGACY_CHANNEL_ACCESS)
    }

    private fun channel(id: String, name: String, description: String): NotificationChannel =
        NotificationChannel(id, name, NotificationManager.IMPORTANCE_LOW).also {
            it.description = description
            it.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            it.setSound(null, null)
        }

    fun fill(template: String, vararg pairs: Pair<String, String>): String {
        var out = template
        for ((key, value) in pairs) out = out.replace("{$key}", value)
        return out
    }

    fun relayServiceNotification(context: Context, activeCount: Int): Notification {
        val decision = CompanionNotificationPolicy.decide(
            CompanionNotificationEvent.OtpSessions(activeCount),
        )
        require(decision is CompanionNotificationDecision.OtpForeground) {
            "relay foreground notification requires an active crawl"
        }
        return foreground(
            context,
            CHANNEL_RELAY,
            NotificationCopy.RELAY_ACTIVE_TITLE,
            fill(NotificationCopy.RELAY_ACTIVE_BODY, "count" to decision.activeCount.toString()),
        )
    }

    fun proxyServiceNotification(
        context: Context,
        routingLabel: String,
        activeCount: Int,
    ): Notification {
        val decision = CompanionNotificationPolicy.decide(
            CompanionNotificationEvent.TunnelSessions(activeCount),
        )
        require(decision is CompanionNotificationDecision.TunnelForeground) {
            "proxy foreground notification requires an active crawl"
        }
        val title = if (routingLabel.isBlank()) {
            NotificationCopy.PROXY_ROUTING_TITLE_FALLBACK
        } else {
            fill(NotificationCopy.PROXY_ROUTING_TITLE, "label" to routingLabel)
        }
        return foreground(
            context,
            CHANNEL_PROXY,
            title,
            NotificationCopy.PROXY_ROUTING_BODY,
            NotificationCopy.PROXY_PUBLIC,
        )
    }

    private fun foreground(
        context: Context,
        channel: String,
        title: String,
        body: String,
        publicText: String = title,
    ): Notification {
        ensureChannels(context)
        return NotificationCompat.Builder(context, channel)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_stat_accrawl)
            .setContentIntent(openAppIntent(context))
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(context, channel, publicText))
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun publicVersion(context: Context, channel: String, text: String): Notification =
        NotificationCompat.Builder(context, channel)
            .setContentTitle(text)
            .setSmallIcon(R.drawable.ic_stat_accrawl)
            .build()

    private fun openAppIntent(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(EXTRA_OPEN_TARGET, TARGET_RELAY)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private const val LEGACY_CHANNEL_MANUAL = "accrawl_manual_code"
    private const val LEGACY_CHANNEL_ACCESS = "accrawl_phone_access"
}
