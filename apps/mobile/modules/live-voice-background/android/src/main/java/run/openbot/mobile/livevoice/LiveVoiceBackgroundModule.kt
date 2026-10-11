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

    AsyncFunction("start") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is not available")
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw SecurityException("Microphone permission is required for a background voice call")
      }

      val intent = Intent(context, LiveVoiceForegroundService::class.java)
        .setAction(LiveVoiceForegroundService.ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      // startService returns ComponentName, which Expo cannot marshal across its JS bridge.
      null
    }

    AsyncFunction("stop") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      context.stopService(Intent(context, LiveVoiceForegroundService::class.java))
    }
  }
}
