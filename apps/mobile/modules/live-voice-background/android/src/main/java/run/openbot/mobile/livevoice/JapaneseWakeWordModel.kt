package run.openbot.mobile.livevoice

import android.content.Context
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException

/** Downloads only the small int8 Japanese recognizer files, outside the APK. */
internal object JapaneseWakeWordModel {
  private const val REVISION = "291488c8151be24d7da4bf7af26e533fad96e407"
  private const val MODEL_DIR = "wake-word-ja-v1"
  private const val SAMPLE_RATE = 16_000
  private const val MODEL_URL = "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/$REVISION/"

  private data class ModelFile(
    val remoteName: String,
    val localName: String,
    val size: Long,
    val sha256: String,
  )

  // Hashes are the SHA-256 LFS object IDs from the pinned public model revision.
  private val files = listOf(
    ModelFile(
      remoteName = "encoder-epoch-99-avg-1.int8.onnx",
      localName = "encoder.int8.onnx",
      size = 154_670_139L,
      sha256 = "2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d",
    ),
    ModelFile(
      remoteName = "decoder-epoch-99-avg-1.int8.onnx",
      localName = "decoder.int8.onnx",
      size = 2_959_337L,
      sha256 = "8f0bff94d38797b03b762634ed03211a8e303d06cc4603cdd0cf4199d6eb1485",
    ),
    ModelFile(
      remoteName = "joiner-epoch-99-avg-1.int8.onnx",
      localName = "joiner.int8.onnx",
      size = 2_696_970L,
      sha256 = "49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de",
    ),
    ModelFile(
      remoteName = "tokens.txt",
      localName = "tokens.txt",
      size = 45_754L,
      sha256 = "2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def",
    ),
  )
  private val totalSize = files.sumOf { it.size }
  private val completeMarker = "reazonspeech-ja-v1\n$REVISION\n${files.joinToString("\n") { it.sha256 }}\n"
  @Volatile private var activeConnection: HttpURLConnection? = null

  @Synchronized
  fun ensureAvailable(
    context: Context,
    onProgress: (Int) -> Unit,
    isActive: () -> Boolean,
  ): File {
    val directory = File(context.noBackupFilesDir, MODEL_DIR)
    directory.mkdirs()
    val marker = File(directory, ".complete")
    if (marker.isFile && marker.readText() == completeMarker && files.all { File(directory, it.localName).length() == it.size }) {
      onProgress(100)
      return directory
    }

    marker.delete()
    var completedBytes = 0L
    for (modelFile in files) {
      checkActive(isActive)
      val target = File(directory, modelFile.localName)
      if (target.isFile && target.length() == modelFile.size && sha256(target) == modelFile.sha256) {
        completedBytes += modelFile.size
        onProgress((completedBytes * 100 / totalSize).toInt())
        continue
      }

      target.delete()
      downloadFile(directory, modelFile, completedBytes, onProgress, isActive)
      completedBytes += modelFile.size
      onProgress((completedBytes * 100 / totalSize).toInt())
    }

    checkActive(isActive)
    val temporaryMarker = File(directory, ".complete.part")
    temporaryMarker.writeText(completeMarker)
    if (!temporaryMarker.renameTo(marker)) {
      temporaryMarker.delete()
      throw IOException("Could not finalize the Japanese wake-word model")
    }
    return directory
  }

  fun cancelDownload() {
    activeConnection?.disconnect()
  }

  fun createRecognizer(directory: File): OfflineRecognizer {
    val config = OfflineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
      modelConfig = OfflineModelConfig(
        transducer = OfflineTransducerModelConfig(
          encoder = File(directory, "encoder.int8.onnx").absolutePath,
          decoder = File(directory, "decoder.int8.onnx").absolutePath,
          joiner = File(directory, "joiner.int8.onnx").absolutePath,
        ),
        numThreads = 2,
        provider = "cpu",
        tokens = File(directory, "tokens.txt").absolutePath,
        modelingUnit = "cjkchar",
      ),
    )
    return OfflineRecognizer(assetManager = null, config = config)
  }

  private fun downloadFile(
    directory: File,
    modelFile: ModelFile,
    completedBytes: Long,
    onProgress: (Int) -> Unit,
    isActive: () -> Boolean,
  ) {
    val partial = File(directory, "${modelFile.localName}.part")
    partial.delete()
    val connection = URL(MODEL_URL + modelFile.remoteName).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = true
    connection.connectTimeout = 20_000
    connection.readTimeout = 60_000
    connection.setRequestProperty("Accept-Encoding", "identity")
    activeConnection = connection

    try {
      checkActive(isActive)
      connection.connect()
      if (connection.responseCode !in 200..299) {
        throw IOException("Japanese wake-word model request failed: HTTP ${connection.responseCode}")
      }

      val digest = MessageDigest.getInstance("SHA-256")
      var receivedBytes = 0L
      connection.inputStream.buffered().use { input ->
        FileOutputStream(partial).buffered().use { output ->
          val buffer = ByteArray(128 * 1024)
          while (true) {
            checkActive(isActive)
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            receivedBytes += count
            onProgress(((completedBytes + receivedBytes) * 100 / totalSize).toInt().coerceIn(0, 99))
          }
        }
      }

      if (receivedBytes != modelFile.size || hex(digest.digest()) != modelFile.sha256) {
        throw IOException("Japanese wake-word model integrity check failed")
      }
      if (!partial.renameTo(File(directory, modelFile.localName))) {
        throw IOException("Could not install a Japanese wake-word model file")
      }
    } catch (error: Exception) {
      partial.delete()
      throw error
    } finally {
      connection.disconnect()
      if (activeConnection === connection) activeConnection = null
    }
  }

  private fun checkActive(isActive: () -> Boolean) {
    if (!isActive()) throw CancellationException("Wake-word model preparation was stopped")
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).buffered().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
