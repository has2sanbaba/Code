// SiMurgh Code -- native Android app.
// Versions mirror a stack proven together in CI (Sept 2026): Gradle 9.7.1,
// AGP 9.4.0, Kotlin 2.4.10 -- the same combination quickjs-kt 1.0.15 builds
// against, which matters because that library's Kotlin metadata sets the floor
// for our compiler.
plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.10" apply false
}
