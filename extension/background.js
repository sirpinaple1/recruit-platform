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

/** 中台 API 默认地址（未配置时的回退值，本地联调用） */
const DEFAULT_API_BASE = 'http://localhost:6017';

/**
 * 已配置后端地址的缓存。
 * MV3 的 service worker 30s 空闲即被回收，缓存只用于降低同一轮调用里的
 * storage 读取次数；storage 变化时立即失效（见下方 onChanged）。
 */
let cachedApiBase = null;

/** 归一化后端地址：去首尾空白与尾部斜杠 */
function normalizeApiBase(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * 取当前生效的中台 API 地址：以配置页（options/index.html）保存的 baseUrl 为准，
 * 未配置时回退到 localhost:6017。
 *
 * 背景：部署到远端服务器后后台地址不再是本机，写死常量会导致 background 侧所有
 * 请求（换权 / 拉草稿 / 回填 / 采集入库）仍然打到 localhost 而失败。
 */
async function getApiBase() {
  if (cachedApiBase) return cachedApiBase;
  try {
    const stored = await chrome.storage.local.get('baseUrl');
    cachedApiBase = normalizeApiBase(stored.baseUrl) || DEFAULT_API_BASE;
  } catch (e) {
    console.warn('[Background] 读取后端地址失败，回退默认值:', e);
    cachedApiBase = DEFAULT_API_BASE;
  }
  return cachedApiBase;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.baseUrl) {
    cachedApiBase = normalizeApiBase(changes.baseUrl.newValue) || DEFAULT_API_BASE;
    console.log('[Background] 后端地址已切换为:', cachedApiBase);
  }
});

/** 等待表单 frame 就绪的上限（BOSS 表单在 iframe 里，frame 晚于壳页面建立） */
const FILL_WAIT_FRAME_MS = 12000;
/** 等待引擎产出结果的上限（引擎含下拉/推荐弹层等待，整体可达 15s+） */
const FILL_WAIT_RESULT_MS = 25000;

/** FILL_REQUEST 去重窗口：同 recordId 在窗口内只处理一次（防消息重复转发开双 tab） */
const FILL_DEDUP_MS = 20000;
const fillRecent = new Map(); // recordId -> 上次受理时间戳

function isDuplicateFill(recordId) {
  const now = Date.now();
  for (const [k, t] of fillRecent) {
    if (now - t > FILL_DEDUP_MS) fillRecent.delete(k);
  }
  if (fillRecent.has(recordId)) return true;
  fillRecent.set(recordId, now);
  return false;
}

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
    if (isDuplicateFill(String(recordId))) {
      console.warn('[Background] FILL_REQUEST 重复（' + FILL_DEDUP_MS + 'ms 窗口内），忽略:', recordId);
      sendResponse({ ok: true, deduped: true });
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
  
  // Phase 2.6: 哨兵成功上报（来自 sentinel.js）
  // 由本 worker 代理调用回填接口（content script 的跨域 fetch 会被 CORS 拦截，
  // 且平台发布成功后页面约 1s 即跳转、会中断页面内未完成的 fetch），
  // 成功后广播 PUBLISH_BACK 给中台 tab
  if (msg && msg.type === 'SENTINEL_REPORT') {
    console.log('[Background] 收到 SENTINEL_REPORT:', msg.payload);
    const { recordId, publishedUrl, platformTabId,
            platformJobId, platformJobHint, platformJobSource } = msg.payload || {};

    // 岗位映射随回填一起上报（路径 A）。拿不到时 platformJobId 为 undefined，
    // 请求体里就不会出现该字段，后端按「尚未绑定」处理 —— 与「不猜」的口径一致。
    reportPublishSuccess(recordId, publishedUrl, { platformJobId, platformJobHint, platformJobSource })
      .then(() => {
        // 广播 PUBLISH_BACK 给中台 tab
        if (platformTabId) {
          sendMessageToTab(platformTabId, {
            type: 'PUBLISH_BACK',
            source: 'recruit-extension',
            payload: {
              recordId,
              publishedUrl,
              platformJobId: platformJobId || null,
              timestamp: Date.now(),
            },
          });
        }
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.error('[Background] 哨兵回填失败:', e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true; // 异步回复
  }

  // 简历采集：HR 点击页面内浮层按钮 -> 本 worker 编排（取数 -> 提交 -> 附件下载上传）
  // 由 worker 而不是内容脚本发起，原因同 SENTINEL_REPORT：
  // 内容脚本在平台页 origin 下打中台 API 会被 CORS 拦，且平台页面可能随时跳转中断 fetch。
  if (msg && msg.type === 'COLLECT_REQUEST') {
    handleCollectRequest(msg.payload || {}, sender.tab ? sender.tab.id : null)
      .then((res) => sendResponse(res))
      .catch((e) => {
        console.error('[Background] 采集失败:', e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true; // 异步回复
  }

  // 采集 hook 就绪诊断（仅用于面板显示，不参与业务流程）
  if (msg && msg.type === 'COLLECT_HOOK_READY') {
    collectHookFrames.set(sender.tab ? sender.tab.id : -1, Date.now());
    sendResponse({ ok: true });
    return false;
  }

  // ---------- 诊断录制：岗位探针上行 ----------
  // 探针在 MAIN 世界只写内存并 postMessage；转发层（ISOLATED）负责送过来，
  // 本 worker 负责聚合 + 落 chrome.storage.session（人能导出、worker 重启也不丢）。
  if (msg && msg.type === 'JOB_PROBE_RECORD') {
    // 不 await：录制很密集，逐条等落盘会拖慢 worker。diagAppend 内部自行保证顺序与限流。
    void diagAppend(msg.payload, sender.tab ? sender.tab.id : null);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'JOB_PROBE_HINT') {
    void diagNoteHint(msg.payload, sender.tab ? sender.tab.id : null);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'JOB_PROBE_RECORD_LIMIT') {
    void diagNoteLimit(msg.payload);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'JOB_PROBE_RECORD_STATE') {
    sendResponse({ ok: true });
    return false;
  }

  // ---------- 诊断录制：popup 控制面 ----------
  if (msg && msg.type === 'DIAG_GET_FLAG') {
    // 转发层在 document_start 装载时问一次「现在该不该录」（见 job-probe-relay.js 头注释）。
    // 必须先水合，否则 worker 刚重启时会答 false，把录制悄悄关掉。
    diagEnsureHydrated().then(() => sendResponse({ recording: diagRecording }));
    return true;
  }
  if (msg && msg.type === 'DIAG_STATUS') {
    diagStatus().then((s) => sendResponse(s)).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'DIAG_START') {
    diagStart(msg.payload || {}).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'DIAG_STOP') {
    diagStop().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'DIAG_CLEAR') {
    diagClear().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'DIAG_EXPORT') {
    diagExport().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

// ============================================================
// 诊断录制（岗位 ID 捕获点取证）
//
// 目的：BOSS 到底在哪个接口、哪个字段给出「这次发布的是哪个岗位」，是**未经验证的
//      平台行为**。路径 A 若只靠猜键表就是赌博。本模块让人做一次真机发布，
//      把所有响应录下来，事后离线翻查 —— 用事实而不是猜测来定键表。
//
// 合规边界（与本项目「只做主动触发」的一贯立场一致，不因为是诊断就放松）：
//   · 默认**关闭**；必须由人在 popup 里显式开启
//   · 数据只落 chrome.storage.session（本地、会话级、关浏览器即清）
//   · **不自动外发任何一条**；只有人点「导出」才下载成文件
//   · 二进制一律不读内容，只记「这里有个非文本响应」
// ============================================================

const DIAG_KEY = 'diag_records';
const DIAG_META_KEY = 'diag_meta';
/** 环形缓冲条数上限 */
const DIAG_MAX_ITEMS = 400;
/** 环形缓冲总量上限（body 长度合计），防止把 storage.session 配额撑爆 */
const DIAG_MAX_TOTAL = 4 * 1024 * 1024;
/** 写盘节流：录制很密集，每条都写 storage 会拖慢 worker */
const DIAG_FLUSH_MS = 1500;

let diagPending = [];
let diagFlushTimer = null;
/** 开关水合的进程内单例 Promise（见 diagEnsureHydrated 的说明） */
let diagReady = null;

/**
 * 录制开关的**内存镜像 + 权威判定**。
 *
 * <p>停止录制为什么不由「广播通知页面」来保证：页面里的探针是 MAIN 世界的独立副本，
 * 广播可能因为帧找不到、扩展刚重载、tab 权限不足而**送不到**；
 * 一旦送不到，页面会继续录、继续上报，用户以为停了其实没停。
 * 所以以 background 这一侧的标志为权威 —— 停止后即使还有条目涌进来，也直接丢弃。
 * 广播只作为「省点开销」的优化，不是正确性的依赖。</p>
 */
let diagRecording = false;

/**
 * MV3 的 service worker 随时可能被回收重启，重启后内存标志是空白的，
 * 必须先从 storage 水合回来 —— 而水合是**异步**的。
 *
 * <p><b>为什么不能只在顶层 `void diagHydrate()` 就算完</b>：
 * 重启后 worker 会给积压的消息派发事件，若某条 `JOB_PROBE_RECORD` 在水合完成前到达，
 * 此时 `diagRecording` 仍是 false，那条记录会被<b>静默丢弃</b>——
 * 表现成「录制开着却一条没录到」，极难排查（实测踩过：popup 显示已开始录制、条数为 0）。
 * 所以改成「首个条目到达时先 await 水合」，用一个进程内单例 Promise 保证只读一次。</p>
 */
/** 用户是否在本进程内显式设过开关（设过之后，晚到的水合结果不得覆盖） */
let diagExplicit = false;

function diagEnsureHydrated() {
  if (!diagReady) diagReady = diagHydrate();
  return diagReady;
}

async function diagHydrate() {
  try {
    const s = await chrome.storage.session.get(['diag_recording']);
    // 竞态防护：若「水合」与「用户点开始/停止」并发，显式动作优先。
    // 否则一个更早发出的水合 promise 晚到，会把刚设好的值覆盖回旧值，
    // 表现成「点了开始但没在录」/「点了停止却还在录」，两种都很难查。
    if (!diagExplicit) {
      diagRecording = s.diag_recording === true;
    }
  } catch (e) { /* storage 不可用则按不录 */ }
  return diagRecording;
}

async function diagSetRecording(on) {
  diagExplicit = true;
  diagRecording = on === true;
  // 让水合单例指向已确定的值，后续 diagAppend 的 await 立刻返回、不会倒退
  diagReady = Promise.resolve(diagRecording);
  try {
    await chrome.storage.session.set({ diag_recording: diagRecording });
  } catch (e) { /* ignore */ }
}

async function diagReadAll() {
  const s = await chrome.storage.session.get([DIAG_KEY, DIAG_META_KEY]);
  return { records: s[DIAG_KEY] || [], meta: s[DIAG_META_KEY] || {} };
}

/** 入队 + 节流落盘（放在内存里攒，避免每条都写 storage） */
async function diagAppend(entry, tabId) {
  // 先 await 水合：worker 刚重启时内存标志还是 false，直接判定会把记录静默丢掉
  await diagEnsureHydrated();
  if (!diagRecording) return;
  if (!entry || !entry.url) return;
  diagPending.push(Object.assign({ tabId: tabId || null }, entry));
  diagScheduleFlush();
}

function diagScheduleFlush() {
  if (diagFlushTimer) return;
  diagFlushTimer = setTimeout(() => {
    diagFlushTimer = null;
    void diagFlush();
  }, DIAG_FLUSH_MS);
}

async function diagFlush() {
  if (!diagPending.length) return;
  const batch = diagPending;
  diagPending = [];
  try {
    const { records, meta } = await diagReadAll();
    const merged = records.concat(batch);
    let total = merged.reduce((n, r) => n + (r.bodyText ? r.bodyText.length : 0), 0);
    let trimmed = meta.trimmed || 0;
    // 三重上限（条数 / 总量）——超限丢**最旧**的：
    // 诊断关心「刚刚发岗位时发生了什么」，保留最近的才有价值。
    while (merged.length > DIAG_MAX_ITEMS || total > DIAG_MAX_TOTAL) {
      const dropped = merged.shift();
      if (!dropped) break;
      total -= dropped.bodyText ? dropped.bodyText.length : 0;
      trimmed += 1;
    }
    await chrome.storage.session.set({
      [DIAG_KEY]: merged,
      [DIAG_META_KEY]: Object.assign({}, meta, {
        count: merged.length,
        bytes: total,
        trimmed,
        updatedAt: new Date().toISOString()
      })
    });
  } catch (e) {
    console.warn('[Background] 诊断录制落盘失败（可能超配额，将丢弃本批）:', e && e.message);
  }
}

async function diagNoteHint(payload, tabId) {
  try {
    const { meta } = await diagReadAll();
    await chrome.storage.session.set({
      [DIAG_META_KEY]: Object.assign({}, meta, {
        lastHint: payload,
        lastHintTabId: tabId || null,
        lastHintAt: new Date().toISOString()
      })
    });
  } catch (e) { /* ignore */ }
}

async function diagNoteLimit(payload) {
  try {
    const { meta } = await diagReadAll();
    await chrome.storage.session.set({
      [DIAG_META_KEY]: Object.assign({}, meta, {
        pageLimitHit: payload,
        pageLimitAt: new Date().toISOString()
      })
    });
  } catch (e) { /* ignore */ }
}

async function diagStatus() {
  await diagFlush(); // 把内存里还没写的先落下去，状态才对得上
  const { records, meta } = await diagReadAll();
  return {
    ok: true,
    recording: diagRecording,
    count: records.length,
    bytes: meta.bytes || 0,
    trimmed: meta.trimmed || 0,
    startedAt: meta.startedAt || null,
    updatedAt: meta.updatedAt || null,
    // 内容脚本是否注册成功 —— 注册失败意味着「之后加载的页面都不会被录」，
    // 这是「明明开着录制却只录到一部分」的头号原因，必须显式暴露出来
    registered: meta.registered === true,
    lastHint: meta.lastHint || null,
    pageLimitHit: meta.pageLimitHit || null
  };
}

/**
 * 录制会话用「动态注册内容脚本」而不是只做一次性注入。
 *
 * <p><b>为什么必须这样</b>（两次真机取证失败换来的结论）：</p>
 * <ol>
 *   <li><b>一次性注入只覆盖注入那一刻的活动 tab。</b> 填充流程会**新开**一个发布页 tab，
 *       探针留在旧 tab，新 tab 一条都录不到。</li>
 *   <li><b>注入发生在填充完成之后</b>，页面加载期与填充期的请求全部错过。</li>
 *   <li><b>页面一跳转，注入的脚本就没了</b> —— 发布成功后回列表页刷新是常见动作，
 *       恰好把最需要的「列表接口带出新岗位 ID」那一段丢掉。</li>
 * </ol>
 * <p>动态注册（document_start、全帧）把这三个问题一次解决：注册期间**任何** zhipin
 * 页面的**每次**加载都会自动带上探针与转发层。</p>
 *
 * <p><b>合规边界</b>：注册只在「人显式开始录制」到「停止」之间有效，
 * 且 <code>persistAcrossSessions: false</code>（浏览器重启不会残留）。
 * 停止时立即注销 —— 不做常驻 hook。</p>
 */
const DIAG_SCRIPT_IDS = ['recruit-job-probe-main', 'recruit-job-probe-relay'];
const DIAG_MATCHES = ['https://www.zhipin.com/*', 'https://*.zhipin.com/*'];

async function diagRegisterScripts() {
  try {
    // 先注销：注册是幂等的，但残留的旧同 id 注册会让 register 直接抛错
    await chrome.scripting.unregisterContentScripts({ ids: DIAG_SCRIPT_IDS });
  } catch (e) { /* 本来就没有，正常 */ }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'recruit-job-probe-main',
        matches: DIAG_MATCHES,
        js: ['content/job-probe.js'],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN',
        persistAcrossSessions: false,
      },
      {
        id: 'recruit-job-probe-relay',
        matches: DIAG_MATCHES,
        js: ['content/job-probe-relay.js'],
        runAt: 'document_start',
        // 全帧各有一份：转发层按 ev.source === window 只上报本帧，
        // 既保证恰好一次，又让每个帧（含 iframe）都能自己同步录制开关。
        allFrames: true,
        world: 'ISOLATED',
        persistAcrossSessions: false,
      },
    ]);
    console.log('[Background] 诊断录制：内容脚本已注册（document_start / 全帧）');
    return true;
  } catch (e) {
    console.warn('[Background] 诊断录制：内容脚本注册失败:', e && e.message);
    return false;
  }
}

async function diagUnregisterScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: DIAG_SCRIPT_IDS });
    console.log('[Background] 诊断录制：内容脚本已注销');
  } catch (e) { /* 本来就没有，忽略 */ }
}

