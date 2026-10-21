// 当前文件：非 Docker Web 部署的空运行时配置，具体值继续由 Vite 环境变量提供。
window.__FOLIA_RUNTIME_CONFIG__ = window.__FOLIA_RUNTIME_CONFIG__ || {};

// ---------------------------------------------------------------------------
// 安卓壳里把 Service Worker 清掉。
//
// 壳内的页面由 LocalHttpServer 从 APK 的 assets 提供，升级 APK 就该立刻是新前端。
// 但 PWA 的 Workbox 预缓存按 URL 缓存 index.html 和整套 assets，且端口固定
// (47777-47781，last_port 持久化)，origin 一直不变 —— 旧的 SW 于是跨版本活下来，
// 升级后仍然喂旧 JS。表现就是：模拟器全新安装能看到新界面，车机看不到；
// 原生层(dex)明明是新的，前端却还是几版之前的。
//
// 这个文件之所以能修它：`globIgnores: ['**/runtime-config.js', ...]` 让它不进预缓存，
// 每次加载都向本地服务器请求，所以旧页面也会拿到这份新代码 —— 这是唯一能在
// "旧前端已被 SW 接管"的局面下执行到的地方。
//
// 判定条件刻意收得很窄：只有壳的 origin（127.0.0.1:47777-47781）才动手，
// Web 部署和手机浏览器里的 PWA 离线能力一点不受影响。
(function () {
    try {
        var isShellOrigin = /^127\.0\.0\.1:4777[7-9]$|^127\.0\.0\.1:4778[01]$/.test(location.host);
        if (!isShellOrigin) return;
        if (!('serviceWorker' in navigator)) return;

        // 做过就永不再做；sessionStorage 再兜一层，防止 unregister 没生效时反复重载。
        var DONE_KEY = 'folia_shell_sw_purged_v1';
        var TRY_KEY = 'folia_shell_sw_reload_v1';
        try {
            if (localStorage.getItem(DONE_KEY) === '1') return;
            if (sessionStorage.getItem(TRY_KEY) === '1') return;
        } catch (e) { /* 存储不可用时照常往下走，靠 promise 自身收敛 */ }

        var settle = function (needsReload) {
            try {
                localStorage.setItem(DONE_KEY, '1');
                sessionStorage.setItem(TRY_KEY, '1');
            } catch (e) { /* ignore */ }
            // 只有确实卸掉了 SW 才重载：没有 SW 的机器不必多刷一次。
            if (needsReload) location.reload();
        };

        navigator.serviceWorker.getRegistrations().then(function (regs) {
            if (!regs || regs.length === 0) {
                settle(false);
                return;
            }
            Promise.all(regs.map(function (r) { return r.unregister(); })).then(function () {
                var purge = (window.caches && caches.keys)
                    ? caches.keys().then(function (keys) {
                        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
                    })
                    : Promise.resolve();
                purge.then(function () { settle(true); }, function () { settle(true); });
            }, function () {
                // 注销失败：不重载，至少别把用户困在刷新循环里。
                settle(false);
            });
        }, function () { settle(false); });
    } catch (e) { /* 诊断不该影响启动 */ }
})();
