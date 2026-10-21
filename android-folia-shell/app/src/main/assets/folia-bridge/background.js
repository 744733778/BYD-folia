// folia-bridge background relay.
//
// Links:
//   content script --browser.runtime.sendMessage({target:"background", id, ns, method, requestId, arg})--> here
//   here --connectNative("browser") port.postMessage({id, ns, method, requestId, arg})--> native MainActivity
//   native --port.postMessage({id, ns, requestId, ok, payload})--> here
//   here --resolve(pending[id] promise)--> content script
//
// The content-side promise resolves with the WHOLE native reply object
// {id, ns, requestId, ok, payload}; content.js then forwards it to the main world.

let port = null;
// content-side request id -> resolve callback
const pending = new Map();

/**
 * 原生推送（无 id，如 system.mediaKey）广播给所有 content script。
 *
 * 这里**不能**用 browser.runtime.sendMessage：从 background 发出的 runtime 消息到不了
 * content script，Gecko 直接报 "Could not establish connection. Receiving end does not exist."
 * （此前所有版本的原生事件——方向盘按键、音量键、诊断——全卡死在这一行，静默丢失）。
 * 按扩展规范，给 content script 发消息必须走 tabs.sendMessage。
 */
function broadcastPush(pushMsg) {
  browser.tabs.query({}).then(function (tabs) {
    (tabs || []).forEach(function (t) {
      if (!t || typeof t.id !== "number") return;
      browser.tabs.sendMessage(t.id, { target: "content", push: pushMsg }).catch(function () {});
    });
  }).catch(function () {});
}

function onNativeMessage(msg) {
  // 原生推送（无 id，如 system.mediaKey）：广播给所有 content script，不进 pending map
  if (msg && msg.push) {
    broadcastPush(msg);
    return;
  }
  if (!msg || typeof msg.id === "undefined") return;
  if (pending.has(msg.id)) {
    const done = pending.get(msg.id);
    pending.delete(msg.id);
    try { done(msg); } catch (_) {}
  }
}

function connect() {
  if (port) return;
  try {
    port = browser.runtime.connectNative("browser");
  } catch (e) {
    console.warn("[folia-bridge] connectNative failed, retry in 500ms:", e);
    setTimeout(connect, 500);
    return;
  }
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(() => {
    console.warn("[folia-bridge] native port disconnected");
    port = null;
    setTimeout(connect, 500);
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.target !== "background") return;
  return new Promise((resolve) => {
    pending.set(msg.id, resolve);
    const trySend = () => {
      if (!port) {
        connect();
        setTimeout(trySend, 100);
        return;
      }
      try {
        port.postMessage({
          id: msg.id,
          ns: msg.ns,
          method: msg.method,
          requestId: msg.requestId,
          arg: msg.arg
        });
      } catch (e) {
        pending.delete(msg.id);
        resolve({
          id: msg.id,
          ns: msg.ns,
          requestId: msg.requestId,
          ok: false,
          payload: "native port send failed: " + e
        });
      }
    };
    trySend();
  });
});

connect();
