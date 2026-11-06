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
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.util.ArrayDeque
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.sqrt

class WakeWordForegroundService : Service() {
  @Volatile private var captureRequested = false
  @Volatile private var captureGeneration = 0
  @Volatile private var audioRecord: AudioRecord? = null
  @Volatile private var foregroundStarted = false
  private var captureThread: Thread? = null
  @Volatile private var modelPreparationThread: Thread? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private val preferences by lazy { WakeWordStore.preferences(this) }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    Log.i(TAG, "Service command: action=${action?.substringAfterLast('.') ?: "none"} startId=$startId")
    when (action) {
      ACTION_START -> {
        WakeWordStore.reconcileBoot(this)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
          preferences.edit()
            .putBoolean(WakeWordStore.KEY_ARMED, false)
            .putBoolean(WakeWordStore.KEY_LISTENING, false)
            .remove(WakeWordStore.KEY_START_REQUESTED_AT)
            .apply()
          stopSelfResult(startId)
          return START_NOT_STICKY
        }
        startForegroundServiceNotification()
        preferences.edit()
          .putBoolean(WakeWordStore.KEY_ARMED, true)
          .putBoolean(WakeWordStore.KEY_LISTENING, false)
          .putLong(WakeWordStore.KEY_START_REQUESTED_AT, android.os.SystemClock.elapsedRealtime())
          .apply()
        startCapture()
      }
      ACTION_PAUSE -> {
        stopCapture("pause")
        preferences.edit().remove(WakeWordStore.KEY_START_REQUESTED_AT).apply()
        if (foregroundStarted) updateNotification(paused = true) else stopSelfResult(startId)
      }
      ACTION_RESUME -> {
        if (WakeWordStore.reconcileBoot(this).getBoolean(WakeWordStore.KEY_ARMED, false)) {
          startForegroundServiceNotification()
          preferences.edit()
            .putBoolean(WakeWordStore.KEY_LISTENING, false)
            .putLong(WakeWordStore.KEY_START_REQUESTED_AT, android.os.SystemClock.elapsedRealtime())
            .apply()
          startCapture()
        } else {
          stopSelfResult(startId)
        }
      }
      ACTION_STOP -> {
        preferences.edit()
          .putBoolean(WakeWordStore.KEY_ARMED, false)
          .putBoolean(WakeWordStore.KEY_LISTENING, false)
          .remove(WakeWordStore.KEY_START_REQUESTED_AT)
          .remove(WakeWordStore.KEY_PENDING_DETECTION_AT)
          .remove(WakeWordStore.KEY_PENDING_SERVER_ID)
          .remove(WakeWordStore.KEY_PENDING_AGENT_ID)
          .apply()
        stopCapture("stop")
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        stopSelfResult(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopCapture("destroy")
    preferences.edit()
      .putBoolean(WakeWordStore.KEY_LISTENING, false)
      .remove(WakeWordStore.KEY_START_REQUESTED_AT)
      .apply()
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
    preferences.edit()
      .putBoolean(WakeWordStore.KEY_LISTENING, false)
      .putLong(WakeWordStore.KEY_START_REQUESTED_AT, android.os.SystemClock.elapsedRealtime())
      .apply()
    acquireWakeLock()
    updateNotification(preparing = true)
    captureThread = Thread({ captureLoop(generation) }, "openbot-wake-word").apply {
      isDaemon = true
      start()
    }
  }

  private fun stopCapture(reason: String) {
    Log.i(TAG, "Capture stop requested: reason=$reason active=$captureRequested generation=$captureGeneration")
    captureRequested = false
    captureGeneration += 1
    preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, false).apply()
    try {
      audioRecord?.stop()
    } catch (_: IllegalStateException) {
      // The capture thread may already have released the recorder.
    }
    modelPreparationThread?.interrupt()
    JapaneseWakeWordModel.cancelDownload()
    releaseWakeLock()
  }

