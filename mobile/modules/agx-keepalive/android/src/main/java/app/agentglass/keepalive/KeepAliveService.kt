package app.agentglass.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Lifts this process to FOREGROUND_SERVICE state so Android 15 (API 35) does
 * not cut its network a few seconds after the screen goes off. See the plan
 * this module implements: the JS keeps running in the SAME process, so the
 * live socket in src/lib/live.ts and the raise() path in host-context.tsx are
 * unchanged — this service exists only to keep the process itself alive.
 *
 * The notification is the price of that: Android will not grant foreground
 * state without one on screen. It asks for the quietest channel the platform
 * allows — silent, no badge, no vibration, IMPORTANCE_MIN — but that request
 * is not the last word: measured on the API 35 emulator
 * (`adb shell dumpsys notification`), the system raises a foreground
 * service's own channel from MIN to LOW, which does draw a status-bar icon.
 * So this is silent and unobtrusive, not invisible, and nothing in this file
 * or in Settings' copy claims otherwise.
 */
class KeepAliveService : Service() {
  companion object {
    private const val CHANNEL_ID = "agx-link"
    private const val NOTIFICATION_ID = 4200

    /*
     * Whether the service is actually alive right now, for
     * KeepAliveModule.isRunning() to read.
     *
     * Not set from Module.start()'s own success: that call only means
     * `startForegroundService` was ACCEPTED, and the service's own process
     * may not have run onCreate yet — or may since have been killed by the
     * OS, by battery settings, or from Android's own "stop" affordance on the
     * foreground-service notification, none of which the module would ever
     * hear about. Reading it from this lifecycle instead means a phone that
     * killed the service from Android's own UI shows OFF the next time
     * Settings asks, rather than a switch stuck on the last thing it was told
     * to do.
     */
    @Volatile
    var running: Boolean = false
      private set
  }

  override fun onCreate() {
    super.onCreate()
    running = true
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Nothing below may crash this process: a channel Android refuses to
    // create, a null launch intent (packageManager returning nothing for our
    // own package would be a very strange phone), or the OS refusing
    // startForeground itself (ForegroundServiceStartNotAllowedException,
    // API 31+) all land here rather than taking down the socket this service
    // exists to protect. stopSelf() leaves the app running without the
    // exemption, which is the failure this feature already documents — not
    // running at all is a worse one it does not need to add.
    try {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "Background connection",
          NotificationManager.IMPORTANCE_MIN,
        ).apply {
          setSound(null, null)
          enableVibration(false)
          setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
      }

      val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      val contentIntent = PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_IMMUTABLE,
      )

      val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_agx_keepalive)
        .setContentTitle("Listening for your agents")
        .setContentText("Tap to open. Hide it in Android's settings.")
        .setSilent(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(contentIntent)
        .build()

      // The type flag only exists as of API 34 (UPSIDE_DOWN_CAKE) — ServiceInfo
      // itself, not a compat shim, since androidx.core's own constant for it
      // was not resolvable against the version this module built against. On
      // Q..33 the type is not required for the exemption this service exists
      // for, so 0 is correct there, not a fallback that loses anything.
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
      } else {
        0
      }
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    } catch (e: Exception) {
      stopSelf()
    }

    // NOT_STICKY on purpose: if the OS kills this process it also kills the JS
    // socket the service exists to keep open. A system-restarted service with
    // no socket behind it holds a notification for nothing, so it does not
    // ask to be restarted — a fresh app open (or the sync on next ACTIVE) is
    // what starts it again.
    return START_NOT_STICKY
  }

  // Deliberately no WakeLock: the ceiling this service does not try to raise.
  // In deep Doze the CPU still sleeps and this process can still be paused;
  // what a foreground service buys is the network exemption, not a wake
  // guarantee, and holding a WakeLock just for that trade would spend battery
  // for a case this feature does not promise to cover.
}
