package com.foliaapp.android

import android.content.Context
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 极简本地 HTTP 服务器：把 app/src/main/assets/folia/ 下的前端产物通过
 * http://127.0.0.1:<port>/ 提供给 WebView。
 *
 * 为什么不用 file:///android_asset/folia/index.html？
 * Folia 的 vite 产物是 ES module + code-splitting（多 chunk 相互 import，
 * 还有 worker、动态图标等）。Chromium 内核在 file:// 源下会静默阻止 ES module
 * 执行（页面无任何报错、React 不挂载、启动遮罩永不消失）。改走本地 http 源后，
 * module / worker / code-splitting 全部正常工作——这也是 Capacitor/Cordova 的
 * 通用做法（它们用 https://localhost 或 capacitor:// 加载）。
 *
 * 本服务器只监听 127.0.0.1 回环地址，不对外网开放；仅做静态文件只读服务。
 */
class LocalHttpServer(private val context: Context) {

    private val serverSocket: ServerSocket =
        ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")) // 端口 0 => 随机空闲端口

    /** WebView 加载用的实际端口 */
    val port: Int = serverSocket.localPort

    private val executor: ExecutorService = Executors.newCachedThreadPool()

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
            socket.soTimeout = 8000
            val requestLine = socket.getInputStream().bufferedReader().readLine()
                ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2 || parts[0] != "GET") {
                respond(socket, 400, "text/plain", "Bad Request".toByteArray())
                return
            }
            var path = parts[1]
            if (path == "/") path = "/index.html"
            val queryIdx = path.indexOf('?')
            if (queryIdx >= 0) path = path.substring(0, queryIdx)

            val rel = path.removePrefix("/")
            if (rel.contains("..") || rel.startsWith("/") || rel.isEmpty()) {
                respond(socket, 403, "text/plain", "Forbidden".toByteArray())
                return
            }

            val stream: InputStream? = try {
                context.assets.open("folia/$rel")
            } catch (_: java.io.FileNotFoundException) {
                null
            }

            if (stream == null) {
                respond(socket, 404, "text/plain", "Not Found".toByteArray())
                return
            }
            val bytes = stream.readBytes()
            stream.close()
            val ext = rel.substringAfterLast('.', "")
            respond(socket, 200, mime(ext), bytes)
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

    private fun respond(socket: Socket, code: Int, type: String, body: ByteArray) {
        val reason = when (code) {
            200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"
            404 -> "Not Found"; 500 -> "Internal Server Error"; else -> "OK"
        }
        val head = "HTTP/1.1 $code $reason\r\n" +
            "Content-Type: $type\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        val out = socket.getOutputStream()
        out.write(head.toByteArray())
        out.write(body)
        out.flush()
    }

    private fun mime(ext: String): String = when (ext) {
        "html" -> "text/html"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        "webmanifest" -> "application/manifest+json"
        "ttf" -> "font/ttf"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "txt" -> "text/plain"
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
