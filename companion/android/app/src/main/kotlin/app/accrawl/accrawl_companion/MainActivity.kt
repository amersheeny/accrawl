package app.accrawl.accrawl_companion

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Method-channel bridge for the pairing/status UI: permission checks + one-shot session recovery, plus a
 * `permissionChanged` nudge after a grant. The 2FA relay itself does NOT run here — it runs natively in
 * the session-bound RelayService/NativeRelay so it survives the activity being swiped away. We keep a channel reference only to
 * push the post-grant permission nudge to Dart while the UI is open.
 */
class MainActivity : FlutterFragmentActivity() {
    private var pendingFinancialCredentialResult: MethodChannel.Result? = null

    companion object {
        const val CHANNEL = "accrawl/sms"
        // Held only while the engine is alive, to nudge the UI after a permission grant. Nulled in onDestroy;
        // the relay never touches this (it's fully native), so a null channel no longer drops codes.
        @Volatile var channel: MethodChannel? = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        if (!BuildConfig.ALLOW_SCREEN_CAPTURE) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        super.onCreate(savedInstanceState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "hasSmsPermission" -> result.success(hasSmsPermission())
                "requestSmsPermission" -> { requestSmsPermission(); result.success(null) }
                "hasNotificationPermission" -> result.success(hasNotificationPermission())
                "requestNotificationPermission" -> { requestNotificationPermission(); result.success(null) }
                "isIgnoringBatteryOptimizations" -> result.success(isIgnoringBatteryOptimizations())
                "requestIgnoreBatteryOptimizations" -> {
                    requestIgnoreBatteryOptimizations()
                    result.success(null)
                }
                "registerPushToken" -> { PushRegistration.registerCurrentToken(this); result.success(null) }
                "recoverPendingSessions" -> { CompanionSessionRecovery.recoverAllAsync(this); result.success(null) }
                "stopService" -> { RelayService.stop(this); result.success(null) }
                "stopTunnelService" -> { TunnelService.stop(this); result.success(null) }
                "allowsInsecureHttp" -> result.success(BuildConfig.ALLOW_INSECURE_HTTP)
                "elapsedRealtime" -> result.success(SystemClock.elapsedRealtime())
                "authenticateFinancialCredential" ->
                    authenticateFinancialCredential(
                        call.argument<String>("title").orEmpty(),
                        call.argument<String>("subtitle").orEmpty(),
                        result,
                    )
                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        pendingFinancialCredentialResult?.error(
            "ACTIVITY_DESTROYED",
            "Credential confirmation was interrupted.",
            null,
        )
        pendingFinancialCredentialResult = null
        channel = null
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun authenticateFinancialCredential(
        title: String,
        subtitle: String,
        result: MethodChannel.Result,
    ) {
        // Android 11+ supports device credentials directly in the crypto-bound
        // BiometricPrompt used by flutter_secure_storage. Android 9–10 do not;
        // they authenticate a short-duration Keystore key through Keyguard.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            result.success(true)
            return
        }
        if (pendingFinancialCredentialResult != null) {
            result.error(
                "CREDENTIAL_CONFIRMATION_ACTIVE",
                "A credential confirmation is already in progress.",
                null,
            )
            return
        }
        val keyguard = getSystemService(KEYGUARD_SERVICE) as? KeyguardManager
        if (keyguard?.isDeviceSecure != true) {
            result.success(false)
            return
        }
        val intent = keyguard.createConfirmDeviceCredentialIntent(title, subtitle)
        if (intent == null) {
            result.success(false)
            return
        }
        pendingFinancialCredentialResult = result
        try {
            startActivityForResult(intent, REQ_FINANCIAL_CREDENTIAL)
        } catch (error: RuntimeException) {
            pendingFinancialCredentialResult = null
            result.error(
                "CREDENTIAL_CONFIRMATION_FAILED",
                error.message,
                null,
            )
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        if (requestCode == REQ_FINANCIAL_CREDENTIAL) {
            val result = pendingFinancialCredentialResult
            pendingFinancialCredentialResult = null
            result?.success(resultCode == Activity.RESULT_OK)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    private fun hasSmsPermission(): Boolean = SMS_PERMISSIONS.all { permission ->
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestSmsPermission() {
        ActivityCompat.requestPermissions(this, SMS_PERMISSIONS, REQ_SMS)
    }

    private fun hasNotificationPermission(): Boolean =
        NotificationManagerCompat.from(this).areNotificationsEnabled()

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIFICATIONS,
            )
        } else {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            })
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    private fun requestIgnoreBatteryOptimizations() {
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        })
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_SMS || requestCode == REQ_NOTIFICATIONS) {
            if (requestCode == REQ_SMS) RelayService.permissionsChanged()
            channel?.invokeMethod("permissionChanged", null)
        }
    }
}

private const val REQ_SMS = 1001
private const val REQ_FINANCIAL_CREDENTIAL = 1002
private const val REQ_NOTIFICATIONS = 1003
private val SMS_PERMISSIONS = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
