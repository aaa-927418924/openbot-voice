package run.openbot.mobile.attachmentvideo

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URI
import java.security.MessageDigest
import java.util.BitSet
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Serves MP4 bytes to Media3 while fetching only the ranges the player reads from the host. */
class AttachmentVideoStreamModule : Module() {
  private data class PendingRange(
    val streamId: String,
    val expectedBytes: Int,
    val result: CompletableFuture<ByteArray>,
  )

  private class CachedVideo(
    val size: Long,
    val dataFile: File,
    val indexFile: File,
  ) {
    val lock = Any()
    val completedChunks = BitSet()
    val inFlight = ConcurrentHashMap<Int, CompletableFuture<ByteArray>>()
  }

  private val streams = ConcurrentHashMap<String, CachedVideo>()
  private val pendingRanges = ConcurrentHashMap<String, PendingRange>()
  private val cachedVideos = ConcurrentHashMap<String, CachedVideo>()
  private val workers = Executors.newCachedThreadPool()
  private val serverLock = Any()
  @Volatile private var server: ServerSocket? = null

  override fun definition() = ModuleDefinition {
    Name("OpenBotAttachmentVideoStream")
    Events("rangeRequested")

    AsyncFunction("start") { streamId: String, attachmentId: String, size: Int, mimeType: String ->
      if (!streamId.matches(Regex("[A-Za-z0-9_-]{16,80}"))) {
        throw IllegalArgumentException("The video stream token is invalid.")
      }
      if (attachmentId.isBlank() || attachmentId.length > 256 || size !in 1..MAX_VIDEO_BYTES) {
        throw IllegalArgumentException("The video attachment metadata is invalid.")
      }
      if (!mimeType.startsWith("video/")) throw IllegalArgumentException("The attachment is not a video.")
      streams[streamId] = cachedVideo(attachmentId, size.toLong())
      val address = ensureServer()
      "http://127.0.0.1:$address/video/$streamId"
    }

    AsyncFunction("respond") { requestId: String, base64: String ->
      val pending = pendingRanges[requestId] ?: return@AsyncFunction null
      val bytes = try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        pending.result.completeExceptionally(error)
        return@AsyncFunction null
      }
      if (bytes.size != pending.expectedBytes) {
        pending.result.completeExceptionally(IllegalStateException("The downloaded video range has an invalid size."))
      } else {
        pending.result.complete(bytes)
      }
      null
    }

    AsyncFunction("fail") { requestId: String ->
      pendingRanges[requestId]?.result?.completeExceptionally(
        IllegalStateException("The host could not provide this video range."),
      )
      null
    }

    AsyncFunction("stop") { streamId: String ->
      streams.remove(streamId)
      null
    }

