import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

private enum PickerKind: Equatable {
  case files
  case directory
}

private final class FolderPickerCancelledException: Exception {
  override var reason: String {
    "Folder picker was cancelled by the user"
  }
}

public class DeviceFileAccessModule: Module, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private var pendingPromise: Promise?
  private var pendingKind: PickerKind?
  private var activeAccess: [String: (URL, Bool)] = [:]

  public func definition() -> ModuleDefinition {
    Name("DeviceFileAccess")

    AsyncFunction("pickFiles") { (multiple: Bool, promise: Promise) in
      self.presentPicker(kind: .files, multiple: multiple, initialUri: nil, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("pickDirectory") { (initialUri: String?, promise: Promise) in
      self.presentPicker(kind: .directory, multiple: false, initialUri: initialUri, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("resolveReference") { (reference: String) throws -> [String: String] in
      guard let data = Data(base64Encoded: reference) else {
        throw DeviceFileReferenceException("저장한 파일 접근 정보가 올바르지 않아요.")
      }
      var isStale = false
      let url = try URL(
        resolvingBookmarkData: data,
        options: [],
        relativeTo: nil,
        bookmarkDataIsStale: &isStale
      )
      let didStartAccessing = url.startAccessingSecurityScopedResource()
      do {
        let refreshedBookmark = isStale ? try makeBookmark(for: url) : reference
        let token = UUID().uuidString
        activeAccess[token] = (url, didStartAccessing)
        return ["uri": url.absoluteString, "token": token, "reference": refreshedBookmark]
      } catch {
        if didStartAccessing { url.stopAccessingSecurityScopedResource() }
        throw error
      }
    }.runOnQueue(.main)

    AsyncFunction("releaseAccess") { (token: String) in
      guard let (url, didStartAccessing) = self.activeAccess.removeValue(forKey: token) else { return }
      if didStartAccessing { url.stopAccessingSecurityScopedResource() }
    }.runOnQueue(.main)

    AsyncFunction("releaseReference") { (_: String) in }

    OnDestroy {
      activeAccess.values.forEach { url, didStartAccessing in
        if didStartAccessing { url.stopAccessingSecurityScopedResource() }
      }
      activeAccess.removeAll()
    }
  }

  private func presentPicker(kind: PickerKind, multiple: Bool, initialUri: String?, promise: Promise) {
    guard pendingPromise == nil else {
      promise.reject(PickingInProgressException())
      return
    }
    guard let viewController = appContext?.utilities?.currentViewController() else {
      promise.reject(MissingViewControllerException())
      return
    }

    let picker: UIDocumentPickerViewController
    switch kind {
    case .files:
      picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
      picker.allowsMultipleSelection = multiple
    case .directory:
      picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      if let initialUri, let url = URL(string: initialUri) { picker.directoryURL = url }
    }
    pendingPromise = promise
    pendingKind = kind
    picker.delegate = self
    picker.presentationController?.delegate = self
    picker.modalPresentationStyle = .pageSheet
    SceneGeometry.anchorPopover(of: picker, to: viewController.view)
    viewController.present(picker, animated: true)
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let promise = pendingPromise, let kind = pendingKind else { return }
    pendingPromise = nil
    pendingKind = nil

    do {
      switch kind {
      case .files:
        promise.resolve(try urls.map(fileDetails))
      case .directory:
        guard let url = urls.first else { throw DeviceFileReferenceException("폴더를 선택하지 못했어요.") }
        promise.resolve(try directoryDetails(url))
      }
    } catch {
      promise.reject(error)
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard let promise = pendingPromise, let kind = pendingKind else { return }
    pendingPromise = nil
    pendingKind = nil
    if kind == .directory { promise.reject(FolderPickerCancelledException()) }
    else { promise.resolve([[String: Any]]()) }
  }

  private func fileDetails(_ url: URL) throws -> [String: Any] {
    let didStartAccessing = url.startAccessingSecurityScopedResource()
    defer { if didStartAccessing { url.stopAccessingSecurityScopedResource() } }
    let values = try? url.resourceValues(forKeys: [.fileSizeKey])
    let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    var details: [String: Any] = [
      "uri": url.absoluteString,
      "name": url.lastPathComponent,
      "mimeType": mimeType,
      "reference": try makeBookmark(for: url),
    ]
    if let size = values?.fileSize { details["size"] = size }
    else { details["size"] = NSNull() }
    return details
  }

  private func directoryDetails(_ url: URL) throws -> [String: Any] {
    let didStartAccessing = url.startAccessingSecurityScopedResource()
    defer { if didStartAccessing { url.stopAccessingSecurityScopedResource() } }
    return [
      "uri": url.absoluteString,
      "name": url.lastPathComponent,
      "mimeType": "",
      "reference": try makeBookmark(for: url),
    ]
  }

  private func makeBookmark(for url: URL) throws -> String {
    try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString()
  }
}

private final class PickingInProgressException: Exception {
  override var reason: String { "Another file picker is already open" }
}

private final class MissingViewControllerException: Exception {
  override var reason: String { "No view controller is available to present the file picker" }
}

private final class DeviceFileReferenceException: GenericException<String> {
  override var reason: String { param }
}
