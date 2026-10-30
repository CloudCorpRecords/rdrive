package io.github.cloudcorprecords.rdrive

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.widget.Toast
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Handles "Share → rdrive". Shared files are only readable briefly, so they're copied into the
 * app's private outbox first; UploadWorker then sends them to "/Phone uploads" (retrying if offline).
 */
class ShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Prefs.serverUrl(this) == null) {
            Toast.makeText(this, "Open rdrive and connect to your drive first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        val uris = sharedUris(intent)
        val text = if (uris.isEmpty()) intent.getStringExtra(Intent.EXTRA_TEXT) else null
        if (uris.isEmpty() && text.isNullOrBlank()) {
            Toast.makeText(this, "Nothing to upload.", Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        Toast.makeText(this, "Sending to rdrive…", Toast.LENGTH_SHORT).show()
        Thread {
            var queued = 0
            var failed = 0
            for (uri in uris) {
                try {
                    val name = displayName(uri)
                    val file = outboxFile(name)
                    contentResolver.openInputStream(uri)!!.use { input -> file.outputStream().use { input.copyTo(it) } }
                    UploadWorker.enqueue(this, file, name)
                    queued++
                } catch (e: Exception) {
                    failed++
                }
            }
            if (!text.isNullOrBlank()) {
                val stamp = SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.US).format(Date())
                val name = "Shared text $stamp.txt"
                val file = outboxFile(name)
                file.writeText(text)
                UploadWorker.enqueue(this, file, name)
                queued++
            }
            runOnUiThread {
                val msg = when {
                    failed > 0 -> "Uploading $queued item(s); $failed couldn't be read."
                    queued == 1 -> "Uploading to rdrive → Phone uploads"
                    else -> "Uploading $queued items to rdrive → Phone uploads"
                }
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                finish()
            }
        }.start()
    }

    private fun outboxFile(name: String): File {
        val dir = File(cacheDir, "outbox/${UUID.randomUUID()}")
        dir.mkdirs()
        return File(dir, DriveClient.safeName(name))
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_STREAM)
        )
        Intent.ACTION_SEND_MULTIPLE ->
            (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
        else -> emptyList()
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) return it.getString(0)
        }
        val ext = contentResolver.getType(uri)?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        return "shared-$stamp" + (ext?.let { ".$it" } ?: "")
    }
}