/**
 * 导航兜底：录制期间，任何 zhipin 页面加载完成就补注一次探针。
 *
 * <p><b>为什么注册了脚本还要这一层</b>：</p>
 * <ul>
 *   <li>动态注册对 `world: 'MAIN'` 的支持随 Chrome 版本而异，注册可能失败或被忽略 ——
 *       而失败是**静默**的（返回不代表生效），不能把正确性押在它上面。</li>
 *   <li>注册只对**之后**加载的页面生效；已经打开的页面靠 diagStart 的一次性注入，
 *       而那次注入发生在填充之后，看不到页面加载期的请求。</li>
 * </ul>
 * <p>读取 tab.url 需要 host 权限 —— 本扩展有 zhipin 的 host_permissions，故可读；
 * 非 zhipin 页面直接跳过（也避免对无权限的域调用 executeScript 抛出噪声）。</p>
 * <p>重复注入是安全的：探针有 `__recruit_job_probe_active` 守卫，只会同步开关、不会重复挂 hook。</p>
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!diagRecording) return;
  if (!changeInfo || changeInfo.status !== 'complete') return;
  const url = tab && tab.url;
  if (!url || !/^https?:\/\/([^/]*\.)?zhipin\.com\//.test(url)) return;
  void diagInjectProbe(tabId, true).then((ok) => {
    if (ok) console.log('[Background] 诊断录制：导航兜底注入完成 tabId=' + tabId);
  }).catch(() => { /* 注入失败不影响页面 */ });
});

/**
 * 开始录制：① 动态注册内容脚本（管住**后续**所有页面加载）
 *          ② 同时对当前活动 tab 立即注入一次（管住**已经打开**的这一页）
 *
 * 两步缺一不可：注册只对之后加载的页面生效，而人往往是「页面已经开着」才点开始录制。
 */
async function diagStart(opts) {
  const tabId = opts.tabId;
  if (!tabId) throw new Error('缺少 tabId');
  // 先置标志再注入：注入是异步的，期间若有响应进来也不该被丢掉
  await diagSetRecording(true);
  const registered = await diagRegisterScripts();
  try {
    // ★ 合并而不是整体覆盖 meta ★
    //   直接 set({[DIAG_META_KEY]: {startedAt, tabId}}) 会把 bytes / count / trimmed /
    //   lastHint 一起抹掉 —— 表现成「明明录了一堆，状态却显示 0 KB」，
    //   而且「环形缓冲丢过条目」这个关键警告也会消失，会误导诊断结论（实测踩过）。
    const { meta } = await diagReadAll();
    await chrome.storage.session.set({
      [DIAG_META_KEY]: Object.assign({}, meta, {
        startedAt: new Date().toISOString(),
        tabId,
        registered,
      })
    });
  } catch (e) { /* ignore */ }
  const injected = await diagInjectProbe(tabId, true);
  return { ok: true, injected, registered };
}

async function diagStop() {
  await diagSetRecording(false);
  await diagUnregisterScripts();
  await diagFlush();
  // 广播关录只是「省开销」的优化，不是正确性依赖（见 diagRecording 注释）。
  // 注意：tabs.query 的 url 过滤依赖 host 权限，权限不足时会抛 —— 忽略即可。
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.zhipin.com/*'] });
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(
      t.id, { target: 'job-probe-relay', command: 'RECORD_OFF' }).catch(() => {})));
  } catch (e) { /* 权限不足/无匹配 tab，不影响已停止的事实 */ }
  const s = await diagStatus();
  return { ok: true, count: s.count };
}

async function diagClear() {
  await chrome.storage.session.remove([DIAG_KEY, DIAG_META_KEY]);
  diagPending = [];
  return { ok: true, count: 0 };
}

/** 导出聚合结果（含元信息，便于离线核对「录了多久、有没有被截断」） */
async function diagExport() {
  await diagFlush();
  const { records, meta } = await diagReadAll();
  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    meta,
    count: records.length,
    records
  };
}

/**
 * 注入「岗位探针 + 转发层」。
 *
 * @param recording 是否同时打开录制（注入前必须先把开关写进页面，脚本装载时读一次）
 * @param rulesOverride 键表覆盖（发布流程按渠道数据给；不传则用兜底表）
 * @returns 是否注入成功（探针与转发层任一失败都算失败，调用方据此提示）
 */
