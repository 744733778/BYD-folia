// folia-bridge content script (isolated world, document_start).
//
// Two jobs:
//  1. Inject a <script> into the page MAIN world that defines window.foliaBridge /
//     window.nativeLibrary (the React bundle lives in the main world and probes there).
//  2. Relay: main-world shim --window.postMessage("request")--> here
//     --browser.runtime.sendMessage(target:background)--> background.js
//     --connectNative port--> native; the native reply comes back as the sendMessage
//     promise value, and we window.postMessage("result") back into the main world,
//     where the shim calls window.__foliaBridgeOnResult / __nativeLibraryOnResult.
//
// Loop prevention: requests carry __foliaBridge === "request", results carry
// __foliaBridge === "result"; each side only reacts to the opposite type and checks
// event.source === window.

(function () {
  'use strict';

  // ---- 1. Main-world shim source (runs in the page's main world) ----
  var SHIM_SOURCE = [
    '(function () {',
    '  if (window.__foliaShimInstalled) return;',
    '  window.__foliaShimInstalled = true;',
    '  function sendToBridge(ns, method, requestId, arg) {',
    '    window.postMessage({ __foliaBridge: "request", ns: ns, method: method, requestId: requestId, arg: arg }, "*");',
    '  }',
    '  window.foliaBridge = {',
    '    httpRequest: function (requestId, requestJson) {',
    '      sendToBridge("foliaBridge", "httpRequest", requestId, requestJson);',
    '    }',
    '  };',
    '  window.nativeLibrary = {',
    '    isAvailable: true,',
    '    pickDirectory: function (requestId) {',
    '      sendToBridge("nativeLibrary", "pickDirectory", requestId, null);',
    '    },',
    '    readFile: function (requestId, relativePath) {',
    '      sendToBridge("nativeLibrary", "readFile", requestId, relativePath);',
    '    }',
    '  };',
    '  window.addEventListener("message", function (e) {',
    '    if (e.source !== window) return;',
    '    var d = e.data;',
    '    if (!d || d.__foliaBridge !== "result") return;',
    '    var ok = !!d.ok;',
    '    var payload = typeof d.payload === "string" ? d.payload : (d.payload == null ? "" : String(d.payload));',
    '    if (d.ns === "foliaBridge" && typeof window.__foliaBridgeOnResult === "function") {',
    '      window.__foliaBridgeOnResult(d.requestId, ok, payload);',
    '    } else if (d.ns === "nativeLibrary" && typeof window.__nativeLibraryOnResult === "function") {',
    '      window.__nativeLibraryOnResult(d.requestId, ok, payload);',
    '    }',
    '  });',
    '})();'
  ].join('\n');

  function injectShim() {
    try {
      var s = document.createElement('script');
      s.textContent = SHIM_SOURCE;
      (document.documentElement || document.head || document.body).appendChild(s);
      // shim is self-contained; remove it so it does not linger
      if (s.parentNode) s.parentNode.removeChild(s);
    } catch (e) {
      console.warn('[folia-bridge] shim inject failed', e);
    }
  }

  // document_start: documentElement may already exist
  injectShim();

  // ---- 2. Relay shim <-> background ----
  var bridgeId = 0;

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__foliaBridge !== 'request') return;
    if (typeof d.requestId !== 'number') return;

    var myId = ++bridgeId;
    browser.runtime.sendMessage({
      target: 'background',
      id: myId,
      ns: d.ns,
      method: d.method,
      requestId: d.requestId,
      arg: d.arg
    }).then(function (reply) {
      if (!reply) return;
      window.postMessage({
        __foliaBridge: 'result',
        ns: reply.ns,
        requestId: reply.requestId,
        ok: !!reply.ok,
        payload: typeof reply.payload === 'string' ? reply.payload : (reply.payload == null ? '' : String(reply.payload))
      }, '*');
    }).catch(function (err) {
      window.postMessage({
        __foliaBridge: 'result',
        ns: d.ns,
        requestId: d.requestId,
        ok: false,
        payload: String(err && err.message ? err.message : err)
      }, '*');
    });
  });
})();
