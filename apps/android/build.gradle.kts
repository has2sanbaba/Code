// SiMurgh Code -- native Android app.
// Versions mirror a stack proven together in CI (Sept 2026): Gradle 9.7.1 +
// AGP 9.4.0 -- the combination quickjs-kt 1.0.15 builds against, which matters
// because that library's Kotlin metadata sets the floor for the compiler.
// AGP 9 ships built-in Kotlin (compiler 2.2.0), which cannot read the Kotlin
// 2.4.10 metadata quickjs-kt publishes, so built-in Kotlin is disabled in
// gradle.properties (android.builtInKotlin=false, exactly like quickjs-kt's
// own build) and KGP 2.4.10 is applied instead.
plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.10" apply false
}
