// SiMurgh Code -- native Android app.
// Versions mirror a stack proven together in CI (Sept 2026): Gradle 9.7.1 +
// AGP 9.4.0 -- the combination quickjs-kt 1.0.15 builds against, which matters
// because that library's Kotlin metadata sets the floor for the compiler.
// Since AGP 9.0 Kotlin support is BUILT IN; applying the standalone
// org.jetbrains.kotlin.android plugin is rejected.
plugins {
    id("com.android.application") version "9.4.0" apply false
}