    OnDestroy {
      server?.close()
      server = null
      streams.clear()
      pendingRanges.values.forEach {
        it.result.completeExceptionally(IllegalStateException("Video playback stopped."))
      }
      pendingRanges.clear()
      workers.shutdownNow()
    }
  }

  private fun ensureServer(): Int = synchronized(serverLock) {
    server?.let { return@synchronized it.localPort }
    val opened = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    server = opened
    workers.execute {
      while (!opened.isClosed) {
        try {
          val socket = opened.accept()
          workers.execute { serve(socket) }
        } catch (_: SocketException) {
          if (!opened.isClosed) continue
        } catch (_: Exception) {
          if (!opened.isClosed) continue
        }
      }
    }
    opened.localPort
  }

  private fun cachedVideo(attachmentId: String, size: Long): CachedVideo {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest("$attachmentId:$size".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
    return cachedVideos.computeIfAbsent(digest) {
      val context = appContext.reactContext ?: throw IllegalStateException("React context is not available")
      val directory = File(context.cacheDir, "openbot-video-ranges-v1")
      if (!directory.exists() && !directory.mkdirs()) {
        throw IllegalStateException("The video cache could not be created.")
      }
      val data = File(directory, "$digest.mp4")
      val index = File(directory, "$digest.ranges")
      if (!data.exists() || data.length() != size) {
        RandomAccessFile(data, "rw").use { it.setLength(size) }
        index.delete()
      }
      val cached = CachedVideo(size, data, index)
      if (index.exists()) {
        runCatching { BitSet.valueOf(index.readBytes()) }
          .getOrNull()
          ?.takeIf { it.length() <= chunkCount(size) }
          ?.let { cached.completedChunks.or(it) }
      }
      cached
    }
  }

  private fun serve(socket: Socket) {
    socket.use { client ->
      try {
        client.soTimeout = SOCKET_TIMEOUT_MS
        val headerText = readHeader(client) ?: return
        val lines = headerText.split("\r\n")
        val requestLine = lines.firstOrNull()?.split(' ') ?: return writeError(client, 400, "Bad Request")
        if (requestLine.size < 2) return writeError(client, 400, "Bad Request")
        val method = requestLine[0]
        val token = runCatching { URI(requestLine[1]).rawPath }
          .getOrNull()
          ?.removePrefix("/video/")
          ?.takeIf { it.isNotEmpty() && !it.contains('/') }
          ?: return writeError(client, 404, "Not Found")
        val video = streams[token] ?: return writeError(client, 404, "Not Found")
        val rangeHeader = lines.drop(1).firstNotNullOfOrNull { line ->
          val colon = line.indexOf(':')
          if (colon > 0 && line.substring(0, colon).equals("Range", ignoreCase = true)) {
            line.substring(colon + 1).trim()
          } else null
        }
        if (method != "GET" && method != "HEAD") return writeError(client, 405, "Method Not Allowed")
        if (video.size <= 0) return writeError(client, 416, "Range Not Satisfiable", "Content-Range: bytes */0\r\n")
        val range = parseRange(rangeHeader, video.size)
        if (range == null) {
          return writeError(client, 416, "Range Not Satisfiable", "Content-Range: bytes */${video.size}\r\n")
        }
        val (start, end) = range
        val length = end - start + 1
        val status = if (rangeHeader == null) "200 OK" else "206 Partial Content"
        val output = client.getOutputStream()
        val header = buildString {
          append("HTTP/1.1 $status\r\n")
          append("Content-Type: video/mp4\r\n")
          append("Accept-Ranges: bytes\r\n")
          append("Content-Length: $length\r\n")
          if (rangeHeader != null) append("Content-Range: bytes $start-$end/${video.size}\r\n")
          append("Connection: close\r\n\r\n")
        }
        output.write(header.toByteArray(Charsets.US_ASCII))
        output.flush()
        if (method == "HEAD") return
        var position = start
        while (position <= end) {
          val index = (position / RANGE_CHUNK_BYTES).toInt()
          val chunkStart = index.toLong() * RANGE_CHUNK_BYTES
          val bytes = readChunk(token, video, index)
          val inside = (position - chunkStart).toInt()
          val count = minOf(bytes.size - inside, (end - position + 1).toInt())
          if (count <= 0) throw IllegalStateException("The video range was incomplete.")
          output.write(bytes, inside, count)
          position += count
        }
        output.flush()
      } catch (_: Exception) {
        // The player closes range requests while changing playback position. The socket owns that cancellation.
      }
    }
  }

  private fun readChunk(streamId: String, video: CachedVideo, index: Int): ByteArray {
    synchronized(video.lock) {
      if (video.completedChunks[index]) return readCachedChunk(video, index)
    }
    val existing = video.inFlight[index]
    val future = if (existing != null) existing else {
      val created = CompletableFuture<ByteArray>()
      val raced = video.inFlight.putIfAbsent(index, created)
      if (raced != null) raced else {
        val offset = index.toLong() * RANGE_CHUNK_BYTES
        val expected = minOf(RANGE_CHUNK_BYTES.toLong(), video.size - offset).toInt()
        val requestId = UUID.randomUUID().toString()
        pendingRanges[requestId] = PendingRange(streamId, expected, created)
        created.whenComplete { _, _ ->
          pendingRanges.remove(requestId)
          video.inFlight.remove(index, created)
        }
        sendEvent(
          "rangeRequested",
          mapOf("requestId" to requestId, "streamId" to streamId, "offset" to offset.toDouble(), "length" to expected),
        )
        created
      }
    }
    val bytes = try {
      future.get(RANGE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      future.completeExceptionally(error)
      throw error
    } catch (error: ExecutionException) {
      throw IllegalStateException("The video byte range failed.", error.cause)
    }
    synchronized(video.lock) {
      if (!video.completedChunks[index]) {
        RandomAccessFile(video.dataFile, "rw").use { file ->
          file.seek(index.toLong() * RANGE_CHUNK_BYTES)
          file.write(bytes)
        }
        video.completedChunks.set(index)
        val temporary = File(video.indexFile.parentFile, "${video.indexFile.name}.tmp")
        temporary.writeBytes(video.completedChunks.toByteArray())
        if (video.indexFile.exists()) video.indexFile.delete()
        if (!temporary.renameTo(video.indexFile)) {
          temporary.delete()
          throw IllegalStateException("The video range cache index could not be saved.")
        }
      }
    }
    return bytes
  }

  private fun readCachedChunk(video: CachedVideo, index: Int): ByteArray {
    val offset = index.toLong() * RANGE_CHUNK_BYTES
    val count = minOf(RANGE_CHUNK_BYTES.toLong(), video.size - offset).toInt()
    return RandomAccessFile(video.dataFile, "r").use { file ->
      val bytes = ByteArray(count)
      file.seek(offset)
      file.readFully(bytes)
      bytes
    }
  }

  private fun parseRange(value: String?, size: Long): Pair<Long, Long>? {
    if (value == null) return 0L to size - 1
    if (!value.startsWith("bytes=")) return null
    val spec = value.removePrefix("bytes=").trim()
    if (spec.contains(',')) return null
    val parts = spec.split('-', limit = 2)
    if (parts.size != 2) return null
    if (parts[0].isEmpty()) {
      val suffixLength = parts[1].toLongOrNull()?.takeIf { it > 0 } ?: return null
      val start = (size - suffixLength).coerceAtLeast(0)
      return start to size - 1
    }
    val start = parts[0].toLongOrNull()?.takeIf { it >= 0 && it < size } ?: return null
    val requestedEnd = parts[1].toLongOrNull()?.takeIf { it >= start } ?: if (parts[1].isEmpty()) size - 1 else return null
    return start to requestedEnd.coerceAtMost(size - 1)
  }

  private fun readHeader(socket: Socket): String? {
    val bytes = ByteArrayOutputStream()
    val end = byteArrayOf(13, 10, 13, 10)
    var matched = 0
    val input = socket.getInputStream()
    while (bytes.size() < MAX_HEADER_BYTES) {
      val next = input.read()
      if (next < 0) return null
      bytes.write(next)
      if (next == end[matched].toInt()) {
        matched++
        if (matched == end.size) return bytes.toString(Charsets.ISO_8859_1.name())
      } else {
        matched = if (next == end[0].toInt()) 1 else 0
      }
    }
    throw IllegalArgumentException("The video request header is too large.")
  }

  private fun writeError(socket: Socket, status: Int, reason: String, extraHeaders: String = "") {
    val body = "$status $reason".toByteArray(Charsets.UTF_8)
    val headers = "HTTP/1.1 $status $reason\r\n${extraHeaders}Content-Type: text/plain\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
    socket.getOutputStream().apply {
      write(headers.toByteArray(Charsets.US_ASCII))
      write(body)
      flush()
    }
  }

  private fun chunkCount(size: Long): Int = ((size + RANGE_CHUNK_BYTES - 1) / RANGE_CHUNK_BYTES).toInt()

  companion object {
    private const val RANGE_CHUNK_BYTES = 256 * 1024
    private const val MAX_VIDEO_BYTES = 100 * 1024 * 1024
    private const val MAX_HEADER_BYTES = 16 * 1024
    private const val SOCKET_TIMEOUT_MS = 35_000
    private const val RANGE_TIMEOUT_SECONDS = 30L
  }
}
