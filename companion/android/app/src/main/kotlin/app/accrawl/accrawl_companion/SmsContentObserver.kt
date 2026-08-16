package app.accrawl.accrawl_companion

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.provider.Telephony
import android.util.Log

/**
 * Active-session fallback for devices that persist an incoming SMS but do not deliver SMS_RECEIVED reliably.
 * Existing inbox rows are never replayed: registration starts from the current highest provider row ID.
 * Raw sender/body values continue through NativeRelay, which retains session/sender binding and server-side
 * extraction.
 */
internal class SmsContentObserver(
    handler: Handler,
    private val context: Context,
    private val onSmsReceived: (sender: String, body: String, providerTimestampMillis: Long) -> Unit,
) : ContentObserver(handler) {
    @Volatile private var lastSeenId = 0L

    fun initialize(): Boolean {
        val currentMax = queryMaxSmsId() ?: return false
        lastSeenId = currentMax
        Log.d(TAG, "SMS observer initialized at row $lastSeenId")
        return true
    }

    override fun onChange(selfChange: Boolean) {
        super.onChange(selfChange)
        checkForNewSms()
    }

    private fun checkForNewSms() {
        val cursor = try {
            context.contentResolver.query(
                SMS_INBOX_URI,
                arrayOf(
                    Telephony.Sms._ID,
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE,
                    Telephony.Sms.DATE_SENT,
                ),
                "${Telephony.Sms._ID} > ?",
                arrayOf(lastSeenId.toString()),
                "${Telephony.Sms._ID} ASC",
            )
        } catch (error: SecurityException) {
            Log.e(TAG, "SMS observer lost inbox access", error)
            return
        } catch (error: RuntimeException) {
            Log.e(TAG, "SMS observer could not query the inbox", error)
            return
        }

        if (cursor == null) {
            Log.e(TAG, "SMS inbox query returned no cursor")
            return
        }
        try {
            cursor.use {
                val idIndex = it.getColumnIndexOrThrow(Telephony.Sms._ID)
                val senderIndex = it.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val bodyIndex = it.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val dateIndex = it.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val dateSentIndex = it.getColumnIndex(Telephony.Sms.DATE_SENT)
                while (it.moveToNext()) {
                    val id = it.getLong(idIndex)
                    if (id > lastSeenId) lastSeenId = id
                    val sender = it.getString(senderIndex) ?: continue
                    val body = it.getString(bodyIndex) ?: continue
                    val sentAtMillis = if (dateSentIndex >= 0 && !it.isNull(dateSentIndex)) {
                        it.getLong(dateSentIndex)
                    } else {
                        null
                    }
                    onSmsReceived(
                        sender,
                        body,
                        selectSmsIdentityTimestamp(
                            sentAtMillis = sentAtMillis,
                            receivedAtMillis = it.getLong(dateIndex),
                        ),
                    )
                }
            }
        } catch (error: RuntimeException) {
            Log.e(TAG, "SMS observer could not read an inbox update", error)
        }
    }

    private fun queryMaxSmsId(): Long? {
        val cursor = try {
            context.contentResolver.query(
                SMS_INBOX_URI,
                arrayOf(Telephony.Sms._ID),
                null,
                null,
                "${Telephony.Sms._ID} DESC LIMIT 1",
            )
        } catch (error: SecurityException) {
            Log.e(TAG, "SMS observer does not have inbox access", error)
            return null
        } catch (error: RuntimeException) {
            Log.e(TAG, "SMS observer could not initialize its inbox position", error)
            return null
        } ?: return null

        return cursor.use { if (it.moveToFirst()) it.getLong(0) else 0L }
    }

    internal companion object {
        private const val TAG = "SmsContentObserver"
        val SMS_INBOX_URI = Telephony.Sms.Inbox.CONTENT_URI
    }
}
