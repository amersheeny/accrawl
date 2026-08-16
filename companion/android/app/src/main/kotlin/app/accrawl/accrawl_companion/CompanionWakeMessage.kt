package app.accrawl.accrawl_companion

/**
 * Data-only FCM wake messages. They are hints, never authorization: the receiver must re-read the exact
 * session through the paired-device API before starting a foreground service.
 */
sealed interface CompanionWakeMessage {
    val sessionId: String

    data class Otp(
        override val sessionId: String,
        val institutionId: String,
        val institutionName: String,
        val connectionName: String?,
        val otpSenderPattern: String?,
        val otpRequestEpoch: Int,
    ) : CompanionWakeMessage

    data class Tunnel(
        override val sessionId: String,
        val institutionId: String,
        val institutionName: String,
        val connectionName: String?,
    ) : CompanionWakeMessage

    companion object {
        fun parse(data: Map<String, String>): CompanionWakeMessage? {
            val sessionId = data["sessionId"]?.trim()?.takeIf(String::isNotEmpty) ?: return null
            val institutionId = data["institutionId"]?.trim().orEmpty()
            val institutionName = data["institutionName"]?.trim().orEmpty()
            val connectionName = data["connectionName"]?.trim()?.takeIf(String::isNotEmpty)
            return when (data["type"]?.trim().orEmpty()) {
                "" -> {
                    val epoch = data["otpRequestEpoch"]?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
                    Otp(
                        sessionId = sessionId,
                        institutionId = institutionId,
                        institutionName = institutionName,
                        connectionName = connectionName,
                        otpSenderPattern = data["otpSenderPattern"]?.trim()?.takeIf(String::isNotEmpty),
                        otpRequestEpoch = epoch,
                    )
                }
                "tunnel" -> Tunnel(sessionId, institutionId, institutionName, connectionName)
                else -> null
            }
        }
    }
}
