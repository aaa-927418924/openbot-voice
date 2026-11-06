package run.openbot.mobile.livevoice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LiveVoiceBackgroundModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenBotLiveVoiceBackground")

    AsyncFunction("start") { agentId: String, serverId: String, agentName: String, avatarHue: Int? ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is not available")
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw SecurityException("Microphone permission is required for a background voice call")
      }

      val intent = Intent(context, LiveVoiceForegroundService::class.java)
        .setAction(LiveVoiceForegroundService.ACTION_START)
        .putExtra(LiveVoiceForegroundService.EXTRA_AGENT_ID, agentId)
        .putExtra(LiveVoiceForegroundService.EXTRA_SERVER_ID, serverId)
        .putExtra(LiveVoiceForegroundService.EXTRA_AGENT_NAME, agentName)
        .putExtra(LiveVoiceForegroundService.EXTRA_AVATAR_HUE, avatarHue ?: -1)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      null
    }

    AsyncFunction("stop") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      context.stopService(Intent(context, LiveVoiceForegroundService::class.java))
    }

    AsyncFunction("setWakeWordTarget") { serverId: String, agentId: String, agentName: String, avatarHue: Int? ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is not available")
      WakeWordStore.reconcileBoot(context).edit()
        .putString(WakeWordStore.KEY_SERVER_ID, serverId.take(256))
        .putString(WakeWordStore.KEY_AGENT_ID, agentId.take(256))
        .putString(WakeWordStore.KEY_AGENT_NAME, agentName.take(120))
        .putInt(WakeWordStore.KEY_AVATAR_HUE, avatarHue ?: -1)
        .remove(WakeWordStore.KEY_PENDING_DETECTION_AT)
        .remove(WakeWordStore.KEY_PENDING_SERVER_ID)
        .remove(WakeWordStore.KEY_PENDING_AGENT_ID)
        .apply()
      null
    }

    AsyncFunction("getWakeWordStatus") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is not available")
      val preferences = WakeWordStore.reconcileBoot(context)
      mapOf(
        "armed" to preferences.getBoolean(WakeWordStore.KEY_ARMED, false),
        "listening" to preferences.getBoolean(WakeWordStore.KEY_LISTENING, false),
        "serverId" to preferences.getString(WakeWordStore.KEY_SERVER_ID, null),
        "agentId" to preferences.getString(WakeWordStore.KEY_AGENT_ID, null),
        "agentName" to preferences.getString(WakeWordStore.KEY_AGENT_NAME, null),
        "avatarHue" to preferences.getInt(WakeWordStore.KEY_AVATAR_HUE, -1).takeIf { it >= 0 },
      )
    }

    AsyncFunction("startWakeWord") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is not available")
      val preferences = WakeWordStore.reconcileBoot(context)
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw SecurityException("Microphone permission is required for wake-word listening")
      }
      if (preferences.getString(WakeWordStore.KEY_AGENT_ID, null).isNullOrBlank() ||
        preferences.getString(WakeWordStore.KEY_SERVER_ID, null).isNullOrBlank()
      ) {
        throw IllegalStateException("Select a Bot before starting wake-word listening")
      }
      preferences.edit().putBoolean(WakeWordStore.KEY_ARMED, true).apply()
      val intent = Intent(context, WakeWordForegroundService::class.java)
        .setAction(WakeWordForegroundService.ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      null
    }

    AsyncFunction("stopWakeWord") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      WakeWordStore.preferences(context).edit()
        .putBoolean(WakeWordStore.KEY_ARMED, false)
        .putBoolean(WakeWordStore.KEY_LISTENING, false)
        .remove(WakeWordStore.KEY_PENDING_DETECTION_AT)
        .remove(WakeWordStore.KEY_PENDING_SERVER_ID)
        .remove(WakeWordStore.KEY_PENDING_AGENT_ID)
        .apply()
      context.startService(
        Intent(context, WakeWordForegroundService::class.java)
          .setAction(WakeWordForegroundService.ACTION_STOP),
      )
      null
    }

    AsyncFunction("pauseWakeWord") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (WakeWordStore.reconcileBoot(context).getBoolean(WakeWordStore.KEY_ARMED, false)) {
        context.startService(
          Intent(context, WakeWordForegroundService::class.java)
            .setAction(WakeWordForegroundService.ACTION_PAUSE),
        )
      }
      null
    }

    AsyncFunction("resumeWakeWord") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (WakeWordStore.reconcileBoot(context).getBoolean(WakeWordStore.KEY_ARMED, false)) {
        val intent = Intent(context, WakeWordForegroundService::class.java)
          .setAction(WakeWordForegroundService.ACTION_RESUME)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      }
      null
    }

    AsyncFunction("consumeWakeWordDetection") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      val preferences = WakeWordStore.reconcileBoot(context)
      val detectedAt = preferences.getLong(WakeWordStore.KEY_PENDING_DETECTION_AT, 0L)
      if (detectedAt == 0L) return@AsyncFunction null
      val result = mapOf(
        "detectedAt" to detectedAt,
        "serverId" to preferences.getString(WakeWordStore.KEY_PENDING_SERVER_ID, null),
        "agentId" to preferences.getString(WakeWordStore.KEY_PENDING_AGENT_ID, null),
      )
      preferences.edit()
        .remove(WakeWordStore.KEY_PENDING_DETECTION_AT)
        .remove(WakeWordStore.KEY_PENDING_SERVER_ID)
        .remove(WakeWordStore.KEY_PENDING_AGENT_ID)
        .apply()
      context.getSystemService(android.app.NotificationManager::class.java)
        .cancel(WakeWordForegroundService.DETECTION_NOTIFICATION_ID)
      result
    }

    AsyncFunction("consumePendingVoiceEndAction") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val preferences = WakeWordStore.reconcileBoot(context)
      val pending = preferences.getBoolean(WakeWordStore.KEY_PENDING_LIVE_VOICE_END, false)
      if (pending) preferences.edit().remove(WakeWordStore.KEY_PENDING_LIVE_VOICE_END).apply()
      pending
    }
  }
}
