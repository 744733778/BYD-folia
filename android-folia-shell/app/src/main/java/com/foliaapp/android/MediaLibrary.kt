package com.foliaapp.android

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 本地曲库索引：系统媒体扫描器（MediaStore）是唯一来源。
 *
 * 为什么不再自己递归扫盘：
 *  - 车机上是 scoped storage，「所有文件访问」要跳设置页、SAF 要用户点目录，两条路都容易在
 *    重启后丢授权（rootDoc 为 null → 前端被当成"未选目录"→ 每次都要重扫）。
 *  - aplayer 那套「音乐放 Music 文件夹 + 系统扫描」的实质是：索引归系统维护，APP 只做查询。
 *    查询几百行是毫秒级，重启后重新查一次即可，不需要任何授权状态。
 *
 * 快照形状与前端 NativeSnapshot 对齐：
 *   { mode:'media', root:'本地音乐', revision, files:[{path, relativePath, folder, size,
 *     lastModified, meta{title,artist,album,duration,bitrate}, sidecarPath?, coverUri?}] }
 *  - path / relativePath 都是 MediaStore content uri（readFile / /local / /cover 的键）
 *  - folder 只用于前端建目录树，避免把 content:// 当路径切出一堆伪目录
 */
class MediaLibrary(private val context: Context) {

    companion object {
        /** 认的音频扩展名（MediaStore 里理论上只有音频，留作兜底过滤） */
        private val AUDIO_EXT = setOf(
            "mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav",
            "wma", "ape", "alac", "aiff", "aif", "dsf", "dff", "mp4"
        )

        /** 文件夹封面候选名（不含扩展名，小写） */
        private val COVER_STEMS = setOf("cover", "folder", "front", "album", "albumart", "封面", "专辑")

        /** 默认纳入曲库的顶层目录（对应 RELATIVE_PATH 第一段）；可在 SP folia_scan_roots 覆盖 */
        private val DEFAULT_ROOTS = listOf(
            "Music", "音乐", "我的音乐", "车载音乐", "Audio", "Audiobooks", "Podcasts", "Recordings"
        )

        /** 快照内存缓存的保鲜期：前端冷启动会连查两次，避免重复扫表 */
        private const val CACHE_TTL_MS = 4000L
    }

    private val lock = Any()

    @Volatile
    private var cached: JSONObject? = null

    @Volatile
    private var cachedAt = 0L

    @Volatile
    private var cachedRevision = ""

    /** 最近一次成功构建的文件数（用于"查空了就退回缓存"） */
    @Volatile
    private var cachedCount = 0

