/**
 * 招聘助手 · 岗位探针转发（ISOLATED 世界）
 *
 * 运行环境：隔离世界。两种注入方式都会用到本文件：
 *   · 录制会话期间由 background **动态注册**（registerContentScripts，document_start、全帧）
 *   · 单次发布任务由 injectSentinel **程序化注入**（顶层帧兜底）
 *
 * 职责（两个方向）：
 *   · 上行：把本帧 MAIN 世界探针 postMessage 出来的录制条目 / 岗位提示，转交 background
 *     （只有 background 能访问 chrome.storage 与宿主网络）。
 *   · 下行：把「当前是否在录」同步进本帧的探针（见下方「为什么必须主动问一次」）。
 *
 * ★ 为什么上行要按 `ev.source === window` 过滤（实测后改回来的）★
 *   探针会同时投递到**本帧**与**顶层帧**（投顶层是为了让顶层哨兵能收到 JOB_HINT）。
 *   若本文件在全帧都注册、却不过滤来源，顶层转发层会把「子帧投给顶层」的那一份
 *   再转一次 —— 同一条响应被上报两遍，数据看起来翻倍，会直接毁掉诊断结论。
 *   加上本过滤后：每条消息只由**它自己所在帧**的转发层上报一次，恰好一次。
 *
 * ★ 为什么必须主动问一次开关（而不是等 background 推）★
 *   动态注册的脚本在 document_start 就跑起来了，此时 background 还没机会往
 *   window 上写 `__RECRUIT_JOB_PROBE_RECORD__`；而探针是在装载时读一次该标志。
 *   所以由本转发层向 background 问一次当前状态，再广播进本帧，探针据此开录。
 *   没有这一步，录制会「开关开着但探针以为自己是关的」——静默录不到。
 *
 * 合规：本脚本只做搬运，不解析内容、不落盘、不主动外发。
 *      是否录制由人在 popup 里决定；数据只进 chrome.storage.session，导出须人点按钮。
 *
 * ⚠️ 整体包 IIFE：与其它注入脚本共享顶层作用域，裸写 let/const 会在同名时抛
 *    SyntaxError 并让整支脚本不运行（见 bridge.js 事故）。
 */
(() => {
  'use strict';

  const NS = '__recruit_job_probe';
  const NS_VAL = 'v1';
  const GUARD = '__recruit_job_probe_relay_active';

  if (window[GUARD]) {
    return; // 已注入，避免重复挂监听
  }
  window[GUARD] = true;

  /** 把一条指令广播进本帧的 MAIN 世界 */
  function broadcast(command) {
    try {
      window.postMessage({ [NS]: NS_VAL, type: command }, '*');
    } catch (e) { /* ignore */ }
  }

  /** 上行：转发给 background（worker 可能正在重启，失败静默） */
  function toBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => {
        // 读一下 lastError，否则 worker 休眠/重载时会打一条无害但刺眼的
        // "Unchecked runtime.lastError" 到扩展错误页
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // 扩展上下文失效（重载扩展）时必然抛，属正常，咽掉
    }
  }

  /** 只转本帧自己发出的消息（见文件头说明） */
  function isOwnFrameMessage(ev) {
    try {
      return ev.source === window;
    } catch (e) {
      return false;
    }
  }

  window.addEventListener('message', (ev) => {
    try {
      const d = ev.data;
      if (!d || typeof d !== 'object' || d[NS] !== NS_VAL) return;
      if (!isOwnFrameMessage(ev)) return; // 顶层帧不再替子帧转一次
      switch (d.type) {
        case 'RECORD':
          toBackground('JOB_PROBE_RECORD', d.payload);
          break;
        case 'RECORD_LIMIT':
          toBackground('JOB_PROBE_RECORD_LIMIT', d.payload);
          break;
        case 'RECORD_STATE':
          toBackground('JOB_PROBE_RECORD_STATE', d.payload);
          break;
        case 'JOB_HINT':
          toBackground('JOB_PROBE_HINT', d.payload);
          break;
        default:
          break;
      }
    } catch (e) { /* 转发异常绝不能影响页面 */ }
  }, false);

  // 装载时同步一次开关：探针在 document_start 就被注册进来了，此刻它还不知道该不该录。
  // 探针可能比本回调更晚装好，所以回执到达后再补发一次（两条 RECORD_ON 是幂等的）。
  (function syncFlag(retry) {
    try {
      chrome.runtime.sendMessage({ type: 'DIAG_GET_FLAG' }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.recording) broadcast('RECORD_ON');
        if (retry) setTimeout(() => broadcast(r && r.recording ? 'RECORD_ON' : 'RECORD_OFF'), 600);
      });
    } catch (e) { /* 扩展上下文失效，忽略 */ }
  })(true);

  /** 下行：background 转来的指令 → 广播进本帧主世界 */
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        if (!msg || msg.target !== 'job-probe-relay') return undefined;
        broadcast(msg.command);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return undefined;
    });
  } catch (e) { /* 扩展上下文失效，忽略 */ }
})();
