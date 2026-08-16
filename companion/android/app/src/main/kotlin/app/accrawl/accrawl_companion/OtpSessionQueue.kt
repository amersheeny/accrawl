package app.accrawl.accrawl_companion

/** OTP concurrency policy: different institutions run together; requests for the same one queue. */
class OtpSessionQueue {
    data class Session(
        val sessionId: String,
        val institutionId: String,
        val institutionName: String,
        val connectionName: String?,
        val senderPattern: String?,
        val otpRequestEpoch: Int,
        val status: String,
    ) {
        val institutionKey: String
            get() = institutionId.trim().ifEmpty { institutionName.trim() }
    }

    enum class AddResult { START, QUEUE, DUPLICATE, REJECTED }

    data class FinishResult(val finished: Session, val promoted: Session?)

    private val active = linkedMapOf<String, Session>()
    private val pendingByInstitution = linkedMapOf<String, ArrayDeque<Session>>()

    val size: Int
        @Synchronized get() = active.size + pendingByInstitution.values.sumOf { it.size }

    @Synchronized
    fun contains(sessionId: String): Boolean =
        active.containsKey(sessionId) || pendingByInstitution.values.any { queue ->
            queue.any { it.sessionId == sessionId }
        }

    @Synchronized
    fun add(session: Session): AddResult {
        if (session.sessionId.isBlank() || session.institutionKey.isBlank() || session.otpRequestEpoch < 0) {
            return AddResult.REJECTED
        }
        if (contains(session.sessionId)) return AddResult.DUPLICATE
        val key = session.institutionKey
        if (active.values.any { it.institutionKey == key }) {
            pendingByInstitution.getOrPut(key) { ArrayDeque() }.addLast(session)
            return AddResult.QUEUE
        }
        active[session.sessionId] = session
        return AddResult.START
    }

    @Synchronized
    fun finish(sessionId: String): FinishResult? {
        val finished = active.remove(sessionId) ?: run {
            for ((key, queue) in pendingByInstitution) {
                val removed = queue.firstOrNull { it.sessionId == sessionId } ?: continue
                queue.remove(removed)
                if (queue.isEmpty()) pendingByInstitution.remove(key)
                return FinishResult(removed, null)
            }
            return null
        }
        val key = finished.institutionKey
        val queue = pendingByInstitution[key]
        val promoted = queue?.removeFirstOrNull()
        if (queue?.isEmpty() == true) pendingByInstitution.remove(key)
        if (promoted != null) active[promoted.sessionId] = promoted
        return FinishResult(finished, promoted)
    }

    @Synchronized fun activeSessions(): List<Session> = active.values.toList()
    @Synchronized fun pendingSessions(): List<Session> = pendingByInstitution.values.flatMap { it.toList() }
    @Synchronized fun allSessions(): List<Session> = active.values + pendingSessions()

    @Synchronized
    fun update(session: Session): Boolean {
        if (active.containsKey(session.sessionId)) {
            active[session.sessionId] = session
            return true
        }
        for ((key, queue) in pendingByInstitution) {
            val index = queue.indexOfFirst { it.sessionId == session.sessionId }
            if (index < 0) continue
            if (session.institutionKey != key) return false
            queue[index] = session
            return true
        }
        return false
    }

    @Synchronized
    fun clear(): List<Session> {
        val sessions = allSessions()
        active.clear()
        pendingByInstitution.clear()
        return sessions
    }
}
