package io.github.cloudcorprecords.rdrive

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Exercises the phone's upload code against a real rdrive server.
 * Start a throwaway server with a user "phonetest" / "phonetest-password", then:
 *   RDRIVE_TEST_URL=http://127.0.0.1:8561 ./gradlew testDebugUnitTest
 * Without RDRIVE_TEST_URL the server tests are skipped (only the name tests run).
 */
class DriveClientTest {
    private val base = System.getenv("RDRIVE_TEST_URL")

    private fun login(): String {
        val c = URL("$base/api/login").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("X-Rdrive", "1")
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write("""{"username":"phonetest","password":"phonetest-password"}""".toByteArray()) }
        assertEquals(200, c.responseCode)
        return c.headerFields["Set-Cookie"]!!.first().substringBefore(';')
    }

    private fun list(cookie: String, dir: String): List<String> {
        val c = URL("$base/api/list?path=${URLEncoder.encode(dir, "UTF-8")}").openConnection() as HttpURLConnection
        c.setRequestProperty("Cookie", cookie)
        val entries = JSONObject(c.inputStream.bufferedReader().readText()).getJSONArray("entries")
        return (0 until entries.length()).map { entries.getJSONObject(it).getString("name") }
    }

    @Test
    fun safeNameMakesPhoneNamesServerSafe() {
        assertEquals("Screenshot 10_30_12.png", DriveClient.safeName("Screenshot 10:30:12.png"))
        assertEquals("a_b", DriveClient.safeName("a/b"))
        assertEquals("file", DriveClient.safeName("..."))
        assertEquals("_CON.txt", DriveClient.safeName("CON.txt"))
        assertEquals("trailing", DriveClient.safeName("trailing. "))
    }

    @Test
    fun uploadsIntoNestedFoldersAndKeepsDuplicates() {
        assumeTrue("set RDRIVE_TEST_URL to run against a server", base != null)
        val cookie = login()
        val client = DriveClient(base!!) { cookie }
        client.ensureDir("/Phone uploads/Camera")
        client.ensureDir("/Phone uploads/Camera") // second time is a no-op, not an error
        val bytes = "hello from the phone".toByteArray()
        val first = client.upload("/Phone uploads/Camera", "IMG 1:2.jpg", bytes.size.toLong(), bytes.inputStream())
        val second = client.upload("/Phone uploads/Camera", "IMG 1:2.jpg", -1, bytes.inputStream()) // chunked
        assertEquals("IMG 1_2.jpg", first)
        assertEquals("IMG 1_2 (1).jpg", second)
        assertTrue(list(cookie, "/Phone uploads/Camera").containsAll(listOf(first, second)))
    }

    @Test
    fun reportsWhenNotSignedIn() {
        assumeTrue(base != null)
        val client = DriveClient(base!!) { null }
        assertThrows(DriveClient.NotSignedIn::class.java) { client.ensureDir("/x") }
    }
}
