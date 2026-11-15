// 녹음 → 구간 m4a (MediaExtractor로 AAC 프레임을 읽어 MediaMuxer로 그대로 씀 = 다시 인코딩 안 함)
package expo.modules.stellaaudiosplit

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

class SplitRange : Record {
  @Field var start: Double = 0.0
  @Field var duration: Double = 0.0
}

class SplitException(message: String) : CodedException("SPLIT_FAILED", message, null)

class StellaAudioSplitModule : Module() {
  private fun pathOf(uri: String): String {
    val u = Uri.parse(uri)
    return when {
      u.scheme == null || u.scheme == "" -> uri
      u.scheme == "file" -> u.path ?: throw SplitException("bad uri: $uri")
      else -> throw SplitException("file:// 경로만 지원: $uri")
    }
  }

  /** 오디오 트랙을 고른 extractor와 그 형식 */
  private fun openAudio(path: String): Triple<MediaExtractor, Int, MediaFormat> {
    val ex = MediaExtractor()
    ex.setDataSource(path)
    for (i in 0 until ex.trackCount) {
      val f = ex.getTrackFormat(i)
      if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
        ex.selectTrack(i)
        return Triple(ex, i, f)
      }
    }
    ex.release()
    throw SplitException("오디오 트랙이 없어요")
  }

  override fun definition() = ModuleDefinition {
    Name("StellaAudioSplit")

    AsyncFunction("getAudioDuration") { uri: String ->
      val (ex, _, format) = openAudio(pathOf(uri))
      try {
        if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0 else {
          // 형식에 길이가 없으면 마지막 샘플 시각
          var last = 0L
          while (ex.sampleTime >= 0) { last = ex.sampleTime; ex.advance() }
          last / 1_000_000.0
        }
      } finally { ex.release() }
    }

    AsyncFunction("splitAudio") { uri: String, ranges: List<SplitRange>, outputDir: String? ->
      val src = pathOf(uri)
      val dir = if (outputDir != null) File(pathOf(outputDir)) else File(appContext.reactContext?.cacheDir ?: throw SplitException("no cache dir"), "stella-split/${UUID.randomUUID()}")
      dir.mkdirs()
      val (ex, track, format) = openAudio(src)
      val maxInput = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
      val buffer = ByteBuffer.allocate(maxOf(maxInput, 256 * 1024))
      // AAC 프레임 하나 길이(1024 샘플) → 구간 길이 = 마지막 프레임 시각 - 첫 프레임 시각 + 프레임 하나
      val frameUs = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) 1024L * 1_000_000L / format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 23_220L
      val info = MediaCodec.BufferInfo()
      val out = mutableListOf<Map<String, Any>>()
      try {
        ranges.forEachIndexed { i, r ->
          val startUs = (r.start * 1_000_000).toLong()
          val endUs = ((r.start + r.duration) * 1_000_000).toLong()
          val dest = File(dir, String.format("%03d.m4a", i))
          if (dest.exists()) dest.delete()
          ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
          val muxer = MediaMuxer(dest.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
          val dst = muxer.addTrack(format)
          muxer.start()
          var first = -1L
          var last = -1L
          try {
            while (true) {
              if (ex.sampleTrackIndex != track) { if (!ex.advance()) break else continue }
              val t = ex.sampleTime
              if (t < 0 || t >= endUs) break
              val size = ex.readSampleData(buffer, 0)
              if (size < 0) break
              // 구간 경계: 시작 시각 이후 프레임만 → 다음 구간은 이 구간이 멈춘 프레임부터 (겹침·빠짐 없음)
              if (t >= startUs) {
                if (first < 0) first = t
                info.offset = 0
                info.size = size
                info.presentationTimeUs = t - first
                info.flags = if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                muxer.writeSampleData(dst, buffer, info)
                last = t
              }
              if (!ex.advance()) break
            }
          } finally {
            if (first >= 0) muxer.stop()
            muxer.release()
          }
          if (first < 0) { dest.delete(); return@forEachIndexed }
          out.add(mapOf(
            "seq" to i, "uri" to Uri.fromFile(dest).toString(), "startSeconds" to first / 1_000_000.0,
            "durationSeconds" to ((last - first + frameUs) / 1_000_000.0),
            "sizeBytes" to dest.length(),
          ))
        }
      } finally {
        ex.release()
      }
      out
    }
  }
}
