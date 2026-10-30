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
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
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
import java.io.File

/** The drive itself (the same web app as on a computer) in a locked-down WebView, plus the app menu. */
class MainActivity : Activity() {

    private var web: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cleanOldOutbox()
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
        }
        if (Prefs.serverUrl(this) == null) showSetup() else showDrive(savedInstanceState)
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
                val url = Prefs.normalizeUrl(input.text.toString())
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
        invalidateOptionsMenu()
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
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
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
        setContentView(w)
        applyInsets(w)
        if (state == null || w.restoreState(state) == null) w.loadUrl(url)
        invalidateOptionsMenu()
    }

    private fun isGithubSignIn(u: Uri): Boolean {
        val p = u.path ?: return false
        return p.startsWith("/login") || p.startsWith("/session")
    }

    // Keep content clear of the status bar, app bar and navigation bar (Android 15+ draws edge to edge,
    // so the app bar overlaps the content unless we leave room for it).
    private fun applyInsets(v: View) {
        if (Build.VERSION.SDK_INT < 35) return
        val tv = android.util.TypedValue()
        val appBar = if (theme.resolveAttribute(android.R.attr.actionBarSize, tv, true)) {
            android.util.TypedValue.complexToDimensionPixelSize(tv.data, resources.displayMetrics)
        } else 0
        v.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top + appBar, bars.right, bars.bottom)
            insets
        }
        (v.parent as? ViewGroup)?.requestApplyInsets()
    }

    private fun goBack() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else finish()
    }

    @Deprecated("Used below Android 13; newer versions use OnBackInvokedCallback.")
    override fun onBackPressed() = goBack()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web?.saveState(outState)
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

    // ---------- menu ----------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        if (web == null) return false
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        val syncing = Prefs.syncTree(this) != null
        menu.findItem(R.id.upload_now)?.isVisible = syncing
        menu.findItem(R.id.stop_folder)?.isVisible = syncing
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.new_spreadsheet -> {
                web?.evaluateJavascript("window.rdriveCreateSpreadsheet && window.rdriveCreateSpreadsheet()", null)
            }
            R.id.upload_folder -> {
                askNotificationPermission()
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE)
            }
            R.id.upload_now -> {
                FolderSyncWorker.runNow(this)
                Toast.makeText(this, "Checking for new files…", Toast.LENGTH_SHORT).show()
            }
            R.id.stop_folder -> stopAutoUpload()
            R.id.reload -> web?.reload()
            R.id.change_address -> showSetup()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun stopAutoUpload() {
        FolderSyncWorker.cancel(this)
        Prefs.syncTree(this)?.let { uri ->
            runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        Prefs.setSyncTree(this, null)
        invalidateOptionsMenu()
        Toast.makeText(this, "Auto-upload stopped.", Toast.LENGTH_SHORT).show()
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    @Deprecated("Plain Activity result API; fine for this small app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
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
                invalidateOptionsMenu()
                AlertDialog.Builder(this)
                    .setTitle("Auto-upload this folder")
                    .setMessage("New files in this folder will be uploaded to rdrive → Phone, about every 15 minutes when you're online.\n\nAlso upload the files that are already in it?")
                    .setPositiveButton("Upload existing too") { _, _ -> FolderSyncWorker.start(this, uploadExisting = true) }
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
    }
}
