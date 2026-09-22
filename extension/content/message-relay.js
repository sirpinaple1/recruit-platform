/**
 * Content Script: 消息中转器
 *
 * 职责：双向转发页面与 background 之间的消息
 *
 * Phase 1 - 零配置授权流程：
 * bridge.js (页面)
 *   -> postMessage
 *   -> 本脚本 (content script)
 *   -> chrome.runtime.sendMessage
 *   -> background.js
 *
 * Phase 2 - 中台触发流程：
 * 页面 -> bridge.js -> 本脚本 -> background.js（FILL_REQUEST）
 * background.js -> 本脚本 -> bridge.js -> 页面（FILL_PROGRESS/FILL_RESULT/PUBLISH_BACK）
 *
 * 失效处理（2026-09-22）：
 * 扩展被重载 / 更新 / 禁用后，已经注入页面的 content script 会变成"孤儿"——
 * chrome.runtime.id 置空，任何 chrome.* 调用都会抛
 * "Extension context invalidated"。此时本脚本不再转发消息，改为向页面广播一条
 * EXT_UNAVAILABLE，让中台 UI 提示"扩展已更新，请刷新页面"，而不是静默地
 * 判定为"未安装"。
 *
 * ⚠️ 必须整体包在 IIFE 里（2026-09-22 事故）：
 * manifest 中本文件与 bridge.js 同属一个 content_scripts 的 js 数组，
 * 二者被注入**同一个隔离世界**（同源同帧只有一个 world）。若各自在顶层用
 * let/const 声明同名变量（当时两边都有 `let contextDead`），后执行的那支会
 * 直接抛 "Identifier 'X' has already been declared"，整支脚本不运行。
 * 包成 IIFE 后各文件自成一个作用域，同名不再互相干扰。
 */
(() => {
  'use strict';

  /** 注入标记：同一页面被重复注入时跳过，避免监听器叠加导致重复转发 */
  const RELAY_FLAG = 'recruit-message-relay';

  if (window[RELAY_FLAG]) {
    console.log('[MessageRelay] 已注入，跳过');
    return;
  }
  window[RELAY_FLAG] = true;

  /**
   * 扩展上下文是否仍然有效
   *
   * 判定依据：chrome.runtime.id 存在且有值。上下文失效时该属性为 undefined
   * （不抛错），因此取到 falsy 即可认定失效。
   */
  function isContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** 上下文失效只广播一次，避免重复刷屏 */
  let contextDead = false;

  function notifyContextDead(reason) {
    if (contextDead) return;
    contextDead = true;
    const message = String((reason && reason.message) || reason || '扩展上下文已失效');
    console.warn('[MessageRelay] 扩展上下文已失效，停止转发:', message);
    try {
      window.postMessage(
        {
          type: 'EXT_UNAVAILABLE',
          source: 'recruit-extension',
          payload: { reason: message },
        },
        window.location.origin
      );
    } catch (e) {
      // 页面已跳转或上下文异常，忽略
    }
  }

  /** 是否属于"上下文化失效"类错误 */
  function isInvalidationError(text) {
    return /context invalidated|extension context/i.test(String(text || ''));
  }

  /**
   * 安全转发到 background
   *
   * 上下文失效、调用抛错、background 返回失效错误——三种情况统一降级，
   * 都不会向上冒泡成未捕获异常。
   */
  function sendToBackground(msg, label) {
    if (!isContextAlive()) {
      notifyContextDead('扩展已被重载或停用');
      return false;
    }
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          const text = lastError.message || String(lastError);
          if (isInvalidationError(text)) {
            notifyContextDead(text);
            return;
          }
          console.error('[MessageRelay] ' + label + ' 转发失败:', text);
          return;
        }
        console.log('[MessageRelay] Background 响应(' + label + '):', response);
      });
      return true;
    } catch (e) {
      notifyContextDead(e);
      return false;
    }
  }

  // 监听页面消息，转发给 background
  window.addEventListener('message', (event) => {
    // 只接受来自同源的消息
    if (event.source !== window) return;

    const msg = event.data;

    // 过滤：只转发 bridge 重发过的消息。页面原始消息（source='recruit-platform'）由
    // bridge.js 接收并以 source='recruit-bridge' 重发；若此处也接受原始来源，同一条
    // FILL_REQUEST 会被转发两次，background 会开两个 tab（2026-09-18 双开修复）。
    if (!msg || msg.source !== 'recruit-bridge') return;

    if (contextDead) return;

    // Phase 1: 零配置授权
    if (msg.type === 'RECRUIT_SESSION_DETECTED') {
      console.log('[MessageRelay] 转发登录态通知到 background');
      sendToBackground(msg, 'RECRUIT_SESSION_DETECTED');
    }

    // Phase 2: 填充请求
    if (msg.type === 'FILL_REQUEST') {
      console.log('[MessageRelay] 转发 FILL_REQUEST 到 background:', msg.payload);
      sendToBackground(msg, 'FILL_REQUEST');
    }
  });

  // 监听 background 消息，转发给页面
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log('[MessageRelay] 收到 background 消息:', msg);

    // Phase 2: 填充进度、结果、发布回执
    if (['FILL_PROGRESS', 'FILL_RESULT', 'PUBLISH_BACK'].includes(msg.type)) {
      console.log('[MessageRelay] 转发给页面:', msg);
      // 加上 source 标识，让 bridge.js 识别这是扩展发来的消息
      window.postMessage(
        {
          ...msg,
          source: 'recruit-extension',
        },
        window.location.origin
      );
      sendResponse({ success: true });
    }

    return true; // 保持消息通道开启（异步响应）
  });
})();