  private fun captureLoop(generation: Int) {
    var recorder: AudioRecord? = null
    var spotter: KeywordSpotter? = null
    var stream: com.k2fsa.sherpa.onnx.OnlineStream? = null
    val japaneseRecognizer = AtomicReference<OfflineRecognizer?>(null)
    var speechSegmenter: WakeWordSpeechSegmenter? = null
    var pcmBuffer: ShortArray? = null
    var audioFrame: FloatArray? = null
    var keywordCandidateInSegment = false
    var detected = false
    var failed = false

    try {
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      if (!captureRequested || generation != captureGeneration) throw CancellationException("Wake-word capture stopped")
      val minimumBuffer = AudioRecord.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minimumBuffer <= 0) throw IllegalStateException("AudioRecord buffer is unavailable")
      if (!captureRequested || generation != captureGeneration) throw CancellationException("Wake-word capture stopped")

      recorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minimumBuffer * 2, SAMPLE_RATE * 4),
      )
      if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("Microphone is unavailable")
      audioRecord = recorder
      if (!captureRequested || generation != captureGeneration) throw CancellationException("Wake-word capture stopped")
      recorder.startRecording()
      if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("Microphone did not enter the recording state")
      }
      if (!captureRequested || generation != captureGeneration) {
        recorder.stop()
        throw CancellationException("Wake-word capture stopped")
      }
      preferences.edit()
        .putBoolean(WakeWordStore.KEY_LISTENING, true)
        .remove(WakeWordStore.KEY_START_REQUESTED_AT)
        .apply()
      if (!captureRequested || generation != captureGeneration) {
        preferences.edit().putBoolean(WakeWordStore.KEY_LISTENING, false).apply()
        recorder.stop()
        throw CancellationException("Wake-word capture stopped")
      }
      Log.i(TAG, "Microphone capture active at ${SAMPLE_RATE}Hz; JapaneseASR=preparing")

      Log.i(TAG, "Initializing English on-device keyword spotter; threshold=$KEYWORD_THRESHOLD")

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
      speechSegmenter = WakeWordSpeechSegmenter()
      updateNotification(preparing = true)
      startJapaneseModelPreparation(generation, japaneseRecognizer)

      val pcm = ShortArray(FRAME_SAMPLES)
      pcmBuffer = pcm
      var levelWindowStartedAt = android.os.SystemClock.elapsedRealtime()
      var levelSampleCount = 0L
      var levelSquares = 0.0
      var peakSample = 0
      var zeroReadCount = 0

      fun logInputLevels(now: Long) {
        if (now - levelWindowStartedAt < LEVEL_LOG_INTERVAL_MILLIS) return
        val rmsPermille = if (levelSampleCount == 0L) 0 else (sqrt(levelSquares / levelSampleCount.toDouble()) * 1000).toInt()
        val peakPercent = peakSample * 100 / Short.MAX_VALUE.toInt()
        Log.i(
          TAG,
          "Microphone health (no audio stored): samples=$levelSampleCount zeroReads=$zeroReadCount rmsPermille=$rmsPermille peakPercent=$peakPercent",
        )
        levelWindowStartedAt = now
        levelSampleCount = 0
        levelSquares = 0.0
        peakSample = 0
        zeroReadCount = 0
      }

      while (captureRequested && generation == captureGeneration) {
        val count = recorder.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION || count < 0) {
          throw IllegalStateException("Microphone capture stopped")
        }
        if (count == 0) {
          zeroReadCount += 1
          logInputLevels(android.os.SystemClock.elapsedRealtime())
          continue
        }

        var frameSquares = 0.0
        val samples = FloatArray(count) { index ->
          val normalized = pcm[index] / 32768.0f
          val square = normalized.toDouble() * normalized.toDouble()
          levelSquares += square
          frameSquares += square
          peakSample = maxOf(peakSample, kotlin.math.abs(pcm[index].toInt()))
          normalized
        }
        audioFrame = samples
        levelSampleCount += count
        val now = android.os.SystemClock.elapsedRealtime()
        logInputLevels(now)
        stream.acceptWaveform(samples, SAMPLE_RATE)
        while (spotter.isReady(stream)) spotter.decode(stream)
        val keyword = spotter.getResult(stream).keyword
        if (keyword.isNotBlank()) {
          // Treat the English spotter as a candidate only. Japanese ASR must confirm the
          // phrase before starting a call, which prevents acoustic near-matches from waking it.
          keywordCandidateInSegment = true
        }

        val segment = speechSegmenter?.accept(samples, sqrt(frameSquares / count))
        samples.fill(0f)
        audioFrame = null
        val recognizer = japaneseRecognizer.get()
        if (segment != null && recognizer != null) {
          val speechStream = recognizer.createStream()
          val recognitionStartedAt = android.os.SystemClock.elapsedRealtime()
          try {
            speechStream.acceptWaveform(segment, SAMPLE_RATE)
            recognizer.decode(speechStream)
            val transcript = recognizer.getResult(speechStream).text
            val matched = WakeWordPhraseMatcher.matches(transcript, allowMildVariant = keywordCandidateInSegment)
            val processingMs = android.os.SystemClock.elapsedRealtime() - recognitionStartedAt
            Log.i(
              TAG,
              "Japanese ASR segment processed: durationMs=${segment.size * 1000 / SAMPLE_RATE}, " +
                "processingMs=$processingMs, keywordCandidate=$keywordCandidateInSegment, wakeMatch=$matched",
            )
            if (matched && captureRequested && generation == captureGeneration) {
              Log.i(TAG, "Wake word detected by Japanese on-device recognition")
              markWakeWordDetected()
              detected = true
            }
          } finally {
            speechStream.release()
            segment.fill(0f)
            keywordCandidateInSegment = false
          }
          if (detected) break
        } else {
          segment?.fill(0f)
          if (segment != null) keywordCandidateInSegment = false
        }
      }
    } catch (error: CancellationException) {
      Log.i(TAG, "Wake-word capture canceled before microphone loop completed")
    } catch (error: SecurityException) {
      Log.e(TAG, "Microphone permission denied during wake-word capture", error)
      failed = true
    } catch (error: Exception) {
      Log.e(TAG, "Wake-word capture failed", error)
      failed = true
    } finally {
      audioFrame?.fill(0f)
      pcmBuffer?.fill(0)
      try {
        if (recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
      } catch (_: IllegalStateException) {
        // Ignore recorder shutdown races.
      }
      recorder?.release()
      stream?.release()
      spotter?.release()
      japaneseRecognizer.getAndSet(null)?.release()
      speechSegmenter?.clear()
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

  private fun markWakeWordDetected() {
    captureRequested = false
    modelPreparationThread?.interrupt()
    JapaneseWakeWordModel.cancelDownload()
    preferences.edit()
      .putBoolean(WakeWordStore.KEY_LISTENING, false)
      .remove(WakeWordStore.KEY_START_REQUESTED_AT)
      .putLong(WakeWordStore.KEY_PENDING_DETECTION_AT, System.currentTimeMillis())
      .putString(WakeWordStore.KEY_PENDING_SERVER_ID, preferences.getString(WakeWordStore.KEY_SERVER_ID, null))
      .putString(WakeWordStore.KEY_PENDING_AGENT_ID, preferences.getString(WakeWordStore.KEY_AGENT_ID, null))
      .apply()
  }

  private fun startJapaneseModelPreparation(generation: Int, recognizerRef: AtomicReference<OfflineRecognizer?>) {
    if (!captureRequested || generation != captureGeneration) return
    val worker = Thread({
      var lastDownloadProgress = -1
      try {
        Log.i(TAG, "Preparing Japanese wake-word model in background; microphone is already active")
        val modelDirectory = JapaneseWakeWordModel.ensureAvailable(
          this,
          onProgress = { progress ->
            if (progress != lastDownloadProgress && captureRequested && generation == captureGeneration) {
              lastDownloadProgress = progress
              updateNotification(modelProgress = progress)
            }
          },
          isActive = { captureRequested && generation == captureGeneration && !Thread.currentThread().isInterrupted },
        )
        if (!captureRequested || generation != captureGeneration || Thread.currentThread().isInterrupted) {
          throw CancellationException("Wake-word model preparation was stopped")
        }

        Log.i(TAG, "Loading Japanese on-device speech recognizer in background")
        val recognizer = JapaneseWakeWordModel.createRecognizer(modelDirectory)
        if (!captureRequested || generation != captureGeneration || Thread.currentThread().isInterrupted) {
          recognizer.release()
          throw CancellationException("Wake-word recognizer initialization was stopped")
        }
        if (!recognizerRef.compareAndSet(null, recognizer)) {
          recognizer.release()
          throw IllegalStateException("Japanese wake-word recognizer was initialized twice")
        }
        if (!captureRequested || generation != captureGeneration || Thread.currentThread().isInterrupted) {
          if (recognizerRef.compareAndSet(recognizer, null)) recognizer.release()
          throw CancellationException("Wake-word recognizer initialization was stopped")
        }
        Log.i(TAG, "Japanese on-device speech recognizer ready")
        updateNotification()
      } catch (_: CancellationException) {
        Log.i(TAG, "Japanese wake-word model preparation canceled; microphone capture is independent")
      } catch (error: Exception) {
        if (captureRequested && generation == captureGeneration) {
          Log.w(TAG, "Japanese on-device model unavailable (${error.javaClass.simpleName}); stopping wake-word listening")
          captureFailed(japaneseModelUnavailable = true)
        } else {
          Log.i(TAG, "Japanese wake-word model preparation stopped with capture")
        }
      } finally {
        if (modelPreparationThread === Thread.currentThread()) modelPreparationThread = null
      }
    }, "openbot-wake-word-ja-model").apply {
      isDaemon = true
    }
    modelPreparationThread = worker
    worker.start()
  }

  private fun captureFailed(japaneseModelUnavailable: Boolean = false) {
    captureRequested = false
    captureGeneration += 1
    modelPreparationThread?.interrupt()
    JapaneseWakeWordModel.cancelDownload()
    preferences.edit()
      .putBoolean(WakeWordStore.KEY_ARMED, false)
      .putBoolean(WakeWordStore.KEY_LISTENING, false)
      .remove(WakeWordStore.KEY_START_REQUESTED_AT)
      .apply()
    releaseWakeLock()
    updateNotification(failed = true, japaneseModelUnavailable = japaneseModelUnavailable)
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

  private fun updateNotification(
    paused: Boolean = false,
    detected: Boolean = false,
    failed: Boolean = false,
    preparing: Boolean = false,
    modelProgress: Int? = null,
    japaneseModelUnavailable: Boolean = false,
  ) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(
      NOTIFICATION_ID,
      buildNotification(paused, detected, failed, preparing, modelProgress, japaneseModelUnavailable),
    )
  }

  private fun buildNotification(
    paused: Boolean = false,
    detected: Boolean = false,
    failed: Boolean = false,
    preparing: Boolean = false,
    modelProgress: Int? = null,
    japaneseModelUnavailable: Boolean = false,
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
      japaneseModelUnavailable -> getString(R.string.wake_word_notification_model_unavailable)
      failed -> getString(R.string.wake_word_notification_failed)
      detected -> getString(R.string.wake_word_notification_detected, agentName)
      paused -> getString(R.string.wake_word_notification_paused)
      modelProgress != null -> getString(R.string.wake_word_notification_model_download_progress, modelProgress)
      preparing -> getString(R.string.wake_word_notification_model_preparing)
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

/** Holds only a short in-memory utterance for local wake-phrase matching. */
private class WakeWordSpeechSegmenter {
  private val preRoll = ArrayDeque<FloatArray>()
  private val buffer = FloatArray(MAX_SEGMENT_SAMPLES)
  private var length = 0
  private var silenceFrames = 0
  private var speechFrames = 0
  private var active = false

  fun accept(samples: FloatArray, rms: Double): FloatArray? {
    val speech = rms >= SPEECH_RMS_THRESHOLD
    if (!active && !speech) {
      remember(samples)
      return null
    }

    if (!active) {
      active = true
      while (preRoll.isNotEmpty()) {
        val frame = preRoll.removeFirst()
        append(frame)
        frame.fill(0f)
      }
    }
    append(samples)
    if (speech) {
      speechFrames += 1
      silenceFrames = 0
    } else {
      silenceFrames += 1
    }

    val reachedMaximumLength = length >= MAX_SEGMENT_SAMPLES
    if (silenceFrames < END_SILENCE_FRAMES && !reachedMaximumLength) return null

    val result = if (speechFrames >= MIN_SPEECH_FRAMES && length >= MIN_SEGMENT_SAMPLES) buffer.copyOf(length) else null
    if (reachedMaximumLength && silenceFrames < END_SILENCE_FRAMES) {
      // Keep a short overlap so the wake phrase is not lost when a long utterance crosses a
      // segment boundary. This also caps Japanese ASR wait time while someone keeps talking.
      val overlapLength = minOf(SEGMENT_OVERLAP_SAMPLES, length)
      val overlapStart = length - overlapLength
      buffer.copyInto(buffer, destinationOffset = 0, startIndex = overlapStart, endIndex = length)
      buffer.fill(0f, overlapLength, length)
      length = overlapLength
      silenceFrames = 0
      speechFrames = 0
      active = true
    } else {
      buffer.fill(0f, 0, length)
      length = 0
      silenceFrames = 0
      speechFrames = 0
      active = false
    }
    return result
  }

  fun clear() {
    while (preRoll.isNotEmpty()) preRoll.removeFirst().fill(0f)
    buffer.fill(0f)
    length = 0
    silenceFrames = 0
    speechFrames = 0
    active = false
  }

  private fun remember(samples: FloatArray) {
    preRoll.addLast(samples.copyOf())
    while (preRoll.size > PRE_ROLL_FRAMES) preRoll.removeFirst().fill(0f)
  }

  private fun append(samples: FloatArray, startIndex: Int = 0) {
    val count = minOf(samples.size - startIndex, buffer.size - length)
    if (count <= 0) return
    samples.copyInto(buffer, destinationOffset = length, startIndex = startIndex, endIndex = startIndex + count)
    length += count
  }

  private companion object {
    const val SPEECH_RMS_THRESHOLD = 0.004
    const val PRE_ROLL_FRAMES = 8
    const val END_SILENCE_FRAMES = 16
    const val MIN_SPEECH_FRAMES = 6
    const val MIN_SEGMENT_SAMPLES = 6_000
    const val MAX_SEGMENT_SAMPLES = 16_000 * 3
    const val SEGMENT_OVERLAP_SAMPLES = 16_000
  }
}
