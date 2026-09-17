/**
 * 哨兵脚本：监听平台发布成功信号（Phase 2 §6）
 * 
 * 职责：
 * 1. 在填充任务完成后由 background 注入到平台页（如 BOSS）
 * 2. 监听成功信号（URL 变化 + CSS 选择器）
 * 3. 检测到成功后调用 POST /api/ext/records/{id}/report 回填
 * 4. 向中台 tab 广播 PUBLISH_BACK 消息
 * 
 * 配置来源：field_map_json.success
 * {
 *   "urlPattern": "**/job/**",  // URL 需匹配的模式（简单通配符）
 *   "selectors": [".publish-success", ".job-published-tip"],  // CSS 选择器列表
 *   "timeoutMs": 60000  // 超时时间（默认 60 秒）
 * }
 * 
 * 策略：保守双命中（URL 变化 + 选择器出现）
 */
'use strict';

// 全局标识避免重复注入
const SENTINEL_ID = 'recruit-sentinel-active';
if (window[SENTINEL_ID]) {
  console.log('[Sentinel] 已存在，跳过');
} else {
  window[SENTINEL_ID] = true;
  
  // 从配置中读取
  const config = window.__RECRUIT_SENTINEL_CONFIG__;
  if (!config) {
    console.error('[Sentinel] 缺少配置，无法启动');
  } else {
    startSentinel(config);
  }
}

function startSentinel(config) {
  const { recordId, successConfig, apiBase, token, platformTabId } = config;
  
  if (!recordId || !successConfig) {
    console.error('[Sentinel] 配置不完整:', config);
    return;
  }
  
  console.log('[Sentinel] 启动，recordId:', recordId, 'config:', successConfig);
  
  const { urlPattern, selectors, timeoutMs } = successConfig;
  const timeout = timeoutMs || 60000;
  
  let urlMatched = false;
  let selectorMatched = false;
  let reported = false;
  let startTime = Date.now();
  
  // 检查 URL 是否匹配（简单通配符）
  function checkUrlMatch() {
    const currentUrl = window.location.href;
    if (!urlPattern) return true; // 无 pattern 则不作 URL 判定
    
    // 简单通配符实现：** 匹配任意字符，* 匹配非 / 字符
    const regex = new RegExp(
      '^' + urlPattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') + '$'
    );
    
    const matched = regex.test(currentUrl);
    if (matched && !urlMatched) {
      console.log('[Sentinel] URL 匹配成功:', currentUrl);
      urlMatched = true;
      checkAndReport();
    }
    return matched;
  }
  
  // 检查选择器是否出现
  function checkSelectorMatch() {
    if (!selectors || selectors.length === 0) return true; // 无选择器则不作判定
    
    for (const sel of selectors) {
      if (document.querySelector(sel)) {
        console.log('[Sentinel] 选择器匹配成功:', sel);
        selectorMatched = true;
        checkAndReport();
        return true;
      }
    }
    return false;
  }
  
  // 双命中判定 + 自动回填
  function checkAndReport() {
    if (reported) return;
    
    // 保守策略：要求双命中（或单方无配置）
    const urlOk = !urlPattern || urlMatched;
    const selectorOk = !selectors || selectors.length === 0 || selectorMatched;
    
    if (urlOk && selectorOk) {
      console.log('[Sentinel] 成功信号双命中，准备回填');
      reported = true;
      reportSuccess();
    }
  }
  
  // 调用后端 report 接口
  async function reportSuccess() {
    const publishedUrl = window.location.href;
    console.log('[Sentinel] 回填发布成功, publishedUrl:', publishedUrl);
    
    try {
      const resp = await fetch(`${apiBase}/api/ext/records/${recordId}/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Extension-Token': token,
        },
        body: JSON.stringify({
          status: 'published',
          publishedUrl,
        }),
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[Sentinel] 回填失败:', resp.status, text);
        return;
      }
      
      const data = await resp.json();
      if (data.code !== 200) {
        console.error('[Sentinel] 回填失败:', data.message);
        return;
      }
      
      console.log('[Sentinel] 回填成功');
      
      // 通知 background，让它广播给中台 tab
      chrome.runtime.sendMessage({
        type: 'SENTINEL_SUCCESS',
        payload: {
          recordId,
          publishedUrl,
          platformTabId,
        },
      });
      
    } catch (e) {
      console.error('[Sentinel] 回填异常:', e);
    }
  }
  
  // 初始检查
  checkUrlMatch();
  checkSelectorMatch();
  
  // 监听 URL 变化（SPA 路由）
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[Sentinel] URL 变化:', currentUrl);
      checkUrlMatch();
    }
  }).observe(document, { subtree: true, childList: true });
  
  // 监听 popstate（浏览器前进后退）
  window.addEventListener('popstate', () => {
    console.log('[Sentinel] popstate 触发');
    checkUrlMatch();
  });
  
  // 轮询检查选择器（定时 + MutationObserver）
  const selectorCheckInterval = setInterval(() => {
    if (reported || Date.now() - startTime > timeout) {
      clearInterval(selectorCheckInterval);
      if (!reported) {
        console.log('[Sentinel] 超时未检测到成功信号，停止监听');
      }
      return;
    }
    checkSelectorMatch();
  }, 1000);
  
  // DOM 变化也检查选择器
  new MutationObserver(() => {
    if (!reported) {
      checkSelectorMatch();
    }
  }).observe(document.body, { subtree: true, childList: true });
}