    /**
     * 曲库快照。force=false 且缓存还在保鲜期内时直接返回缓存。
     * MediaStore 查空（权限没给/扫描器还没跑完）而缓存里还有歌时，返回缓存，
     * 避免前端把整库当成 0 首删掉。
     */
    fun snapshot(force: Boolean = false): JSONObject {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            if (!force && cached != null && now - cachedAt < CACHE_TTL_MS) return cached!!
            val fresh = build()
            if (fresh.optInt("count", 0) == 0 && cached != null && cachedCount > 0) {
                // 查不到但之前有：保留上一次结果，等 MediaStore 恢复/扫描完成
                return cached!!
            }
            cached = fresh
            cachedAt = now
            cachedRevision = fresh.optString("revision")
            cachedCount = fresh.optInt("count", 0)
            return fresh
        }
    }

    /** 最近一次快照的 revision（无缓存时为空串） */
    fun revision(): String = cachedRevision

    /** 把缓存标记为失效：媒体库变更广播/用户手动刷新时调用 */
    fun invalidate() {
        synchronized(lock) { cached = null; cachedAt = 0L }
    }

    // ==================== 构建 ====================

    private fun build(): JSONObject {
        val roots = scanRoots()
        // 歌词文件不是音频，MediaStore.Audio 查不到；先按目录批量捞一次 .lrc/.krc 的 content uri，
        // 音频行直接按"目录 + 基名"挂上去。查不到（Android 13+ 未授所有文件访问时非媒体文件不可见）就退化成
        // 绝对路径探测，行为与之前一致，不影响放歌。
        val lyrics = queryLyricUris(roots)
        // 第一遍按目录白名单收（避免把铃声/微信语音/App 音效全捞进来）；
        // 白名单一首都没命中（用户把歌放在 "My Music" 之类没预料到的目录）时，第二遍不限目录，
        // 宁可多几首也不要"明明有歌却看不到"。
        var obj = buildWithRoots(roots, lyrics)
        if (obj.optInt("count", 0) == 0 && roots.isNotEmpty()) {
            obj = buildWithRoots(emptyList(), lyrics)
        }
        return obj
    }

    private fun buildWithRoots(roots: List<String>, lyrics: Map<String, LyricUris>): JSONObject {
        val audioBase = audioCollection()
        val files = JSONArray()
        val folders = LinkedHashMap<String, String>() // folder -> 目录封面 content uri
        val albumArtCache = HashMap<Long, Boolean>() // albumId -> 该专辑是否真有图（同专辑多首歌共享，避免每首开流探测）
        var maxModified = 0L
        var count = 0

        if (roots.isNotEmpty()) {
            folders.putAll(queryFolderCovers(roots))
        }

        try {
            context.contentResolver.query(audioBase, audioProjection(), null, null, sortOrder())?.use { c ->
                val idI = c.getColumnIndex(MediaStore.Audio.Media._ID)
                val nameI = c.getColumnIndex(MediaStore.Audio.Media.DISPLAY_NAME)
                val relI = c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
                val dataI = c.getColumnIndex(MediaStore.Audio.Media.DATA)
                val sizeI = c.getColumnIndex(MediaStore.Audio.Media.SIZE)
                val modI = c.getColumnIndex(MediaStore.Audio.Media.DATE_MODIFIED)
                val titleI = c.getColumnIndex(MediaStore.Audio.Media.TITLE)
                val artistI = c.getColumnIndex(MediaStore.Audio.Media.ARTIST)
                val albumI = c.getColumnIndex(MediaStore.Audio.Media.ALBUM)
                val albumIdI = c.getColumnIndex(MediaStore.Audio.Media.ALBUM_ID)
                val durI = c.getColumnIndex(MediaStore.Audio.Media.DURATION)
                val volI = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    c.getColumnIndex(MediaStore.Audio.Media.VOLUME_NAME) else -1

                while (c.moveToNext()) {
                    val id = if (idI >= 0) c.getLong(idI) else 0L
                    if (id <= 0L) continue
                    val dataPath = if (dataI >= 0) c.getString(dataI) ?: "" else ""
                    val name = (if (nameI >= 0) c.getString(nameI) else null)
                        ?: dataPath.substringAfterLast('/').ifEmpty { "audio-$id" }
                    val ext = name.substringAfterLast('.', "").lowercase()
                    if (ext.isNotEmpty() && ext !in AUDIO_EXT) continue

                    val folderRel = relativeFolder(
                        if (relI >= 0) c.getString(relI) else null,
                        dataPath
                    )
                    if (!isUnderRoots(folderRel, roots)) continue

                    val volume = if (volI >= 0) c.getString(volI) else null
                    val contentUri = audioContentUri(volume, id).toString()
                    val size = if (sizeI >= 0) c.getLong(sizeI) else 0L
                    val modified = if (modI >= 0) c.getLong(modI) else 0L
                    if (modified > maxModified) maxModified = modified

                    val meta = JSONObject()
                    meta.put("title", strOrNull(c, titleI))
                    meta.put("artist", strOrNull(c, artistI))
                    meta.put("album", strOrNull(c, albumI))
                    meta.put("duration", if (durI >= 0) c.getLong(durI) else JSONObject.NULL)
                    meta.put("bitrate", JSONObject.NULL)

                    val o = JSONObject()
                    o.put("path", contentUri)
                    o.put("relativePath", contentUri)
                    o.put("folder", folderRel)
                    o.put("name", name)
                    o.put("mimeType", mimeOf(ext))
                    o.put("size", size)
                    o.put("lastModified", modified)
                    o.put("meta", meta)
                    // 歌词：优先 MediaStore.Files 里同基名的 .lrc/.krc（content uri，播放时按需读）；
                    // 拿不到再按绝对路径探测（Android 10 及以下、或已授"所有文件访问"的老车机）。
                    val lyricKey = lyricLookupKey(folderRel, name)
                    val lyricEntry = lyrics[lyricKey]
                    lyricEntry?.lyric?.let { o.put("sidecarPath", it) }
                    lyricEntry?.translation?.let { o.put("translationSidecarPath", it) }
                    if (!o.has("sidecarPath")) {
                        sidecarFor(dataPath)?.let { o.put("sidecarPath", it) }
                    }
                    folders[folderRel]?.let { o.put("coverUri", it) }
                    // 专辑图兜底（抄 APlayer 的快）：目录没有 cover.jpg 时用 MediaStore 的专辑图。
                    // 系统媒体库早就把每张专辑的封面抽出来缓存好了（albumart provider），按
                    // albumId 拼 content uri 让 LocalHttpServer /cover 出图即可——本地读缓存，
                    // 零网络，音乐墙/播放页瞬间有图，不必再走慢速在线匹配。
                    // 但 album_id 对"无内嵌封面"的歌也照样 >0，必须实测该 albumart URI 能否取到
                    // 字节，否则会把一个打不开的 URI 写进 coverUri：前端按"有本地封面"跳过在线
                    // 匹配，结果整片灰且无兜底（0.1.22 踩过的坑：模拟器/无图专辑全灰）。
                    if (!o.has("coverUri") && albumIdI >= 0) {
                        val albumId = c.getLong(albumIdI)
                        if (albumId > 0L && albumArtExists(albumId, albumArtCache)) {
                            o.put("coverUri", albumArtUri(albumId).toString())
                        }
                    }
                    files.put(o)
                    count++
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("MediaLibrary", "audio query failed", e)
        }

        return JSONObject().apply {
            put("mode", "media")
            put("root", "本地音乐")
            put("revision", "$count-$maxModified")
            put("count", count)
            put("files", files)
        }
    }

    // ==================== MediaStore 查询细节 ====================

    /**
     * API29+ 用 VOLUME_EXTERNAL 聚合查询：能一次拿到 U 盘/副卷的歌（主卷 URI 看不到它们）。
     * 拿到的行要用自己的 VOLUME_NAME 拼 content uri，否则跨卷 id 会指错文件。
     */
    private fun audioCollection(): Uri =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

    private fun audioContentUri(volumeName: String?, id: Long): Uri {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val volume = volumeName?.takeIf { it.isNotEmpty() } ?: MediaStore.VOLUME_EXTERNAL_PRIMARY
            return ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(volume), id)
        }
        return ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)
    }

    /** MediaStore 专辑图（系统已缓存）：/cover 端点可直接 openInputStream 出图。 */
    private fun albumArtUri(albumId: Long): Uri =
        ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), albumId)

    /**
     * 实测该 albumId 是否真的有专辑图。MediaStore 给每个音频文件都分配了 album_id（哪怕
     * 没有内嵌封面），所以光看 album_id>0 不足以判断有图；必须尝试 openInputStream 并确认
     * 至少能读到一个字节。结果按 albumId 缓存，同一专辑的多首歌只探测一次。
     */
    private fun albumArtExists(albumId: Long, cache: MutableMap<Long, Boolean>): Boolean {
        cache[albumId]?.let { return it }
        var exists = false
        try {
            context.contentResolver.openInputStream(albumArtUri(albumId))?.use { ist ->
                exists = ist.read() != -1
            }
        } catch (_: Exception) {
            exists = false
        }
        cache[albumId] = exists
        return exists
    }

    private fun audioProjection(): Array<String> {
        val base = mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.ALBUM_ID,
            MediaStore.Audio.Media.DURATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            base.add(MediaStore.Audio.Media.RELATIVE_PATH)
            base.add(MediaStore.Audio.Media.VOLUME_NAME)
        }
        return base.toTypedArray()
    }

    /** RELATIVE_PATH 是 API29 才有的列，老系统按文件名排 */
    private fun sortOrder(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "${MediaStore.Audio.Media.RELATIVE_PATH} ASC, ${MediaStore.Audio.Media.DISPLAY_NAME} ASC"
        } else {
            "${MediaStore.Audio.Media.DISPLAY_NAME} ASC"
        }

    /**
     * 目录封面：在纳入曲库的目录下找 cover/folder/front/album 之类的图片。
     * 一次查询建 folder->uri 映射，命中即给该目录所有曲目挂 coverUri，
     * 前端直接 /cover?uri=... 同源出图，字节不进 JS。
     */
    private fun queryFolderCovers(roots: List<String>): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        val priority = HashMap<String, Int>()
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val projection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.RELATIVE_PATH,
                MediaStore.Images.Media.VOLUME_NAME
            )
        } else {
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATA
            )
        }
        // 只查曲库根目录下的图片，避免把相册整表拉一遍
        val selection = roots.joinToString(" OR ") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?"
            } else {
                "${MediaStore.Images.Media.DATA} LIKE ?"
            }
        }
        val args = roots.map { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "$it/%" else "%/$it/%" }.toTypedArray()

        try {
            context.contentResolver.query(collection, projection, selection, args, null)?.use { c ->
                val idI = c.getColumnIndex(MediaStore.Images.Media._ID)
                val nameI = c.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME)
                val relI = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    c.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH) else -1
                val dataI = c.getColumnIndex(MediaStore.Images.Media.DATA)
                val volI = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    c.getColumnIndex(MediaStore.Images.Media.VOLUME_NAME) else -1

                while (c.moveToNext()) {
                    val id = if (idI >= 0) c.getLong(idI) else 0L
                    if (id <= 0L) continue
                    val name = if (nameI >= 0) c.getString(nameI) ?: "" else ""
                    val stem = name.substringBeforeLast('.').lowercase()
                    val rank = when (stem) {
                        "cover" -> 0
                        "folder" -> 1
                        "front" -> 2
                        "album", "albumart" -> 3
                        "封面", "专辑" -> 4
                        else -> 9
                    }
                    if (rank > 4) continue
                    val dataPath = if (dataI >= 0) c.getString(dataI) ?: "" else ""
                    val dir = relativeFolder(if (relI >= 0) c.getString(relI) else null, dataPath)
                    val prev = priority[dir]
                    if (prev != null && prev <= rank) continue
                    val volume = if (volI >= 0) c.getString(volI) else null
                    val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentUris.withAppendedId(
                            MediaStore.Images.Media.getContentUri(
                                volume?.takeIf { it.isNotEmpty() } ?: MediaStore.VOLUME_EXTERNAL_PRIMARY
                            ),
                            id
                        )
                    } else {
                        ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                    }
                    priority[dir] = rank
                    result[dir] = uri.toString()
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("MediaLibrary", "cover query failed", e)
        }
        return result
    }

    // ==================== 路径工具 ====================

    /** 曲库根目录列表（SP 可覆盖；空串=不筛选） */
    private fun scanRoots(): List<String> {
        val raw = context.getSharedPreferences("folia_saf", Context.MODE_PRIVATE)
            .getString("folia_scan_roots", null)
        val list = raw?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: DEFAULT_ROOTS
        return list.filter { it != "-" }
    }

    private fun isUnderRoots(folderRel: String, roots: List<String>): Boolean {
        if (rootListDisabled(roots)) return true
        val first = folderRel.substringBefore('/')
        return roots.any { it.equals(first, ignoreCase = true) }
    }

    /** 根列表里显式给了空集合 → 认为"全部目录都要" */
    private fun rootListDisabled(roots: List<String>): Boolean = roots.isEmpty()

    /** RELATIVE_PATH（"Music/Album/"）/ DATA 绝对路径 → 统一成 "Music/Album" */
    private fun relativeFolder(relativePath: String?, dataPath: String?): String {
        val rel = relativePath?.trim('/')?.trim()
        if (!rel.isNullOrEmpty()) return rel
        if (dataPath.isNullOrEmpty()) return ""
        val parts = dataPath.split('/')
        // /storage/emulated/0/Music/x.mp3 → 跳过 storage/emulated/0；/storage/XXXX-XXXX/Music/x.mp3 → 跳过 storage/卷名
        val skip = when {
            parts.size > 4 && parts.getOrNull(1) == "storage" && parts.getOrNull(2) == "emulated" -> 4
            parts.size > 3 && parts.getOrNull(1) == "storage" -> 3
            parts.size > 3 && parts.getOrNull(1) == "sdcard" -> 2
            else -> 0
        }
        return parts.drop(skip).dropLast(1).joinToString("/")
    }

    // ==================== 歌词 sidecar ====================

    /** 一个基名下的两份歌词：主歌词与翻译歌词（.t.lrc / .t.vtt） */
    private data class LyricUris(val lyric: String?, val translation: String?)

    /** 音频条目 → 歌词查表键：目录 + 去掉扩展名的文件名，统一小写。 */
    private fun lyricLookupKey(folderRel: String, fileName: String): String {
        val rawBase = fileName.substringBeforeLast('.')
        return (if (folderRel.isEmpty()) rawBase else "$folderRel/$rawBase").lowercase()
    }

    /**
     * 批量查歌词文件（.lrc/.krc/.qrc/.yrc/.fia/.vtt/.ttml 及其 .t.* 翻译版）。
     *
     * 为什么查 MediaStore.Files 而不是自己扫目录：Android 11+ 直接按路径读非媒体文件会被拒绝，
     * 而 Files 表在授了「所有文件访问」的设备上能给出 content uri，走 ContentResolver 读就不受路径限制。
     * Android 13+ 普通媒体权限下 Files 只返回媒体行，这段会查空——不影响放歌，只是回到"没有歌词"。
     */
    private fun queryLyricUris(roots: List<String>): Map<String, LyricUris> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return emptyMap()
        val suffixes = listOf(".lrc", ".krc", ".qrc", ".yrc", ".fia", ".vtt", ".ttml")
        val selection = suffixes.joinToString(" OR ") {
            "${MediaStore.Files.FileColumns.DISPLAY_NAME} LIKE ?"
        }
        val args = suffixes.map { "%$it" }.toTypedArray()
        val result = HashMap<String, LyricUris>()

        try {
            val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
            context.contentResolver.query(
                collection,
                arrayOf(
                    MediaStore.Files.FileColumns._ID,
                    MediaStore.Files.FileColumns.DISPLAY_NAME,
                    MediaStore.Files.FileColumns.RELATIVE_PATH,
                    MediaStore.Files.FileColumns.VOLUME_NAME
                ),
                selection,
                args,
                null
            )?.use { c ->
                val idI = c.getColumnIndex(MediaStore.Files.FileColumns._ID)
                val nameI = c.getColumnIndex(MediaStore.Files.FileColumns.DISPLAY_NAME)
                val relI = c.getColumnIndex(MediaStore.Files.FileColumns.RELATIVE_PATH)
                val volI = c.getColumnIndex(MediaStore.Files.FileColumns.VOLUME_NAME)

                while (c.moveToNext()) {
                    val name = (if (nameI >= 0) c.getString(nameI) else null) ?: continue
                    val lower = name.lowercase()
                    val folderRel = (if (relI >= 0) c.getString(relI) else null)?.trim('/') ?: ""
                    if (!isUnderRoots(folderRel, roots)) continue

                    val isTranslation = lower.endsWith(".t.lrc") || lower.endsWith(".t.vtt")
                    var base = if (isTranslation) {
                        name.dropLast(6) // ".t.lrc" / ".t.vtt"
                    } else {
                        val suffix = suffixes.firstOrNull { lower.endsWith(it) } ?: continue
                        name.dropLast(suffix.length)
                    }
                    // "01.mp3.lrc" 这种写法：去掉歌词后缀后还带音频扩展名
                    if (base.substringAfterLast('.', "").lowercase() in AUDIO_EXT) {
                        base = base.substringBeforeLast('.')
                    }
                    if (base.isEmpty()) continue

                    val volume = if (volI >= 0) c.getString(volI) else null
                    val id = if (idI >= 0) c.getLong(idI) else 0L
                    if (id <= 0L) continue
                    val fileUri = MediaStore.Files.getContentUri(
                        volume?.takeIf { it.isNotEmpty() } ?: MediaStore.VOLUME_EXTERNAL_PRIMARY
                    )
                    val uri = ContentUris.withAppendedId(fileUri, id).toString()
                    val key = (if (folderRel.isEmpty()) base else "$folderRel/$base").lowercase()
                    val existing = result[key] ?: LyricUris(null, null)
                    result[key] = if (isTranslation) {
                        if (existing.translation == null) existing.copy(translation = uri) else existing
                    } else {
                        if (existing.lyric == null) existing.copy(lyric = uri) else existing
                    }
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("MediaLibrary", "lyric query failed", e)
        }
        return result
    }

    /** 同名同目录 sidecar 歌词：只有能按绝对路径读到文件时才给（否则给了也读不了） */
    private fun sidecarFor(dataPath: String): String? {
        if (dataPath.isEmpty()) return null
        val base = dataPath.substringBeforeLast('.')
        for (ext in arrayOf(".lrc", ".krc")) {
            val f = File(base + ext)
            if (f.isFile && f.canRead()) return f.absolutePath
        }
        return null
    }

    private fun strOrNull(c: android.database.Cursor, idx: Int): Any {
        if (idx < 0) return JSONObject.NULL
        val v = c.getString(idx) ?: return JSONObject.NULL
        // MediaStore 对未知标签会填 "<unknown>"，当缺失处理
        if (v.isBlank() || v == "<unknown>") return JSONObject.NULL
        return v
    }

    private fun mimeOf(ext: String): String = when (ext) {
        "mp3" -> "audio/mpeg"
        "m4a", "mp4", "alac" -> "audio/mp4"
        "aac" -> "audio/aac"
        "flac" -> "audio/flac"
        "ogg", "oga" -> "audio/ogg"
        "opus" -> "audio/opus"
        "wav" -> "audio/wav"
        "wma" -> "audio/x-ms-wma"
        "ape" -> "audio/x-ape"
        "aiff", "aif" -> "audio/aiff"
        "dsf", "dff" -> "audio/dsd"
        else -> "audio/*"
    }
}
