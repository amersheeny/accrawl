package app.accrawl.accrawl_companion

/** Thread-safe concrete-session registry used to deduplicate tunnel wakes and reject stale close callbacks. */
class TunnelSessionRegistry<T : Any> {
    private val sessions = linkedMapOf<String, T>()

    @Synchronized
    fun add(sessionId: String, value: T): Boolean {
        if (sessionId.isBlank() || sessions.containsKey(sessionId)) return false
        sessions[sessionId] = value
        return true
    }

    @Synchronized fun get(sessionId: String): T? = sessions[sessionId]

    @Synchronized
    fun remove(sessionId: String, expected: T): T? {
        val current = sessions[sessionId] ?: return null
        if (current != expected) return null
        sessions.remove(sessionId)
        return current
    }

    @Synchronized fun keys(): List<String> = sessions.keys.toList()
    @Synchronized fun values(): List<T> = sessions.values.toList()
    @Synchronized fun isEmpty(): Boolean = sessions.isEmpty()
}
