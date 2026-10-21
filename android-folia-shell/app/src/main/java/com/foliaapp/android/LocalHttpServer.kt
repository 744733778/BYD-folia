package com.foliaapp.android

import android.content.Context
import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 极简本地 HTTP 服务器：把 app/src/main/assets/folia/ 下的前端产物通过
 * http://127.0.0.1:<port>/ 提供给 GeckoView。
 *
 * 为什么不用 file:///android_asset/folia/index.html？
 * Folia 的 vite 产物是 ES module + code-splitting。Chromium 系内核在 file:// 源下会静默
 * 阻止 ES module 执行（页面无报错、React 不挂载、启动遮罩永不消失）。改走本地 http 源后
 * module / worker / code-splitting 全部正常——Capacitor/Cordova 也是这么做的。
 *
 * 三个端点：
 *   /                     前端静态资源（assets/folia）
 *   /cover?uri=&size=     封面（content:// 或绝对路径），按尺寸降采样 + ETag
 *   /local?uri=           本地音频/歌词原始字节，**支持 Range**，<audio> 直接流式播放 + 拖动进度条
 */
class LocalHttpServer(private val context: Context) {

    // 固定端口候选（按序尝试第一个空闲者）：origin = http://127.0.0.1:PORT/ 跨启动不变，
    // GeckoView 默认 profile 下的 IndexedDB / localStorage 才能跨重启持久。
    // origin 一变，前端整个曲库库（IndexedDB）就等于被清空——所以这里绝不能用随机端口。
    private val candidatePorts = intArrayOf(47777, 47778, 47779, 47780, 47781)

    private val loopback = InetAddress.getByName("127.0.0.1")

    private val serverSocket: ServerSocket = openSocket()

