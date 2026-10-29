package code.simurgh.scanner

import android.content.Context
import com.dokar.quickjs.QuickJs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Host of the symbology engine.
 *
 * The app is native Kotlin: native UI, native camera, native bitmaps -- there
 * is no WebView and no HTML anywhere. The symbology itself (geometry, Format
 * Crown, Golay, Reed-Solomon, DEFLATE, ChaCha20-Poly1305, the whole imaging
 * pipeline) is the *same* TypeScript core as the reference implementation,
 * bundled by `tools/build-engine.mjs` into `assets/engine.js` and executed in
 * an embedded QuickJS VM. Kotlin talks to exactly one global:
 *
 *     SimurghEngine.call(requestJson) -> responseJson
 *
 * Keeping one entry point keeps the JNI surface minimal and lets the JVM unit
 * tests (EngineVectorsTest) run the identical bundle in the identical runtime
 * and compare it, bit for bit, against vectors produced by the TypeScript
 * reference on the CI host.
 *
 * Cryptographic randomness never comes from the VM: QuickJS has no CSPRNG, so
 * Kotlin draws salts and nonces with [SecureRandom] and passes them in
 * explicitly. `Math.random` never touches an envelope.
 */
object Engine {

    private val mutex = Mutex()
    private var vm: QuickJs? = null
    private val random = SecureRandom()

    private const val HEX = "0123456789abcdef"

    /** Loads the bundle into a QuickJS runtime once per process. */
    suspend fun init(context: Context): QuickJs = mutex.withLock {
        vm ?: run {
            val source = context.assets.open("engine.js").use { it.readBytes() }.decodeToString()
            createVm(source)
        }
    }

    private suspend fun createVm(source: String): QuickJs {
        val q = QuickJs.create(Dispatchers.Default)
        // The vision ladder and the RS decoder nest deeply; QuickJS defaults to
        // a 256 KiB stack, which is not enough for a full-size symbol.
        q.maxStackSize = 8L * 1024 * 1024
        q.evaluate<Any?>(source, "engine.js")
        vm = q
        return q
    }

    /** One engine request. Safe to call from any coroutine; calls serialize. */
    suspend fun call(context: Context, request: JSONObject): JSONObject {
        val runtime = init(context)
        return mutex.withLock { callRaw(runtime, request) }
    }

    /**
     * Bit-level decode (codewords in, text out) with no imaging ladder. The
     * create panel uses this for its post-encode self-test: it proves the
     * Reed-Solomon blocks, Golay crown, CRC and segments all read back without
     * paying for a full render -> locate -> orient -> sample pass. For a sealed
     * symbol, call it with no key to verify structure only (a keyed verify would
     * re-run the full PBKDF2 derivation).
     */
    suspend fun decodeBits(
        context: Context,
        dataBitsHex: String,
        beadsHex: String,
        secureJson: String? = null,
    ): JSONObject {
        val runtime = init(context)
        return mutex.withLock { decodeBitsRaw(runtime, dataBitsHex, beadsHex, secureJson) }
    }

    /**
     * Pre-loads the bundle into a VM and runs one trivial op, so the first real
     * user action (generate or scan) does not pay the cold-start cost of reading
     * assets/engine.js and evaluating ~184 KiB of interpreter bytecode. Called
     * once from MainActivity.onCreate on a background dispatcher.
     */
    suspend fun warmup(context: Context) {
        val runtime = init(context)
        mutex.withLock { callRaw(runtime, JSONObject().put("op", "spec")) }
    }

    /**
     * The bridge itself, against an already-loaded runtime. Split out so JVM
     * unit tests exercise the exact escaping/parsing path the app uses, with no
     * Android classes involved.
     */
    suspend fun callRaw(runtime: QuickJs, request: JSONObject): JSONObject =
        JSONObject(
            runtime.evaluate<String>(
                "SimurghEngine.call(${jsString(request.toString())})",
                "engine-call.js",
            ),
        )

    /** Bit-level decode entry (dataBits/beads instead of an image), for tests. */
    suspend fun decodeBitsRaw(
        runtime: QuickJs,
        dataBitsHex: String,
        beadsHex: String,
        secureJson: String? = null,
    ): JSONObject {
        val extra = if (secureJson == null) "" else ", ${jsString(secureJson)}"
        return JSONObject(
            runtime.evaluate<String>(
                "SimurghEngine.decodeBits(${jsString(dataBitsHex)}, ${jsString(beadsHex)}$extra)",
                "engine-bits.js",
            ),
        )
    }

    /**
     * Encode a Kotlin string as a JavaScript string literal. JSON already
     * escaped quotes and control characters once; we escape the JSON text
     * again so the whole request rides inside `SimurghEngine.call("...")`.
     * U+2028/U+2029 are line terminators in JS source and must not appear raw.
     */
    fun jsString(s: String): String {
        val sb = StringBuilder(s.length + 16)
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\u2028' -> sb.append("\\u2028")
                '\u2029' -> sb.append("\\u2029")
                else ->
                    if (c.code < 0x20) {
                        sb.append("\\u")
                        sb.append(HEX[(c.code shr 12) and 0xf])
                        sb.append(HEX[(c.code shr 8) and 0xf])
                        sb.append(HEX[(c.code shr 4) and 0xf])
                        sb.append(HEX[c.code and 0xf])
                    } else {
                        sb.append(c)
                    }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /** Cryptographically random hex, for envelope salts (16 B) and nonces (12 B). */
    fun randomHex(byteCount: Int): String {
        val bytes = ByteArray(byteCount)
        random.nextBytes(bytes)
        val sb = StringBuilder(byteCount * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v shr 4])
            sb.append(HEX[v and 0xf])
        }
        return sb.toString()
    }
}
