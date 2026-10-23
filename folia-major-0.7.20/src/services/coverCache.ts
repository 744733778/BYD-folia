import { getFromCache, removeFromCache, saveToCache } from './db';
import { createSafeObjectUrl, isBlob } from '../utils/blobGuards';
import {
    clearCoverAssets,
    getCoverAssetUsage,
    readCoverAsset,
    removeCoverAsset,
    writeCoverAsset,
    type BinaryAssetWriteResult,
} from './binaryAssetStore';

interface StoredCoverDescriptor extends BinaryAssetWriteResult { }

const isStoredCoverDescriptor = (value: unknown): value is StoredCoverDescriptor => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredCoverDescriptor>;
    return (candidate.backend === 'opfs' || candidate.backend === 'electron')
        && typeof candidate.mimeType === 'string'
        && typeof candidate.size === 'number'
        && typeof candidate.updatedAt === 'number';
};

const buildCoverRequestUrl = (coverUrl: string): string => {
    if (typeof window !== 'undefined' && window.electron) return coverUrl;
    try {
        const hostname = new URL(coverUrl).hostname;
        // 安卓壳：前端从 LocalHttpServer（127.0.0.1）同源加载，经同源 /fetch 代理出图，
        // 绕开 webview 的 CORS 限制（网易/QQ/酷狗封面 CDN 普遍不带 CORS 头，浏览器 fetch
        // 直接失败——这正是自动匹配封面整片缺失的根因）。该端点只在我们自己的 LocalHttpServer
        // 上才有，靠 hostname 判断可精准命中、不会误伤普通 web 部署。
        if (typeof window !== 'undefined'
            && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')) {
            return `${window.location.origin}/fetch?url=${encodeURIComponent(coverUrl)}`;
        }
        if (hostname === 'y.gtimg.cn'
            || hostname === 'kugou.com' || hostname.endsWith('.kugou.com')
            || hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com')) {
            return `/api/lyric-proxy?url=${encodeURIComponent(coverUrl)}`;
        }
    } catch {
        return coverUrl;
    }
    return coverUrl;
};

const fetchCoverBlob = async (coverUrl: string): Promise<Blob> => {
    const response = await fetch(buildCoverRequestUrl(coverUrl), { mode: 'cors' });
    if (response.ok === false) throw new Error(`Cover request failed: ${response.status}`);
    return await response.blob();
};

export async function getCachedCoverUrl(cacheKey: string): Promise<string | null> {
    const stored = await getFromCache<unknown>(cacheKey);
    if (isBlob(stored)) {
        const descriptor = await writeCoverAsset(cacheKey, stored).catch(() => null);
        if (!descriptor) {
            return createSafeObjectUrl(stored);
        }
        await saveToCache(cacheKey, descriptor);
        return createSafeObjectUrl(stored);
    }

    if (stored !== null && !isStoredCoverDescriptor(stored)) {
        await removeFromCache(cacheKey);
        await removeCoverAsset(cacheKey);
        return null;
    }

    const cachedCover = await readCoverAsset(cacheKey, isStoredCoverDescriptor(stored) ? stored.mimeType : undefined);
    if (!cachedCover) {
        if (stored) await removeFromCache(cacheKey);
        return null;
    }
    return createSafeObjectUrl(cachedCover);
}

/**
 * Whether a cover is already stored, without minting an object URL to find out.
 *
 * `getCachedCoverUrl` is the wrong question to ask when nothing is going to be displayed: it reads
 * the bytes and hands back a URL that a caller checking for mere existence then has to remember to
 * revoke. Reads the descriptor only, and accepts the legacy raw-Blob shape the same way the reader
 * above does, so a cover written before the asset store existed still counts as cached.
 */
export async function hasCachedCover(cacheKey: string): Promise<boolean> {
    const stored = await getFromCache<unknown>(cacheKey);
    return isBlob(stored) || isStoredCoverDescriptor(stored);
}

export async function loadCachedOrFetchCover(cacheKey: string, coverUrl?: string | null): Promise<string | null> {
    if (!coverUrl) return null;

    try {
        const cachedCoverUrl = await getCachedCoverUrl(cacheKey);
        if (cachedCoverUrl) {
            return cachedCoverUrl;
        }

        const coverBlob = await fetchCoverBlob(coverUrl);
        const descriptor = await writeCoverAsset(cacheKey, coverBlob).catch(() => null);
        if (descriptor) await saveToCache(cacheKey, descriptor);
        return createSafeObjectUrl(coverBlob) || coverUrl;
    } catch (error) {
        console.warn('Failed to cache cover:', error);
        return coverUrl;
    }
}

export async function saveCoverBlob(cacheKey: string, coverBlob: Blob): Promise<void> {
    const descriptor = await writeCoverAsset(cacheKey, coverBlob).catch(() => null);
    if (descriptor) {
        await saveToCache(cacheKey, descriptor);
        return;
    }
    await saveToCache(cacheKey, coverBlob);
}

// Replaces the cached online cover used by local-song playback without changing the audio file.
export async function cacheLocalSongOnlineCover(songId: string, coverUrl: string): Promise<boolean> {
    const cacheKey = `cover_local_${songId}`;
    await removeCachedCover(cacheKey);
    try {
        const descriptor = await writeCoverAsset(cacheKey, await fetchCoverBlob(coverUrl));
        if (!descriptor) return false;
        await saveToCache(cacheKey, descriptor);
        return true;
    } catch (error) {
        console.warn('[LocalMusic] Failed to cache matched cover:', error);
        return false;
    }
}

export async function removeCachedCover(cacheKey: string): Promise<void> {
    await Promise.all([removeFromCache(cacheKey), removeCoverAsset(cacheKey)]);
}

export { clearCoverAssets, getCoverAssetUsage };
