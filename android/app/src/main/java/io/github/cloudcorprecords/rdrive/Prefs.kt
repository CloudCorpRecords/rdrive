package io.github.cloudcorprecords.rdrive

import android.content.Context
import android.net.Uri

/** Small wrapper around the app's private settings. */
object Prefs {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("rdrive", Context.MODE_PRIVATE)

    /** The drive's https origin, e.g. https://my-pc.my-tailnet.ts.net, or null before setup. */
    fun serverUrl(ctx: Context): String? = prefs(ctx).getString("serverUrl", null)

    fun setServerUrl(ctx: Context, url: String?) = prefs(ctx).edit().putString("serverUrl", url).apply()

    /** Folder chosen for auto-upload (a Storage Access Framework tree URI). */
    fun syncTree(ctx: Context): Uri? = prefs(ctx).getString("syncTree", null)?.let(Uri::parse)

    fun setSyncTree(ctx: Context, uri: Uri?) = prefs(ctx).edit().putString("syncTree", uri?.toString()).apply()

    /** Turns "https://host:port/anything" into "https://host:port"; null if it isn't a usable https address. */
    fun normalizeUrl(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = Uri.parse(s)
        if (u.scheme != "https" || u.host.isNullOrBlank()) return null
        return "https://" + u.host + (if (u.port > 0) ":${u.port}" else "")
    }
}