async function diagInjectProbe(tabId, recording, rulesOverride) {
  const rules = rulesOverride || {
    jobIdKeys: FALLBACK_JOB_ID_KEYS,
    jobHintKeys: FALLBACK_JOB_HINT_KEYS,
  };
  let ok = true;
  try {
    // 1) 规则 + 录制开关：必须在脚本装载之前写入（脚本启动时读一次）
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (r, rec) => {
        window.__RECRUIT_JOB_PROBE_RULES__ = r;
        window.__RECRUIT_JOB_PROBE_RECORD__ = rec;
      },
      args: [rules, !!recording],
    });
  } catch (e) {
    console.warn('[Background] 探针规则注入失败:', e && e.message);
    ok = false;
  }
  try {
    // 2) 探针本体（MAIN，全帧）——发布页可能是 iframe，顶层注了不等于覆盖到
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['content/job-probe.js'],
    });
  } catch (e) {
    console.warn('[Background] 探针注入失败:', e && e.message);
    ok = false;
  }
  try {
    // 3) 转发层（ISOLATED，全帧）：每帧各一份，各自只上报本帧的消息
    //    （顶层帧不再替子帧转发 —— 否则同一条会被上报两次，数据看着翻倍）
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/job-probe-relay.js'],
    });
  } catch (e) {
    console.warn('[Background] 探针转发层注入失败:', e && e.message);
    ok = false;
  }
  return ok;
}

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
  const resp = await fetch(`${await getApiBase()}/api/extension/session-token`, {
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
  const resp = await fetch(`${await getApiBase()}/api/ext/drafts?status=pending`, {
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
 * Phase 2.6: 代理哨兵调用回填接口
 * content script 在平台页 origin 下 fetch 中台 API 会被 CORS 拦截，且平台发布
 * 成功后页面约 1s 即跳转列表页会中断未完成的 fetch——由本 worker（持有
 * host_permissions、生命周期独立于页面导航）代理执行。
 */
/**
 * 回填发布结果。
 *
 * @param jobBinding 岗位映射（可选）：{ platformJobId, platformJobHint, platformJobSource }
 *        —— 平台岗位 ID 拿不到时三个字段都可为空，此时不往请求体里塞这些键，
 *        后端按「尚未绑定」处理，由中台人工绑定兜底（见设计文档 candidate-position-linking.md）。
 */
async function reportPublishSuccess(recordId, publishedUrl, jobBinding) {
  const stored = await chrome.storage.local.get(['ext_token']);
  const token = stored.ext_token;
  if (!token) throw new Error('未找到扩展 token，无法回填');

  const payload = {
    status: 'published',
    publishedUrl,
  };
  const binding = jobBinding || {};
  if (binding.platformJobId) {
    payload.platformJobId = binding.platformJobId;
  }
  // 来源与平台原文提示只进 resultNote 之外的诊断通道，不占业务字段：
  // 后端 platform_job_hint 由采集侧（候选人节点上的 bottomText）负责，
  // 这里的 jobSource 只用于真机排障，写进 note 便于日志对齐。
  if (binding.platformJobSource) {
    payload.resultNote = '扩展自动关联平台岗位（来源：' + binding.platformJobSource + '）';
  }

  const resp = await fetch(`${await getApiBase()}/api/ext/records/${recordId}/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-Token': token,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`回填接口失败 (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  if (data.code !== 200) {
    throw new Error(`回填失败: ${data.message || '未知错误'}`);
  }
  console.log('[Background] 哨兵回填成功, recordId:', recordId);
}

/**
 * Phase 2.6: 注入哨兵脚本到填充完成的平台页
 *
 * @param {number} targetTabId - 填充完成的平台页 tabId
 * @param {string} recordId - 发布记录 ID
 * @param {object} successConfig - 成功信号配置 { urlPattern, selectors, timeoutMs }
 * @param {number} platformTabId - 中台页面 tabId（用于回传 PUBLISH_BACK）
 */
/**
 * 岗位 ID 键表兜底值（与后端 CollectRules.JOB_ID_KEYS / job-probe.js 的 DEFAULT_RULES 保持一致）。
 *
 * 为什么有兜底而不是只依赖后端下发：发布回填链路与采集链路是两条，
 * HR 可能先发布、后采集（此时还没拉过采集规则）。拿不到规则也必须能捕获岗位 ID，
 * 否则路径 A 会因「没拉过另一个接口」静默失效 —— 这与 FALLBACK_RESUME_KEYS 是同一个理由。
 *
 * 渠道数据（field_map_json.jobIdKeys）若配了，优先用渠道的（逻辑后置，平台改版不改扩展发版）。
 */
const FALLBACK_JOB_ID_KEYS = ['jobId', 'encryptJobId', 'jobIdEncrypt'];
const FALLBACK_JOB_HINT_KEYS = ['bottomText'];

/**
 * 注入岗位捕获探针（MAIN 世界，覆盖所有帧）。
 *
 * 为什么必须 MAIN 世界：只有主世界能 hook 到页面自己的 fetch / XMLHttpRequest。
 * 为什么必须 allFrames：BOSS 发布页是 /web/frame/job/publish-edit（frame 形态），
 *   发布提交的响应不一定发生在顶层帧，只在顶层注入会看不到。
 * 为什么允许失败：探针是「多一条通道」，不是必要条件 —— 哨兵仍会退到 URL / DOM 两路。
 *   探针注入失败绝不能让填充流程失败（那条链路是用户可感知的主功能）。
 */
async function injectJobProbe(tabId, successConfig) {
  const fromChannel = (successConfig && Array.isArray(successConfig.jobIdKeys)
    && successConfig.jobIdKeys.length) ? successConfig.jobIdKeys : null;
  const rules = {
    jobIdKeys: fromChannel || FALLBACK_JOB_ID_KEYS,
    jobHintKeys: (successConfig && Array.isArray(successConfig.jobHintKeys)
      && successConfig.jobHintKeys.length) ? successConfig.jobHintKeys : FALLBACK_JOB_HINT_KEYS,
  };
  // ★ 若诊断录制已开着，发布流程注入的探针也必须带录制开关 ★
  //   否则会出现最坏的情况：人明明点了「开始录制」，发布过程却一条都没录到，
  //   拿去分析时误判成「发布时平台没返回岗位信息」。
  const recording = diagRecording;
  const ok = await diagInjectProbe(tabId, recording, rules);
  if (ok) {
    console.log('[Background] 岗位探针已注入，键表:', rules.jobIdKeys, '录制:', recording);
  }
  // 注入失败不阻断：哨兵还有 URL / DOM 两条退路，最差情况是留空等人工绑定
}

async function injectSentinel(targetTabId, recordId, successConfig, platformTabId) {
  console.log('[Background] 准备注入哨兵, targetTabId:', targetTabId, 'recordId:', recordId);

  // 0. 岗位捕获探针（路径 A：发布成功时把平台岗位 ID 一并带回）
  await injectJobProbe(targetTabId, successConfig);

  // 1. 构造哨兵配置（回填 fetch 由 background 代理，无需下发 token）
  const sentinelConfig = {
    recordId,
    successConfig: {
      urlPattern: successConfig.urlPattern || null,
      selectors: successConfig.selectors || [],
      timeoutMs: successConfig.timeoutMs || 60000,
    },
    platformTabId,
  };

  // 2. 注入配置到目标页面的 window
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

  // 3. 注入哨兵脚本
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

  // 1. 前台开 tab：引擎大量依赖 setTimeout 等待级联渲染/推荐流程，后台 tab 会被
  //    Chrome 定时器节流（隐藏 5 分钟后每分钟仅 1 次定时器），流程会被拖死
  const tab = await chrome.tabs.create({ url: entryUrl, active: true });
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

  // 5. 报告落 storage（tab 创建时已在前台，无需再切）
  const report = {
    recordId: d.recordId || null,
    requestNo: d.requestNo || '',
    title: d.title || '',
    at: Date.now(),
    tabId: tab.id,
    result,
  };
  await chrome.storage.local.set({ lastFillReport: report });
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

// ============================================================
// 简历采集（框架 §2 Phase 1）
//
// 形态：HR 在 BOSS 页面点「采集到人才库」-> content/collect-button.js 发 COLLECT_REQUEST
//      -> 本 worker 编排：下发规则 -> 跨帧取数 -> 提交入库 -> 附件重放下载并上传。
//
// 为什么必须由 worker 编排，而不是让内容脚本直接打接口：
//   1) 内容脚本在平台页 origin 下访问中台 API 会被 CORS 拦；
//   2) 数据分散在多个帧：JSON 命中在聊天/列表帧，附件响应在 pdf-viewer 帧，
//      内容脚本只能看到自己那一帧，必须由 worker 汇总；
//   3) 平台页面随时可能跳转，页面内未完成的 fetch 会被中断。
// ============================================================

/** 采集平台标识（一期仅 BOSS，见框架 D3） */
const COLLECT_PLATFORM = 'boss';

/** tabId -> 最近一次收到 hook 就绪的时间戳（仅用于面板诊断） */
const collectHookFrames = new Map();

/** 后端规则不可用时的兜底键表（与后端 CollectRules 保持一致） */
const FALLBACK_RESUME_KEYS = [
  'geekName', 'expectSalary', 'geekCard', 'advantage',
  'workExp', 'eduExp', 'workExpList', 'eduExpList',
  'experiences', 'content1', 'content2', 'content3',
  'workYear', 'positionCategory', 'applyStatus', 'education',
  'salary', 'jobSalary', 'bottomText', 'ageDesc'
];

/**
 * 时间戳文本 —— 必须是 ISO-8601 且带 `T`、无时区后缀，例如 2026-09-21T05:58:14.123。
 *
 * 为什么不能用 "yyyy-MM-dd HH:mm:ss"（踩过的坑）：
 *   application.yml 里的 `spring.jackson.date-format` **只对 java.util.Date 生效**，
 *   对 java.time.LocalDateTime 完全无效 —— Jackson 的 JSR-310 模块固定按 ISO-8601 解析。
 *   发成带空格的形式会直接 500：Text '2026-09-21 05:58:14' could not be parsed at index 10。
 *   这个格式也与后端自己的输出一致（前端 utils.ts 的 formatUtcIso 注释：
 *   「后端时间为 UTC ISO 字符串（无时区后缀，如 2026-09-15T13:59:35.956）」）。
 *
 * toISOString() 本身就是 UTC，截到毫秒即得目标格式。
 */
function utcStamp(d) {
  return (d || new Date()).toISOString().slice(0, 23);
}

async function getExtToken() {
  const stored = await chrome.storage.local.get(['ext_token']);
  const token = stored.ext_token;
  if (!token) {
    throw new Error('未找到扩展 token：请先在中台页面登录一次（扩展会自动换取 token）');
  }
  return token;
}

/** 拉取采集规则（后端下发，逻辑后置；失败不阻塞采集，用 hook 内置兜底） */
async function fetchCollectRules(token) {
  const resp = await fetch(`${await getApiBase()}/api/ext/collect/rules`, {
    method: 'GET',
    headers: { 'X-Extension-Token': token },
  });
  if (!resp.ok) throw new Error(`规则接口 ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 200 || !data.data) throw new Error(data.msg || '规则接口返回异常');
  return data.data;
}

/** 向标签页所有帧要采集数据；没有 bridge 的帧不会应答，故直接按应答集合处理 */
async function collectFromFrames(tabId, scene) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_EXTRACT', scene });
  } catch (e) {
    console.warn('[Background] 采集取数无帧应答:', e && e.message);
    return [];
  }
  const arr = Array.isArray(res) ? res : [res];
  return arr.filter((r) => r && r.ok && r.payload).map((r) => r.payload);
}

/** 把所有帧的所有候选条摊平（hook 已按命中键数量降序给出，这里再全局排一次） */
function flattenCaptures(frames) {
  const all = [];
  frames.forEach((f) => {
    (f.captures || []).forEach((c) => { if (c && c.bodyText) all.push(c); });
  });
  all.sort((a, b) => (b.matchedKeyCount || 0) - (a.matchedKeyCount || 0));
  return all;
}

/**
 * 汇总所有帧上报的「岗位 ID 数字 ↔ 加密」配对，建成一张数字 → 加密的翻译表。
 *
 * ★ 为什么必须有这张表（2026-09-22 真机取证）★
 *   BOSS 的岗位 ID 有两套 ID 空间：
 *     · 数字  jobId 575500411      —— 简历采集拿到的 body.resume.jobId 是它
 *     · 加密  encryptJobId 352f9…  —— 发布响应 job/save 与职位管理接口是它
 *   而发布台账记的 platform_job_id 是加密形态。若采集侧直接落数字，
 *   与台账里的加密值**永不相等** → 映射永远解析不到，候选人永远「未归类」。
 *
 * 配对只在**同一个对象节点内**产生（见 hook 的 pairFromNode），所以不存在
 * 「A 岗位的数字配到 B 岗位的加密」这种张冠李戴。
 */
function collectJobPairs(frames) {
  const map = new Map();
  frames.forEach((f) => {
    (f.jobPairs || []).forEach((p) => {
      if (!p || !p.num || !p.enc) return;
      const num = String(p.num).trim();
      const enc = String(p.enc).trim();
      if (!looksNumericId(num) || !looksEncryptedId(enc)) return;
      // 同一个数字 ID 被两个不同的加密 ID 声称（理论上不该发生）→ 以后到的为准，
      // 同时打点：真出现说明配对口径有问题，得回来看，而不是默默取一个。
      if (map.has(num) && map.get(num) !== enc) {
        console.warn('[Background] 岗位 ID 配对冲突:', num, map.get(num), 'vs', enc);
      }
      map.set(num, enc);
    });
  });
  return map;
}

/**
 * 把采集到的岗位 ID 归一成**加密形态**（台账侧的规范形）。
 *
 * @param rawJobId 候选人节点上取到的岗位 ID（可能是数字，也可能已经是加密）
 * @param pairs    数字 → 加密 翻译表
 * @returns {{ jobId:string, normalized:boolean, reason:string }}
 *
 * 为什么规范形只能是加密、不能是数字：
 *   新发布的岗位在「桥」里**还没有数字形态**（还没有任何候选人跟它聊过），
 *   发布当时换不出数字；而采集时必定已有聊天，桥里两种形态都在。
 *   所以发布侧存加密、采集侧归一到加密，是唯一自洽的方向。
 */
function normalizeJobId(rawJobId, pairs) {
  const raw = rawJobId == null ? '' : String(rawJobId).trim();
  if (!raw) return { jobId: '', normalized: false, reason: 'empty' };
  if (looksEncryptedId(raw)) return { jobId: raw, normalized: false, reason: 'already-encrypted' };
  if (!looksNumericId(raw)) return { jobId: raw, normalized: false, reason: 'unrecognized-shape' };
  const enc = pairs && pairs.get(raw);
  if (enc) return { jobId: enc, normalized: true, reason: 'bridged' };
  // 归一失败也**照常返回原始数字形态**：投递事实不能丢（人不落行 = 这次投递永久消失）。
  // request_id 会解析不到 → 候选人库里显示「未归类」，事后可补，比丢数据强。
  return { jobId: raw, normalized: false, reason: 'no-bridge' };
}

/**
 * 从采集到的字段里取岗位 ID。
 *
 * ⚠️ 键名遍历顺序**不代表可信度**：真机实测 jobId 这个键在 job/data/list 里装数字、
 * 在 job/save 里装加密，同名不同物。所以这里只负责「取到一个非空标量」，
 * 形态判定一律交给 normalizeJobId 按**值的形状**做。
 */
function pickJobId(fields, keys) {
  if (!fields) return null;
  const list = Array.isArray(keys) && keys.length ? keys : FALLBACK_JOB_ID_KEYS;
  for (const k of list) {
    const v = fields[k];
    if (v == null) continue;
    if (typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/**
 * 从多条候选响应里分出「字段来源」与「身份来源」，并挡掉多人响应。
 *
 * ★ 为什么必须分开选（真机踩过的坑）★
 *   聊天页两条命中各有优势：historyMsg 字段最丰富（22 键）但**没有加密 ID**；
 *   chat/geek/info 字段少但**有 encryptUid**。
 *   只取一条必然二选一 —— 要么字段全但幂等键落成数字 uid（与其它链路分裂成两个人），
 *   要么键对但字段贫。所以：**字段取最丰富的，身份取带加密 ID 的**。
 *
 * 多人响应（如好友列表、推荐列表）**既不能当字段来源也不能当身份来源**：
 *   前者会把几十个人混进一条记录，后者会随机取到某个陌生人的 ID。
 */
function selectSources(captures, selfUid) {
  const exclude = new Set();
  if (selfUid) exclude.add(String(selfUid));

  const usable = [];
  let multiCount = 0;
  let multiSample = 0;
  for (const c of captures) {
    let body;
    try { body = JSON.parse(c.bodyText); } catch (e) { continue; }
    const ids = distinctEncryptedIds(body);
    if (ids.length > 1) {
      multiCount += 1;
      multiSample = Math.max(multiSample, ids.length);
      continue;
    }
    // ★ 关键：同时算出「候选人对象」节点。
    //   身份扫描必须**先扫这个节点、再扫整份响应体** —— 实测踩过：
    //   historyMsg 的消息信封里 from/to 同时含 HR 与候选人，
    //   直接全 body 扫描会按遍历顺序随机命中，真机上抓到过 HR 自己的 uid（618821200）。
    //   而候选人对象（messages[].body.resume）里只有候选人自己，不含信封。
    const node = extractFields(body, null).node;
    usable.push({ capture: c, body, node });
  }
  if (!usable.length) return { usable, multiCount, multiSample, fields: null, identity: null, platformUserId: null };

  // 字段来源：可用的第一条（hook 已按命中键数降序）
  const fields = usable[0];

  // 身份来源：优先加密 ID（用户已确认只以加密 ID 作幂等键）；每个来源都是「节点优先、body 兜底」
  let identity = null;
  let platformUserId = null;
  for (const u of usable) {
    const eid = scanForKeys(u.node, ENCRYPTED_ID_KEYS, null)
      || scanForKeys(u.body, ENCRYPTED_ID_KEYS, null);
    if (eid) { identity = u; platformUserId = eid; break; }
  }
  // 退路 1：数字 ID（同样节点优先，并排除自己）
  if (!platformUserId) {
    for (const u of usable) {
      const nid = scanForKeys(u.node, ['uid', 'geekId'], exclude)
        || scanForKeys(u.body, ['uid', 'geekId'], exclude);
      if (nid) { identity = u; platformUserId = nid; break; }
    }
  }
  // 退路 2：URL 参数
  if (!platformUserId) {
    for (const u of usable) {
      const uid = identityFromUrl(u.capture.url);
      if (uid && !exclude.has(String(uid))) { identity = u; platformUserId = uid; break; }
    }
  }

  // 备用数字 ID：主键是加密 ID 时顺手记下对应的数字 uid，
  // 写进 candidate.source_platform_user_raw，供日后核对「两个 ID 空间是否一致」
  let secondary = null;
  if (platformUserId && /[A-Za-z]/.test(platformUserId)) {
    for (const u of usable) {
      const nid = scanForKeys(u.node, ['uid', 'geekId'], exclude)
        || scanForKeys(u.body, ['uid', 'geekId'], exclude);
      if (nid && nid !== platformUserId) { secondary = nid; break; }
    }
  }

  return { usable, multiCount, multiSample, fields, identity, platformUserId, secondary };
}

/** 合并所有帧的附件（JSON 在聊天帧、附件响应在 pdf-viewer 帧，必须跨帧汇总） */
function mergeAttachments(frames) {
  const map = new Map();
  frames.forEach((f) => {
    (f.attachments || []).forEach((a) => {
      if (!map.has(a.platformFileId)) map.set(a.platformFileId, a);
    });
  });
  return Array.from(map.values());
}

/** 从 URL 兜底取身份（聊天历史接口把候选人 uid 放在 gid 里，会话接口放在 uid 里） */
function identityFromUrl(url) {
  try {
    const u = new URL(url);
    for (const k of ['geekId', 'uid', 'encryptGeekId', 'gid']) {
      const v = u.searchParams.get(k);
      if (v) return v;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 统计一份响应里出现了几个「人」——用加密 ID 去重。
 *
 * 为什么要这一步：推荐牛人列表一次响应带回整页候选人，
 * 此时「采集」没有明确目标，只能随便挑一个，这与「逐条主动采集」的红线冲突。
 * 用加密 ID 集合的大小判断，比硬编码接口名单更稳（平台换接口也不用改）。
 */
const ENCRYPTED_ID_KEYS = ['encryptGeekId', 'encGeekId', 'encryptUid'];

// ============================================================ 附件观察（webRequest）

/**
 * 为什么附件不能只靠页面 hook 看。
 *
 * 实测踩过（2026-09-21）：HR 点开简历预览、PDF 也渲染出来了，但后端日志证实
 * 那两次采集 `INSERT INTO attachment` 一条都没有 —— hook 在聊天页压根没看到
 * 附件请求。原因是简历 PDF 常由「浏览器内置阅读器」「iframe 导航」「新标签页」
 * 发起，这些都不穿页面 JS 的 fetch/XHR，页面主世界的 hook 天然看不见。
 *
 * 所以补一条扩展层的旁路观察：chrome.webRequest 监听所有 zhipin 请求，
 * 命中附件端点就缓存下来（URL + tabId + 时间）。MV3 下 webRequest 只观察不拦截，
 * 不需要阻塞式权限，也不给页面增加任何延迟。
 *
 * 采集时按「geekId 与当前候选人一致」取用 —— 宁可不采，也不张冠李戴。
 */
const ATTACH_URL_RE = /\/wflow\/[^/]+\/download\//i;
const ATTACH_CACHE_KEY = 'collect_recent_attachments';
const ATTACH_TTL_MS = 30 * 60 * 1000;   // 与后端 origin_ticket_expires_at 同量级
const ATTACH_CACHE_MAX = 40;
/**
 * 「同标签页最近预览」兜底的时效窗。
 *
 * 只在「已确认 ID 对不上」之后才走这条路，所以窗口必须贴着**正确操作路径**取：
 * 文档要求 HR「点开预览 → 等 PDF 渲染 → 立刻点采集」，实际间隔是秒级。
 * 2 分钟足够覆盖手慢的情况，又不足以让「上一位候选人预览过的附件」
 * 漂移到下一位候选人头上（每次认领后还会立刻把该条从缓存移除）。
 */
const ATTACH_TAB_FRESH_MS = 2 * 60 * 1000;

/**
 * 附件幂等键，口径与 collect-hook.js 的 buildPlatformFileId 一致：
 *   <kind>:<geekId>:<previewType>
 *
 * 两处各留一份实现是刻意的 —— 扩展没有打包器，hook 跑在页面主世界、
 * background 跑在 SW，无法共享模块。**改口径必须同时改两处。**
 */
function buildPlatformFileId(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    const kind = seg.length >= 2 ? seg[seg.length - 2] : 'file';
    const id = seg.length ? decodeURIComponent(seg[seg.length - 1]) : 'unknown';
    // ★ 刻意**不包含 query** ★
    //   真机取到的两种 URL 形态（同一份附件、同一个人）：
    //     ① https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/<geekId>
    //     ② .../download4boss/<geekId>?d=...&geekId=<geekId>&previewType=1
    //   ①是②重定向后的形态。旧口径把 previewType 拼进键，同一份文件会算出两个键，
    //   而 attachment 上 uk_platform_file(platform, platform_file_id) 是**全局唯一** ——
    //   结果是同一份简历入库两行（一行 pending 一行 done）。query 只是票据/时间戳，不参与身份。
    return kind + ':' + id;
  } catch (e) {
    return 'file:unknown';
  }
}

/**
 * 取附件 URL 的端点路径（不含 host/query），用于给 HR 展示「到底命中了什么端点」。
 * 真机形态：`/wflow/zpgeek/download/download4boss/01858de472ad39180XRy2t-9FFRU`
 * —— 路径本身就说明了「末段是加密 geekId、不是数字 uid」，比空口描述有效得多。
 */
function attachmentEndpointPath(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return String(url || '?');
  }
}

// ============================================================ 附件主动探测

/**
 * ★ 为什么可以不点预览就拿到附件（2026-09-21 真机取证后的结论）★
 *
 * 观察到的真实 URL（Chrome 本地下载库里挖出来的）：
 *   https://www.zhipin.com/wflow/zpgeek/download/preview4boss/01858de472ad39180XRy2t-9FFRU
 *     ?d=1789957169000&previewType=1&geekId=01858de472ad39180XRy2t-9FFRU
 *   https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/01858de472ad39180XRy2t-9FFRU
 *     ?d=1789957125000&geekId=01858de472ad39180XRy2t-9FFRU&previewType=1
 *
 * 三条关键事实：
 *   1) **没有签名参数**。query 里只有 `d`（毫秒时间戳）、`previewType`、`geekId`，
 *      没有任何 HMAC / token / 票据字段 —— 说明这个 URL 不是服务端签发的，
 *      而是**页面在点击时自己拼出来的**（`d` 就是此刻的 Date.now()）。
 *      凡是页面能拼的，扩展也能拼。
 *   2) path 末段就是**加密 geekId**，而这个值我们已经有了
 *      （加密 ID 是幂等键，见 selectSources / bridgeIdentityIds）。
 *   3) 授权靠 cookie（`credentials: 'include'`），不靠 URL 里的票据 ——
 *      所以「由 SW 发起」与「由页面点击发起」对平台是同一件事。
 *
 * 于是「点开预览」**不是必要条件，只是最省事的一条路**：它让 URL 出现在
 * webRequest 的观察流里。不去点，也可以用同一个 geekId 自己拼出来发一次。
 *
 * 为什么仍然把这条件定位成「兜底」而不是主路径：
 *   主动探测要多打一次平台请求（多一分风控暴露面），而观察路径是**零额外成本**的
 *   （HR 本来就点了预览）。所以只有在「观察路径一份附件都没拿到」时才启动探测。
 *
 * 归属安全性：URL 是用**这位候选人自己的**加密 geekId 拼的，不存在张冠李戴 ——
 * 比 attach_tab 那种弱证据兜底强得多。
 */
const PROBE_HOST = 'https://www.zhipin.com';
const PROBE_ENDPOINTS = ['preview4boss', 'download4boss'];

/** 拼探测 URL：与真机观察到的形态逐字对齐（含 query 的位置与顺序） */
function buildProbeUrl(geekId, endpoint) {
  const id = encodeURIComponent(geekId);
  const base = `${PROBE_HOST}/wflow/zpgeek/download/${endpoint}/${id}`;
  if (endpoint === 'preview4boss') {
    // `d` 在真机上是**点击那一刻**的毫秒时间戳（playload 里没有别的可选来源），
    // 只当缓存击穿用；用当前时间重建与页面行为一致。
    return `${base}?d=${Date.now()}&previewType=1&geekId=${id}`;
  }
  return base;
}

/**
 * 从候选人的全部已知标识里挑一个可用于探测的**加密 ID**。
 * 只认加密形态：数字 uid 拼进下载端点解析不出任何东西（两个 ID 空间，见 bridgeIdentityIds）。
 */
function pickProbeGeekId(candidates) {
  for (const v of candidates || []) {
    if (v && looksEncryptedId(String(v))) return String(v);
  }
  return null;
}

/**
 * 取「同一个人的另一种 ID 形态」，交给后端做**写入时归一**。
 *
 * 为什么这个值不能随便给：它会写进 `candidate.platform_user_id_alt` 并**参与候选人幂等查找**。
 * 混进别人的 ID，就会把那个人的采集请求吸到这条记录上 —— 候选人级别的张冠李戴，
 * 而且比附件错挂更难发现（附件错挂一眼能看出来，候选人错并只有翻库才看得出）。
 * 所以候选值只允许来自这三个**同一人**来源：
 *   ① `sel.secondary` —— 采到的**同一个候选人节点**上的备用 ID（真机已验证有效）；
 *   ② `expectedGeekId` —— 来源 URL 的 gid/geekId，就是被查看的那个人；
 *   ③ `bridgedIds` —— 跨 ID 空间映射表，只在「同一对象内同时出现数字键与 encrypt* 键」时才记账。
 *
 * 刻意**不含 idHints**：那个集合是为「附件 URL 比对」放宽出来的（口径更宽、允许中证据兜底），
 * 拿来做身份归并风险不对称 —— 归并错了会污染候选人主档，代价高得多。
 *
 * 为什么优先 sel.secondary：它在真机两次采集里都被证明是对的（陈诗健 608120464、
 * 谢建广 681940311 都由它带出），已被 source_platform_user_raw 依赖，稳定性有据。
 */
function counterpartIdOf(primary, candidates) {
  const p = primary == null ? '' : String(primary);
  for (const v of candidates || []) {
    if (v == null) continue;
    const s = String(v);
    if (!s || s === p) continue;
    if (!looksEncryptedId(s) && !looksNumericId(s)) continue;
    return s;
  }
  return null;
}

/**
 * 主动探测附件：按加密 geekId 依次试 preview4boss / download4boss。
 *
 * 为什么要做内容嗅探（%PDF 魔数）而不是只看 HTTP 200：
 *   平台对「这位候选人没有附件简历」这种情况，很可能用 200 + 一个 HTML 错误页回应，
 *   光看 resp.ok / blob.size 会把它当成一份简历存进库 —— 那比没采到更糟（脏数据 + 需人工核）。
 *
 * 拿到的 Blob 会随返回值带出去，调用方直接复用它上传，**不再二次请求平台**。
 *
 * @returns {Promise<null|{url:string, blob:Blob, contentType:string, size:number}>}
 */
async function probeAttachmentByGeekId(geekId) {
  for (const ep of PROBE_ENDPOINTS) {
    const url = buildProbeUrl(geekId, ep);
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.zhipin.com/',
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!resp.ok) {
        console.log('[Background] 探测未命中:', ep, 'HTTP', resp.status);
        continue;
      }
      const ct = resp.headers.get('content-type') || '';
      const blob = await resp.blob();
      if (!blob.size) {
        console.log('[Background] 探测未命中:', ep, '空响应');
        continue;
      }
      // 前 4 字节 %%PDF 魔数。只有它是权威判据 —— content-type 可能缺失或被写成 octet-stream。
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
      if (!isPdf) {
        console.log('[Background] 探测未命中:', ep, '不是 PDF（content-type=' + ct + ', bytes=' + blob.size + '）');
        continue;
      }
      return { url, blob, contentType: /pdf/i.test(ct) ? ct : 'application/pdf', size: blob.size };
    } catch (e) {
      console.log('[Background] 探测异常:', ep, String((e && e.message) || e));
    }
  }
  return null;
}

/**
 * 在整条 URL 里找候选人标识（路径段 + 全部 query 值 + 带边界的整串兜底）。
 *
 * ★ 为什么不是只看「路径末段」★
 *   最初按「末段就是 geekId」比对（那只是 Phase 0 的推断），真机上 6 个候选人的
 *   附件**全被判成不匹配** —— 说明这个下载端点的 URL 形态与推断不符：
 *   id 可能在 query 的 `id=` 里，也可能末段是文件令牌。
 *   改为「把候选人的每一种 ID 都拿去在整条 URL 里找」，任一对上即认领。
 *   口径更宽，但仍是**精确的 ID 相等**，不会张冠李戴。
 */
function urlIdentityMatch(url, ids) {
  if (!url || !ids || !ids.length) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }

  const tokens = [];
  u.pathname.split('/').forEach((s) => {
    if (!s) return;
    try { tokens.push(decodeURIComponent(s)); } catch (e) { tokens.push(s); }
  });
  u.searchParams.forEach((v) => { if (v) tokens.push(v); });

  for (const id of ids) {
    const s = String(id);
    if (s && tokens.indexOf(s) >= 0) return s;
  }

  // 兜底：带边界的子串匹配，覆盖 `<id>.pdf`、`<id>_1` 这类拼接形态。
  // 边界用 [^0-9A-Za-z]（把 _ 和 - 也算边界），但前后的数字/字母必须断开 ——
  // 这样 `675754238` 不会误命中 `6757542389`。
  for (const id of ids) {
    const s = String(id);
    if (s.length < 6) continue;          // 太短的串容易误命中，只走 token 精确比较
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(?:^|[^0-9A-Za-z])' + esc + '(?:$|[^0-9A-Za-z])').test(url)) return s;
  }
  return null;
}

/**
 * 收集「这个人可能的所有标识」：加密 ID + 数字 uid/geekId，排除 HR 自己。
 *
 * 为什么要把所有命中响应体都翻一遍：同一个人的标识在不同接口下叫不同名字
 * （encryptUid / encryptGeekId / uid / geekId），只拿主键一个值去比对，
 * 一旦附件 URL 用的是另一个形态就必然失败 —— 这正是真机上踩到的那一脚。
 * 短于 5 位的值直接丢弃：`authType=0`、`previewType=1` 这种参数会被误当成 ID。
 */
function collectIdentityHints(bodies, seeds, selfUid) {
  const out = [];
  const seen = new Set();
  const exclude = new Set();
  if (selfUid) exclude.add(String(selfUid));
  const push = (v) => {
    if (v == null) return;
    const s = String(v);
    if (s.length < 5 || seen.has(s) || exclude.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  (seeds || []).forEach(push);

  const KEYS = ENCRYPTED_ID_KEYS.concat(['uid', 'geekId']);
  for (const body of bodies || []) {
    if (!body || typeof body !== 'object') continue;
    let budget = 900;
    const visited = new Set();
    const stack = [body];
    while (stack.length && budget-- > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
      visited.add(cur);
      if (Array.isArray(cur)) {
        for (let i = 0; i < Math.min(cur.length, 30); i += 1) stack.push(cur[i]);
        continue;
      }
      for (const k of Object.keys(cur)) {
        const v = cur[k];
        if (KEYS.indexOf(k) >= 0 && (typeof v === 'string' || typeof v === 'number') && String(v)) push(v);
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return out;
}

/** 加密 ID 形态：`01858de472ad39180XRy2t-9FFRU`、`414ab30b56e5e1810XN_3Ni5ElFY` —— 字母数字混排 16+ 位 */
function looksEncryptedId(v) {
  const s = String(v);
  if (!/^[0-9A-Za-z_~-]{16,64}$/.test(s)) return false;
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  return true;
}

function looksNumericId(v) {
  return /^\d{6,}$/.test(String(v));
}

/**
 * 建立「数字 uid ↔ 加密 ID」映射，把候选人的**另一个 ID 空间**补齐。
 *
 * ★ 为什么必须这一步（真机取证 2026-09-21）★
 *   从 Chrome 下载链里挖出的真实附件 URL：
 *     https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/01858de472ad39180XRy2t-9FFRU
 *       ?d=1789957125000&geekId=01858de472ad39180XRy2t-9FFRU&previewType=1
 *   而库里这位候选人（陈诗健）的 platform_user_id 是**数字** 608120464。
 *   同一个人、两个 ID 空间。
 *   更麻烦的是：BOSS 聊天页对**大多数**候选人不返回加密 ID
 *   （见 selectSources 注释：historyMsg 字段最丰富但无加密 ID）——
 *   所以「附件 URL 里的加密 geekId」压根不在候选人的已知 ID 里，怎么比都不匹配。
 *
 * ★ 出路不是放宽比对，而是把映射查出来 ★
 *   聊天/好友列表这类**多人响应**里，每一行同时带数字 uid 与加密 geekId。
 *   它不能当采集来源（会把几十个人混成一条，见 distinctEncryptedIds 的拦截），
 *   但完全可以当**映射表**用：我已知这个人的数字 uid，去表里查他对应的加密 ID。
 *   查出来之后，附件 URL 的加密 geekId 与候选人就是**精确相等**关系，不是猜。
 *
 * 只在「同一对象内」建立配对（数字键 + encrypt* 键同时出现）才记账，不做跨对象连线，
 * 避免把不同人的 ID 串起来。
 */
function bridgeIdentityIds(bodies, knownIds) {
  const known = new Set((knownIds || []).filter(Boolean).map(String));
  const out = new Set();
  if (!known.size) return out;

  const NUM_KEYS = ['uid', 'geekId', 'bossId', 'userId', 'friendId'];
  for (const body of bodies || []) {
    if (!body || typeof body !== 'object') continue;
    let budget = 1500;
    const seen = new Set();
    const stack = [body];
    while (stack.length && budget-- > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (let i = 0; i < Math.min(cur.length, 50); i += 1) stack.push(cur[i]);
        continue;
      }
      const nums = [];
      const encs = [];
      for (const k of Object.keys(cur)) {
        const v = cur[k];
        if (typeof v === 'string' || typeof v === 'number') {
          const s = String(v);
          if (NUM_KEYS.indexOf(k) >= 0 && looksNumericId(s)) nums.push(s);
          else if ((ENCRYPTED_ID_KEYS.indexOf(k) >= 0 || /encrypt/i.test(k)) && looksEncryptedId(s)) encs.push(s);
        }
        if (v && typeof v === 'object') stack.push(v);
      }
      if (!nums.length || !encs.length) continue;
      const hitNum = nums.some((n) => known.has(n));
      const hitEnc = encs.some((e) => known.has(e));
      if (!hitNum && !hitEnc) continue;
      nums.forEach((n) => out.add(n));
      encs.forEach((e) => out.add(e));
    }
  }
  return out;
}

/**
 * 从候选人来源 URL 里取数字 ID。先用 gid/geekId（一定是被查看的那个人），
 * uid 放在最后 —— historyMsg 一类响应里 uid 可能是 HR 自己，由调用方排除。
 */
function numericCandidateIdFrom(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const k of ['gid', 'geekId', 'uid']) {
      const v = u.searchParams.get(k);
      if (v && /^\d+$/.test(v)) return v;
    }
  } catch (e) { /* ignore */ }
  return null;
}

let attachCache = null;   // null = 尚未从 storage 载入

function pruneAttachCache() {
  const cut = Date.now() - ATTACH_TTL_MS;
  const seen = new Set();
  const out = [];
  // ★ 必须显式按时间倒序，并且**幂等** ★
  //   原来靠「从数组尾部倒着取」来近似「最新在前」，但这个变换跑一次会反转一次：
  //   loadAttachCache() 与 getRecentAttachments() 都会调用本函数，同一条调用链里跑两遍 ——
  //   顺序被打回正序，于是「最近预览的那一条」实际取到了**最旧**的一条。
  //   这个顺序被两处依赖：① addRecentAttachment 的去重口径；
  //   ② 「同标签页最近预览」兜底认领（取 `cachedAttachments[0]`）。
  //   顺序错 = 认领上一位候选人的附件，所以这里不再靠数组顺序，直接排序定序。
  const sorted = attachCache.slice().sort((a, b) => ((b && b.ts) || 0) - ((a && a.ts) || 0));
  for (const it of sorted) {
    if (!it || !it.url || !it.ts || it.ts < cut) continue;
    const key = buildPlatformFileId(it.url);
    if (seen.has(key)) continue;   // 同一次预览会重复请求，按幂等键只留最新一条
    seen.add(key);
    out.push(it);
    if (out.length >= ATTACH_CACHE_MAX) break;
  }
  attachCache = out;
}

async function loadAttachCache() {
  if (attachCache) return attachCache;
  try {
    const o = await chrome.storage.session.get(ATTACH_CACHE_KEY);
    const v = o && o[ATTACH_CACHE_KEY];
    attachCache = Array.isArray(v) ? v : [];
  } catch (e) {
    attachCache = [];
  }
  pruneAttachCache();
  return attachCache;
}

async function addRecentAttachment(hit) {
  await loadAttachCache();
  const key = buildPlatformFileId(hit.url);
  attachCache = attachCache.filter((x) => buildPlatformFileId(x.url) !== key);
  attachCache.push(hit);
  pruneAttachCache();
  try {
    await chrome.storage.session.set({ [ATTACH_CACHE_KEY]: attachCache });
  } catch (e) { /* 缓存写失败只影响补采能力，不影响采集主流程 */ }
  console.log('[Background] 观察到附件请求:', hit.tabId, key);
}

async function getRecentAttachments() {
  await loadAttachCache();
  pruneAttachCache();
  return attachCache.slice();
}

/**
 * 把一条已认领的附件从缓存里移除。
 *
 * 用途：兜底认领（无 ID 佐证）用掉之后必须消费掉，否则同一份附件在下一次
 * 采集里还会被当成「最近预览过的那一份」，从张冠李戴的风险变成必然张冠李戴。
 */
async function removeRecentAttachment(url) {
  await loadAttachCache();
  const key = buildPlatformFileId(url);
  const before = attachCache.length;
  attachCache = attachCache.filter((x) => buildPlatformFileId(x.url) !== key);
  if (attachCache.length === before) return;
  try {
    await chrome.storage.session.set({ [ATTACH_CACHE_KEY]: attachCache });
  } catch (e) { /* 删不掉只会多留一条，不影响正确性 */ }
}

try {
  chrome.webRequest.onCompleted.addListener((d) => {
    try {
      if (d.tabId < 0) return;
      if (d.statusCode && d.statusCode >= 400) return;
      if (!ATTACH_URL_RE.test(d.url)) return;
      addRecentAttachment({ url: d.url, tabId: d.tabId, ts: Date.now() });
    } catch (e) { /* 观察失败绝不能影响页面 */ }
  }, { urls: ['http://*.zhipin.com/*', 'https://*.zhipin.com/*'] });
} catch (e) {
  console.warn('[Background] webRequest 观察器注册失败（附件将只能靠页面 hook）:', e && e.message);
}

/**
 * 附件因「认不出归属」被丢弃时，把**真实 URL** 记进审计表。
 *
 * 为什么必须落库：归属判定只发生在客户端，扩展控制台里的日志用户看不到，
 * toast 也塞不下一条 URL。落进 `collect_audit.client_note` 之后，直接查库就能看出
 * 「这个下载端点的 URL 到底长什么样」，一次就能把比对口径定死，
 * 不必让用户反复试。
 */
async function reportAttachmentSkips(token, info) {
  if (!token) return;
  const note = ('候选人ID=' + (info.candidateIds || []).join(',')
    + '；被拒附件=' + (info.urls || []).join(' | ')).slice(0, 512);
  try {
    await fetch(`${await getApiBase()}/api/ext/collect/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token },
      body: JSON.stringify({
        action: 'attach_download',
        result: 'skipped',
        platform: COLLECT_PLATFORM,
        platformUserId: (info.candidateIds && info.candidateIds[0]) || null,
        scene: 'attach',
        pageUrl: info.pageUrl || null,
        note,
      }),
    });
    console.log('[Background] 已把被拒附件记入审计:', note);
  } catch (e) { /* 上报失败绝不影响采集 */ }
}


function distinctEncryptedIds(root) {
  const ids = new Set();
  let budget = 2000;
  const seen = new Set();
  const stack = [root];
  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 60); i += 1) stack.push(node[i]);
      continue;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (ENCRYPTED_ID_KEYS.indexOf(k) >= 0 && typeof v === 'string' && v) ids.add(v);
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return Array.from(ids);
}

/**
 * 学习「我自己（HR / Boss 账号）的 uid」并缓存。
 *
 * 为什么必须排除自己：实测发现 /wapi/zpchat/boss/historyMsg 的消息体里
 * from 与 to **同时**包含候选人和 HR 本人（例如 uid=618821200 是 HR 自己）。
 * 若只做深度扫描取第一个 uid，存在把 HR 自己采成候选人的真实风险。
 * 自己的 uid 可从会话进入接口的 userInfo.userBaseInfo.id 拿到。
 */
async function getSelfUid() {
  try {
    const st = await chrome.storage.local.get(['collect_self_uid']);
    return st.collect_self_uid || null;
  } catch (e) {
    return null;
  }
}

/** 在响应体里找 userBaseInfo.id 并记住（会话进入接口会带回自己的账号信息） */
async function learnSelfUid(root) {
  if (!root || typeof root !== 'object') return;
  let budget = 600;
  const seen = new Set();
  const stack = [root];
  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 20); i += 1) stack.push(node[i]);
      continue;
    }
    const base = node.userBaseInfo;
    if (base && (typeof base.id === 'number' || typeof base.id === 'string') && String(base.id)) {
      const id = String(base.id);
      const cur = await getSelfUid();
      if (cur !== id) {
        await chrome.storage.local.set({ collect_self_uid: id });
        console.log('[Background] 已记录本账号 uid（用于排除自己）:', id);
      }
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

/**
 * 有预算限制的键扫描：返回第一个命中的键值（可按 keys 过滤、可按 exclude 排除）。
 * 被 selectSources 用于「按优先级找身份」与「探测加密 ID」，抽出来避免两处各写一遍。
 */
function scanForKeys(node, keys, exclude) {
  if (!node) return null;
  let budget = 800;
  const seen = new Set();
  const stack = [node];
  while (stack.length && budget-- > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < Math.min(cur.length, 30); i += 1) stack.push(cur[i]);
      continue;
    }
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (keys.indexOf(k) >= 0 && (typeof v === 'string' || typeof v === 'number') && String(v)) {
        if (!exclude || !exclude.has(String(v))) return String(v);
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

/**
 * 挑出「简历字段最集中的那个对象」，并把它的一层标量/数组字段作为 fields。
 * 为什么不在扩展里做精细归一：Phase 0 结论 —— 平台同一语义至少三套命名，
 * 归一规则属于会变的东西，必须放后端（框架 §0 总原则第 3 条：逻辑后置）。
 * 这里只负责把原始字段原样带过去。
 */
function extractFields(root, resumeKeys) {
  const keySet = new Set(resumeKeys && resumeKeys.length ? resumeKeys : FALLBACK_RESUME_KEYS);
  let best = null;
  let bestScore = 0;
  let budget = 900;
  const seen = new Set();
  const stack = [root];
  while (stack.length && budget-- > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 20); i += 1) stack.push(node[i]);
      continue;
    }
    let score = 0;
    const keys = Object.keys(node);
    for (const k of keys) {
      if (keySet.has(k)) score += 1;
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  if (!best) return { fields: {}, node: null };
  const fields = {};
  Object.keys(best).forEach((k) => {
    const v = best[k];
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[k] = v;
    } else if (Array.isArray(v)) {
      // 只保留元素是对象的数组（工作经历/教育经历这类），其余丢弃以免塞爆 payload
      if (v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
        fields[k] = v.slice(0, 20);
      }
    } else if (typeof v === 'object' && isFlatObject(v)) {
      // 浅层对象也保留：实测聊天消息里姓名在 body.resume.user.name，
      // 丢掉 user 这一层会让后端无法用点号路径取到姓名（真机踩过）。
      // 只保留"所有值都是标量"的对象，避免把整棵子树塞进 payload。
      fields[k] = v;
    }
  });
  // 同时回传命中的那个节点本身：它才是「候选人对象」，
  // 身份解析优先在它上面做（见 selectSources 的注释）
  return { fields, node: best };
}

