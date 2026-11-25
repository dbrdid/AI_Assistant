package expo.modules.devicefileaccess

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.toCodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PICK_FILES_CODE = 7411
private const val PICK_DIRECTORY_CODE = 7412

private enum class PickerKind { FILES, DIRECTORY }

private class FolderPickerCancelledException :
  CodedException("SAVE_FOLDER_PICKER_CANCELLED", "Folder picker was cancelled by the user", null)

private class PersistentPermissionException(message: String) :
  CodedException("FILE_REFERENCE_PERMISSION", message, null)

class DeviceFileAccessModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: error("React context is unavailable")
  private val contentResolver
    get() = context.contentResolver

  private var pendingPromise: Promise? = null
  private var pendingKind: PickerKind? = null
  private var allowMultiple = false

  override fun definition() = ModuleDefinition {
    Name("DeviceFileAccess")

    AsyncFunction("pickFiles") { multiple: Boolean, promise: Promise ->
      startPicker(PickerKind.FILES, multiple, null, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pickDirectory") { initialUri: String?, promise: Promise ->
      startPicker(PickerKind.DIRECTORY, false, initialUri, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("resolveReference") { reference: String ->
      val uri = Uri.parse(reference)
      mapOf("uri" to uri.toString(), "token" to "", "reference" to reference)
    }

    AsyncFunction("releaseAccess") { _: String -> }

    AsyncFunction("releaseReference") { reference: String ->
      val uri = Uri.parse(reference)
      val permission = contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri }
      if (permission != null) {
        var flags = 0
        if (permission.isReadPermission) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (permission.isWritePermission) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        contentResolver.releasePersistableUriPermission(uri, flags)
      }
    }

    OnActivityResult { _, (requestCode, resultCode, intent) ->
      val promise = pendingPromise ?: return@OnActivityResult
      val kind = pendingKind
      if (requestCode != PICK_FILES_CODE && requestCode != PICK_DIRECTORY_CODE) return@OnActivityResult
      pendingPromise = null
      pendingKind = null

      if (resultCode != Activity.RESULT_OK || intent == null) {
        if (kind == PickerKind.DIRECTORY) promise.reject(FolderPickerCancelledException())
        else promise.resolve(emptyList<Map<String, Any?>>())
        return@OnActivityResult
      }

      val uris = if (intent.clipData != null) {
        (0 until intent.clipData!!.itemCount).mapNotNull { intent.clipData!!.getItemAt(it)?.uri }
      } else {
        listOfNotNull(intent.data)
      }
      if (uris.isEmpty()) {
        promise.reject(PersistentPermissionException("선택한 위치에서 파일 경로를 가져오지 못했어요."))
        return@OnActivityResult
      }

      val chosenUris = if (kind == PickerKind.DIRECTORY || !allowMultiple) listOf(uris.first()) else uris
      val grantFlags = intent.flags and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      val granted = mutableListOf<Uri>()
      try {
        chosenUris.forEach { uri ->
        takePersistablePermission(uri, grantFlags, kind == PickerKind.DIRECTORY)
          granted.add(uri)
        }
        if (kind == PickerKind.DIRECTORY) {
        val uri = chosenUris.first()
          promise.resolve(mapOf("uri" to uri.toString(), "name" to "", "mimeType" to "", "reference" to uri.toString()))
        } else {
        promise.resolve(chosenUris.map(::fileDetails))
        }
      } catch (error: Exception) {
        granted.forEach(::releasePersistablePermission)
        promise.reject(error.toCodedException())
      }
    }
  }

  private fun startPicker(kind: PickerKind, multiple: Boolean, initialUri: String?, promise: Promise) {
    if (pendingPromise != null) {
      promise.reject(PersistentPermissionException("다른 파일 선택이 진행 중이에요."))
      return
    }
    pendingPromise = promise
    pendingKind = kind
    allowMultiple = multiple
    val requestCode = if (kind == PickerKind.DIRECTORY) PICK_DIRECTORY_CODE else PICK_FILES_CODE
    val intent = if (kind == PickerKind.DIRECTORY) {
      Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
    } else {
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      }
    }
    if (initialUri != null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initialUri))
    }
    try {
      appContext.throwingActivity.startActivityForResult(intent, requestCode)
    } catch (error: Exception) {
      pendingPromise = null
      pendingKind = null
      throw error
    }
  }

  private fun takePersistablePermission(uri: Uri, flags: Int, requireWrite: Boolean) {
    val readWriteFlags = flags and
      (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    if (readWriteFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) {
      throw PersistentPermissionException("기기 파일을 읽을 권한을 받지 못했어요.")
    }
    if (requireWrite && readWriteFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION == 0) {
      throw PersistentPermissionException("선택한 폴더에 파일을 저장할 권한을 받지 못했어요.")
    }
    try {
      contentResolver.takePersistableUriPermission(uri, readWriteFlags)
    } catch (error: SecurityException) {
      throw PersistentPermissionException("파일 공급자가 앱의 지속 접근을 허용하지 않았어요. 다른 위치에서 파일을 선택해 주세요.")
    }
  }

  private fun releasePersistablePermission(uri: Uri) {
    val permission = contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri } ?: return
    var flags = 0
    if (permission.isReadPermission) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
    if (permission.isWritePermission) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    if (flags != 0) contentResolver.releasePersistableUriPermission(uri, flags)
  }

  private fun fileDetails(uri: Uri): Map<String, Any?> {
    var name = uri.lastPathSegment ?: "파일"
    var size: Long? = null
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
      }
    }
    return mapOf(
      "uri" to uri.toString(),
      "name" to name,
      "mimeType" to contentResolver.getType(uri),
      "size" to size,
      "reference" to uri.toString(),
    )
  }
}
