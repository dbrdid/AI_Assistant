package expo.modules.stellamodeldevice

import android.app.ActivityManager
import android.app.DownloadManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

class StellaModelDeviceModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private val directory get() = File(context.filesDir, "qwen35")
  // 시스템 다운로드 관리자로 받으면 앱을 나가거나 종료해도 계속 받고, 알림에 진행률이 보인다.
  // 다운로드 관리자는 앱 내부 저장소에 쓸 수 없어 앱 전용 외부 폴더에 받은 뒤 내부 폴더로 옮긴다.
  private val downloads get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
  private val prefs get() = context.getSharedPreferences("stella-model-download", Context.MODE_PRIVATE)
  private val downloadFile get() = File(requireNotNull(context.getExternalFilesDir("models")), "install.download")
  private fun downloadId() = prefs.getLong("id", -1L)
  private fun status(): Map<String, Any?> {
    val id = downloadId()
    if (id < 0) return mapOf("state" to "none")
    downloads.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
      if (!cursor.moveToFirst()) { prefs.edit().remove("id").remove("url").apply(); return mapOf("state" to "none") }
      val state = when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
        DownloadManager.STATUS_SUCCESSFUL -> "done"
        DownloadManager.STATUS_FAILED -> "failed"
        DownloadManager.STATUS_PAUSED -> "paused"
        else -> "running"
      }
      return mapOf(
        "state" to state,
        "url" to prefs.getString("url", null),
        "bytes" to cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble(),
        "total" to cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble(),
        "reason" to cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
      )
    }
  }
  private val pressure = object : ComponentCallbacks2 {
    override fun onConfigurationChanged(config: Configuration) {}
    override fun onLowMemory() = sendEvent("memoryWarning")
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) sendEvent("memoryWarning")
    }
  }
  override fun definition() = ModuleDefinition {
    Name("StellaModelDevice")
    Events("memoryWarning")
    OnStartObserving { context.registerComponentCallbacks(pressure) }
    OnStopObserving { context.unregisterComponentCallbacks(pressure) }
    Function("directoryUri") { Uri.fromFile(directory).toString() }
    Function("memory") {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val info = ActivityManager.MemoryInfo().also(manager::getMemoryInfo)
      mapOf(
        "total" to info.totalMem.toDouble(),
        "rawAvailable" to info.availMem.toDouble(),
        "available" to (info.availMem - info.threshold).coerceAtLeast(0L).toDouble(),
        "lowMemory" to info.lowMemory
      )
    }
    // null below API 29, where the platform has no thermal status.
    Function("thermalRestricted") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) null
      else (context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE
    }
    Function("downloadStatus") { status() }
    // 이미 받는 중이면 같은 다운로드를 그대로 이어서 보여 준다.
    Function("startDownload") { url: String, title: String ->
      val current = status()
      if (current["state"] == "running" || current["state"] == "paused" || current["state"] == "done") {
        if (current["url"] == url) return@Function current
        downloads.remove(downloadId())
      } else if (downloadId() >= 0) downloads.remove(downloadId())
      if (downloadFile.exists()) downloadFile.delete()
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setDescription("Stella 기기 AI 모델")
        .setDestinationInExternalFilesDir(context, "models", "install.download")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(false)
      prefs.edit().putLong("id", downloads.enqueue(request)).putString("url", url).apply()
      status()
    }
    Function("cancelDownload") {
      if (downloadId() >= 0) downloads.remove(downloadId())
      prefs.edit().remove("id").remove("url").apply()
      if (downloadFile.exists()) downloadFile.delete()
      null
    }
    // 완료된 파일을 내부 폴더의 검사용 임시 파일(install.partial)로 옮긴다.
    AsyncFunction("takeDownload") {
      if (status()["state"] != "done") throw IllegalStateException("download not finished")
      directory.mkdirs()
      val staging = File(directory, "install.partial")
      if (staging.exists()) staging.delete()
      if (!downloadFile.renameTo(staging)) {
        downloadFile.inputStream().use { input -> staging.outputStream().use { input.copyTo(it, 1024 * 1024) } }
        downloadFile.delete()
      }
      prefs.edit().remove("id").remove("url").apply()
      null
    }
    AsyncFunction("digestStagingFile") {
      val hash = MessageDigest.getInstance("SHA-256")
      File(directory, "install.partial").inputStream().use { stream ->
        val buffer = ByteArray(1024 * 1024)
        while (true) {
          val count = stream.read(buffer)
          if (count < 0) break
          hash.update(buffer, 0, count)
        }
      }
      hash.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
