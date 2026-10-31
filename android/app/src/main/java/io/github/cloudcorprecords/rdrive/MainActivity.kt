package io.github.cloudcorprecords.rdrive

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.File

/** The drive itself (the same web app as on a computer) in a locked-down WebView, plus the app menu. */
class MainActivity : Activity() {

    private var web: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraOutput: Uri? = null

    private var pendingPairUrl: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cleanOldOutbox()
        Updater.schedule(this)
        maybeCheckForUpdates()
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
        }
        if (Prefs.serverUrl(this) == null) showSetup() else showDrive(savedInstanceState)
        handlePairIntent(intent)
        handleShortcutIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handlePairIntent(intent)
        handleShortcutIntent(intent)
    }

    private fun handleShortcutIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "rdrive" || data.host != "shortcut") return
        val action = data.getQueryParameter("action") ?: return
        intent.data = null
        val targetHash = when (action) {
            "scan" -> "#scan"
            "photos" -> "#photos"
            "starred" -> "#starred"
            "xod" -> "#xod"
            else -> "#/"
        }
        val server = Prefs.serverUrl(this) ?: return
        if (web != null) {
            web?.loadUrl("$server/$targetHash")
        } else {
            pendingPairUrl = "$server/$targetHash"
        }
    }

    // rdrive://pair?url=<drive>&token=<one-time token>, from a "Connect a device" link. Any app or web
    // page can open such a link, so switching to a different drive is always confirmed first.
    private fun handlePairIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "rdrive" || data.host != "pair") return
        val server = data.getQueryParameter("url")?.let(Prefs::normalizeUrl) ?: return
        val token = data.getQueryParameter("token")?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) } ?: return
        intent.data = null // don't act on it again after rotation
        val current = Prefs.serverUrl(this)
        if (current == null || current == server) {
            openPairLink(server, token)
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Switch drives?")
            .setMessage("This link signs you in to a different drive:\n\n${Uri.parse(server).host}\n\nOnly continue if you made this link yourself.")
            .setPositiveButton("Switch") { _, _ -> openPairLink(server, token) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openPairLink(server: String, token: String) {
        Prefs.setServerUrl(this, server)
        val target = "$server/pair#$token"
        if (web != null && Uri.parse(web?.url ?: "").host == Uri.parse(server).host) {
            web?.loadUrl(target)
        } else {
            pendingPairUrl = target
            showDrive(null)
        }
    }

    // ---------- setup screen ----------

    private fun showSetup() {
        web?.destroy()
        web = null
        val pad = (20 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val title = TextView(this).apply {
            text = getString(R.string.setup_title)
            textSize = 22f
        }
        val help = TextView(this).apply {
            text = getString(R.string.setup_help)
            setPadding(0, pad / 2, 0, pad)
        }
        val input = EditText(this).apply {
            hint = getString(R.string.setup_hint)
            isSingleLine = true
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.serverUrl(this@MainActivity) ?: "")
        }
        val save = Button(this).apply {
            text = getString(R.string.setup_save)
            setOnClickListener {
                val raw = input.text.toString().trim()
                // A pasted "Connect a device" link (https://drive/pair#token) sets the address and signs in.
                val pairToken = Regex("/pair#([0-9a-f]{64})$").find(raw)?.groupValues?.get(1)
                val pairServer = pairToken?.let { Prefs.normalizeUrl(raw) }
                if (pairToken != null && pairServer != null) {
                    openPairLink(pairServer, pairToken)
                    return@setOnClickListener
                }
                val url = Prefs.normalizeUrl(raw)
                if (url == null) {
                    input.error = "Enter an https:// address"
                } else {
                    Prefs.setServerUrl(this@MainActivity, url)
                    showDrive(null)
                }
            }
        }
        layout.addView(title)
        layout.addView(help)
        layout.addView(input)
        layout.addView(save)
        val container = android.widget.FrameLayout(this).apply { addView(layout) }
        setContentView(container)
        applyInsets(container)
    }

    // ---------- the drive ----------

    private fun showDrive(state: Bundle?) {
        val url = Prefs.serverUrl(this) ?: return showSetup()
        val host = Uri.parse(url).host
        val w = WebView(this)
        web = w
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(w, false)
        }
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                val inApp = u.scheme == "https" && (u.host == host || (u.host == "github.com" && isGithubSignIn(u)))
                if (inApp) return false
                // Anything else (help links, etc.) opens in the phone's browser.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, u))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }
            // Certificate errors are never overridden: an invalid certificate means "don't connect".
        }
        WebView.setWebContentsDebuggingEnabled(true)
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i("RDriveWeb", "${cm.sourceId()}:${cm.lineNumber()} [${cm.messageLevel()}] ${cm.message()}")
                return true
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                // "Take a photo": open the camera; the picture is saved to Pictures/rdrive and uploaded.
                if (params.isCaptureEnabled && Build.VERSION.SDK_INT >= 29) {
                    val values = android.content.ContentValues().apply {
                        put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "rdrive-${System.currentTimeMillis()}.jpg")
                        put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                        put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/rdrive")
                    }
                    val out = contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    if (out != null) {
                        cameraOutput = out
                        val shoot = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT, out)
                        try {
                            startActivityForResult(shoot, REQ_CAMERA)
                            return true
                        } catch (_: ActivityNotFoundException) {
                            contentResolver.delete(out, null, null)
                            cameraOutput = null
                        }
                    }
                }
                val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    startActivityForResult(Intent.createChooser(pick, "Upload to rdrive"), REQ_FILES)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }
        w.setDownloadListener { dlUrl, _, contentDisposition, mimeType, _ ->
            if (!dlUrl.startsWith("https://") && !dlUrl.startsWith("http://")) {
                Toast.makeText(this, "Saved to your drive.", Toast.LENGTH_SHORT).show()
                return@setDownloadListener
            }
            val name = URLUtil.guessFileName(dlUrl, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(dlUrl))
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(dlUrl) ?: "")
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
        }
        w.addJavascriptInterface(PhoneBridge(host), "RDriveApp")
        w.setBackgroundColor(getColor(R.color.page_bg)) // no white flash before the page paints
        // Status-bar spacing and system navigation bar spacing go on the container around the WebView,
        // so the drive UI, bottom nav, and keyboard never get covered by system bars.
        val frame = android.widget.FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            addView(w, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        setContentView(frame)
        applyInsets(frame, padBottom = true)
        val startUrl = pendingPairUrl ?: url
        val hadPending = pendingPairUrl != null
        pendingPairUrl = null
        if (hadPending || state == null || w.restoreState(state) == null) w.loadUrl(startUrl)
    }

    private fun isGithubSignIn(u: Uri): Boolean {
        val p = u.path ?: return false
        return p.startsWith("/login") || p.startsWith("/session")
    }

    // There's no title bar: the page draws its own header. Keep it clear of the status and navigation
    // bars (Android 15+ draws edge to edge), and match the bar icons to light or dark mode.
    private fun applyInsets(v: View, padBottom: Boolean = true) {
        window.decorView.setBackgroundColor(getColor(R.color.page_bg))
        if (Build.VERSION.SDK_INT >= 30) {
            val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
            val light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (night) 0 else light, light)
        }
        if (Build.VERSION.SDK_INT < 30) return
        v.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
            // Without bottom padding the keyboard still needs room, or it would cover what you type.
            val ime = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom
            val bottomPad = if (padBottom) maxOf(bars.bottom, ime) else ime
            view.setPadding(bars.left, bars.top, bars.right, bottomPad)
            insets
        }
        (v.parent as? ViewGroup)?.requestApplyInsets()
    }

    private fun goBack() {
        val w = web ?: return finish()
        // If an in-app dialog/sheet is open, Back dismisses it first.
        w.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return 'closed';}return '';})()") { res ->
            if (res != null && res.contains("closed")) return@evaluateJavascript
            if (w.canGoBack()) w.goBack() else finish()
        }
    }

    @Deprecated("Used below Android 13; newer versions use OnBackInvokedCallback.")
    override fun onBackPressed() = goBack()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web?.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        // Back from "Install unknown apps" (Android may have restarted the app meanwhile):
        // carry on with the update the user asked for.
        if (Updater.pending(this) != null && packageManager.canRequestPackageInstalls() && !updating) {
            Updater.clearPending(this)
            updating = true
            Thread {
                val rel = runCatching { Updater.latest() }.getOrNull()
                runOnUiThread {
                    updating = false
                    if (rel != null && rel.apkUrl != null && Updater.isNewer(rel.version, Updater.currentVersion(this))) downloadAndInstall(rel)
                }
            }.start()
        }
    }

    // ---------- updates ----------

    private var updating = false

    /** Checks quietly at most twice a day; only speaks up when there's something newer. */
    private fun maybeCheckForUpdates() {
        val prefs = getSharedPreferences("rdrive", MODE_PRIVATE)
        if (System.currentTimeMillis() - prefs.getLong("lastUpdateCheck", 0) < 12 * 3600 * 1000L) return
        prefs.edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply()
        checkForUpdates(manual = false)
    }

    private fun checkForUpdates(manual: Boolean) {
        if (manual) Toast.makeText(this, "Checking for updates…", Toast.LENGTH_SHORT).show()
        Thread {
            val result = runCatching { Updater.latest() }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                val current = Updater.currentVersion(this)
                val rel = result.getOrNull()
                when {
                    result.isFailure -> if (manual) Toast.makeText(this, "Couldn't check for updates: ${result.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                    rel == null || rel.apkUrl == null || !Updater.isNewer(rel.version, current) ->
                        if (manual) AlertDialog.Builder(this).setTitle("rdrive is up to date").setMessage("You have the newest version, $current.").setPositiveButton("OK", null).show()
                    else -> AlertDialog.Builder(this)
                        .setTitle("rdrive ${rel.version} is available")
                        .setMessage("You have $current. Update downloads it, checks it, and asks Android to install it. Your settings and sign-in stay as they are.")
                        .setPositiveButton("Update") { _, _ -> startUpdate(rel) }
                        .setNegativeButton("Later", null)
                        .show()
                }
            }
        }.start()
    }

    private fun startUpdate(rel: Updater.Release) {
        if (!packageManager.canRequestPackageInstalls()) {
            // Android asks once whether rdrive may install updates; the user flips the switch themselves.
            AlertDialog.Builder(this)
                .setTitle("Allow rdrive to install updates")
                .setMessage("Android needs your OK once: on the next screen, turn on \"Allow from this source\", then come back. Android still asks you to confirm each update.")
                .setPositiveButton("Open settings") { _, _ ->
                    Updater.setPending(this, rel.version)
                    startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                }
                .setNegativeButton("Cancel", null)
                .show()
            return
        }
        downloadAndInstall(rel)
    }

    private fun downloadAndInstall(rel: Updater.Release) {
        val progress = AlertDialog.Builder(this)
            .setTitle("Updating rdrive")
            .setMessage("Downloading ${rel.version}…")
            .setCancelable(false)
            .show()
        Thread {
            val result = runCatching {
                val apk = Updater.download(this, rel) { text ->
                    runOnUiThread { progress.setMessage("Downloading ${rel.version}… $text") }
                }
                runOnUiThread { progress.setMessage("Checked. Handing it to Android to install…") }
                Updater.install(this, apk)
            }
            runOnUiThread {
                progress.dismiss()
                result.exceptionOrNull()?.let {
                    if (!isFinishing) AlertDialog.Builder(this)
                        .setTitle("The rdrive update didn't download")
                        .setMessage(it.message ?: "Something went wrong.")
                        .setPositiveButton("Try again") { _, _ -> downloadAndInstall(rel) }
                        .setNegativeButton("Later", null)
                        .show()
                }
            }
        }.start()
    }

    override fun onPause() {
        super.onPause()
        // Make sure the sign-in cookie is on disk for the background uploaders.
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }

    // ---------- the page's "You → This phone" section ----------

    /**
     * Exposed to the drive's page as window.RDriveApp. The WebView can also show GitHub's sign-in pages,
     * so every call first checks that the page asking is your drive.
     */
    inner class PhoneBridge(private val driveHost: String?) {
        private fun fromDrive(action: () -> Unit) {
            runOnUiThread {
                val current = web?.url?.let { Uri.parse(it) }
                if (current?.scheme == "https" && current.host == driveHost) action()
            }
        }

        @JavascriptInterface
        fun status(): String {
            val tree = Prefs.syncTree(this@MainActivity)
            val folder = tree?.let { DocumentsContract.getTreeDocumentId(it).substringAfter(':').substringAfterLast('/').ifBlank { "Phone storage" } }
            val device = FolderSyncWorker.getDeviceName()
            val backupPath = "/Backups/$device"
            return JSONObject()
                .put("syncFolder", folder ?: JSONObject.NULL)
                .put("deviceName", device)
                .put("backupPath", backupPath)
                .put("version", Updater.currentVersion(this@MainActivity))
                .toString()
        }

        @JavascriptInterface
        fun openBackups() = fromDrive {
            val device = FolderSyncWorker.getDeviceName()
            val path = "/Backups/$device"
            val quoted = JSONObject.quote(path)
            web?.evaluateJavascript("(function(){ if(window.navigate) navigate($quoted); var d = document.getElementById('account-dialog'); if(d) d.close(); })()", null)
        }

        @JavascriptInterface
        fun autoUpload() = fromDrive {
            askNotificationPermission()
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE)
        }

        @JavascriptInterface
        fun uploadNow() = fromDrive {
            FolderSyncWorker.runNow(this@MainActivity)
            Toast.makeText(this@MainActivity, "Checking for new files…", Toast.LENGTH_SHORT).show()
        }

        @JavascriptInterface
        fun stopAutoUpload() = fromDrive { this@MainActivity.stopAutoUpload() }

        @JavascriptInterface
        fun checkForUpdates() = fromDrive { this@MainActivity.checkForUpdates(manual = true) }

        @JavascriptInterface
        fun changeAddress() = fromDrive { showSetup() }

        @JavascriptInterface
        fun vibrate(durationMs: Long) = fromDrive {
            val ms = durationMs.coerceIn(5, 500)
            if (Build.VERSION.SDK_INT >= 26) {
                val vib = getSystemService(android.os.Vibrator::class.java)
                vib?.vibrate(android.os.VibrationEffect.createOneShot(ms, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val vib = getSystemService(android.os.Vibrator::class.java)
                vib?.vibrate(ms)
            }
        }
    }

    private fun stopAutoUpload() {
        FolderSyncWorker.cancel(this)
        Prefs.syncTree(this)?.let { uri ->
            runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        Prefs.setSyncTree(this, null)
        Toast.makeText(this, "Auto-upload stopped.", Toast.LENGTH_SHORT).show()
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    @Deprecated("Plain Activity result API; fine for this small app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_CAMERA -> {
                val cb = fileCallback ?: return
                fileCallback = null
                val out = cameraOutput
                cameraOutput = null
                if (resultCode == RESULT_OK && out != null) {
                    cb.onReceiveValue(arrayOf(out))
                } else {
                    out?.let { runCatching { contentResolver.delete(it, null, null) } } // cancelled: drop the empty entry
                    cb.onReceiveValue(null)
                }
            }
            REQ_FILES -> {
                val cb = fileCallback ?: return
                fileCallback = null
                if (resultCode != RESULT_OK || data == null) return cb.onReceiveValue(null)
                val clip = data.clipData
                val uris = if (clip != null) Array(clip.itemCount) { clip.getItemAt(it).uri } else listOfNotNull(data.data).toTypedArray()
                cb.onReceiveValue(uris)
            }
            REQ_TREE -> {
                val uri = data?.data ?: return
                if (resultCode != RESULT_OK) return
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                Prefs.setSyncTree(this, uri)
                val device = FolderSyncWorker.getDeviceName()
                val rootId = DocumentsContract.getTreeDocumentId(uri)
                val folder = rootId.substringAfter(':').substringAfterLast('/').ifBlank { "Folder" }
                val msg = "Files in \"$folder\" will be backed up to:\n\n/Backups/$device/$folder/\n\nPhotos are organized by month (e.g. 2026-10). Backups run every 15 minutes when online.\n\nAlso back up existing files?"
                AlertDialog.Builder(this)
                    .setTitle("Cloud backup for $device")
                    .setMessage(msg)
                    .setPositiveButton("Back up existing too") { _, _ -> FolderSyncWorker.start(this, uploadExisting = true) }
                    .setNegativeButton("Only new files") { _, _ -> FolderSyncWorker.start(this, uploadExisting = false) }
                    .setCancelable(false)
                    .show()
            }
        }
    }

    // Shared files that never got uploaded (e.g. signed out) shouldn't pile up forever.
    private fun cleanOldOutbox() {
        val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        File(cacheDir, "outbox").listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
    }

    companion object {
        private const val REQ_FILES = 1
        private const val REQ_TREE = 2
        private const val REQ_NOTIFY = 3
        private const val REQ_CAMERA = 4
    }
}
