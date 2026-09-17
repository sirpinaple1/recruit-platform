/**
 * 招聘发布助手 · background service worker（填充编排 + 零配置授权 + 中台触发）
 * popup 只负责发起点：「去发布页填充」的完整编排（开 tab → 等 frame 就绪
 * → 两步注入引擎 → 轮询择优 → 报告落 storage → 切前台）在本 worker 执行，
 * popup 中途失焦关闭不影响流程；结果写 chrome.storage.local
 * （lastFillReport），popup 重开后仍可渲染最近一次报告。
 *
 * 红线 1：扩展只做表单预填充，绝不自动点击平台提交按钮（提交必须是人的手）。
 * 
 * Phase 1 - 零配置授权（§4）：
 * - bridge.js 注入中台页面，检测登录态后通过 postMessage 通知本 worker
 * - 本 worker 接收通知后调用 /api/extension/session-token 换权
 * - 支持 token 复用，避免多设备互踢
 * 
 * Phase 2 - 中台触发（§5）：
 * - 页面发送 FILL_REQUEST(recordId) -> background 获取草稿数据并填充
 * - 填充过程中发送 FILL_PROGRESS 回页面
 * - 填充完成后发送 FILL_RESULT 回页面
 */
'use strict';

/** 中台 API 基础地址 */
const API_BASE = 'http://localhost:6017';

/** 等待表单 frame 就绪的上限（BOSS 表单在 iframe 里，frame 晚于壳页面建立） */
const FILL_WAIT_FRAME_MS = 12000;
/** 等待引擎产出结果的上限（引擎含下拉/推荐弹层等待，整体可达 15s+） */
const FILL_WAIT_RESULT_MS = 25000;

// ============ 零配置授权 ============

/**
 * 监听来自 bridge.js 的 postMessage（需通过 content script 中转）
 * 
 * 流程：bridge.js (页面) -> content script (中转) -> background (本 worker)
 * content script 通过 chrome.runtime.sendMessage 转发消息
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 填充任务（来自 popup）
  if (msg && msg.type === 'startFill') {
    runFillTask(msg.draft)
      .then((report) => sendResponse({ ok: true, report }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // 异步回复
  }
  
  // Phase 1: 登录态检测（来自 bridge.js）
  if (msg && msg.type === 'RECRUIT_SESSION_DETECTED') {
    console.log('[Background] 收到登录态通知，开始换权');
    const platformToken = msg.payload?.token;
    if (!platformToken) {
      console.error('[Background] 缺少中台 token');
      sendResponse({ ok: false, error: '缺少中台 token' });
      return false;
    }
    
    exchangeToken(platformToken)
      .then(() => {
        console.log('[Background] 换权完成');
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.error('[Background] 换权失败:', e);
        sendResponse({ ok: false, error: String(e) });
      });
    return true; // 异步回复
  }
  
  // Phase 2: 中台触发填充请求（来自 bridge.js）
  if (msg && msg.type === 'FILL_REQUEST') {
    console.log('[Background] 收到 FILL_REQUEST:', msg.payload);
    const { recordId } = msg.payload || {};
    if (!recordId) {
      sendResponse({ ok: false, error: 'recordId is required' });
      return false;
    }
    
    handleFillRequest(recordId, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error('[Background] FILL_REQUEST 处理失败:', e);
        sendResponse({ ok: false, error: String(e) });
      });
    return true; // 异步回复
  }
  
  // Phase 2.6: 哨兵成功回调（来自 sentinel.js）
  if (msg && msg.type === 'SENTINEL_SUCCESS') {
    console.log('[Background] 收到 SENTINEL_SUCCESS:', msg.payload);
    const { recordId, publishedUrl, platformTabId } = msg.payload || {};
    
    // 广播 PUBLISH_BACK 给中台 tab
    if (platformTabId) {
      sendMessageToTab(platformTabId, {
        type: 'PUBLISH_BACK',
        source: 'recruit-extension',
        payload: {
          recordId,
          publishedUrl,
          timestamp: Date.now(),
        },
      });
    }
    
    sendResponse({ ok: true });
    return false;
  }
});

/**
 * 换权：调用 /api/extension/session-token 获取扩展 token
 * 
 * 逻辑：
 * 1. 从 storage 读取本地已存的 ext_token（如有）
 * 2. 调用接口，传入 oldToken
 * 3. 若 reused=true，无需更新；否则存储新 token
 */
