package com.foliaapp.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Folia 安卓壳 —— GeckoView 内核 + WebExtension 消息桥。
 *
 * 通信链路：
 *   页面主世界 window.foliaBridge / window.nativeLibrary（由 content.js 注入的主世界 shim 定义）
 *     --window.postMessage({__foliaBridge:"request", ns, method, requestId, arg})--> 隔离世界 content.js
 *     --browser.runtime.sendMessage({target:"background", id, ns, method, requestId, arg})--> background.js
 *     --connectNative("browser") port.postMessage({id, ns, method, requestId, arg})--> 本类 onPortMessage
 *   本类按 ns 路由（foliaBridge 在线 HTTP 转发 / nativeLibrary 本地曲库），结果经
 *     port.postMessage({id, ns, requestId, ok, payload}) 回 background -> content.js
 *     -> window.postMessage({__foliaBridge:"result", ...}) -> 主世界 shim
 *     -> window.__foliaBridgeOnResult / __nativeLibraryOnResult。
 *
 * 目录选择用 SAF（ACTION_OPEN_DOCUMENT_TREE）——系统授权目录即可，无需危险的
 * MANAGE_EXTERNAL_STORAGE，兼容 scoped storage；授权可持久化，重扫复用同一 tree URI。
 */
class MainActivity : AppCompatActivity() {

    private val TAG = "foliaAPP"

    companion object {
        /** GeckoRuntime 每进程只能 create 一次：static 持有，Activity 重建只 close session */
        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var sRuntime: GeckoRuntime? = null
    }

    private lateinit var geckoView: GeckoView
    private var session: GeckoSession? = null
    private var webExtension: WebExtension? = null

    /** content script 经 background connectNative 建立的端口；原生经它回传结果 */
    private var nativePort: WebExtension.Port? = null

    /** 本地 http server：file:// 下 ES module 不执行，改走 http://127.0.0.1 加载前端 */
    private var httpServer: LocalHttpServer? = null

    /** 用户选定的根目录（SAF tree DocumentFile），null 表示尚未选择 */
    private var rootDoc: DocumentFile? = null

    /** foliaBridge 在线 HTTP 转发专用线程池（网络绝不能跑在 JS/UI/port 线程上） */
    private val foliaExecutor = Executors.newCachedThreadPool()

    /** 单次在线请求超时（秒）：connect/read 超时 + watchdog 兜底 */
    private val foliaTimeoutSec = 25L

    /** NavigationDelegate 回调缓存的历史后退能力（GeckoView 无同步 canGoBack()） */
    private var canGoBack = false

    /** 已发出/在途的 content 侧 bridge id；worker 与 watchdog 竞争回传权，谁先 remove 谁回 */
    private val pendingBridgeIds =
        Collections.newSetFromMap(ConcurrentHashMap<Int, Boolean>())

    /** 自建 cookie 存储（扫码登录 cookie 跨重启保留） */
    private lateinit var cookieStore: CookieStore

    private val uaMobileChrome =
        "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cookieStore = CookieStore(applicationContext)

