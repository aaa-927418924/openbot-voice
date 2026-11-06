package run.openbot.mobile.livevoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class LiveVoiceForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_START ||
      checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
    ) {
      stopSelfResult(startId)
      return START_NOT_STICKY
    }

    val agentId = intent.getStringExtra(EXTRA_AGENT_ID).orEmpty()
    val serverId = intent.getStringExtra(EXTRA_SERVER_ID).orEmpty()
    val agentName = intent.getStringExtra(EXTRA_AGENT_NAME).orEmpty().ifBlank { "OpenBot" }
    val avatarHue = intent.getIntExtra(EXTRA_AVATAR_HUE, -1)
    WakeWordStore.preferences(this).edit()
      .putString(WakeWordStore.KEY_LIVE_VOICE_AGENT_ID, agentId)
      .putString(WakeWordStore.KEY_LIVE_VOICE_SERVER_ID, serverId)
      .putString(WakeWordStore.KEY_LIVE_VOICE_AGENT_NAME, agentName)
      .putInt(WakeWordStore.KEY_LIVE_VOICE_AVATAR_HUE, avatarHue)
      .apply()
    acquireWakeLock()
    val notification = buildNotification(agentName, avatarHue)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    stopForeground(true)
    super.onDestroy()
  }

  private fun buildNotification(agentName: String, avatarHue: Int): Notification {
    val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          getString(R.string.live_voice_notification_channel_name),
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          setSound(null, null)
          enableVibration(false)
          setShowBadge(false)
        }
      )
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra(EXTRA_OPEN_LIVE_VOICE, true)
    }
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val endPendingIntent = PendingIntent.getBroadcast(
      this,
      END_REQUEST_CODE,
      Intent(this, LiveVoiceNotificationActionReceiver::class.java).setAction(LiveVoiceNotificationActionReceiver.ACTION_END),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
    else Notification.Builder(this)
    val notification = builder
      .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_btn_speak_now)
      .setContentTitle(agentName)
      .setContentText(getString(R.string.live_voice_notification_text))
      .setCategory(Notification.CATEGORY_CALL)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setWhen(System.currentTimeMillis())
      .setUsesChronometer(true)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = Person.Builder()
        .setName(agentName)
        .setIcon(Icon.createWithBitmap(createAvatar(agentName, avatarHue)))
        .setImportant(true)
        .build()
      notification.setStyle(Notification.CallStyle.forOngoingCall(person, endPendingIntent))
    } else {
      notification.addAction(
        Notification.Action.Builder(
          android.R.drawable.ic_menu_close_clear_cancel,
          getString(R.string.live_voice_notification_hang_up),
          endPendingIntent,
        ).build(),
      )
    }
    return notification.build()
  }

  private fun createAvatar(name: String, hue: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val background = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = android.graphics.Color.HSVToColor(floatArrayOf((hue.takeIf { it >= 0 } ?: 215).toFloat(), 0.62f, 0.78f))
    }
    canvas.drawCircle(48f, 48f, 48f, background)
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = android.graphics.Color.WHITE
      textSize = 46f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "O"
    val bounds = Rect()
    text.getTextBounds(initial, 0, initial.length, bounds)
    canvas.drawText(initial, 48f - bounds.exactCenterX(), 48f - bounds.exactCenterY(), text)
    return bitmap
  }

  private fun acquireWakeLock() {
    val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
    val lock = wakeLock ?: manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenBot:LiveVoice").also {
      it.setReferenceCounted(false)
      wakeLock = it
    }
    if (!lock.isHeld) lock.acquire()
  }

  private fun releaseWakeLock() {
    val lock = wakeLock ?: return
    if (lock.isHeld) lock.release()
  }

  companion object {
    const val ACTION_START = "run.openbot.mobile.livevoice.START"
    const val EXTRA_AGENT_ID = "run.openbot.mobile.livevoice.agentId"
    const val EXTRA_SERVER_ID = "run.openbot.mobile.livevoice.serverId"
    const val EXTRA_AGENT_NAME = "run.openbot.mobile.livevoice.agentName"
    const val EXTRA_AVATAR_HUE = "run.openbot.mobile.livevoice.avatarHue"
    const val EXTRA_OPEN_LIVE_VOICE = "openbot.liveVoiceActive"
    private const val CHANNEL_ID = "live_voice_background"
    private const val NOTIFICATION_ID = 5701
    private const val END_REQUEST_CODE = 5704
  }
}
