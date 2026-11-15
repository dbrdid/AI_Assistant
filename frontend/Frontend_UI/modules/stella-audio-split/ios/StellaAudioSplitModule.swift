// 녹음 → 구간 m4a (AVAssetExportSession, 가능하면 Passthrough = 다시 인코딩 안 함)
import AVFoundation
import ExpoModulesCore

struct SplitRange: Record {
  @Field var start: Double = 0
  @Field var duration: Double = 0
}

enum SplitError: Error, CustomStringConvertible {
  case badUri(String), noAudio, exportFailed(Int, String)
  var description: String {
    switch self {
    case .badUri(let u): return "SPLIT_BAD_URI: \(u)"
    case .noAudio: return "SPLIT_NO_AUDIO"
    case .exportFailed(let i, let m): return "SPLIT_EXPORT_FAILED(\(i)): \(m)"
    }
  }
}

private func fileURL(_ uri: String) throws -> URL {
  if let u = URL(string: uri), u.isFileURL { return u }
  if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
  throw SplitError.badUri(uri)
}

public class StellaAudioSplitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellaAudioSplit")

    AsyncFunction("getAudioDuration") { (uri: String) async throws -> Double in
      let asset = AVURLAsset(url: try fileURL(uri))
      let d = try await asset.load(.duration)
      return CMTimeGetSeconds(d)
    }

    AsyncFunction("splitAudio") { (uri: String, ranges: [SplitRange], outputDir: String?) async throws -> [[String: Any]] in
      let asset = AVURLAsset(url: try fileURL(uri), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
      let tracks = try await asset.loadTracks(withMediaType: .audio)
      if tracks.isEmpty { throw SplitError.noAudio }
      let total = CMTimeGetSeconds(try await asset.load(.duration))

      let dir: URL
      if let o = outputDir { dir = try fileURL(o) } else {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("stella-split/\(UUID().uuidString)", isDirectory: true)
      }
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

      // Passthrough가 m4a를 지원하면 그대로 자르고(빠름, 음질 그대로), 아니면 AAC로 다시 인코딩
      let passthrough = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
        AVAssetExportSession.determineCompatibility(ofExportPreset: AVAssetExportPresetPassthrough, with: asset, outputFileType: .m4a) { c.resume(returning: $0) }
      }
      let preset = passthrough ? AVAssetExportPresetPassthrough : AVAssetExportPresetAppleM4A
      let timescale: CMTimeScale = 44100

      var out: [[String: Any]] = []
      for (i, r) in ranges.enumerated() {
        let start = max(0, min(r.start, total))
        let end = min(total, r.start + r.duration)
        if end <= start { continue }
        let dest = dir.appendingPathComponent(String(format: "%03d.m4a", i))
        try? FileManager.default.removeItem(at: dest)
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
          throw SplitError.exportFailed(i, "no session")
        }
        session.outputURL = dest
        session.outputFileType = .m4a
        session.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: timescale),
                                        end: CMTime(seconds: end, preferredTimescale: timescale))
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
          session.exportAsynchronously { c.resume() }
        }
        if session.status != .completed {
          throw SplitError.exportFailed(i, session.error?.localizedDescription ?? "status \(session.status.rawValue)")
        }
        let size = (try FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? 0
        let segAsset = AVURLAsset(url: dest, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let dur = CMTimeGetSeconds(try await segAsset.load(.duration))
        out.append(["seq": i, "uri": dest.absoluteString, "startSeconds": start,
                    "durationSeconds": dur.isFinite && dur > 0 ? dur : end - start, "sizeBytes": size])
      }
      return out
    }
  }
}
