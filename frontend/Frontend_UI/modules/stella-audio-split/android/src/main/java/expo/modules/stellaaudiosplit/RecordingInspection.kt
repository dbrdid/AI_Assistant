package expo.modules.stellaaudiosplit

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import java.nio.ByteBuffer
import kotlin.math.roundToLong

// Inspect the finalized recording without changing the AAC file used for playback and transcription.
internal fun inspectRecordingAudio(extractor: MediaExtractor, track: MediaFormat): Map<String, Any> {
  val mime = track.getString(MediaFormat.KEY_MIME) ?: throw SplitException("오디오 형식을 알 수 없어요")
  val durationUs = if (track.containsKey(MediaFormat.KEY_DURATION)) track.getLong(MediaFormat.KEY_DURATION) else -1L
  track.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
  val decoder = MediaCodec.createDecoderByType(mime)
  try {
    // The extractor's encoder-delay and padding, when present, are forwarded to the decoder.
    decoder.configure(track, null, null, 0)
    decoder.start()
    return readDecodedRecording(extractor, decoder, durationUs)
  } finally {
    decoder.release()
  }
}

private fun readDecodedRecording(extractor: MediaExtractor, decoder: MediaCodec, durationUs: Long): Map<String, Any> {
  val info = MediaCodec.BufferInfo()
  val samples = RecordingSamples(durationUs)
  var inputEnded = false
  var lastProgress = SystemClock.elapsedRealtime()
  while (true) {
    var fed = false
    if (!inputEnded) {
      val index = decoder.dequeueInputBuffer(0)
      if (index >= 0) {
        val input = decoder.getInputBuffer(index) ?: throw SplitException("디코더 입력을 열 수 없어요")
        val time = extractor.sampleTime
        val size = extractor.readSampleData(input, 0)
        inputEnded = size < 0
        if (inputEnded) {
          decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        } else {
          decoder.queueInputBuffer(index, 0, size, time, 0)
          extractor.advance()
        }
        fed = true
        lastProgress = SystemClock.elapsedRealtime()
      }
    }

    val index = decoder.dequeueOutputBuffer(info, if (fed) 0L else 10_000L)
    if (index >= 0) {
      val end = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
      try {
        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
          if (!samples.configured) samples.configure(decoder.getOutputFormat(index))
          // getOutputBuffer sets position and limit to the valid PCM range.
          val pcm = decoder.getOutputBuffer(index) ?: throw SplitException("디코더 출력을 열 수 없어요")
          samples.add(pcm)
          lastProgress = SystemClock.elapsedRealtime()
        }
      } finally {
        decoder.releaseOutputBuffer(index, false)
      }
      if (end) return samples.result()
    } else if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
      samples.configure(decoder.outputFormat)
    }
    if (SystemClock.elapsedRealtime() - lastProgress > 5_000L) throw SplitException("오디오 디코더가 응답하지 않아요")
  }
}

// Android voice recordings have a stable sample rate. Limit the final AAC packet to the track's
// playback duration when known. Never count time from container metadata without corresponding PCM.
private class RecordingSamples(private val durationUs: Long) {
  private var sampleRate = 0
  private var channels = 0
  private var frames = 0L
  private var maxFrames = Long.MAX_VALUE
  private var hasSignal = false
  val configured get() = sampleRate > 0

  fun configure(format: MediaFormat) {
    val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING))
      format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
    if (rate <= 0 || channels <= 0 || encoding != AudioFormat.ENCODING_PCM_16BIT || (frames > 0 && rate != sampleRate)) {
      throw SplitException("지원하지 않는 녹음 형식이에요")
    }
    sampleRate = rate
    if (durationUs > 0) maxFrames = (durationUs / 1_000_000.0 * rate).roundToLong()
  }

  fun add(pcm: ByteBuffer) {
    val frameBytes = channels * 2
    if (pcm.remaining() % frameBytes != 0) throw SplitException("녹음 샘플이 손상됐어요")
    val count = minOf((pcm.remaining() / frameBytes).toLong(), maxFrames - frames)
    frames += count
    if (hasSignal) return
    pcm.limit(pcm.position() + count.toInt() * frameBytes)
    // Signed PCM16 digital silence consists exclusively of zero bytes. Check every channel,
    // including a single +/-1 sample; using peak loudness would discard valid quiet recordings.
    while (pcm.remaining() >= 8) if (pcm.long != 0L) { hasSignal = true; return }
    while (pcm.hasRemaining()) if (pcm.get() != 0.toByte()) { hasSignal = true; return }
  }

  fun result(): Map<String, Any> = mapOf(
    "durationSeconds" to if (sampleRate > 0) frames.toDouble() / sampleRate else 0.0,
    "hasSignal" to hasSignal,
  )
}
