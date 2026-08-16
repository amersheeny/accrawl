package app.accrawl.accrawl_companion

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Data-only FCM receiver: wake, re-authorize against Accrawl, then start one concrete session. */
class CompanionFcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val wake = CompanionWakeMessage.parse(message.data)
        if (wake == null) {
            Log.w(TAG, "ignoring malformed Companion wake")
            return
        }
        CompanionSessionRecovery.recoverWake(this, wake)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        PushRegistration.registerTokenAsync(this, token)
    }

    private companion object {
        const val TAG = "CompanionFcmService"
    }
}
