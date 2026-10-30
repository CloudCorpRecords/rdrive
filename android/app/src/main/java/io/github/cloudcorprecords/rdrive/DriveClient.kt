package io.github.cloudcorprecords.rdrive

import android.webkit.CookieManager
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Talks to the rdrive server's API using the sign-in cookie from the app's WebView,
 * so you only ever sign in once (in the app).
 */
class DriveClient(
    private val baseUrl: String,
    private val cookie: () -> String? = { CookieManager.getInstance().getCookie(baseUrl) },
) {

    class NotSignedIn : IOException("Not signed in to rdrive")

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun open(path: String, method: String): HttpURLConnection {
        // Loopback http is only for tests on a computer; the app's network config blocks plain http anyway.
        require(baseUrl.startsWith("https://") || baseUrl.startsWith("http://127.0.0.1:")) { "rdrive address must use https" }
        val c = URL(baseUrl + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        c.instanceFollowRedirects = false
        // The server requires this header on every change (CSRF protection).
        c.setRequestProperty("X-Rdrive", "1")
        cookie()?.let { c.setRequestProperty("Cookie", it) }
        return c
    }

    private fun check(c: HttpURLConnection, vararg ok: Int): String {
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (code == 401) throw NotSignedIn()
        if (code !in ok) {
            val msg = runCatching { JSONObject(body).optString("error") }.getOrNull()
            throw IOException("rdrive replied $code${if (!msg.isNullOrBlank()) ": $msg" else ""}")
        }
        return body
    }

    private fun mkdir(parent: String, name: String) {
        val c = open("/api/mkdir", "POST")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(JSONObject().put("path", parent).put("name", name).toString().toByteArray()) }
        check(c, 200, 409) // 409 = already exists, which is fine
    }

    /** Creates every folder along "/a/b/c" that doesn't exist yet. */
    fun ensureDir(path: String) {
        var current = "/"
        for (segment in path.split('/').filter { it.isNotEmpty() }) {
            mkdir(current, segment)
            current = if (current == "/") "/$segment" else "$current/$segment"
        }
    }

    /** Streams a file into folder [dir]. Returns the name it was saved as (the server renames duplicates). */
    fun upload(dir: String, name: String, length: Long, input: InputStream): String {
        val c = open("/api/upload?path=${enc(dir)}&name=${enc(safeName(name))}", "PUT")
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/octet-stream")
        if (length >= 0) c.setFixedLengthStreamingMode(length) else c.setChunkedStreamingMode(64 * 1024)
        c.outputStream.use { out -> input.copyTo(out, 64 * 1024) }
        val body = check(c, 200)
        return runCatching { JSONObject(body).getString("name") }.getOrDefault(name)
    }

    companion object {
        private val BAD = Regex("[<>:\"/\\\\|?*\\u0000-\\u001f]")
        private val RESERVED = Regex("^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$", RegexOption.IGNORE_CASE)

        /** Makes a phone file name acceptable to the server (which also has to work on Windows). */
        fun safeName(name: String): String {
            var n = name.replace(BAD, "_").trimEnd('.', ' ').take(200)
            if (n.isEmpty() || n == "." || n == "..") n = "file"
            if (RESERVED.matches(n)) n = "_$n"
            return n
        }
    }
}
