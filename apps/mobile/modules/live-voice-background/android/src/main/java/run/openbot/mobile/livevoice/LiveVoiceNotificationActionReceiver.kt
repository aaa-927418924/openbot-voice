package run.openbot.mobile.livevoice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class LiveVoiceNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_END) return
    WakeWordStore.preferences(context).edit()
      .putBoolean(WakeWordStore.KEY_PENDING_LIVE_VOICE_END, true)
      .commit()
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    launchIntent.putExtra(LiveVoiceForegroundService.EXTRA_OPEN_LIVE_VOICE, true)
    context.startActivity(launchIntent)
  }

  companion object {
    const val ACTION_END = "run.openbot.mobile.livevoice.END_FROM_NOTIFICATION"
  }
}
