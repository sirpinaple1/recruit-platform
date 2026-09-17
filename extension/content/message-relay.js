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
 */
'use strict';

// 监听页面消息，转发给 background
window.addEventListener('message', (event) => {
  // 只接受来自同源的消息
  if (event.source !== window) return;
  
  const msg = event.data;
  
  // 过滤：只转发招聘扩展的消息（接受 bridge 和 platform 两种来源）
  if (!msg || (msg.source !== 'recruit-bridge' && msg.source !== 'recruit-platform')) return;
  
  // Phase 1: 零配置授权
  if (msg.type === 'RECRUIT_SESSION_DETECTED') {
    console.log('[MessageRelay] 转发登录态通知到 background');
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[MessageRelay] 转发失败:', chrome.runtime.lastError);
      } else {
        console.log('[MessageRelay] Background 响应:', response);
      }
    });
  }
  
  // Phase 2: 填充请求
  if (msg.type === 'FILL_REQUEST') {
    console.log('[MessageRelay] 转发 FILL_REQUEST 到 background:', msg.payload);
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[MessageRelay] FILL_REQUEST 转发失败:', chrome.runtime.lastError);
      } else {
        console.log('[MessageRelay] Background 响应:', response);
      }
    });
  }
});

// 监听 background 消息，转发给页面
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[MessageRelay] 收到 background 消息:', msg);
  
  // Phase 2: 填充进度、结果、发布回执
  if (['FILL_PROGRESS', 'FILL_RESULT', 'PUBLISH_BACK'].includes(msg.type)) {
    console.log('[MessageRelay] 转发给页面:', msg);
    // 加上 source 标识，让 bridge.js 识别这是扩展发来的消息
    window.postMessage({
      ...msg,
      source: 'recruit-extension',
    }, window.location.origin);
    sendResponse({ success: true });
  }
  
  return true; // 保持消息通道开启（异步响应）
});
