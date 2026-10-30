package io.github.cloudcorprecords.rdrive

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Uploads one file that the Share menu copied into the app's outbox. Retries until there's a connection. */
class UploadWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val file = File(inputData.getString(KEY_FILE) ?: return Result.failure())
        val dir = inputData.getString(KEY_DIR) ?: SHARE_DIR
        val name = inputData.getString(KEY_NAME) ?: file.name
        if (!file.exists()) return Result.failure()
        val server = Prefs.serverUrl(applicationContext) ?: return Result.failure()
        return try {
            val client = DriveClient(server)
            client.ensureDir(dir)
            file.inputStream().use { client.upload(dir, name, file.length(), it) }
            file.parentFile?.deleteRecursively()
            Result.success()
        } catch (e: DriveClient.NotSignedIn) {
            Notify.post(applicationContext, Notify.ID_SIGN_IN, "Sign in to rdrive", "Open rdrive and sign in, then share the file again.")
            file.parentFile?.deleteRecursively()
            Result.failure()
        } catch (e: IOException) {
            if (runAttemptCount >= 8) {
                Notify.post(applicationContext, Notify.ID_FAILED, "Couldn't upload $name", e.message ?: "Network error")
                file.parentFile?.deleteRecursively()
                Result.failure()
            } else {
                Result.retry()
            }
        }
    }

    companion object {
        const val KEY_FILE = "file"
        const val KEY_DIR = "dir"
        const val KEY_NAME = "name"
        const val SHARE_DIR = "/Phone uploads"

        fun enqueue(ctx: Context, file: File, name: String, dir: String = SHARE_DIR) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf(KEY_FILE to file.absolutePath, KEY_NAME to name, KEY_DIR to dir))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag("upload")
                .build()
            WorkManager.getInstance(ctx).enqueue(req)
        }
    }
}
