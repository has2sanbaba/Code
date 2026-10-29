plugins {
    id("com.android.application")
    // Built-in Kotlin is disabled in gradle.properties; KGP matches the
    // metadata version quickjs-kt 1.0.15 publishes (2.4.10).
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "code.simurgh.scanner"
    compileSdk = 36

    defaultConfig {
        applicationId = "code.simurgh.scanner"
        // Android 6.0 (2015) through the newest release. 23 is the floor set
        // by quickjs-kt's own AAR metadata (CameraX needs 21, Material 21) --
        // the manifest merger rejects anything lower, and CI proves 23 builds.
        minSdk = 23
        targetSdk = 36
        versionCode = 3
        versionName = "1.3.0"

        // No abiFilters: the debug APK stays universal and carries the engine's
        // native library for every phone CPU architecture -- armeabi-v7a
        // (32-bit ARM), arm64-v8a (64-bit ARM), x86 and x86_64. A CI step
        // unzips the built APK and fails if any of the four is missing.
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// A desktop JVM cannot load the Android native library, so local unit tests run
// against the -jvm artifact of quickjs-kt (per the library's own README). This
// is what lets CI execute the symbology engine inside a real QuickJS runtime,
// on a normal runner, with no emulator and no device.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("io.github.dokar3:quickjs-kt-android"))
            .using(module("io.github.dokar3:quickjs-kt-jvm:1.0.15"))
    }
}

dependencies {
    // Pinned to versions whose AAR metadata is satisfied by compileSdk 36:
    // core-ktx 1.19.0 demands compileSdk 37 (CI told us so directly).
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.12.0")

    // Camera: CameraX preview + frame analysis. No Google Play Services, no
    // ML Kit, no third-party scanner -- the symbology is ours.
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    // The symbology engine: the reference TypeScript core bundled to
    // assets/engine.js, executed in an embedded QuickJS VM over JNI.
    implementation("io.github.dokar3:quickjs-kt:1.0.15")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    // org.json is part of the Android platform; plain JVM unit tests need it.
    testImplementation("org.json:json:20240303")
}