async function exchangeToken(platformToken) {
  // 1. 读取本地 token
  const stored = await chrome.storage.local.get(['ext_token']);
  const oldToken = stored.ext_token || null;
  
  // 2. 调用接口（使用中台 JWT token 认证）
  const resp = await fetch(`${API_BASE}/api/extension/session-token`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${platformToken}`, // 使用中台 token 认证
    },
    body: JSON.stringify({ token: oldToken }),
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`换权失败 (${resp.status}): ${text}`);
  }
  
  const data = await resp.json();
  if (data.code !== 200) {
    throw new Error(`换权失败: ${data.message || '未知错误'}`);
  }
  
  const result = data.data;
  
  // 3. 若复用，无需更新
  if (result.reused) {
    console.log('[Background] Token 复用，tokenId:', result.tokenId);
    return;
  }
  
  // 4. 新签发，存储 token
  if (!result.token) {
    throw new Error('接口未返回 token');
  }
  
  await chrome.storage.local.set({ ext_token: result.token });
  console.log('[Background] 新 token 已存储，tokenId:', result.tokenId, 'expiresAt:', result.expiresAt);
}

/**
 * Phase 2: 处理中台触发的填充请求
 * 
 * 流程：
 * 1. 调用 GET /api/ext/drafts/{recordId} 获取草稿数据
 * 2. 发送 FILL_PROGRESS 通知页面"填充中"
 * 3. 执行填充任务（复用 runFillTask）
 * 4. 发送 FILL_RESULT 通知页面填充结果
 */
async function handleFillRequest(recordId, sourceTabId) {
  console.log('[Background] 开始处理 FILL_REQUEST, recordId:', recordId);
  
  // 1. 获取 ext_token
  const stored = await chrome.storage.local.get(['ext_token']);
  const token = stored.ext_token;
  if (!token) {
    throw new Error('未找到扩展 token，请先在中台登录');
  }
  
  // 2. 发送进度：开始填充
  await sendMessageToTab(sourceTabId, {
    type: 'FILL_PROGRESS',
    source: 'recruit-extension',
    payload: {
      recordId,
      stage: 'fetching',
      message: '正在获取草稿数据...',
    },
  });
  
  // 3. 调用 /api/ext/drafts 获取所有待发布草稿
  const resp = await fetch(`${API_BASE}/api/ext/drafts?status=pending`, {
    method: 'GET',
    headers: {
      'X-Extension-Token': token,
    },
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    const error = `获取草稿失败 (${resp.status}): ${text}`;
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: false,
        summary: { total: 0, filled: 0, skipped: 0, failed: 0 },
        error,
      },
    });
    throw new Error(error);
  }
  
  const data = await resp.json();
  if (data.code !== 200) {
    const error = `获取草稿失败: ${data.message || '未知错误'}`;
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: false,
        summary: { total: 0, filled: 0, skipped: 0, failed: 0 },
        error,
      },
    });
    throw new Error(error);
  }
  
  const drafts = data.data;
  if (!Array.isArray(drafts)) {
    const error = '草稿数据格式错误';
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: false,
        summary: { total: 0, filled: 0, skipped: 0, failed: 0 },
        error,
      },
    });
    throw new Error(error);
  }
  
  // 4. 在列表中查找匹配的 recordId
  const draft = drafts.find(d => String(d.recordId) === String(recordId));
  if (!draft) {
    const error = `未找到 recordId=${recordId} 的草稿（可能已发布或不属于当前用户）`;
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: false,
        summary: { total: 0, filled: 0, skipped: 0, failed: 0 },
        error,
      },
    });
    throw new Error(error);
  }
  console.log('[Background] 草稿数据获取成功:', draft);
  
  // 4. 发送进度：开始填充
  await sendMessageToTab(sourceTabId, {
    type: 'FILL_PROGRESS',
    source: 'recruit-extension',
    payload: {
      recordId,
      stage: 'filling',
      message: '正在填充表单...',
    },
  });
  
  // 5. 执行填充任务
  try {
    const report = await runFillTask(draft);
    console.log('[Background] 填充完成:', report);
    
    // 6. 注入哨兵（如果配置了 success）
    const fieldMap = draft.fieldMapJson || {};
    const successConfig = fieldMap.success;
    if (successConfig && report.tabId) {
      console.log('[Background] 注入哨兵到平台页, tabId:', report.tabId);
      await injectSentinel(report.tabId, recordId, successConfig, sourceTabId);
    }
    
    // 7. 发送结果
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: true,
        summary: report.result?.summary || { total: 0, filled: 0, skipped: 0, failed: 0 },
        tabId: report.tabId,
      },
    });
  } catch (e) {
    console.error('[Background] 填充失败:', e);
    await sendMessageToTab(sourceTabId, {
      type: 'FILL_RESULT',
      source: 'recruit-extension',
      payload: {
        recordId,
        ok: false,
        summary: { total: 0, filled: 0, skipped: 0, failed: 0 },
        error: String(e && e.message ? e.message : e),
      },
    });
    throw e;
  }
}

/**
 * 向指定 tab 发送消息（通过 content script 中转）
 */
async function sendMessageToTab(tabId, message) {
  if (!tabId) {
    console.warn('[Background] 无法发送消息，tabId 未提供');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
    console.log('[Background] 消息已发送到 tab', tabId, ':', message.type);
  } catch (e) {
    console.error('[Background] 发送消息失败:', e);
  }
}

/**
 * Phase 2.6: 注入哨兵脚本到填充完成的平台页
 * 
 * @param {number} targetTabId - 填充完成的平台页 tabId
 * @param {string} recordId - 发布记录 ID
 * @param {object} successConfig - 成功信号配置 { urlPattern, selectors, timeoutMs }
 * @param {number} platformTabId - 中台页面 tabId（用于回传 PUBLISH_BACK）
 */
async function injectSentinel(targetTabId, recordId, successConfig, platformTabId) {
  console.log('[Background] 准备注入哨兵, targetTabId:', targetTabId, 'recordId:', recordId);
  
  // 1. 获取 ext_token（用于哨兵回填接口）
  const stored = await chrome.storage.local.get(['ext_token']);
  const token = stored.ext_token;
  if (!token) {
    console.error('[Background] 哨兵注入失败：未找到 ext_token');
    return;
  }
  
  // 2. 构造哨兵配置
  const sentinelConfig = {
    recordId,
    successConfig: {
      urlPattern: successConfig.urlPattern || null,
      selectors: successConfig.selectors || [],
      timeoutMs: successConfig.timeoutMs || 60000,
    },
    apiBase: API_BASE,
    token,
    platformTabId,
  };
  
  // 3. 注入配置到目标页面的 window
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: (config) => {
        window.__RECRUIT_SENTINEL_CONFIG__ = config;
      },
      args: [sentinelConfig],
    });
    console.log('[Background] 哨兵配置已注入');
  } catch (e) {
    console.error('[Background] 哨兵配置注入失败:', e);
    return;
  }
  
  // 4. 注入哨兵脚本
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ['content/sentinel.js'],
    });
    console.log('[Background] 哨兵脚本已注入，开始监听成功信号');
  } catch (e) {
    console.error('[Background] 哨兵脚本注入失败:', e);
  }
}

// ============ 填充编排 ============

/**
 * 填充编排（原 popup.fillDraft 的逻辑，无 UI）：
 * 开后台 tab → 轮询 frame 就绪 → 注入 config + 引擎（allFrames，引擎自动执行）
 * → 轮询各 frame 结果择优（filled 最多者 = 表单 frame）→ 报告落 storage → 切前台。
 */
async function runFillTask(d) {
  const entryUrl = d && d.publishEntryUrl;
  const pattern = d && d.publishUrlPattern;
  
  if (!entryUrl) throw new Error('该渠道未配置发布页入口地址（publish_entry_url）');
  if (!pattern) throw new Error('该渠道未配置发布页匹配模式（publish_url_pattern）');
  if (pattern.includes('*')) throw new Error('通配发布页模式需先手动打开对应页面');

  // 1. 后台开 tab（不打扰当前焦点；填充完成后切前台）
  const tab = await chrome.tabs.create({ url: entryUrl, active: false });
  await waitTabComplete(tab.id);

  // 2. 轮询等任一 frame 出现表单控件（避免注到尚未建立的 frame）
  const t0 = Date.now();
  while (Date.now() - t0 < FILL_WAIT_FRAME_MS) {
    const checks = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => !!document.querySelector('input:not([type=hidden]), textarea, select'),
    }).catch(() => []);
    if (checks.some((c) => c && c.result)) break;
    await sleep(500);
  }

  // 3. 两步注入：先放配置，再注引擎源码（每个 frame 各自自动执行）
  const fieldMap = d.fieldMapJson || {};
  const config = {
    fields: fieldMap.fields || [],
    selectors: fieldMap.selectors || {},
    values: d.fieldsJson || {},
  };
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (c) => {
      window.__RECRUIT_FILL_CONFIG__ = c;
      window.__RECRUIT_FILL_RESULT__ = null;
    },
    args: [config],
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['content/fill-engine.js'],
  });

  // 4. 轮询各 frame 结果并择优：取 total>0 中 filled 最多者（表单所在 frame）
  let result = null;
  const t1 = Date.now();
  while (Date.now() - t1 < FILL_WAIT_RESULT_MS) {
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__RECRUIT_FILL_RESULT__,
    }).catch(() => []);
    for (const fr of frameResults) {
      const res = fr && fr.result;
      if (!res || !res.summary || !res.summary.total) continue;
      if (!result || res.summary.filled > result.summary.filled) result = res;
    }
    // 完成（filled>0 且三态计数覆盖 total）即可提前结束，否则等超时
    const s = result && result.summary;
    if (s && s.filled > 0 && s.filled + s.skipped + s.failed >= s.total) break;
    await sleep(400);
  }

  // 5. 报告落 storage + 把发布页切到前台（此时填充已完成，切前台无副作用）
  const report = {
    recordId: d.recordId || null,
    requestNo: d.requestNo || '',
    title: d.title || '',
    at: Date.now(),
    tabId: tab.id,
    result,
  };
  await chrome.storage.local.set({ lastFillReport: report });
  await chrome.tabs.update(tab.id, { active: true });
  return report;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitTabComplete(tabId, timeoutMs) {
  const timeout = timeoutMs || 15000;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish();
    }).catch(finish);
  });
}
