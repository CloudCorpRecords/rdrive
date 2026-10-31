import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing keys live outside the repo: ~/.rdrive-android/keystore.properties
// (storeFile, storePassword, keyAlias, keyPassword). Without it, release builds use the debug key.
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".rdrive-android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "io.github.cloudcorprecords.rdrive"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.cloudcorprecords.rdrive"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.5.2"
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.work:work-runtime:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// The DriveClient test talks to a real rdrive server when RDRIVE_TEST_URL is set (see the test file).
tasks.withType<Test>().configureEach {
    System.getenv("RDRIVE_TEST_URL")?.let { environment("RDRIVE_TEST_URL", it) }
}
