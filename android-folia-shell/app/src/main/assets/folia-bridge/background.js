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

function onNativeMessage(msg) {
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