    private fun openSocket(): ServerSocket {
        val prefs = context.getSharedPreferences("folia_server", Context.MODE_PRIVATE)
        // 1) 先试上次成功绑定的端口：锁定 origin，防 Web 存储随端口漂移隔离
        val saved = prefs.getInt("last_port", 0)
        val savedVersion = prefs.getInt("last_version", 0)
        // 2) 版本变了就换一个 origin。
        //
        // 这是被现实逼出来的：origin 固定（47777）时，车机和模拟器升级 APK 后**仍在跑旧前端**。
        // 原因是 GeckoView 的 profile 跨版本保留，旧版本注册的 Service Worker（Workbox 预缓存
        // 整套 index.html + assets）继续从缓存应答，新 APK 里的 assets 根本没机会被读到；
        // 而用来清理缓存的那段脚本本身也在旧 SW 的预缓存里，等于让它自己删自己，永远跑不到。
        // 换 origin 是这个死循环唯一的出路：新 origin 没有 SW、没有缓存，天然是干净环境。
        // 代价是该 origin 下的 IndexedDB/localStorage 重建一次（曲库索引重扫一遍）。
        val target = if (savedVersion != com.foliaapp.android.BuildConfig.VERSION_CODE) {
            nextPort(saved)
        } else {
            saved
        }
        if (target in candidatePorts) {
            try {
                return bind(target, prefs)
            } catch (_: IOException) {
            }
        }
        // 3) 候选列表按序尝试
        for (p in candidatePorts) {
            try {
                return bind(p, prefs)
            } catch (_: IOException) {
            }
        }
        // 3) 全部占用：仍然随机取一个，但明确告警（origin 变了，曲库索引会重建一次）
        android.util.Log.e(
            "LocalHttpServer",
            "all candidate ports busy, fallback to random port — origin changed, web storage is lost!"
        )
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            android.widget.Toast.makeText(
                context, "本地端口被占用，曲库索引会重建一次", android.widget.Toast.LENGTH_LONG
            ).show()
        }
        return ServerSocket(0, 50, loopback)
    }

    /** 下一个候选端口（环形）。saved 非法时从第一个开始。 */
    private fun nextPort(saved: Int): Int {
        val idx = candidatePorts.indexOf(saved)
        if (idx < 0) return candidatePorts[0]
        return candidatePorts[(idx + 1) % candidatePorts.size]
    }

    private fun bind(port: Int, prefs: android.content.SharedPreferences): ServerSocket {
        val s = ServerSocket(port, 50, loopback)
        s.reuseAddress = true
        prefs.edit()
            .putInt("last_port", port)
            .putInt("last_version", com.foliaapp.android.BuildConfig.VERSION_CODE)
            .apply()
        return s
    }

    /** 前端加载用的实际端口 */
    val port: Int = serverSocket.localPort

    /** 固定 8 线程：缓存线程池在车机上会被 1800 个 chunk 瞬间撑成几十个线程 */
    private val executor: ExecutorService = Executors.newFixedThreadPool(8)

    @Volatile
    private var running = true

    fun start() {
        val thread = Thread { acceptLoop() }
        thread.isDaemon = true
        thread.start()
    }

    private fun acceptLoop() {
        while (running) {
            try {
                val socket = serverSocket.accept()
                executor.execute { handle(socket) }
            } catch (_: IOException) {
                break
            }
        }
    }

    private fun handle(socket: Socket) {
        try {
            socket.soTimeout = 15000
            val reader = socket.getInputStream().bufferedReader()
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2 || (parts[0] != "GET" && parts[0] != "HEAD")) {
                respond(socket, 400, "text/plain", "Bad Request".toByteArray())
                return
            }
            val headOnly = parts[0] == "HEAD"
            val headers = HashMap<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
            }

            val target = parts[1]
            var path = target
            val queryIdx = path.indexOf('?')
            if (queryIdx >= 0) path = path.substring(0, queryIdx)
            if (path == "/") path = "/index.html"

            when (path) {
                "/cover" -> {
                    handleCover(socket, target, headers["if-none-match"])
                    return
                }
                "/local" -> {
                    handleLocal(socket, target, headers["range"], headOnly)
                    return
                }
            }

            val rel = path.removePrefix("/")
            if (rel.contains("..") || rel.isEmpty()) {
                respond(socket, 403, "text/plain", "Forbidden".toByteArray())
                return
            }
            serveAsset(socket, rel, headers["if-none-match"], headOnly)
        } catch (_: Exception) {
            try {
                respond(socket, 500, "text/plain", "Error".toByteArray())
            } catch (_: Exception) {
            }
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    // ==================== 静态资源 ====================

    private fun serveAsset(socket: Socket, rel: String, ifNoneMatch: String?, headOnly: Boolean) {
        val ext = rel.substringAfterLast('.', "")
        // vite 产物带内容 hash：可以长期强缓存，重启不再重复拉 1800 个 chunk
        val immutable = rel.startsWith("assets/") && ext in setOf("js", "css", "woff2", "woff", "ttf", "png", "jpg", "svg")
        val size = try {
            context.assets.openFd("folia/$rel").use { it.length }
        } catch (_: Exception) {
            -1L
        }
        val etag = "\"${rel.hashCode().toString(16)}-${if (size >= 0) size else 0}\""
        if (!immutable && ifNoneMatch != null && ifNoneMatch == etag) {
            respond304(socket, etag)
            return
        }

        val cache = if (immutable) "Cache-Control: public, max-age=31536000, immutable\r\nETag: $etag\r\n"
        else "Cache-Control: no-cache\r\nETag: $etag\r\n"

        if (size >= 0) {
            val head = StringBuilder()
                .append("HTTP/1.1 200 OK\r\n")
                .append("Content-Type: ").append(mime(ext)).append("\r\n")
                .append("Content-Length: ").append(size).append("\r\n")
                .append(cache)
                .append("Connection: close\r\n\r\n")
                .toString()
            val out = socket.getOutputStream()
            out.write(head.toByteArray())
            if (!headOnly) {
                context.assets.open("folia/$rel").use { input -> copyTo(input, out) }
            }
            out.flush()
            return
        }

        // 压缩存储的资源拿不到 fd：整块读出（这些通常是很小的 html/json/manifest）
        val bytes: ByteArray = try {
            context.assets.open("folia/$rel").use { it.readBytes() }
        } catch (_: java.io.FileNotFoundException) {
            respond(socket, 404, "text/plain", "Not Found".toByteArray())
            return
        }
        respond(socket, 200, mime(ext), bytes, etag = null, extraHeaders = cache, headOnly = headOnly)
    }

    // ==================== /local：本地音频流（支持 Range） ====================

    /**
     * GET /local?uri=<content://...|/abs/path|file:///...>
     * 直接把本地字节回给 <audio>，支持 Range 供拖动进度条。
     * 这条链路替代了旧的「整首 base64 过 WebExtension 桥」——那是车机上卡顿/爆内存的主因。
     */
    private fun handleLocal(socket: Socket, target: String, rangeHeader: String?, headOnly: Boolean) {
        val key = queryParam(target, "uri")
        if (key.isNullOrEmpty()) {
            respond(socket, 400, "text/plain", "missing uri".toByteArray())
            return
        }
        val ext = key.substringAfterLast('.', "").lowercase()
        val type = when {
            key.startsWith("content://") -> try {
                context.contentResolver.getType(Uri.parse(key))
            } catch (_: Exception) {
                null
            }
            else -> null
        } ?: mime(ext).takeIf { it != "application/octet-stream" } ?: "audio/*"

        val isContent = key.startsWith("content://")
        val pfd = if (isContent) {
            try {
                context.contentResolver.openFileDescriptor(Uri.parse(key), "r")
            } catch (_: Exception) {
                null
            }
        } else null
        val file = if (isContent) null else File(if (key.startsWith("file://")) key.substring(7) else key)

        val total: Long = pfd?.statSize ?: file?.length() ?: -1L
        if (total < 0) {
            try { pfd?.close() } catch (_: Exception) {}
            respond(socket, 404, "text/plain", "not found".toByteArray())
            return
        }

        var start = 0L
        var end = total - 1
        var partial = false
        if (!rangeHeader.isNullOrBlank()) {
            val m = Regex("bytes=(\\d*)-(\\d*)").find(rangeHeader)
            if (m != null) {
                val s = m.groupValues[1]
                val e = m.groupValues[2]
                if (s.isNotEmpty()) {
                    start = s.toLongOrNull() ?: 0L
                    if (e.isNotEmpty()) end = minOf(e.toLongOrNull() ?: end, total - 1)
                } else if (e.isNotEmpty()) {
                    // bytes=-N：最后 N 字节
                    start = (total - (e.toLongOrNull() ?: 0L)).coerceAtLeast(0L)
                }
                if (start > end || start >= total) {
                    try { pfd?.close() } catch (_: Exception) {}
                    val head = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\n" +
                        "Content-Length: 0\r\nConnection: close\r\n\r\n"
                    socket.getOutputStream().write(head.toByteArray())
                    return
                }
                partial = true
            }
        }
        val length = end - start + 1

        val sb = StringBuilder()
        if (partial) {
            sb.append("HTTP/1.1 206 Partial Content\r\n")
            sb.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(total).append("\r\n")
        } else {
            sb.append("HTTP/1.1 200 OK\r\n")
        }
        sb.append("Content-Type: ").append(type).append("\r\n")
        sb.append("Content-Length: ").append(length).append("\r\n")
        sb.append("Accept-Ranges: bytes\r\n")
        sb.append("Cache-Control: no-store\r\n")
        sb.append("Connection: close\r\n\r\n")

        val out = socket.getOutputStream()
        out.write(sb.toString().toByteArray())
        if (!headOnly) {
            if (pfd != null) {
                FileInputStream(pfd.fileDescriptor).use { fis ->
                    fis.channel.position(start)
                    copyLimited(fis, out, length)
                }
            } else if (file != null) {
                RandomAccessFile(file, "r").use { raf ->
                    raf.seek(start)
                    copyLimited(raf, out, length)
                }
            }
        }
        out.flush()
        try { pfd?.close() } catch (_: Exception) {}
    }

    // ==================== /cover：封面 ====================

    /**
     * GET /cover?uri=<content://...>[&size=N]：按 SAF content uri 读封面回传。
     * - size=N：按短边≤N 降采样（inSampleSize 2 的幂），不传则上限 1024；
     * - ETag = hash(uri+size+lastModified)，响应带 max-age=86400；
     * - If-None-Match 命中 → 304 不重读字节。
     */
    private fun handleCover(socket: Socket, target: String, ifNoneMatch: String?) {
        try {
            val uriStr = queryParam(target, "uri")
            val size = (queryParam(target, "size")?.toIntOrNull() ?: 1024).coerceIn(64, 2048)
            if (uriStr.isNullOrEmpty() ||
                (!uriStr.startsWith("content://") && !uriStr.startsWith("file://") && !uriStr.startsWith("/"))
            ) {
                respond(socket, 400, "text/plain", "bad uri".toByteArray())
                return
            }
            val type = if (uriStr.startsWith("content://")) {
                try {
                    context.contentResolver.getType(Uri.parse(uriStr))
                } catch (_: Exception) {
                    null
                } ?: imageType(uriStr.substringAfterLast('.', ""))
            } else {
                imageType(uriStr.substringAfterLast('.', ""))
            }
            val lastMod = when {
                uriStr.startsWith("content://") -> try {
                    androidx.documentfile.provider.DocumentFile
                        .fromSingleUri(context, Uri.parse(uriStr))?.lastModified() ?: 0L
                } catch (_: Exception) { 0L }
                else -> try { File(uriStr.removePrefix("file://")).lastModified() } catch (_: Exception) { 0L }
            }
            val etag = "\"" + (uriStr + "|" + size + "|" + lastMod).hashCode().toString(16) + "\""
            if (ifNoneMatch != null && ifNoneMatch == etag) {
                respond304(socket, etag)
                return
            }
            val bytes = coverBytes(uriStr, size) ?: throw IOException("cover read failed")
            respond(socket, 200, type, bytes, etag)
        } catch (_: Exception) {
            try {
                respond(socket, 500, "text/plain", "cover error".toByteArray())
            } catch (_: Exception) {
            }
        }
    }

    /** 按短边≤size 降采样解码封面字节；content:// 走 contentResolver，file://或绝对路径走 FileInputStream */
    private fun coverBytes(uriStr: String, size: Int): ByteArray? {
        return try {
            val isContent = uriStr.startsWith("content://")
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            open(uriStr, isContent).use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            val minDim = minOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1)
            while (minDim / sample > size) sample *= 2
            val o = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = open(uriStr, isContent).use { android.graphics.BitmapFactory.decodeStream(it, null, o) }
                ?: return null
            val ba = java.io.ByteArrayOutputStream()
            bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, ba)
            bmp.recycle()
            ba.toByteArray()
        } catch (_: Exception) {
            null
        }
    }

    private fun open(uriStr: String, isContent: Boolean): InputStream =
        if (isContent) {
            context.contentResolver.openInputStream(Uri.parse(uriStr)) ?: throw IOException("open failed")
        } else {
            FileInputStream(File(uriStr.removePrefix("file://")))
        }

    /** cover 端点 contentResolver.getType 拿不到时的扩展名兜底映射 */
    private fun imageType(ext: String): String = when (ext.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "gif" -> "image/gif"
        else -> "image/*"
    }

    // ==================== 响应工具 ====================

    private fun queryParam(target: String, name: String): String? {
        val qIdx = target.indexOf('?')
        if (qIdx < 0) return null
        for (kv in target.substring(qIdx + 1).split('&')) {
            if (kv.startsWith("$name=")) {
                return try {
                    URLDecoder.decode(kv.substring(name.length + 1), "UTF-8")
                } catch (_: Exception) {
                    kv.substring(name.length + 1)
                }
            }
        }
        return null
    }

    private fun copyTo(input: InputStream, out: java.io.OutputStream) {
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            out.write(buf, 0, n)
        }
    }

    /** 精确写 length 字节（Range 需要严格不多不少） */
    private fun copyLimited(input: InputStream, out: java.io.OutputStream, length: Long) {
        val buf = ByteArray(64 * 1024)
        var remaining = length
        while (remaining > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
            if (n <= 0) break
            out.write(buf, 0, n)
            remaining -= n
        }
    }

    /** RandomAccessFile 版（绝对路径分支用 seek，避免再套一层流） */
    private fun copyLimited(raf: RandomAccessFile, out: java.io.OutputStream, length: Long) {
        val buf = ByteArray(64 * 1024)
        var remaining = length
        while (remaining > 0) {
            val n = raf.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
            if (n <= 0) break
            out.write(buf, 0, n)
            remaining -= n
        }
    }

    private fun respond(
        socket: Socket,
        code: Int,
        type: String,
        body: ByteArray,
        etag: String? = null,
        extraHeaders: String? = null,
        headOnly: Boolean = false,
    ) {
        val reason = when (code) {
            200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"
            404 -> "Not Found"; 500 -> "Internal Server Error"; else -> "OK"
        }
        val cache = extraHeaders ?: (if (etag != null) "Cache-Control: max-age=86400\r\nETag: $etag\r\n"
        else "Cache-Control: no-store\r\n")
        val head = "HTTP/1.1 $code $reason\r\n" +
            "Content-Type: $type\r\n" +
            "Content-Length: ${body.size}\r\n" +
            cache +
            "Connection: close\r\n\r\n"
        val out = socket.getOutputStream()
        out.write(head.toByteArray())
        if (!headOnly) out.write(body)
        out.flush()
    }

    /** 条件 GET 命中：304 不带 body，只回 ETag */
    private fun respond304(socket: Socket, etag: String) {
        val head = "HTTP/1.1 304 Not Modified\r\n" +
            "ETag: $etag\r\n" +
            "Cache-Control: max-age=86400\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n\r\n"
        val out = socket.getOutputStream()
        out.write(head.toByteArray())
        out.flush()
    }

    private fun mime(ext: String): String = when (ext.lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "application/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "ico" -> "image/x-icon"
        "webmanifest" -> "application/manifest+json"
        "ttf" -> "font/ttf"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "txt" -> "text/plain; charset=utf-8"
        "mp3" -> "audio/mpeg"
        "m4a", "mp4" -> "audio/mp4"
        "aac" -> "audio/aac"
        "flac" -> "audio/flac"
        "ogg", "oga" -> "audio/ogg"
        "opus" -> "audio/opus"
        "wav" -> "audio/wav"
        "lrc" -> "text/plain; charset=utf-8"
        "krc" -> "application/octet-stream"
        else -> "application/octet-stream"
    }

    fun stop() {
        running = false
        try {
            serverSocket.close()
        } catch (_: Exception) {
        }
        executor.shutdownNow()
    }
}
