/**
 * 招聘助手 · 简历采集 · ISOLATED world 桥
 *
 * MAIN world 没有 chrome.* API，service worker 也碰不到页面 window，
 * 所以必须由这一层做双向转发：
 *   MAIN → ISOLATED : window.postMessage（支持结构化克隆）
 *   ISOLATED → SW   : chrome.runtime.sendMessage（只做 JSON 序列化，Blob 会变空对象）
 *
 * 校验（不校验就会被同页脚本伪造数据投毒）：
 *   1) ev.source === window
 *   2) 魔数字段 __recruit_collect === 'v1'
 *   3) type 在入站白名单内
 *
 * 与 Phase 0 POC 的差异：POC 是「持续上报」，本文件只在被要求时才请求数据
 * （采集是主动触发形态，见 collect-hook.js 头注释）。
 */
(() => {
  'use strict';

  const NS = '__recruit_collect';
  const NS_VAL = 'v1';

  /** 等待 hook 应答的超时：超时说明该帧没有 hook 或页面未加载完，不该无限等 */
  const REPLY_TIMEOUT_MS = 1500;

  const INBOUND = {
    HOOK_READY: 1,
    STATUS_RESULT: 1,
    EXTRACT_RESULT: 1,
    RULES_ACK: 1
  };

  const pending = new Map(); // requestId -> {resolve, timer}
  let seq = 0;

  function nextRequestId() {
    seq += 1;
    return 'r' + seq + '-' + Math.random().toString(36).slice(2, 7);
  }

  function postToMain(msg) {
    try { window.postMessage(Object.assign({ [NS]: NS_VAL }, msg), '*'); }
    catch (e) { /* ignore */ }
  }

  /** 向 MAIN world 发指令并等待应答（超时返回 null，调用方据此判断该帧无数据） */
  function askHook(type, extra, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = nextRequestId();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs || REPLY_TIMEOUT_MS);
      pending.set(requestId, { resolve, timer });
      postToMain(Object.assign({ type, requestId }, extra || {}));
    });
  }

  function sendToBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload, frameUrl: safeHref() },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* SW 不在或扩展重载中 */ }
  }

  function safeHref() {
    try { return location.href; } catch (e) { return ''; }
  }

  // ---------- MAIN → SW ----------
  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d[NS] !== NS_VAL) return;
      if (!INBOUND[d.type]) return;

      // 有 requestId 的是「应答」，交给对应的等待者，不进 SW
      if (d.requestId && pending.has(d.requestId)) {
        const entry = pending.get(d.requestId);
        pending.delete(d.requestId);
        clearTimeout(entry.timer);
        entry.resolve(d.payload);
        return;
      }

      // HOOK_READY 等广播类消息转给 SW，作为「该帧 hook 已就绪」的诊断信号
      if (d.type === 'HOOK_READY') {
        sendToBackground('COLLECT_HOOK_READY', d.payload);
      }
    } catch (e) { /* ignore */ }
  }, false);

  // ---------- SW → MAIN（service worker 通过 chrome.tabs.sendMessage 广播到各帧） ----------
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        if (!msg || typeof msg !== 'object') return false;

        if (msg.type === 'COLLECT_EXTRACT') {
          askHook('EXTRACT', { scene: msg.scene }).then((payload) => {
            sendResponse({ ok: !!payload, payload: payload || null, frameUrl: safeHref() });
          });
          return true; // 异步应答
        }

        if (msg.type === 'COLLECT_STATUS') {
          askHook('STATUS').then((payload) => {
            sendResponse({ ok: !!payload, payload: payload || null, frameUrl: safeHref() });
          });
          return true;
        }

        if (msg.type === 'COLLECT_SET_RULES') {
          askHook('SET_RULES', { payload: msg.rules }).then((payload) => {
            sendResponse({ ok: !!payload, payload: payload || null, frameUrl: safeHref() });
          });
          return true;
        }

        return false;
      } catch (e) {
        try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* ignore */ }
        return false;
      }
    });
  } catch (e) { /* ignore */ }

  // 宣告桥已就绪（hook 收到后会把 bridgeReady 置真，仅用于诊断）
  postToMain({ type: 'BRIDGE_READY' });
  setTimeout(() => postToMain({ type: 'BRIDGE_READY' }), 120);
})();
