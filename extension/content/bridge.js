/**
 * 中台页面桥接脚本（零配置授权 §4 + 中台触发 §5）
 *
 * 职责：
 * Phase 1 - 零配置授权：
 * 1. 检测用户已登录中台（localStorage 或 session 存在）
 * 2. 通过 postMessage 通知 background 触发换权
 * 3. 心跳维持：每 5 分钟检查一次登录态，确保 token 有效
 *
 * Phase 2 - 中台触发：
 * 4. 发送 EXT_READY 心跳（每 5 秒），让页面知道扩展已安装
 * 5. 监听 FILL_REQUEST，转发给 background 执行填充
 * 6. 接收 FILL_PROGRESS / FILL_RESULT / PUBLISH_BACK，转发给页面
 *
 * 注入时机：用户打开中台前端页面时自动注入（origin 见 manifest.json 的
 * content_scripts.matches：本地开发 5173/5176，已部署环境 118.145.246.201）
 */
'use strict';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟（零配置授权心跳）
const EXT_READY_INTERVAL_MS = 5 * 1000; // 5 秒（扩展就绪心跳）
const BRIDGE_ID = 'recruit-extension-bridge';

/**
 * 扩展上下文是否仍然有效
 *
 * 扩展被重载 / 更新 / 禁用后，content script 变成孤儿，chrome.runtime.id 置空，
 * 随后的 chrome.* 调用会抛 "Extension context invalidated"。
 */
function isContextAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

/** 版本号读不到时给个兜底值，避免整支脚本挂掉 */
function readExtVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    console.warn('[Bridge] 读取扩展版本失败（上下文可能已失效）:', e);
    return 'unknown';
  }
}

const EXT_VERSION = readExtVersion();

/** 上下文失效后置 true，停掉所有定时器并告知页面 */
let contextDead = false;
const timers = [];

function notifyContextDead(reason) {
  if (contextDead) return;
  contextDead = true;
  // 停掉所有心跳，避免持续报错
  timers.forEach((t) => clearInterval(t));
  timers.length = 0;
  const message = String((reason && reason.message) || reason || '扩展上下文已失效');
  console.warn('[Bridge] 扩展上下文已失效，停止心跳:', message);
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
    // 忽略：页面可能已跳转
  }
}

// 避免重复注入
if (window[BRIDGE_ID]) {
  console.log('[Bridge] 已注入，跳过');
} else {
  window[BRIDGE_ID] = true;
  init();
}

function init() {
  console.log('[Bridge] 初始化，版本', EXT_VERSION);

  // Phase 1: 零配置授权心跳
  checkAndNotify();
  timers.push(setInterval(checkAndNotify, HEARTBEAT_INTERVAL_MS));

  // Phase 2: 扩展就绪心跳（让页面知道扩展已安装）
  sendExtReady();
  timers.push(setInterval(sendExtReady, EXT_READY_INTERVAL_MS));

  // 监听 storage 变化（用户登录/登出时触发）
  window.addEventListener('storage', (e) => {
    if (e.key === 'recruit_token' || e.key === 'recruit_user') {
      console.log('[Bridge] 检测到登录态变化');
      checkAndNotify();
    }
  });

  // Phase 2: 监听页面发来的 FILL_REQUEST
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    // 只处理来自中台的消息
    if (!msg || msg.source !== 'recruit-platform') return;

    if (msg.type === 'FILL_REQUEST') {
      if (contextDead) {
        console.warn('[Bridge] 上下文已失效，忽略 FILL_REQUEST');
        return;
      }
      console.log('[Bridge] 收到页面 FILL_REQUEST，转发给 background:', msg.payload);
      // 通过 postMessage 转发给 message-relay，再由它转发给 background
      window.postMessage(
        {
          type: 'FILL_REQUEST',
          source: 'recruit-bridge',
          payload: msg.payload,
        },
        '*'
      );
    }
  });

  // Phase 2: background 消息已由 message-relay 直接发送到页面
  // bridge.js 不需要再次转发（否则会形成消息循环）
  // useExtensionBridge 会直接监听 message-relay 发送的消息
}

/**
 * 检查登录态并通知 background
 *
 * 判定逻辑：
 * - localStorage.recruit_token 存在 -> 已登录
 * - sessionStorage.recruit_token 存在 -> 已登录
 * - 否则 -> 未登录
 */
function checkAndNotify() {
  if (contextDead) return;
  if (!isContextAlive()) {
    notifyContextDead('扩展已被重载或停用');
    return;
  }

  const token = localStorage.getItem('recruit_token') || sessionStorage.getItem('recruit_token');

  if (!token) {
    console.log('[Bridge] 未检测到登录态');
    return;
  }

  console.log('[Bridge] 检测到登录态，通知 background 换权');

  // 通过 postMessage 通知 background（携带 token）
  window.postMessage(
    {
      type: 'RECRUIT_SESSION_DETECTED',
      source: 'recruit-bridge',
      payload: { token }, // 携带 token
      timestamp: Date.now(),
    },
    '*'
  );
}

/**
 * Phase 2: 发送扩展就绪心跳
 *
 * 让页面知道扩展已安装并正常运行
 * 页面 15 秒未收到心跳 -> 按钮显示"未安装"
 */
function sendExtReady() {
  if (contextDead) return;
  if (!isContextAlive()) {
    notifyContextDead('扩展已被重载或停用');
    return;
  }

  window.postMessage(
    {
      type: 'EXT_READY',
      source: 'recruit-extension',
      payload: {
        version: EXT_VERSION,
        timestamp: Date.now(),
      },
    },
    window.location.origin
  );
}
