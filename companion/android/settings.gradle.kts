pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Raises the Kotlin the build tool supplies to every module. It supplies Kotlin itself — no module here
// applies the plugin — but the version it bundles is 2.2.10, below the 2.2.20 the framework's own
// dependency check accepts, so the two current releases refuse each other out of the box.
//
// This belongs in the settings file rather than the root build file the vendor's note shows. The build
// tool is resolved here, through plugin management, so this is the classpath it is loaded from; the same
// line in the root build file resolves into a child of that one and never reaches it. Verified: the root
// build file left the framework still reading 2.2.10, and this reads 2.4.10.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10")
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.3.1" apply false
}

include(":app")
