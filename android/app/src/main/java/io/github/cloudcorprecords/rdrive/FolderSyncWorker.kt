package io.github.cloudcorprecords.rdrive

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Auto-upload: every ~15 minutes, uploads files in the chosen phone folder that haven't been
 * uploaded yet, into "/Phone/<folder name>/..." on the drive. It only adds files; it never
 * deletes anything on the phone or the drive.
 */
class FolderSyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    private val seenFile = File(applicationContext.filesDir, "uploaded.txt")
    private val seen = HashSet<String>()
    private var uploaded = 0

    override fun doWork(): Result {
        val tree = Prefs.syncTree(applicationContext) ?: return Result.success()
        val server = Prefs.serverUrl(applicationContext) ?: return Result.success()
        // "Baseline" marks everything already in the folder as done, so only new files upload.
        val baselineOnly = inputData.getBoolean(KEY_BASELINE, false)
        if (seenFile.exists()) seen.addAll(seenFile.readLines())

        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = queryName(tree, rootId) ?: "Phone folder"
        val client = DriveClient(server)
        val madeDirs = HashSet<String>()
        return try {
            walk(tree, rootId, "/Phone/${DriveClient.safeName(rootName)}", 0) { docId, name, size, modified, remoteDir ->
                val key = "$docId|$size|$modified"
                if (key in seen) return@walk
                if (!baselineOnly) {
                    if (madeDirs.add(remoteDir)) client.ensureDir(remoteDir)
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
                    applicationContext.contentResolver.openInputStream(uri)?.use { client.upload(remoteDir, name, size, it) }
                    uploaded++
                }
                seen.add(key)
                if (seen.size % 20 == 0) save()
            }
            save()
            if (uploaded > 0) {
                Notify.post(applicationContext, Notify.ID_FOLDER, "rdrive", "Uploaded $uploaded new file${if (uploaded == 1) "" else "s"} from $rootName")
            }
            Result.success()
        } catch (e: DriveClient.NotSignedIn) {
            save()
            Notify.post(applicationContext, Notify.ID_SIGN_IN, "Sign in to rdrive", "Auto-upload is paused until you sign in again in the rdrive app.")
            Result.success() // try again on the next scheduled run
        } catch (e: IOException) {
            save()
            Result.retry()
        } catch (e: SecurityException) {
            // The folder permission was revoked (e.g. the folder was deleted). Stop auto-upload.
            Prefs.setSyncTree(applicationContext, null)
            cancel(applicationContext)
            Result.failure()
        }
    }

    private fun save() {
        seenFile.writeText(seen.joinToString("\n"))
    }

    private fun queryName(tree: Uri, docId: String): String? =
        applicationContext.contentResolver.query(
            DocumentsContract.buildDocumentUriUsingTree(tree, docId), arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null
        )?.use { if (it.moveToFirst()) it.getString(0) else null }

    private fun walk(
        tree: Uri, parentId: String, remoteDir: String, depth: Int,
        onFile: (docId: String, name: String, size: Long, modified: Long, remoteDir: String) -> Unit
    ) {
        if (isStopped || depth > MAX_DEPTH) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
        val dirs = ArrayList<Pair<String, String>>()
        applicationContext.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext() && !isStopped) {
                val id = c.getString(0)
                val name = c.getString(1) ?: continue
                if (name.startsWith(".")) continue // hidden and temporary files
                if (c.getString(2) == Document.MIME_TYPE_DIR) {
                    dirs.add(id to name)
                } else {
                    onFile(id, name, if (c.isNull(3)) -1 else c.getLong(3), c.getLong(4), remoteDir)
                }
            }
        }
        for ((id, name) in dirs) walk(tree, id, "$remoteDir/${DriveClient.safeName(name)}", depth + 1, onFile)
    }

    companion object {
        private const val KEY_BASELINE = "baseline"
        private const val MAX_DEPTH = 6
        private const val PERIODIC = "folder-sync"
        private const val NOW = "folder-sync-now"

        private fun constraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

        /** Starts auto-upload. With [uploadExisting] false, files already in the folder are skipped. */
        fun start(ctx: Context, uploadExisting: Boolean) {
            File(ctx.filesDir, "uploaded.txt").delete()
            val wm = WorkManager.getInstance(ctx)
            wm.enqueueUniqueWork(
                NOW, ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<FolderSyncWorker>()
                    .setInputData(workDataOf(KEY_BASELINE to !uploadExisting))
                    .setConstraints(constraints())
                    .build()
            )
            wm.enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<FolderSyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints()).build()
            )
        }

        fun runNow(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                NOW, ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<FolderSyncWorker>().setConstraints(constraints()).build()
            )
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
            WorkManager.getInstance(ctx).cancelUniqueWork(NOW)
        }
    }
}
