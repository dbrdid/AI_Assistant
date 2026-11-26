import CryptoKit
import ExpoModulesCore
import Foundation
import os

public final class StellaModelDeviceModule: Module {
  private func directory() throws -> URL {
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var url = root.appendingPathComponent("qwen35", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    var flags = URLResourceValues()
    flags.isExcludedFromBackup = true
    try url.setResourceValues(flags)
    return url
  }
  public func definition() -> ModuleDefinition {
    Name("StellaModelDevice")
    Function("directoryUri") { try self.directory().absoluteString }
    Function("memory") {
      ["total": Double(ProcessInfo.processInfo.physicalMemory), "available": Double(os_proc_available_memory())]
    }
    Function("thermalRestricted") { () -> Bool in
      let state = ProcessInfo.processInfo.thermalState
      return state == .serious || state == .critical
    }
    AsyncFunction("digestStagingFile") { () throws -> String in
      let file = try FileHandle(forReadingFrom: self.directory().appendingPathComponent("install.partial"))
      defer { try? file.close() }
      var digest = SHA256()
      while let data = try autoreleasepool(invoking: { try file.read(upToCount: 1024 * 1024) }), !data.isEmpty {
        digest.update(data: data)
      }
      return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
  }
}
