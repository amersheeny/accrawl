package app.accrawl.accrawl_companion

/**
 * Session notification policy, kept as a pure decision table so every branch is testable without Android:
 * only a live OTP-relay or tunnel foreground service produces a notification. Relay outcomes, errors,
 * waiting-state transitions, access failures, and proxy-unavailable events remain in the in-app activity log.
 */
sealed interface CompanionNotificationEvent {
    data class OtpSessions(val activeCount: Int) : CompanionNotificationEvent
    data class TunnelSessions(val activeCount: Int) : CompanionNotificationEvent

    enum class LogOnly : CompanionNotificationEvent {
        RELAY_ACCEPTED,
        RELAY_NO_CODE,
        RELAY_AMBIGUOUS,
        RELAY_UNMATCHED,
        RELAY_FAILED,
        ACCESS_INVALID,
        OTP_WATCHING,
        OTP_WAITING,
        OTP_WAITING_MANUAL,
        PROXY_UNAVAILABLE,
    }
}

sealed interface CompanionNotificationDecision {
    data class OtpForeground(val activeCount: Int) : CompanionNotificationDecision
    data class TunnelForeground(val activeCount: Int) : CompanionNotificationDecision
    data object None : CompanionNotificationDecision
}

object CompanionNotificationPolicy {
    fun decide(event: CompanionNotificationEvent): CompanionNotificationDecision = when (event) {
        is CompanionNotificationEvent.OtpSessions -> if (event.activeCount > 0) {
            CompanionNotificationDecision.OtpForeground(event.activeCount)
        } else {
            CompanionNotificationDecision.None
        }
        is CompanionNotificationEvent.TunnelSessions -> if (event.activeCount > 0) {
            CompanionNotificationDecision.TunnelForeground(event.activeCount)
        } else {
            CompanionNotificationDecision.None
        }
        is CompanionNotificationEvent.LogOnly -> CompanionNotificationDecision.None
    }
}
