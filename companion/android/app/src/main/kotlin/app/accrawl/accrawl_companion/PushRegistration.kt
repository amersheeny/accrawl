package app.accrawl.accrawl_companion

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Registers and refreshes this installation's FCM registration token through the paired-device API. */
object PushRegistration {
    private const val PREFS_FILE = "FlutterSharedPreferences"
    private const val KEY_FCM_TOKEN = "nativeFcmToken"
    private const val KEY_PUSH_CLIENT = "nativePushClient"
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "companion-push-registration").apply { isDaemon = true }
    }

    fun registerCurrentToken(context: Context) {
        val appContext = context.applicationContext
        // Which project to register with is the paired deployment's answer, not this build's, so the
        // work starts off the main thread: it takes a request before a token can even be asked for.
        //
        // The cached-token read moved in here with it. This is reached from a MethodChannel handler,
        // which runs on the platform thread, and the FIRST read of a preferences file parses the whole
        // file synchronously on the calling thread — disk I/O on the UI thread, which is what
        // StrictMode's disk-read policy exists to catch. Nothing needs it before the executor runs.
        executor.execute {
            val cached = appContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
                .getString(KEY_FCM_TOKEN, null)
            if (!cached.isNullOrBlank()) registerTokenAsync(appContext, cached)
            val ready = try {
                syncPushClient(appContext)
            } catch (error: Exception) {
                Log.w(TAG, "unable to read this deployment's push configuration", error)
                false
            }
            if (!ready) return@execute
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token -> registerTokenAsync(appContext, token) }
                .addOnFailureListener { error -> Log.w(TAG, "unable to obtain a push token", error) }
        }
    }

    /**
     * Apply the configuration this installation was last given, without asking for it again.
     *
     * Called at process start, because a wake that arrives before the push client exists is not
     * delivered at all — the app would look offline for exactly the crawl that needed it.
     */
    fun initializeFromCache(context: Context): Boolean {
        val appContext = context.applicationContext
        if (FirebaseApp.getApps(appContext).isNotEmpty()) return true
        val cached = appContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .getString(KEY_PUSH_CLIENT, null) ?: return false
        return try {
            initializeClient(appContext, JSONObject(cached))
            true
        } catch (error: Exception) {
            Log.w(TAG, "the remembered push configuration could not be applied", error)
            false
        }
    }

    private fun initializeClient(context: Context, client: JSONObject) {
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder()
                .setApplicationId(client.getString("applicationId"))
                .setApiKey(client.getString("apiKey"))
                .setProjectId(client.getString("projectId"))
                .setGcmSenderId(client.getString("senderId"))
                .build(),
        )
    }

    /**
     * Make this installation's registration match what the paired deployment says today.
     *
     * This app ships with no project of its own. The four values it needs are not secrets — every app
     * that embeds them exposes them — but which ones apply is a property of the deployment, so they
     * arrive after pairing. That is what lets one published build work against any deployment, instead
     * of forcing anyone self-hosting to rebuild the app from source before wake-ups work at all.
     *
     * Asked every time rather than once, because a deployment can move to a different project. Answering
     * from memory would leave this installation registered with the old one and never woken again — and
     * nothing on screen would say so, which is the failure this whole arrangement exists to avoid.
     *
     * Returns false when there is nothing to register with: a deployment that sends no wake-ups, which
     * is a working deployment where the code is typed into its console instead.
     */
    private fun syncPushClient(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val current = try {
            fetchPushClient(context)
        } catch (error: Exception) {
            // Unreachable right now. Keep whatever was working before rather than dropping wake-ups
            // over one failed request.
            Log.w(TAG, "could not ask the deployment which project to use", error)
            return initializeFromCache(context)
        }
        if (current == null) {
            // The deployment sends no wake-ups. Forget any project this installation was using, so a
            // stale registration cannot outlive the configuration that created it.
            prefs.edit().remove(KEY_PUSH_CLIENT).apply()
            FirebaseApp.getApps(context).forEach { it.delete() }
            return false
        }
        val serialized = current.toString()
        if (prefs.getString(KEY_PUSH_CLIENT, null) != serialized) {
            FirebaseApp.getApps(context).forEach { it.delete() }
            prefs.edit().putString(KEY_PUSH_CLIENT, serialized).apply()
        }
        if (FirebaseApp.getApps(context).isEmpty()) initializeClient(context, current)
        return true
    }

    /** What the paired deployment says today, or null when it sends no wake-ups. */
    private fun fetchPushClient(context: Context): JSONObject? {
        val pairing = NativeRelay.pairing(context) ?: return null
        val conn = URL("${pairing.baseUrl.trimEnd('/')}/api/devices/push-config")
            .openConnection() as HttpURLConnection
        val body = try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "GET"
            conn.setRequestProperty("authorization", "Bearer ${pairing.deviceToken}")
            conn.setRequestProperty("accept", "application/json")
            when (val status = conn.responseCode) {
                200 -> BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
                    .use(BufferedReader::readText)
                404 -> {
                    Log.i(TAG, "this deployment sends no wake-ups; nothing to register")
                    return null
                }
                401 -> throw SecurityException("paired-device access was rejected")
                else -> throw RuntimeException("push configuration HTTP $status: ${readError(conn)}")
            }
        } finally {
            conn.disconnect()
        }
        return JSONObject(body)
    }

    fun registerTokenAsync(context: Context, token: String) {
        if (token.isBlank()) return
        val appContext = context.applicationContext
        appContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        executor.execute {
            try {
                registerToken(appContext, token)
            } catch (error: Exception) {
                Log.w(TAG, "FCM token registration failed", error)
            }
        }
    }

    private fun registerToken(context: Context, token: String) {
        val pairing = NativeRelay.pairing(context) ?: return
        val conn = URL("${pairing.baseUrl.trimEnd('/')}/api/devices/push")
            .openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("authorization", "Bearer ${pairing.deviceToken}")
            conn.setRequestProperty("accept", "application/json")
            conn.setRequestProperty("content-type", "application/json")
            val payload = JSONObject()
                .put("pushTransport", "fcm")
                .put("pushToken", token)
                .toString().toByteArray(Charsets.UTF_8)
            conn.outputStream.use { it.write(payload) }
            when (val status = conn.responseCode) {
                204 -> Unit
                401 -> throw SecurityException("paired-device access was rejected")
                else -> throw RuntimeException("push registration HTTP $status: ${readError(conn)}")
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun readError(conn: HttpURLConnection): String =
        conn.errorStream?.let {
            BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use(BufferedReader::readText)
        }.orEmpty()

    private const val TAG = "PushRegistration"
    private const val CONNECT_TIMEOUT_MS = 4_000
    private const val READ_TIMEOUT_MS = 4_000
}
