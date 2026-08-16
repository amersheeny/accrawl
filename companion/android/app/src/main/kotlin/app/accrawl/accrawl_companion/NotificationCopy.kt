package app.accrawl.accrawl_companion

/**
 * User-visible native copy for active foreground-service notifications. This object is
 * parsed by the repository content-review gate; every catalogue change requires content-strategy review.
 */
object NotificationCopy {
    const val CHANNEL_RELAY_NAME = "SMS relay"
    const val CHANNEL_RELAY_DESCRIPTION = "Codes relayed to your crawls, and crawls waiting for one."
    const val CHANNEL_PROXY_NAME = "Device proxy"
    const val CHANNEL_PROXY_DESCRIPTION = "Routing status while crawls use this phone's network."

    const val PROXY_ROUTING_TITLE = "Routing the {label} crawl"
    const val PROXY_ROUTING_TITLE_FALLBACK = "Routing a crawl"
    const val PROXY_ROUTING_BODY = "The crawl is using this phone's network."
    const val PROXY_PUBLIC = "A crawl is using this phone's network."

    const val RELAY_ACTIVE_TITLE = "Watching for SMS codes"
    const val RELAY_ACTIVE_BODY = "Crawls being watched for SMS codes: {count}."
}
