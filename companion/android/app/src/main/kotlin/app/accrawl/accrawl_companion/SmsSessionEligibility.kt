package app.accrawl.accrawl_companion

/** An SMS can only belong to a session that was already active when Android received the message. */
internal fun eligibleSmsSessionIds(
    activeSessions: List<OtpSessionQueue.Session>,
    startedAtMillis: Map<String, Long>,
    smsReceivedAtMillis: Long,
): Set<String> = activeSessions
    .filter { session ->
        val startedAt = startedAtMillis[session.sessionId] ?: return@filter false
        startedAt <= smsReceivedAtMillis
    }
    .mapTo(mutableSetOf()) { it.sessionId }
