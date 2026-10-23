import type { LocalSong } from '../types';

// src/utils/localSongCover.ts
// Detects the canonical content-addressed local cover reference.

// 原生壳的封面（目录 cover.jpg / MediaStore 专辑图，经 LocalHttpServer /cover 出图）也是
// 本地封面：有它就不该再发起在线封面匹配。此前只认 localCoverAssetId，导致车机上每首
// 明明有本地图的歌在首次播放时都要等一次慢速在线搜索——这正是"封面匹配很久才到正在
// 播放这首"的主要来源之一（0.1.22）。
export const hasLocalSongCover = (song: LocalSong): boolean => (
  Boolean(song.localCoverAssetId || song.nativeCoverUrl)
);
