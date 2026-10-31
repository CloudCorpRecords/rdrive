package io.github.cloudcorprecords.rdrive

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.widget.Toast
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Updates the app from GitHub Releases (scripts/release.js attaches rdrive-<version>.apk and SHA256SUMS.txt).
 * The download is checked against SHA256SUMS.txt, and Android itself refuses an update that isn't signed
 * with the same key as the installed app. Installing always shows Android's own confirmation.
 */
object Updater {
    private const val API = "https://api.github.com/repos/CloudCorpRecords/rdrive/releases/latest"

    data class Release(val version: String, val page: String, val apkName: String?, val apkUrl: String?, val sumsUrl: String?)

    fun currentVersion(ctx: Context): String =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0"

    fun isNewer(a: String, b: String): Boolean {
        val x = Regex("\\d+").findAll(a).map { it.value.toInt() }.take(3).toList()
        val y = Regex("\\d+").findAll(b).map { it.value.toInt() }.take(3).toList()
        for (i in 0 until 3) {
            val p = x.getOrElse(i) { 0 }
            val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return false
    }

    private fun get(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "rdrive-android-updater")
        c.setRequestProperty("Accept", "application/vnd.github+json")
        return c
    }

    /** Blocking: the latest published release, or null if there is none. */
    fun latest(): Release? {
        val c = get(API)
        if (c.responseCode == 404) return null
        if (c.responseCode != 200) throw IOException("GitHub said ${c.responseCode}")
        val d = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        val version = d.optString("tag_name").removePrefix("v")
        val assets = d.optJSONArray("assets")
        var apk: Pair<String, String>? = null
        var sums: String? = null
        for (i in 0 until (assets?.length() ?: 0)) {
            val a = assets!!.getJSONObject(i)
            val name = a.optString("name")
            val url = a.optString("browser_download_url")
            if (name == "rdrive-$version.apk") apk = name to url
            if (name == "SHA256SUMS.txt") sums = url
        }
        return Release(version, d.optString("html_url"), apk?.first, apk?.second, sums)
    }

    /** Blocking: downloads the release's APK into the app's cache and checks it against SHA256SUMS.txt. */
    fun download(ctx: Context, rel: Release, onProgress: (Int) -> Unit): File {
        val apkUrl = rel.apkUrl ?: throw IOException("This release has no Android app.")
        val sumsUrl = rel.sumsUrl ?: throw IOException("This release has no SHA256SUMS.txt to check the download against.")
        val dir = File(ctx.cacheDir, "updates").apply { deleteRecursively(); mkdirs() }
        val file = File(dir, rel.apkName!!)
        val c = get(apkUrl)
        if (c.responseCode != 200) throw IOException("Download failed (${c.responseCode})")
        val total = c.contentLengthLong
        val md = MessageDigest.getInstance("SHA-256")
        c.inputStream.use { input ->
            file.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var got = 0L
                var lastPct = -1
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    md.update(buf, 0, n)
                    got += n
                    val pct = if (total > 0) ((got * 100) / total).toInt() else -1
                    if (pct != lastPct) {
                        lastPct = pct
                        onProgress(pct)
                    }
                }
            }
        }
        val sums = get(sumsUrl).inputStream.bufferedReader().use { it.readText() }
        val want = sums.lines().map { it.trim().split(Regex("\\s+")) }.firstOrNull { it.size >= 2 && it.last() == rel.apkName }?.first()?.lowercase()
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (want == null || want != got) {
            file.delete()
            throw IOException("The download's checksum doesn't match the release.")
        }
        return file
    }

    /** Hands the checked APK to Android's installer; Android asks you to confirm. */
    fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("rdrive.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(ctx, InstallResultReceiver::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
        }
    }

    /** Daily background check that posts a notification when a new version is out. */
    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<UpdateCheckWorker>(1, TimeUnit.DAYS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("update-check", ExistingPeriodicWorkPolicy.KEEP, req)
    }
}

/** Receives the installer's answer: shows Android's confirmation screen, or says what went wrong. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (confirm != null) ctx.startActivity(confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // the app restarts as the new version
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                Toast.makeText(ctx, "rdrive update failed: $msg", Toast.LENGTH_LONG).show()
            }
        }
    }
}

class UpdateCheckWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        return try {
            val rel = Updater.latest() ?: return Result.success()
            val current = Updater.currentVersion(applicationContext)
            if (rel.apkUrl != null && Updater.isNewer(rel.version, current)) {
                Notify.post(applicationContext, Notify.ID_UPDATE, "rdrive ${rel.version} is available", "Open rdrive and choose Update. You have $current.")
            }
            Result.success()
        } catch (e: IOException) {
            Result.retry()
        }
    }
}