/** 判断是否"浅层对象"：所有自有值都是标量（可安全作为字段树的一层带出去） */
function isFlatObject(o) {
  const keys = Object.keys(o);
  if (!keys.length || keys.length > 20) return false;
  for (const k of keys) {
    const v = o[k];
    if (v != null && typeof v === 'object') return false;
  }
  return true;
}

/** 场景 -> resume_version.source（后端按此归档采集链路） */
function sourceFromScene(scene) {
  if (scene === 'list') return 'list';
  if (scene === 'detail') return 'detail';
  return 'chat';
}

/**
 * SW 重放下载 + 上传（框架 §2 Phase 2.1 的主路径）。
 *
 * 为什么走 SW：二进制完全不穿消息通道，零膨胀（base64 会 +33%）。
 * 失败原因必须回报后端 —— Phase 0 的 D7 未决点（无 Referer 能否下载附件）
 * 就靠这条 reason 才能判断是「票据过期」「cookie 未带上」还是「被风控拒绝」。
 */
async function downloadAndUploadAttachment(attachmentId, att, token) {
  try {
    let blob = att.prefetchedBlob || null;
    let ct = att.contentType || '';
    if (!blob) {
      // 真机（Chrome 下载链）里这个请求的 Referer 是 https://www.zhipin.com/ —— 原样带上，
      // 免得平台侧按 Referer 判来源；credentials 必须带，下载票据绑在 cookie 上。
      const resp = await fetch(att.originUrl, {
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.zhipin.com/',
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!resp.ok) {
        throw new Error('附件下载返回 HTTP ' + resp.status);
      }
      blob = await resp.blob();
      ct = resp.headers.get('content-type') || '';
    }
    // 探测路径已经把字节拿到手了（见 probeAttachmentByGeekId），这里直接复用 ——
    // 同一份文件不跑第二趟平台请求：少一次风控暴露面，也少一次票据过期的机会。
    if (!blob.size) {
      throw new Error('附件下载内容为空（可能被平台风控拦成空响应）');
    }
    const filename = guessAttachmentName(att, ct);
    const fd = new FormData();
    fd.append('file', blob, filename);
    const up = await fetch(`${await getApiBase()}/api/ext/collect/attachments/${attachmentId}/content`, {
      method: 'POST',
      headers: { 'X-Extension-Token': token },
      body: fd,
    });
    const data = await up.json().catch(() => ({}));
    if (data.code !== 200) {
      throw new Error(data.msg || ('附件上传返回 ' + up.status));
    }
    console.log('[Background] 附件入库成功:', attachmentId, blob.size, 'bytes');
    return true;
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 500);
    console.warn('[Background] 附件下载/上传失败:', attachmentId, reason);
    try {
      await fetch(`${await getApiBase()}/api/ext/collect/attachments/${attachmentId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token },
        body: JSON.stringify({ reason }),
      });
    } catch (e2) { /* 回报失败也不该让整个采集失败 */ }
    return false;
  }
}

function guessAttachmentName(att, contentType) {
  const base = String(att.platformFileId || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
  if (/pdf/i.test(contentType)) return base + '.pdf';
  if (/zip/i.test(contentType)) return base + '.zip';
  if (/image\/png/i.test(contentType)) return base + '.png';
  if (/image\/jpeg/i.test(contentType)) return base + '.jpg';
  return base;
}

/**
 * 采集主编排。
 * @returns {Promise<{ok:boolean, error?:string, summary?:object, candidateName?:string, warning?:string}>}
 */
async function handleCollectRequest(payload, tabId) {
  if (!tabId) {
    return { ok: false, error: '无法确定来源标签页，请刷新页面后重试' };
  }
  const token = await getExtToken();
  const scene = payload.scene || 'chat';

  // 1) 规则下发（后端为真源；拉不到就用 hook 内置兜底，不阻塞采集）
  let rules = null;
  try {
    rules = await fetchCollectRules(token);
    await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_SET_RULES', rules });
  } catch (e) {
    console.warn('[Background] 规则下发失败，使用 hook 内置键表:', e && e.message);
  }

  // 2) 跨帧取数
  const frames = await collectFromFrames(tabId, scene);
  const captures = flattenCaptures(frames);
  const attachments = mergeAttachments(frames);
  // 附件还有一个来源：扩展层 webRequest 观察到的近期附件请求（见 ATTACH_URL_RE 处注释）。
  // 这里只是取出来备用 —— 真正是否采纳要等拿到候选人身份后按 geekId 比对。
  const cachedAttachments = await getRecentAttachments();
  if (!captures.length && !attachments.length && !cachedAttachments.length) {
    return {
      ok: false,
      error: '当前页面没有可采集的简历数据。\n请先在 BOSS 里打开该候选人的简历详情或聊天窗口，再点采集。',
    };
  }

  // 3) 组装提交载荷
  // 先补齐/刷新「本账号 uid」（用于排除 HR 自己被当成候选人）。
  // 为什么需要旁路线索：实测 bossEnter 响应里并没有 userBaseInfo，
  // 自己的 uid 藏在 batch/requests 内嵌的 chat/config 响应里，
  // 而那多半不是本次选中的那条，所以必须由 hook 在近期缓冲里捞出来带出。
  const selfHint = frames.map((f) => f.selfUidHint).find((v) => !!v) || null;
  if (selfHint && selfHint !== (await getSelfUid())) {
    await chrome.storage.local.set({ collect_self_uid: selfHint });
    console.log('[Background] 已记录本账号 uid（页面线索）:', selfHint);
  }
  if (captures.length) {
    try { await learnSelfUid(JSON.parse(captures[0].bodyText)); } catch (e) { /* 解析失败忽略 */ }
  }
  const selfUid = await getSelfUid();

  // 分出「字段来源」与「身份来源」，并挡掉多人响应（框架 §6 红线第 1 条）
  const sel = selectSources(captures, selfUid);
  const fieldsCapture = sel.fields;
  let platformUserId = sel.platformUserId;

  if (!fieldsCapture) {
    if (sel.multiCount > 0) {
      return {
        ok: false,
        error: '当前响应包含 ' + Math.max(sel.multiSample, 2) + ' 位候选人，没有明确的采集目标。\n'
          + '请点开具体候选人的简历或聊天窗口后再点采集（本功能只支持逐条采集，不做整页批量）。',
      };
    }
    if (!attachments.length) {
      return {
        ok: false,
        error: '当前响应没有可用的简历字段。\n请先在 BOSS 里打开该候选人的简历详情或聊天窗口，等数据加载完再点采集。',
      };
    }
    // 极端情况：只有附件、没有 JSON 命中 —— 那就以附件 URL 里的 ID 为准
    platformUserId = identityFromUrl(attachments[0].originUrl);
  }

  if (!platformUserId) {
    return {
      ok: false,
      error: '未能识别候选人 ID（响应里既没有加密 ID，也没能从 URL 取到）。\n'
        + '请点开该候选人的简历或聊天框后再试，避免采到与其他候选人无关的公共数据。',
    };
  }

  const fields = fieldsCapture
    ? extractFields(fieldsCapture.body, rules && rules.resumeKeys).fields
    : {};

  const sourceUrl = fieldsCapture ? fieldsCapture.capture.url : '';

  // ---------- 岗位 ID 归一（数字 → 加密）----------
  // 简历节点上的 body.resume.jobId 是**数字**，而发布台账记的是**加密**形态，
  // 直接落数字会让映射永远解析不到（2026-09-22 真机取证）。这里用同一次采集
  // 会话里页面侧看到的「数字 ↔ 加密」配对把数字换掉。详见 normalizeJobId 注释。
  const jobPairs = collectJobPairs(frames);
  const rawJobId = pickJobId(fields, (rules && rules.jobIdKeys) || FALLBACK_JOB_ID_KEYS);
  const jobNorm = normalizeJobId(rawJobId, jobPairs);
  const jobHint = pickJobId(fields, (rules && rules.jobHintKeys) || FALLBACK_JOB_HINT_KEYS);
  if (rawJobId) {
    console.log('[Background] 岗位 ID 归一:', {
      raw: rawJobId, jobId: jobNorm.jobId, normalized: jobNorm.normalized,
      reason: jobNorm.reason, bridgeSize: jobPairs.size,
    });
  } else {
    console.log('[Background] 未取到岗位 ID（bridgeSize=' + jobPairs.size + '）—— 该条投递将显示为未归类');
  }

  // ---------- 附件合并（页面 hook + 扩展层观察）----------
  // 比对基准：这个人的**全部**已知标识 —— 主键、备用数字 uid、来源 URL 的 gid，
  // 从各条命中响应体里能捞到的所有 ID，以及**跨 ID 空间的映射**（数字 uid → 加密 geekId）。
  // ★ 只拿一个值比对是不够的 ★
  //   真机踩过两脚：
  //   ① 只按「路径末段 == geekId」比对（那只是 Phase 0 的推断）；
  //   ② 文档站以数字 uid 为幂等键，而附件 URL 带的是**加密** geekId —— 永远是两串不同的字符。
  //   多给几种候选值、在整条 URL 里找，再用映射表把两个 ID 空间打通，才稳。
  const urlNumericId = numericCandidateIdFrom(sourceUrl);
  const expectedGeekId = sel.secondary
    || (urlNumericId && urlNumericId !== String(selfUid || '') ? urlNumericId : null);

  // 全量解析所有命中响应（**含被 selectSources 排除的多人列表**）—— 它们不能当采集来源，
  // 但「同一行里数字 uid 与加密 ID 的对应关系」是查映射表的唯一凭据（见 bridgeIdentityIds）。
  const allBodies = [];
  for (const c of captures.slice(0, 40)) {
    try { allBodies.push(JSON.parse(c.bodyText)); } catch (e) { /* 截断的 JSON 解析失败，跳过 */ }
  }
  const bridgedIds = bridgeIdentityIds(allBodies, [platformUserId, sel.secondary, expectedGeekId]);
  if (bridgedIds.size) {
    console.log('[Background] 跨 ID 空间映射命中:', Array.from(bridgedIds));
  }

  const idHints = collectIdentityHints(
    (sel.usable || []).map((u) => u.body),
    [platformUserId, sel.secondary, expectedGeekId].concat(Array.from(bridgedIds)),
    selfUid,
  );

  const ownFileIds = new Set(attachments.map((a) => buildPlatformFileId(a.originUrl)));
  const extraAttachments = [];
  const rejectedUrls = [];
  // 兜底认领只允许一次，且只允许给「本标签页最近的那一条」（见下方注释）
  const newestInTab = cachedAttachments.find((h) => h.tabId === tabId) || null;
  let weakClaimed = 0;
  let cacheCandidates = 0;
  let cacheRejected = 0;
  for (const hit of cachedAttachments) {
    const fid = buildPlatformFileId(hit.url);
    if (ownFileIds.has(fid)) continue;          // 页面 hook 已经拿到了，不重复登记
    cacheCandidates += 1;
    // 归属校验（强证据）：该附件 URL 里必须出现本候选人的某个 ID ——
    // 宁可漏采，也不能把别人的简历挂到这个候选人名下。
    const matchedBy = urlIdentityMatch(hit.url, idHints);
    if (!matchedBy) {
      // —— 兜底认领（弱证据）：同标签页 + 最近一次预览 + 2 分钟窗口 ——
      // 为什么允许：BOSS 对**大多数**候选人不返回加密 ID（见 selectSources 注释），
      // 若该候选人的好友/聊天列表响应也没被这次采集捞到，映射表就查不到，
      // 此时一律拒绝会让「先预览再采集」这条**正确操作路径**永远采不到附件 —— 功能等于没用。
      // 约束（防张冠李戴）：① 必须与采集同一标签页；② 必须是该标签页**最近**一次附件请求；
      // ③ 时差 ≤ ATTACH_TAB_FRESH_MS；④ 用掉即从缓存移除，不能漂到下一位候选人；
      // ⑤ 明确写进 warning 让 HR 核对，并落审计。
      const canWeak = newestInTab
        && hit === newestInTab
        && hit.tabId === tabId
        && (Date.now() - (hit.ts || 0)) <= ATTACH_TAB_FRESH_MS
        && weakClaimed === 0;
      if (!canWeak) {
        cacheRejected += 1;
        if (rejectedUrls.length < 2) rejectedUrls.push(hit.url);
        continue;
      }
      weakClaimed += 1;
      await removeRecentAttachment(hit.url);
      ownFileIds.add(fid);
      extraAttachments.push({
        originUrl: hit.url,
        contentType: '',
        bytes: null,
        sourceScene: 'attach_tab',
        platformFileId: fid,
      });
      continue;
    }
    ownFileIds.add(fid);
    extraAttachments.push({
      originUrl: hit.url,
      contentType: '',
      bytes: null,
      sourceScene: 'attach',
      platformFileId: fid,
    });
  }
  if (cacheCandidates) {
    console.log('[Background] 扩展层观察到的附件候选:', cacheCandidates,
      '补入:', extraAttachments.length, '其中兜底认领:', weakClaimed,
      '丢弃:', cacheRejected, '候选人 ID 候选值:', idHints);
  }
  if (cacheRejected) {
    // 把真实 URL 落进审计表 —— 下次查库就知道该按什么口径比对（见函数注释）
    await reportAttachmentSkips(token, { candidateIds: idHints, urls: rejectedUrls, pageUrl: payload.pageUrl });
  }
  const allAttachments = attachments.concat(extraAttachments);

  // ---------- 附件主动探测（兜底路径，见 PROBE_HOST 处的说明）----------
  // 只在「观察路径一份都没拿到」时启动：HR 点过预览的话，上面的缓存匹配已经拿到了，
  // 再探测一遍等于白打一次平台请求。
  // 探测用的 ID 只认加密形态，且必须是**这位候选人自己的** —— 归属由 URL 构造方式保证。
  let probeInfo = null;
  if (!allAttachments.length) {
    const probeId = pickProbeGeekId(
      [platformUserId, sel.secondary, expectedGeekId]
        .concat(Array.from(bridgedIds))
        .concat(idHints),
    );
    if (probeId) {
      const hit = await probeAttachmentByGeekId(probeId);
      if (hit) {
        allAttachments.push({
          originUrl: hit.url,
          contentType: hit.contentType,
          bytes: hit.size,
          sourceScene: 'probe',
          platformFileId: buildPlatformFileId(hit.url),
          // 字节已经在手，上传阶段直接复用，不再回平台取第二遍
          prefetchedBlob: hit.blob,
        });
        probeInfo = { geekId: probeId, endpoint: attachmentEndpointPath(hit.url), bytes: hit.size };
        console.log('[Background] 主动探测命中附件:', probeInfo);
      } else {
        probeInfo = { geekId: probeId, missed: true };
        console.log('[Background] 主动探测未命中（该候选人可能确实没有附件简历）:', probeId);
      }
    } else {
      probeInfo = { geekId: null, skipped: 'no-encrypted-id' };
      console.log('[Background] 跳过主动探测：没有可用的加密 geekId（无法构造下载端点）');
    }
  }

  const candidatePayload = {
    platformUserId,
    // 归一用：同一个人在平台上的**另一种 ID 形态**。服务端拿它做写入时归一 ——
    // 只按主键单键查会让「先采到数字 uid、后采到加密 geekId」分裂成两条候选人记录
    // （2026-09-21 实测：陈诗健、谢建广各中一次）。取值约束见 counterpartIdOf 注释。
    secondaryPlatformUserId: counterpartIdOf(
      platformUserId,
      [sel.secondary, expectedGeekId].concat(Array.from(bridgedIds)),
    ),
    sourceChannel: payload.sourceChannel || 'chat',
    scene,
    pageUrl: payload.pageUrl || '',
    source: sourceFromScene(scene),
    sourceApi: sourceUrl,
    sourceUrl,
    // 岗位 ID：**已归一成加密形态**（与发布台账 platform_job_id 同形态，映射才解析得到）。
    // 拿不到桥时退化为原始数字形态 —— 照样落行，只是这条投递暂时「未归类」，
    // 宁可显示未归类，也不让投递事实凭空消失。
    platformJobId: jobNorm.jobId || null,
    platformJobHint: jobHint || null,
    fields,
    raw: fieldsCapture ? fieldsCapture.capture.bodyText : null,
    rawEncrypted: 0, // Phase 0 ADJUST-1：详情页密文原样存 raw，这里不做解密判断
    rawBytes: fieldsCapture ? fieldsCapture.capture.chars : null,
    rawTruncated: fieldsCapture && fieldsCapture.capture.truncated ? 1 : 0,
    collectedAt: utcStamp(),
    attachments: allAttachments.map((a) => ({
      platformFileId: a.platformFileId,
      originUrl: a.originUrl,
      contentType: a.contentType || null,
      bytes: a.bytes || null,
      sourceScene: a.sourceScene || 'attach',
    })),
  };

  // 4) 提交入库（服务端在同一事务内做三级幂等 + 写审计）
  const submitResp = await fetch(`${await getApiBase()}/api/ext/collect/resumes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-Token': token,
    },
    body: JSON.stringify({
      platform: COLLECT_PLATFORM,
      consent: {
        confirmed: true,
        ts: utcStamp(),
        pageUrl: payload.pageUrl || '',
        scene,
      },
      candidates: [candidatePayload],
    }),
  });
  const submitData = await submitResp.json().catch(() => ({}));
  if (submitData.code !== 200 || !submitData.data) {
    return { ok: false, error: submitData.msg || ('采集提交失败（HTTP ' + submitResp.status + '）') };
  }
  const result = submitData.data;

  // 5) 附件：逐个重放下载并上传（顺序与提交的 attachments 一一对应）
  //    用 allAttachments 而不是 candidatePayload.attachments 迭代：前者可能带 prefetchedBlob
  //    （探测路径已拿到字节），后者是给后端提交用的纯数据副本。两者顺序、长度严格一致。
  const needIds = result.attachmentIds || [];
  let stored = 0;
  for (let i = 0; i < needIds.length && i < allAttachments.length; i += 1) {
    // 串行：并发下载大文件容易触发平台风控，也让失败归因更难
    // eslint-disable-next-line no-await-in-loop
    const okOne = await downloadAndUploadAttachment(needIds[i], allAttachments[i], token);
    if (okOne) stored += 1;
  }

  const total = candidatePayload.attachments.length;
  const nameHint = fields.name || fields.geekName
    || (fields.user && fields.user.name) || null;

  const warnings = [];
  if (total && stored < total) {
    warnings.push((total - stored) + ' 份附件未能下载入库（可在中台候选人库查看失败原因）');
  }
  if (weakClaimed) {
    // 兜底认领必须显式告知 —— 它没有 ID 佐证，HR 有权知道这条记录需要核对。
    warnings.push('有 ' + weakClaimed + ' 份附件按「同标签页最近预览」认领（未获得 ID 佐证），'
      + '请在中台核对是否确属该候选人');
  }
  if (!total) {
    if (cacheCandidates && cacheRejected) {
      // 看到了附件却不敢用 —— 这个信息必须给 HR，否则只会以为「PDF 没采到」而重试。
      // 把「附件端点路径」和「本候选人的 ID 候选值」都打出来：一眼就能分辨是口径不对，
      // 还是这附件真不是这个人。带上端点路径也让「下一轮该按什么口径比对」当场可见。
      const seenPath = rejectedUrls.map((u) => {
        try { return attachmentEndpointPath(u); } catch (e) { return '?'; }
      }).join('、');
      warnings.push('观察到 ' + cacheCandidates + ' 个附件请求，但都与当前候选人 ID 不匹配，已丢弃（避免张冠李戴）'
        + '（附件端点：' + seenPath + '；本候选人 ID：' + idHints.slice(0, 3).join('/') + '）');
    } else if (probeInfo && probeInfo.missed) {
      // 探测已经跑过了还落空 —— 大概率是这位候选人真没有附件简历，不是操作问题。
      // 明确写清「端点也试过了」，免得 HR 反复重试同一件事。
      warnings.push('已用该候选人的加密 ID 自动探测附件端点（preview4boss / download4boss），未取到 PDF'
        + '——通常说明这位候选人没有附件简历；若你确认他有，请点开预览（等 PDF 渲染出来）再点一次采集');
    } else if (probeInfo && probeInfo.skipped) {
      warnings.push('本次没有采集到附件，且未取到加密 ID（无法自动探测下载端点）。'
        + '若该候选人有简历 PDF，请先点开简历预览（等 PDF 渲染出来）再点采集');
    } else {
      // 不是错误，只是提示 —— 有些候选人确实没有附件简历
      warnings.push('本次没有采集到附件。若该候选人有简历 PDF，请先点开简历预览（等 PDF 渲染出来）再点采集');
    }
  } else if (cacheRejected > 0) {
    warnings.push('另有 ' + cacheRejected + ' 个附件请求与当前候选人 ID 不匹配，已丢弃（避免张冠李戴）');
  }
  if (!/[A-Za-z]/.test(platformUserId)) {
    // 幂等键退化成数字 ID —— 与加密 ID 形态不同，可能和别的采集链路产生重复候选人（报告 V7）
    warnings.push('本次未取到加密 ID，幂等键为数字 ID（' + platformUserId
      + '），可能与其它采集链路产生重复记录');
  }

  return {
    ok: true,
    candidateName: nameHint,
    summary: {
      candidateCreated: !!result.candidateCreated,
      resumeVersionCreated: !!result.resumeVersionCreated,
      attachmentTotal: total,
      attachmentStored: stored,
    },
    // 诊断用：附件采集失败时靠这几个数就能定位是哪一环（页面 hook / 扩展层观察 / ID 比对）
    diag: {
      hookAttachments: attachments.length,
      cachedCandidates: cacheCandidates,
      cachedRejected: cacheRejected,
      weakClaimed,
      rejectedUrls,
      rejectedEndpoints: rejectedUrls.map((u) => attachmentEndpointPath(u)),
      idHints,
      bridgedIds: Array.from(bridgedIds),
      expectedGeekId,
      platformUserId,
      // 归一用：上报给后端的「另一种 ID 形态」（写进 candidate.platform_user_id_alt）。
      // 排查「同一个人为什么还是分裂成两条」时，第一眼就该看这个值有没有带上。
      altPlatformUserId: candidatePayload.secondaryPlatformUserId,
      // 主动探测的结果：命中 / 未命中 / 因无加密 ID 跳过
      probe: probeInfo,
    },
    warning: warnings.length ? warnings.join('；') : null,
  };
}
