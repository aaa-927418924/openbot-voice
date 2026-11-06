package run.openbot.mobile.livevoice

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings

internal object WakeWordStore {
  private const val PREFERENCES_NAME = "openbot_voice_background"

  const val KEY_ARMED = "wake_word_armed"
  const val KEY_LISTENING = "wake_word_listening"
  const val KEY_SERVER_ID = "wake_word_server_id"
  const val KEY_AGENT_ID = "wake_word_agent_id"
  const val KEY_AGENT_NAME = "wake_word_agent_name"
  const val KEY_AVATAR_HUE = "wake_word_avatar_hue"
  const val KEY_START_REQUESTED_AT = "wake_word_start_requested_at"
  const val START_REQUEST_GRACE_MILLIS = 15_000L
  const val KEY_PENDING_DETECTION_AT = "wake_word_pending_detection_at"
  const val KEY_PENDING_SERVER_ID = "wake_word_pending_server_id"
  const val KEY_PENDING_AGENT_ID = "wake_word_pending_agent_id"
  const val KEY_PENDING_LIVE_VOICE_END = "live_voice_pending_end"
  const val KEY_LIVE_VOICE_SERVER_ID = "live_voice_server_id"
  const val KEY_LIVE_VOICE_AGENT_ID = "live_voice_agent_id"
  const val KEY_LIVE_VOICE_AGENT_NAME = "live_voice_agent_name"
  const val KEY_LIVE_VOICE_AVATAR_HUE = "live_voice_avatar_hue"
  private const val KEY_BOOT_COUNT = "wake_word_boot_count"

  fun preferences(context: Context): SharedPreferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  fun reconcileBoot(context: Context): SharedPreferences {
    val preferences = preferences(context)
    val bootCount = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, 0)
    if (preferences.getInt(KEY_BOOT_COUNT, -1) != bootCount) {
      preferences.edit()
        .putInt(KEY_BOOT_COUNT, bootCount)
        .putBoolean(KEY_ARMED, false)
        .putBoolean(KEY_LISTENING, false)
        .remove(KEY_START_REQUESTED_AT)
        .remove(KEY_PENDING_DETECTION_AT)
        .remove(KEY_PENDING_SERVER_ID)
        .remove(KEY_PENDING_AGENT_ID)
        .remove(KEY_PENDING_LIVE_VOICE_END)
        .apply()
    }
    return preferences
  }
}
