package io.github.cloudcorprecords.rdrive

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {
    @Test
    fun comparesVersionsNumerically() {
        assertTrue(Updater.isNewer("0.5.0", "0.4.0"))
        assertTrue(Updater.isNewer("0.4.10", "0.4.9"))
        assertTrue(Updater.isNewer("1.0.0", "0.99.99"))
        assertFalse(Updater.isNewer("0.4.0", "0.4.0"))
        assertFalse(Updater.isNewer("0.3.9", "0.4.0"))
        assertFalse(Updater.isNewer("v0.4.0", "0.4.0"))
    }
}
