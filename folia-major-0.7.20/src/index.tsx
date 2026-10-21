// 页面世界的 window.foliaBridge / window.nativeLibrary 由内置 WebExtension 的 content script
// 在 document_start 注入（见 android-folia-shell/assets/folia-bridge/content.js）。
// 曾经这里还 import 过一个 geckoNativeBridge 自己再装一套，两套监听会让同一个媒体键事件
// 分发两次（按一次下一曲跳两首），已删除。
import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// 前端版本号：车机上"改了却没生效"排查了整整一轮，根因是 Service Worker 让页面继续跑旧 JS。
// 这一行让会话日志的第一条就能回答"现在跑的是哪一版前端"，不必再去猜。
// （壳内已不再注册 SW，见 public/runtime-config.js；这行留着，以后仍然用得上。）
console.log('[Boot] ui', __APP_VERSION__, __BUILD_TIME__, __BUILD_COMMIT__ || __COMMIT_HASH__ || 'dev');
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();

void import('./bootstrap');
