import java.util.Properties

val accrawlSourceRevision = providers.environmentVariable("ACCRAWL_VERSION")
    .orElse("dev")
    .get()
if (accrawlSourceRevision != "dev" && !accrawlSourceRevision.matches(Regex("^[0-9a-f]{40}$"))) {
    throw GradleException("ACCRAWL_VERSION must be dev or the full 40-character lowercase Git commit")
}

plugins {
    id("com.android.application")
    // No Kotlin plugin: the build tool supplies it. The root build file raises the version it supplies.
    // No push-service plugin: this app is not built against one project. It asks the deployment it
    // pairs with which project to register with, so one build works against any deployment. See
    // PushRegistration.
    // The Flutter Gradle Plugin must be applied after the Android Gradle plugin.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "app.accrawl.accrawl_companion"
    // flutter_secure_storage 11 compiles against API 37, above the API 36 that
    // Flutter's own `compileSdkVersion` still reports, and the app must compile
    // against at least the highest SDK any plugin uses.
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Java and Kotlin must agree on a target, and the Java one above is stated rather than inferred.
    // Saying the Kotlin one here too keeps both compilers on it regardless of the JDK running the build.
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "app.accrawl.accrawl_companion"
        minSdk = 28
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["sourceRevision"] = accrawlSourceRevision
        // Replaces the framework default, so this installation can apply the push configuration
        // it was given at pairing before a wake can arrive at a cold process and be dropped.
        manifestPlaceholders["applicationName"] =
            "app.accrawl.accrawl_companion.CompanionApplication"
    }

    flavorDimensions += "security"
    productFlavors {
        create("secure") {
            dimension = "security"
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            buildConfigField("boolean", "ALLOW_SCREEN_CAPTURE", "false")
            buildConfigField("boolean", "ALLOW_INSECURE_HTTP", "false")
        }
        create("qa") {
            dimension = "security"
            applicationIdSuffix = ".qa"
            versionNameSuffix = "-qa"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            buildConfigField("boolean", "ALLOW_SCREEN_CAPTURE", "true")
            buildConfigField("boolean", "ALLOW_INSECURE_HTTP", "true")
        }
    }

    val signingPropertiesFile = rootProject.file("key.properties")
    val signingProperties = Properties()
    val hasReleaseSigning = signingPropertiesFile.isFile
    if (hasReleaseSigning) {
        signingPropertiesFile.inputStream().use(signingProperties::load)
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
    }

    testOptions {
        // The pure relay logic (extractOtp / senderMatches / the claim-state ledger) has no Android deps, so
        // it runs as a plain JVM unit test. Return default values for any incidental android.* call rather
        // than throwing; the real org.json on the test classpath (below) replaces the throwing stub.
        unitTests.isReturnDefaultValues = true
    }
}

flutter {
    source = "../.."
}

dependencies {
    // OkHttp's WebSocket client drives the device-proxy tunnel WS to the engine (TunnelService). It's the
    // standard Android WS client; no WS-specific module is needed (WebSocket support ships in core okhttp3).
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("com.google.firebase:firebase-messaging:24.1.1")

    // JVM unit tests for the pure relay logic (NativeRelay.extractOtp / senderMatches / the claim-state
    // ledger). org.json must be the real impl, not the android.jar stub that throws under unit tests.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}

gradle.taskGraph.whenReady {
    val releaseRequested = allTasks.any {
        it.project == project && it.name.contains("Release", ignoreCase = true)
    }
    if (releaseRequested && !rootProject.file("key.properties").isFile) {
        throw GradleException(
            "Release signing is not configured. Copy key.properties.example to key.properties and provide a private keystore."
        )
    }
    if (releaseRequested && accrawlSourceRevision == "dev") {
        throw GradleException(
            "Release builds require ACCRAWL_VERSION to be the full public Git commit."
        )
    }
}
