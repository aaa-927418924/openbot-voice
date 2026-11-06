package run.openbot.mobile.livevoice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import kotlin.math.sqrt

class WakeWordForegroundService : Service() {
  @Volatile private var captureRequested = false
  @Volatile private var captureGeneration = 0
  @Volatile private var audioRecord: AudioRecord? = null
  @Volatile private var foregroundStarted = false
  private var captureThread: Thread? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private val preferences by lazy { WakeWordStore.preferences(this) }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        WakeWordStore.reconcileBoot(this)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
          preferences.edit()
            .putBoolean(WakeWordStore.KEY_ARMED, false)
            .putBoolean(WakeWordStore.KEY_LISTENING, false)
            .apply()
          stopSelfResult(startId)
          return START_NOT_STICKY
        }
        startForegroundServiceNotification()
        preferences.edit().putBoolean(WakeWordStore.KEY_ARMED, true).apply()
        startCapture()
      }
      ACTION_PAUSE -> {
        stopCapture()
        if (foregroundStarted) updateNotification(paused = true) else stopSelfResult(startId)
      }
      ACTION_RESUME -> {
        if (WakeWordStore.reconcileBoot(this).getBoolean(WakeWordStore.KEY_ARMED, false)) {
          startForegroundServiceNotification()
          startCapture()
        } else {
          stopSelfResult(startId)
        }
      }
      ACTION_STOP -> {
        preferences.edit()
          .putBoolean(WakeWordStore.KEY_ARMED, false)
          .putBoolean(WakeWordStore.KEY_LISTENING, false)
          .remove(WakeWordStore.KEY_PENDING_DETECTION_AT)
          .remove(WakeWordStore.KEY_PENDING_SERVER_ID)
          .remove(WakeWordStore.KEY_PENDING_AGENT_ID)
          .apply()
        stopCapture()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        stopSelfResult(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopCapture()
    preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, false).apply()
    if (foregroundStarted) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foregroundStarted = false
    }
    super.onDestroy()
  }

  private fun startForegroundServiceNotification() {
    createNotificationChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundStarted = true
  }

  private fun startCapture() {
    if (captureRequested || !preferences.getBoolean(WakeWordStore.KEY_ARMED, false)) return
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      captureFailed()
      return
    }

    captureRequested = true
    val generation = ++captureGeneration
    preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, true).apply()
    acquireWakeLock()
    updateNotification()
    captureThread = Thread({ captureLoop(generation) }, "openbot-wake-word").apply {
      isDaemon = true
      start()
    }
  }

  private fun stopCapture() {
    captureRequested = false
    captureGeneration += 1
    preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, false).apply()
    try {
      audioRecord?.stop()
    } catch (_: IllegalStateException) {
      // The capture thread may already have released the recorder.
    }
    releaseWakeLock()
  }

  private fun captureLoop(generation: Int) {
    var recorder: AudioRecord? = null
    var spotter: KeywordSpotter? = null
    var stream: com.k2fsa.sherpa.onnx.OnlineStream? = null
    var detected = false
    var failed = false

    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      Log.i(TAG, "Initializing on-device keyword spotter; threshold=$KEYWORD_THRESHOLD")
      val minimumBuffer = AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minimumBuffer <= 0) throw IllegalStateException("AudioRecord buffer is unavailable")

      spotter = KeywordSpotter(
        assets,
        KeywordSpotterConfig(
          featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
          modelConfig = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(
              encoder = "wake-word/encoder.int8.onnx",
              decoder = "wake-word/decoder.int8.onnx",
              joiner = "wake-word/joiner.int8.onnx",
            ),
            tokens = "wake-word/tokens.txt",
            numThreads = 1,
            provider = "cpu",
            modelType = "zipformer2",
            modelingUnit = "bpe",
            bpeVocab = "wake-word/bpe.model",
          ),
          keywordsFile = "wake-word/keywords.txt",
          keywordsScore = KEYWORD_SCORE,
          keywordsThreshold = KEYWORD_THRESHOLD,
        ),
      )
      stream = spotter.createStream()
      Log.i(TAG, "Keyword spotter initialized")

      recorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minimumBuffer * 2, FRAME_SAMPLES * 4),
      )
      if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("Microphone is unavailable")
      audioRecord = recorder
      recorder.startRecording()
      Log.i(TAG, "Microphone capture active at ${SAMPLE_RATE}Hz")

      val pcm = ShortArray(FRAME_SAMPLES)
      var levelWindowStartedAt = android.os.SystemClock.elapsedRealtime()
      var levelSampleCount = 0L
      var levelSquares = 0.0
      var peakSample = 0
      while (captureRequested && generation == captureGeneration) {
        val count = recorder.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION || count < 0) {
          throw IllegalStateException("Microphone capture stopped")
        }
        if (count == 0) continue

        val samples = FloatArray(count) { index ->
          val normalized = pcm[index] / 32768.0f
          levelSquares += normalized.toDouble() * normalized.toDouble()
          peakSample = maxOf(peakSample, kotlin.math.abs(pcm[index].toInt()))
          normalized
        }
        levelSampleCount += count
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - levelWindowStartedAt >= LEVEL_LOG_INTERVAL_MILLIS) {
          val rmsPercent = if (levelSampleCount == 0L) 0 else (sqrt(levelSquares / levelSampleCount.toDouble()) * 100).toInt()
          val peakPercent = peakSample * 100 / Short.MAX_VALUE.toInt()
          Log.i(TAG, "Microphone input level (no audio stored): rmsPercent=$rmsPercent peakPercent=$peakPercent")
          levelWindowStartedAt = now
          levelSampleCount = 0
          levelSquares = 0.0
          peakSample = 0
        }
        stream.acceptWaveform(samples, SAMPLE_RATE)
        while (spotter.isReady(stream)) spotter.decode(stream)
        val keyword = spotter.getResult(stream).keyword
        if (keyword.isNotBlank()) {
          Log.i(TAG, "Wake word detected: $keyword")
          detected = true
          captureRequested = false
          preferences.edit()
            .putBoolean(WakeWordStore.KEY_LISTENING, false)
            .putLong(WakeWordStore.KEY_PENDING_DETECTION_AT, System.currentTimeMillis())
            .putString(WakeWordStore.KEY_PENDING_SERVER_ID, preferences.getString(WakeWordStore.KEY_SERVER_ID, null))
            .putString(WakeWordStore.KEY_PENDING_AGENT_ID, preferences.getString(WakeWordStore.KEY_AGENT_ID, null))
            .apply()
          break
        }
      }
    } catch (error: SecurityException) {
      Log.e(TAG, "Microphone permission denied during wake-word capture", error)
      failed = true
    } catch (error: Exception) {
      Log.e(TAG, "Wake-word capture failed", error)
      failed = true
    } finally {
      try {
        if (recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
      } catch (_: IllegalStateException) {
        // Ignore recorder shutdown races.
      }
      recorder?.release()
      stream?.release()
      spotter?.release()
      if (audioRecord === recorder) audioRecord = null

      if (generation == captureGeneration) {
        preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, false).apply()
        releaseWakeLock()
        when {
          detected -> updateNotification(detected = true)
          failed -> captureFailed()
          else -> updateNotification(paused = preferences.getBoolean(WakeWordStore.KEY_ARMED, false))
        }
      }
    }
  }

  private fun captureFailed() {
    captureRequested = false
    preferences.edit()
      .putBoolean(WakeWordStore.KEY_ARMED, false)
      .putBoolean(WakeWordStore.KEY_LISTENING, false)
      .apply()
    releaseWakeLock()
    updateNotification(failed = true)
    if (foregroundStarted) {
      stopForeground(STOP_FOREGROUND_DETACH)
      foregroundStarted = false
    }
    stopSelf()
  }

  private fun acquireWakeLock() {
    val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
    val lock = wakeLock ?: manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenBot:WakeWord").also {
      it.setReferenceCounted(false)
      wakeLock = it
    }
    if (!lock.isHeld) lock.acquire()
  }

  private fun releaseWakeLock() {
    val lock = wakeLock ?: return
    if (lock.isHeld) lock.release()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.wake_word_notification_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      },
    )
  }

  private fun updateNotification(paused: Boolean = false, detected: Boolean = false, failed: Boolean = false) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, buildNotification(paused, detected, failed))
  }

  private fun buildNotification(
    paused: Boolean = false,
    detected: Boolean = false,
    failed: Boolean = false,
  ): Notification {
    val agentName = preferences.getString(WakeWordStore.KEY_AGENT_NAME, "OpenBot") ?: "OpenBot"
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra(EXTRA_OPEN_WAKE_WORD, true)
    }
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        CONTENT_REQUEST_CODE,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val stopIntent = Intent(this, WakeWordForegroundService::class.java).setAction(ACTION_STOP)
    val stopPendingIntent = PendingIntent.getService(
      this,
      STOP_REQUEST_CODE,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val text = when {
      failed -> getString(R.string.wake_word_notification_failed)
      detected -> getString(R.string.wake_word_notification_detected, agentName)
      paused -> getString(R.string.wake_word_notification_paused)
      else -> getString(R.string.wake_word_notification_listening)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_btn_speak_now)
      .setContentTitle(getString(R.string.wake_word_notification_title))
      .setContentText(text)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(!failed)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .addAction(
        Notification.Action.Builder(
          android.R.drawable.ic_media_pause,
          getString(R.string.wake_word_notification_stop),
          stopPendingIntent,
        ).build(),
      )
      .build()
  }

  companion object {
    const val ACTION_START = "run.openbot.mobile.livevoice.WAKE_WORD_START"
    const val ACTION_PAUSE = "run.openbot.mobile.livevoice.WAKE_WORD_PAUSE"
    const val ACTION_RESUME = "run.openbot.mobile.livevoice.WAKE_WORD_RESUME"
    const val ACTION_STOP = "run.openbot.mobile.livevoice.WAKE_WORD_STOP"
    const val EXTRA_OPEN_WAKE_WORD = "openbot.wakeWordPending"
    const val DETECTION_NOTIFICATION_ID = 5703
    private const val CHANNEL_ID = "wake_word_listener"
    private const val NOTIFICATION_ID = 5702
    private const val CONTENT_REQUEST_CODE = 5702
    private const val STOP_REQUEST_CODE = 5703
    private const val SAMPLE_RATE = 16_000
    private const val FRAME_SAMPLES = 512
    private const val KEYWORD_SCORE = 2.0f
    private const val KEYWORD_THRESHOLD = 0.25f
    private const val LEVEL_LOG_INTERVAL_MILLIS = 10_000L
    private const val TAG = "OpenBotWakeWord"
  }
}