        // 1) GeckoRuntime（每进程一次，static 复用）。ALLOW_ALL：Gecko 自有网络栈，
        //    不受 Android networkSecurityConfig 控制，本地 http://127.0.0.1 必须显式放行。
        var rt = sRuntime
        if (rt == null) {
            val runtimeSettings = GeckoRuntimeSettings.Builder()
                .allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL)
                .remoteDebuggingEnabled(true)
                .build()
            rt = GeckoRuntime.create(this, runtimeSettings)
            sRuntime = rt
        }
        val runtime = rt

        // 2) 本地 http server 先起来
        httpServer = LocalHttpServer(applicationContext).also { it.start() }
        val port = httpServer?.port ?: 0

        // 3) GeckoView 控件（程序化构造，无需 layout XML）
        geckoView = GeckoView(this)
        setContentView(geckoView)

        // 4) 创建 session + 导航委托 + 空 ContentDelegate（Bug 1758212：不挂空 delegate 会崩）
        val s = GeckoSession()
        s.setContentDelegate(object : GeckoSession.ContentDelegate {})
        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                this@MainActivity.canGoBack = canGoBack
            }
        }

        // 5) 安装/确保内置扩展；扩展就绪后挂消息委托、open、loadUri。
        //    background.js 断线会每 500ms 重连 connectNative，故即使首连早于 delegate 也能接上。
        runtime.webExtensionController
            .ensureBuiltIn(
                "resource://android/assets/folia-bridge/",
                "folia-bridge@folia.app"
            )
            .accept(
                { ext ->
                    val e = ext ?: run {
                        Log.e(TAG, "extension install returned null")
                        return@accept
                    }
                    webExtension = e
                    e.setMessageDelegate(bridgeMessageDelegate, "browser")
                    s.webExtensionController.setMessageDelegate(e, bridgeMessageDelegate, "browser")
                    geckoView.setSession(s)
                    s.open(runtime)
                    session = s
                    s.loadUri("http://127.0.0.1:$port/index.html")
                    Log.d(TAG, "extension ready, frontend loaded on port $port")
                },
                { e -> Log.e(TAG, "Error registering WebExtension", e) }
            )
    }

    override fun onPause() {
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
    }

    override fun onBackPressed() {
        val s = session
        if (s != null && canGoBack) s.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        session?.close()
        httpServer?.stop()
        super.onDestroy()
        // runtime 不 destroy：每进程只 create 一次，重建 Activity 时复用
    }

    // ==================== WebExtension 消息桥 ====================

    /** 消息委托：接收 background.js connectNative 建立的端口 */
    private val bridgeMessageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            Log.d(TAG, "native port connected")
            nativePort = port
            port.setDelegate(object : WebExtension.PortDelegate {
                override fun onPortMessage(message: Any, port: WebExtension.Port) {
                    handleBridgeMessage(message)
                }

                override fun onDisconnect(port: WebExtension.Port) {
                    if (port === nativePort) nativePort = null
                }
            })
        }
    }

    /**
     * background 中继来的 {id, ns, method, requestId, arg}。
     * id 是 content 侧自增配对号（原样回传，background 据此 resolve pending promise）；
     * ns 区分 foliaBridge / nativeLibrary；requestId 是前端业务 requestId（原样回传）。
     */
    private fun handleBridgeMessage(message: Any) {
        if (message !is JSONObject) return
        val id = message.optInt("id", -1)
        val ns = message.optString("ns")
        val requestId = message.optInt("requestId", -1)
        if (id < 0 || requestId < 0) return
        val method = message.optString("method")
        val arg = if (message.has("arg")) message.opt("arg") else null
        try {
            when (ns) {
                "nativeLibrary" -> handleNativeLibrary(id, requestId, method, arg)
                "foliaBridge" -> handleFoliaBridge(id, requestId, method, arg)
            }
        } catch (e: Exception) {
            Log.e(TAG, "bridge error", e)
            sendBridgeResult(ns, id, requestId, false, e.message ?: "bridge error")
        }
    }

    /** 统一回传：{id, ns, requestId, ok, payload}，切 UI 线程发（port 只能在 UI 线程用） */
    private fun sendBridgeResult(ns: String, id: Int, requestId: Int, ok: Boolean, payload: String) {
        runOnUiThread {
            val p = nativePort ?: return@runOnUiThread
            val obj = JSONObject()
            obj.put("id", id)
            obj.put("ns", ns)
            obj.put("requestId", requestId)
            obj.put("ok", ok)
            obj.put("payload", payload)
            try {
                p.postMessage(obj)
            } catch (e: Exception) {
                Log.e(TAG, "port.postMessage failed", e)
            }
        }
    }

    // ==================== 目录桥 nativeLibrary ====================

    private fun handleNativeLibrary(id: Int, requestId: Int, method: String, arg: Any?) {
        when (method) {
            "pickDirectory" -> {
                Log.d(TAG, "pickDirectory requestId=$requestId")
                runOnUiThread {
                    openDirectoryPicker { ok ->
                        val root = rootDoc
                        Log.d(TAG, "picker result ok=$ok rootDoc=${root?.uri}")
                        if (ok && root != null) {
                            sendBridgeResult("nativeLibrary", id, requestId, true, buildTree(root).toString())
                        } else {
                            sendBridgeResult("nativeLibrary", id, requestId, false, "cancelled")
                        }
                    }
                }
            }

            "readFile" -> {
                val rel = arg?.toString() ?: ""
                try {
                    val root = rootDoc
                    val doc = root?.let { findDoc(it, rel) }
                    if (doc == null || doc.isDirectory) {
                        sendBridgeResult("nativeLibrary", id, requestId, false, "not found: $rel")
                        return
                    }
                    val bytes = doc.uri.let { contentResolver.openInputStream(it) }?.readBytes()
                        ?: throw java.io.IOException("read failed: $rel")
                    val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    sendBridgeResult("nativeLibrary", id, requestId, true, b64)
                } catch (e: Exception) {
                    sendBridgeResult("nativeLibrary", id, requestId, false, e.message ?: "read error")
                }
            }
        }
    }

    /** 弹系统目录选择器，用户选定目录后回调 */
    private fun openDirectoryPicker(callback: (Boolean) -> Unit) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            )
        }
        pendingCallback = callback
        // 借鉴 folia-android（Timingyyds，实测可用）：用传统 startActivityForResult 而不是
        // registerForActivityResult。后者依赖 Activity 生命周期时序，部分设备上拿不到可用
        // 启动器，表现为「点了导入毫无反应」——正是此前目录选择器弹不出来的根因。
        startActivityForResult(intent, REQUEST_PICK_DIRECTORY)
    }

    private var pendingCallback: ((Boolean) -> Unit)? = null

    private val REQUEST_PICK_DIRECTORY = 30001

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK_DIRECTORY) return
        val callback = pendingCallback
        pendingCallback = null
        val uri: Uri? = data?.data
        if (resultCode == RESULT_OK && uri != null) {
            // 持久化读取授权，供本次会话及后续重扫复用
            try {
                contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: SecurityException) { /* 可忽略 */ }
            rootDoc = DocumentFile.fromTreeUri(this, uri)
            savedTreeUri = uri
            callback?.invoke(true)
        } else {
            callback?.invoke(false)
        }
    }

    private var savedTreeUri: Uri? = null

    /** 递归把目录构建成前端需要的 JSON 目录树（见 NativeDirectoryTree） */
    private fun buildTree(root: DocumentFile): JSONObject {
        val json = JSONObject()
        json.put("name", root.name ?: "music")
        json.put("rootPath", root.uri.toString())
        json.put("children", buildChildren(root, ""))
        return json
    }

    private fun buildChildren(dir: DocumentFile, prefix: String): JSONArray {
        val arr = JSONArray()
        for (file in dir.listFiles()) {
            val name = file.name ?: continue
            val rel = if (prefix.isEmpty()) name else "$prefix/$name"
            val obj = JSONObject()
            obj.put("name", name)
            obj.put("relativePath", rel)
            obj.put("kind", if (file.isDirectory) "directory" else "file")
            if (file.isDirectory) {
                obj.put("children", buildChildren(file, rel))
            } else {
                obj.put("size", file.length())
                obj.put("lastModified", file.lastModified())
                obj.put("mimeType", file.type ?: "")
            }
            arr.put(obj)
        }
        return arr
    }

    /** 按相对路径逐级定位 DocumentFile */
    private fun findDoc(root: DocumentFile, relativePath: String): DocumentFile? {
        var current: DocumentFile = root
        for (segment in relativePath.split("/")) {
            current = current.findFile(segment) ?: return null
        }
        return current
    }

    // ==================== foliaBridge：在线源 HTTP 转发 ====================

    private val neteaseBase = "https://music.163.com"
    private val neteaseReferer = "https://music.163.com/"
    private val qqReferer = "https://y.qq.com/"

    private data class HttpOutcome(
        val body: String,
        val status: Int,
        val setCookies: List<String>,
    )

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** 取 JSONObject 字段的非空字符串，空串/null/JSON.NULL 一律视为缺失 */
    private fun JSONObject.optStr(name: String): String? {
        val v = this.opt(name) ?: return null
        if (v == JSONObject.NULL) return null
        return v.toString().ifBlank { null }
    }

    /** 业务不可路由：ok=true 但带 __foliaBridgeError 标记，前端据此抛 unsupported */
    private fun foliaUnsupported(provider: String, operation: String): String =
        JSONObject().apply {
            put("__foliaBridgeError", "UNSUPPORTED")
            put("provider", provider)
            put("operation", operation)
            put("message", "Unsupported operation: $provider/$operation")
        }.toString()

    /** 响应体缺顶层 code 时补 code=200（网易云 webapi 部分端点不回 code） */
    private fun ensureCode200(body: String): String =
        try {
            val o = JSONObject(body)
            if (!o.has("code") || o.isNull("code")) o.put("code", 200)
            o.toString()
        } catch (_: Exception) {
            body
        }

    /**
     * 通用 HttpURLConnection 请求。
     * - 调用方显式传的 UA/Referer/Cookie 一律不覆盖；缺省才注入 provider 默认值。
     * - cookieOverride 非空且调用方未带 Cookie 头时优先使用（网易云 query.cookie 解码后传入）。
     * - 响应后把所有 Set-Cookie 归一化（无 Path 补 ; Path=/）写入自建 cookieStore 并持久化。
     */
    private fun execHttp(
        method: String,
        url: String,
        defaultReferer: String,
        callerHeaders: JSONObject,
        bodyText: String? = null,
        bodyContentType: String? = null,
        cookieOverride: String? = null,
    ): HttpOutcome {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12000
            readTimeout = 13000
            instanceFollowRedirects = false
        }
        try {
            var hasUa = false
            var hasReferer = false
            var hasCookie = false
            val itr = callerHeaders.keys()
            while (itr.hasNext()) {
                val k = itr.next()
                val v = callerHeaders.optString(k)
                when (k.lowercase()) {
                    "user-agent" -> hasUa = true
                    "referer" -> hasReferer = true
                    "cookie" -> hasCookie = true
                }
                conn.setRequestProperty(k, v)
            }
            if (!hasUa) conn.setRequestProperty("User-Agent", uaMobileChrome)
            if (!hasReferer && defaultReferer.isNotEmpty()) conn.setRequestProperty("Referer", defaultReferer)

            if (!hasCookie) {
                val cookie = cookieOverride ?: cookieStore.getCookie(url)
                if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
            }

            if ((method.equals("POST", true) || method.equals("PUT", true)) && bodyText != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", bodyContentType ?: "application/x-www-form-urlencoded")
                OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(bodyText) }
            }

            val status = conn.responseCode
            val setCookies = ArrayList<String>()
            conn.headerFields.forEach { (k, values) ->
                if (k != null && k.equals("Set-Cookie", ignoreCase = true)) {
                    values?.forEach { setCookies.add(it) }
                }
            }

            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.let { s ->
                BufferedReader(InputStreamReader(s, Charsets.UTF_8)).use { it.readText() }
            } ?: ""

            // Cookie 持久化：无 Path 属性的补 Path=/（照 BYD FoliaCorePlugin.normalizeCookieForUrl）
            for (sc in setCookies) {
                val normalized = if (sc.contains("Path=", ignoreCase = true)) sc else "$sc; Path=/"
                try { cookieStore.setCookie(url, normalized) } catch (_: Exception) {}
            }

            return HttpOutcome(body, status, setCookies)
        } finally {
            conn.disconnect()
        }
    }

    /** 网易云路由：按 path（如 /cloudsearch、/login/qr/key）转发到 music.163.com webapi */
    private fun routeNetease(
        path: String,
        query: JSONObject,
        headers: JSONObject,
    ): String {
        // 前端把完整 cookie 串 URL 编码后塞在 query.cookie 里：剥离出来作为 Cookie 头
        val cookieOverride = query.optStr("cookie")?.let {
            try { java.net.URLDecoder.decode(it, "UTF-8") } catch (_: Exception) { it }
        }

        return when (path) {
            "/cloudsearch" -> {
                val keywords = enc(query.optString("keywords"))
                val limit = query.optString("limit").ifBlank { "30" }
                val offset = query.optString("offset").ifBlank { "0" }
                val url = "$neteaseBase/api/search/get/web?s=$keywords&type=1&limit=$limit&offset=$offset"
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/lyric/new" -> {
                val id = enc(query.optString("id"))
                val url = "$neteaseBase/api/song/lyric?id=$id&lv=-1&kv=-1&tv=-1"
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/song/detail" -> {
                // ids 形如 "186016" 或 "186016,123"
                val ids = query.optString("ids").split(",").map { it.trim() }.filter { it.isNotEmpty() }
                if (ids.isEmpty()) return foliaUnsupported("netease", path)
                val first = ids[0]
                val idsJson = "[" + ids.joinToString(",") + "]"
                val url = "$neteaseBase/api/song/detail/?id=$first&ids=" + enc(idsJson)
                ensureCode200(execHttp("GET", url, neteaseReferer, headers, cookieOverride = cookieOverride).body)
            }

            "/login/qr/key" -> {
                val out = execHttp(
                    "POST", "$neteaseBase/api/login/qrcode/unikey", neteaseReferer, headers,
                    bodyText = "type=1", cookieOverride = cookieOverride,
                )
                // 上游 {code, unikey:"x"} → 前端读 response.data.unikey
                val raw = JSONObject(out.body)
                JSONObject()
                    .put("code", raw.optInt("code", 200))
                    .put("data", JSONObject().put("unikey", raw.optString("unikey")))
                    .toString()
            }

            "/login/qr/create" -> {
                // 该上游端点 404，本地构造二维码内容与图片 URL
                val key = query.optString("key")
                val qrurl = "$neteaseBase/login?codekey=$key"
                val qrimg = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + enc(qrurl)
                JSONObject()
                    .put("code", 200)
                    .put("data", JSONObject().put("qrurl", qrurl).put("qrimg", qrimg))
                    .toString()
            }

            "/login/qr/check" -> {
                val key = query.optString("key")
                val out = execHttp(
                    "POST", "$neteaseBase/api/login/qrcode/client/login", neteaseReferer, headers,
                    bodyText = "type=1&key=" + enc(key), cookieOverride = cookieOverride,
                )
                val obj = JSONObject(out.body)
                // 803 成功：上游响应体无 cookie 但 Set-Cookie 带 MUSIC_U，拼进 body 给前端持久化
                if (obj.optInt("code") == 803 && !obj.has("cookie") && out.setCookies.isNotEmpty()) {
                    val cookieStr = out.setCookies.joinToString("; ") { sc ->
                        sc.substringBefore(';').trim()
                    }
                    obj.put("cookie", cookieStr)
                }
                obj.toString()
            }

            "/login/status" -> {
                // 前端 getLoginStatus 读 response.data.profile
                val raw = JSONObject(
                    execHttp("GET", "$neteaseBase/api/nuser/account/get", neteaseReferer, headers, cookieOverride = cookieOverride).body
                )
                JSONObject()
                    .put("code", 200)
                    .put(
                        "data",
                        JSONObject()
                            .put("code", raw.optInt("code", 200))
                            .put("account", raw.opt("account"))
                            .put("profile", raw.opt("profile")),
                    ).toString()
            }

            "/user/account" -> {
                // 前端读 response.profile，上游本身即 {code, account, profile}，原样返回
                execHttp("GET", "$neteaseBase/api/nuser/account/get", neteaseReferer, headers, cookieOverride = cookieOverride).body
            }

            "/register/anonimous" -> {
                // 匿名注册：固定 Cookie 头 os=pc; appver=2.9.7，即使 400 也把 body 交给前端
                execHttp(
                    "POST", "$neteaseBase/api/register/anonimous", neteaseReferer, headers,
                    bodyText = null, cookieOverride = "os=pc; appver=2.9.7",
                ).body
            }

            "/logout" -> {
                execHttp(
                    "POST", "$neteaseBase/api/logout", neteaseReferer, headers,
                    bodyText = "type=1", cookieOverride = cookieOverride,
                ).body
            }

            else -> foliaUnsupported("netease", path)
        }
    }

    /** QQ 路由：按 operation 转发到 c.y.qq.com 公开 CGI */
    private fun routeQq(operation: String, params: JSONObject, headers: JSONObject): String =
        when (operation) {
            "search" -> {
                val w = enc(params.optStr("w") ?: "")
                val n = params.optStr("n") ?: "20"
                val p = params.optStr("p") ?: "1"
                val url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=$p&n=$n&w=$w&cr=1&aggr=0&lossless=1&new_json=1"
                // 前端读 data.song.list，client_search_cp 原生即此形状，原样返回
                execHttp("GET", url, qqReferer, headers).body
            }

            "lyric" -> {
                val songmid = enc(params.optStr("songmid") ?: "")
                val url =
                    "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=$songmid&format=json&nobase64=1" +
                        "&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8" +
                        "&notice=0&platform=yqq&needNewCode=0"
                // 前端读 body.lyric（nobase64=1 即明文 LRC），原样返回
                execHttp("GET", url, qqReferer, headers).body
            }

            "smartbox" -> {
                val key = enc(params.optStr("key") ?: params.optStr("w") ?: "")
                val url = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&inCharset=utf-8&outCharset=utf-8&key=$key"
                execHttp("GET", url, qqReferer, headers).body
            }

            else -> foliaUnsupported("qq", operation)
        }

    /** 酷狗路由：按 operation 转发到 mobilecdn / lyrics.kugou.com */
    private fun routeKugou(operation: String, params: JSONObject, headers: JSONObject): String {
        // 酷狗公开端点不需要 Referer；execHttp 在空 Referer 时不注入
        return when (operation) {
            "search", "anonymous_search" -> {
                val keyword = enc(params.optStr("keyword") ?: "")
                val page = params.optStr("page") ?: "1"
                val pagesize = params.optStr("pagesize") ?: "20"
                val url = "http://mobilecdn.kugou.com/api/v3/search/song?keyword=$keyword&page=$page&pagesize=$pagesize&platform=web&tag=em&filter=10"
                // mobilecdn {status:1, data.info[]}，songListOf 能识别 info 数组，原样返回
                execHttp("GET", url, "", headers).body
            }

            "search_lyric" -> {
                // 关键字版 search（v1/search 已死）：前端补传 keyword/singer，多余参数忽略
                val keyword = enc(params.optStr("keyword") ?: "")
                val singer = enc(params.optStr("singer") ?: "")
                val url = "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=$keyword&singer=$singer"
                // 原生返回 candidates[{id,accesskey}]，前端读 candidates[0].{id,accesskey}，原样返回
                execHttp("GET", url, "", headers).body
            }

            "lyric" -> {
                // 前端读 response.decodeContent（KRC 明文）；download 的 content 是 base64
                val id = enc(params.optStr("id") ?: "")
                val accesskey = enc(params.optStr("accesskey") ?: "")
                val fmt = params.optStr("fmt") ?: "krc"
                val url = "http://lyrics.kugou.com/download?ver=1&client=pc&id=$id&accesskey=$accesskey&fmt=$fmt"
                val out = execHttp("GET", url, "", headers).body
                val raw = JSONObject(out)
                var decoded = ""
                val content = raw.optString("content")
                if (content.isNotEmpty()) {
                    try {
                        decoded = String(android.util.Base64.decode(content, android.util.Base64.DEFAULT), Charsets.UTF_8)
                    } catch (_: Exception) { decoded = content }
                }
                JSONObject()
                    .put("status", raw.optInt("status", 1))
                    .put("decodeContent", decoded)
                    .put("contenttype", raw.opt("contenttype"))
                    .toString()
            }

            else -> foliaUnsupported("kugou", operation)
        }
    }

    /** qq_raw/musicu 兜底：POST JSON body 透传到 u.y.qq.com */
    private fun routeQqRaw(headers: JSONObject, bodyObj: Any?): String {
        val bodyText = when (bodyObj) {
            null -> "{}"
            is JSONObject -> bodyObj.toString()
            else -> bodyObj.toString()
        }
        return execHttp(
            "POST", "https://u.y.qq.com/cgi-bin/musicu.fcg", qqReferer, headers,
            bodyText = bodyText, bodyContentType = "application/json",
        ).body
    }

    /** 解析 FoliaBridgeRequest 并按 provider 路由；返回 payload 字符串 */
    private fun handleFoliaRequest(requestJson: String): String {
        val req = JSONObject(requestJson)
        val provider = req.optString("provider")
        val operation = req.optString("operation")
        val path = req.optString("path").ifBlank { operation }
        val query = req.optJSONObject("query") ?: JSONObject()
        val params = req.optJSONObject("params") ?: JSONObject()
        val headers = req.optJSONObject("headers") ?: JSONObject()
        val bodyObj = if (req.has("body")) req.opt("body") else null

        return when (provider) {
            "netease" -> routeNetease(path, query, headers)
            "qq" -> routeQq(operation, params, headers)
            "kugou" -> routeKugou(operation, params, headers)
            "qq_raw" -> routeQqRaw(headers, bodyObj)
            else -> foliaUnsupported(provider, operation)
        }
    }

    /**
     * foliaBridge.httpRequest：丢后台线程执行，绝不阻塞 port 线程。
     * watchdog 在 foliaTimeoutSec 后兜底回传超时错误；worker 与 watchdog 谁先 remove
     * pendingBridgeIds 里的 id 谁负责回传，保证恰好回调一次。
     */
    private fun handleFoliaBridge(id: Int, requestId: Int, method: String, arg: Any?) {
        if (method != "httpRequest") return
        val requestJson = arg?.toString() ?: "{}"
        pendingBridgeIds.add(id)

        val worker = foliaExecutor.submit {
            try {
                val payload = handleFoliaRequest(requestJson)
                if (pendingBridgeIds.remove(id)) {
                    sendBridgeResult("foliaBridge", id, requestId, true, payload)
                }
            } catch (e: Exception) {
                if (pendingBridgeIds.remove(id)) {
                    sendBridgeResult("foliaBridge", id, requestId, false, e.message ?: "bridge error")
                }
            }
        }

        foliaExecutor.submit {
            try {
                TimeUnit.SECONDS.sleep(foliaTimeoutSec)
            } catch (_: InterruptedException) {
                return@submit
            }
            if (pendingBridgeIds.remove(id)) {
                try { worker.cancel(true) } catch (_: Exception) {}
                sendBridgeResult("foliaBridge", id, requestId, false, "request timeout after ${foliaTimeoutSec}s")
            }
        }
    }

    // ==================== 自建持久化 cookie 存储（代理层 cookie jar） ====================

    /**
     * 极简 cookie jar：domain -> (name -> value)。
     * - getCookie(url) 按 host 后缀匹配拼接 "n=v; n=v"。
     * - setCookie 解析 Set-Cookie（取首段 name=value；Domain= 属性指定域），无 Path 的语义已由
     *   调用方补 Path=/（本存储不按 Path 过滤，简化实现）。
     * - 每次写入 JSON 序列化到 SharedPreferences，扫码登录 MUSIC_U 等跨重启保留。
     *
     * 注：本壳已整体迁到 GeckoView，页面只访问 127.0.0.1，API 请求全走原生 HttpURLConnection。
     * 该自建 jar 即代理层 cookie 存储；不依赖系统 webkit CookieManager（车机无系统网页组件
     * 时其初始化会失败），功能等价：Set-Cookie 归一化落盘、请求自动带 Cookie。
     */
    private class CookieStore(private val context: Context) {
        private val prefs = context.getSharedPreferences("folia_cookies", Context.MODE_PRIVATE)
        private val store = ConcurrentHashMap<String, LinkedHashMap<String, String>>()

        init {
            val raw = prefs.getString("jar", null)
            if (!raw.isNullOrEmpty()) {
                try {
                    val root = JSONObject(raw)
                    val it = root.keys()
                    while (it.hasNext()) {
                        val domain = it.next()
                        val cookies = root.optJSONObject(domain) ?: continue
                        val map = LinkedHashMap<String, String>()
                        val cit = cookies.keys()
                        while (cit.hasNext()) {
                            val n = cit.next()
                            map[n] = cookies.optString(n)
                        }
                        store[domain] = map
                    }
                } catch (_: Exception) { /* 损坏则从空开始 */ }
            }
        }

        @Synchronized
        fun getCookie(url: String): String? {
            val host = try { URL(url).host } catch (_: Exception) { return null }
            val pairs = ArrayList<String>()
            for ((domain, map) in store) {
                if (host == domain || host.endsWith(".$domain")) {
                    for ((n, v) in map) pairs.add("$n=$v")
                }
            }
            return if (pairs.isEmpty()) null else pairs.joinToString("; ")
        }

        @Synchronized
        fun setCookie(url: String, cookieSpec: String) {
            val host = try { URL(url).host } catch (_: Exception) { return }
            val parts = cookieSpec.split(";").map { it.trim() }.filter { it.isNotEmpty() }
            if (parts.isEmpty()) return
            val pair = parts[0].split("=", limit = 2)
            if (pair.size < 2) return
            val name = pair[0].trim()
            val value = pair[1].trim()
            var domain = host
            for (attr in parts.drop(1)) {
                val kv = attr.split("=", limit = 2)
                if (kv[0].equals("domain", ignoreCase = true) && kv.size == 2) {
                    domain = kv[1].trim().removePrefix(".")
                }
            }
            val map = store.getOrPut(domain) { LinkedHashMap() }
            map[name] = value
            save()
        }

        @Synchronized
        private fun save() {
            val root = JSONObject()
            for ((domain, map) in store) {
                val o = JSONObject()
                for ((n, v) in map) o.put(n, v)
                root.put(domain, o)
            }
            prefs.edit().putString("jar", root.toString()).apply()
        }
    }
}
