/**
 * 哨兵脚本：监听平台发布成功信号（Phase 2 §6）
 *
 * 职责：
 * 1. 在填充任务完成后由 background 注入到平台页（如 BOSS）
 * 2. 监听成功信号（URL 变化 + CSS 选择器）
 * 3. 检测到成功后通过 SENTINEL_REPORT 消息交给 background 代理回填
 *    （POST /api/ext/records/{id}/report），再由 background 广播
 *    PUBLISH_BACK 给中台 tab
 *
 * 为什么不在本脚本里直接 fetch 回填接口：
 *   a) content script 的 fetch 以页面 origin 发起（BOSS 页 → localhost:6017
 *      跨域 + X-Extension-Token 自定义头触发预检），会被浏览器 CORS 拦截；
 *      background worker 持有 host_permissions，不受此限。
 *   b) 平台发布成功后约 1s 页面即跳转列表页，会中断页面内未完成的 fetch；
 *      worker 的生命周期独立于页面导航，回填不丢。
 *
 * 配置来源：field_map_json.success
 * {
 *   "urlPattern": "URL 模式（** 匹配任意，* 匹配非斜杠），可选",
 *   "selectors": [".publish-success", ".job-published-tip"],  // CSS 选择器列表
 *   "timeoutMs": 60000  // 超时时间（默认 60 秒）
 * }
 *
 * ⚠️ 本文件的块注释中禁止书写「两个星号紧跟斜杠」的通配符示例（URL 模式
 *    通配符的常见写法）——其中末位星号与斜杠组合会终结块注释，使后续注释
 *    文本变成代码，脚本注入即抛 ReferenceError（node --check 无法检出，
 *    只在运行时炸）。需要示例时用文字描述代替。
 *
 * 策略：保守双命中（URL 变化 + 选择器出现；任一方无配置则跳过该方判定）
 *
 * ⚠️ 整体包 IIFE（2026-09-22）：本文件与 message-relay.js 同属一个 content_scripts
 *    的 js 数组，注入**同一个隔离世界**，顶层作用域共享。顶层裸写 let/const 会在
 *    "两个文件同名"时抛 SyntaxError 并让其中一支整支不运行（见 bridge.js 事故）。
 *    一律包 IIFE，不向共享顶层作用域泄漏标识符。
 */
(() => {
'use strict';

/**
 * ★ 岗位 ID 捕获（2026-09-22 增，路径 A）★
 *
 * 发布成功时除了 URL，还要把「平台上的哪个岗位」一并回传，否则中台无法把
 * 该需求单与平台岗位对应起来，采集回来的候选人投递就归不了类。
 *
 * 三个来源，按可信度从高到低尝试（全不中就不带 —— 由中台人工绑定兜底）：
 *   ① job-probe.js（MAIN 世界）从 fetch/XHR 响应体里抓到的岗位 ID —— 最强证据；
 *   ② 当前 URL 的查询参数或 job_detail 路径；
 *   ③ DOM 上的 data-jobid / data-job-id / data-encrypt-job-id 属性。
 *
 * 为什么不当场把三个来源"投票"或做校验：平台形态未定，多来源可能给出不同值。
 * 这里只做**有序尝试**，并把最终采用的来源一并上报（platformJobSource），
 * 让中台与真机排障都能看出「这个 ID 是从哪来的」。中台一律按 auto 记录，人工可覆盖。
 */

/** 探针消息命名空间 —— 必须与 content/job-probe.js 完全一致 */
const PROBE_NS = '__recruit_job_probe';
const PROBE_NS_VAL = 'v1';

/** 探针最近一次上报的岗位提示（内存，不落盘） */
let jobHintFromProbe = null;

/**
 * ★ 发布接口（job/save）给的权威岗位 ID ★
 *
 * 与 jobHintFromProbe 分开存是刻意的：后者会被任何含 jobId 的响应刷新，
 * 而发布接口信号只能出现一次、且它就是本次发布的岗位本身。
 * 取岗位 ID 时它优先级最高，避免被后来的无关响应覆盖成别的岗位。
 */
let publishedJobId = null;
let publishedJobHint = null;

/** 发布接口信号到达时由 startSentinel 注册的回调（见下方 JOB_PUBLISHED 分支） */
let onPublishedSignal = null;
/** 最近一次发布接口信号（供 startSentinel 补消费「先到后注入」的情况） */
let lastPublishedSignal = null;

/**
 * 岗位 ID 合法性（与 job-probe.js / CollectService.looksEncryptedId 同口径）。
 * 保守：宁可拿不到（回落人工绑定），也不要把埋点里的无关数字当岗位 ID 上报。
 */
function isPlausibleJobId(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (/^\d{1,12}$/.test(s)) return Number(s) > 0;
  if (s.length < 16 || s.length > 64) return false;
  let digit = false;
  let alpha = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (c >= '0' && c <= '9') digit = true;
    else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) alpha = true;
    else if (c !== '_' && c !== '~' && c !== '-') return false;
  }
  return digit && alpha;
}

/** 来源 ②：URL 查询参数 / job_detail 路径 */
function jobIdFromUrl() {
  try {
    const u = new URL(window.location.href);
    const keys = ['jobId', 'jobid', 'encryptJobId'];
    for (const k of keys) {
      const v = u.searchParams.get(k);
      if (v && isPlausibleJobId(v)) return { jobId: v.trim(), source: 'url:' + k };
    }
    const m = /\/job_detail\/([A-Za-z0-9_~-]{16,64})\.html/.exec(u.pathname);
    if (m) return { jobId: m[1], source: 'url:path' };
  } catch (e) { /* ignore */ }
  return null;
}

/** 来源 ③：DOM 属性（平台把 ID 挂在元素上时） */
function jobIdFromDom() {
  const attrs = ['data-jobid', 'data-job-id', 'data-encrypt-job-id'];
  for (const attr of attrs) {
    try {
      const el = document.querySelector('[' + attr + ']');
      const v = el && el.getAttribute(attr);
      if (v && isPlausibleJobId(v)) return { jobId: String(v).trim(), source: 'dom:' + attr };
    } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * 组装岗位 ID 上报体。三个来源有序尝试，全不中返回空对象（不带字段）。
 * 空对象是**合法结果** —— 中台会把它当作「尚未绑定」，走人工绑定兜底，
 * 而不是猜一个近似岗（错误归类比未归类危险）。
 */
function collectPlatformJobId() {
  // 发布接口给的 ID 优先级最高：它就是本次发布的岗位本身，
  // 不可能像 jobHintFromProbe 那样被后来的无关响应覆盖成别的岗位。
  if (publishedJobId) {
    return {
      platformJobId: publishedJobId,
      platformJobHint: publishedJobHint || null,
      platformJobSource: 'api:job/save',
    };
  }
  if (jobHintFromProbe && jobHintFromProbe.jobId) {
    return {
      platformJobId: jobHintFromProbe.jobId,
      platformJobHint: jobHintFromProbe.hint || null,
      platformJobSource: 'probe:' + (jobHintFromProbe.keyName || 'unknown'),
    };
  }
  const fromUrl = jobIdFromUrl();
  if (fromUrl) return { platformJobId: fromUrl.jobId, platformJobSource: fromUrl.source };
  const fromDom = jobIdFromDom();
  if (fromDom) return { platformJobId: fromDom.jobId, platformJobSource: fromDom.source };
  return {};
}

// 全局标识避免重复注入
const SENTINEL_ID = 'recruit-sentinel-active';
if (window[SENTINEL_ID]) {
  console.log('[Sentinel] 已存在，跳过');
} else {
  window[SENTINEL_ID] = true;

  // 接收探针的岗位提示（MAIN 世界 -> ISOLATED 世界，只有 postMessage 这一条通道）。
  // ★ 注册位置刻意放在守卫**之内**：本文件会被 background 按每次发布任务重复注入，
  //   若注册在守卫之外，每注入一次就多一个监听器（累积且重复打日志）。
  window.addEventListener('message', (ev) => {
    try {
      const d = ev.data;
      if (!d || typeof d !== 'object' || d[PROBE_NS] !== PROBE_NS_VAL) return;
      const p = d.payload;
      if (!p || !p.jobId) return;

      // ★ JOB_PUBLISHED：发布接口（job/save）的响应 —— 权威信号 ★
      //   它同时解决两件事：
      //     ① 成功判定不再依赖 toast 选择器（实测从未命中，且发布后不跳转、
      //        urlPattern 也无从判定）；
      //     ② 岗位 ID 直接来自发布响应本身，天然是加密规范形，不会被
      //        聊天侧接口污染成数字形态或别的岗位。
      //   详见 job-probe.js 的 PUBLISH_URL_RE 注释（2026-09-23 真机取证）。
      if (d.type === 'JOB_PUBLISHED') {
        publishedJobId = String(p.jobId).trim();
        publishedJobHint = p.hint || null;
        lastPublishedSignal = p;
        console.log('[Sentinel] 收到发布接口成功信号:', publishedJobId, '|', p.hint || '');
        if (typeof onPublishedSignal === 'function') onPublishedSignal(p);
        return;
      }

      if (d.type !== 'JOB_HINT') return;
      jobHintFromProbe = p;
      console.log('[Sentinel] 收到探针岗位提示:', p.jobId, p.keyName);
    } catch (e) { /* 探针消息异常绝不能影响哨兵 */ }
  }, false);

  // 从配置中读取
  const config = window.__RECRUIT_SENTINEL_CONFIG__;
  if (!config) {
    console.error('[Sentinel] 缺少配置，无法启动');
  } else {
    startSentinel(config);
  }
}

function startSentinel(config) {
  const { recordId, successConfig, platformTabId } = config;
  
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
  /** 发布接口已确认成功 —— 权威信号，命中即不再要求 DOM 双命中 */
  let publishedByApi = false;

  // 注册回调：探针在 MAIN 世界捕获到 job/save 成功响应后走这条。
  // 放在这里（而非模块级）是为了能拿到上面的 reported / startTime 做去重与时效判断。
  onPublishedSignal = (p) => {
    if (reported) return;
    // 忽略本次任务启动前很久的陈旧信号（页面可能残留上一次发布的信号）
    if (p && p.ts && startTime - p.ts > 60 * 1000) {
      console.log('[Sentinel] 忽略陈旧的发布接口信号');
      return;
    }
    publishedByApi = true;
    checkAndReport();
  };

  // 信号可能先于哨兵注入到达（注入有延迟），这里补消费一次
  if (lastPublishedSignal && (!lastPublishedSignal.ts || startTime - lastPublishedSignal.ts <= 60 * 1000)) {
    console.log('[Sentinel] 复用先到的发布接口信号');
    publishedByApi = true;
  }
  
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

    // 发布接口信号是权威证据：命中即成功，不再要求 DOM 双命中。
    // 原因（2026-09-23 取证）：BOSS 发布后不跳转（urlPattern 无从判定），
    // 而配置的 toast 选择器 .toast .icon-toast-success 实测从未命中。
    if (publishedByApi) {
      console.log('[Sentinel] 发布接口信号已确认，跳过 DOM 判定直接回填');
      reported = true;
      reportSuccess();
      return;
    }

    // 保守策略：要求双命中（或单方无配置）
    const urlOk = !urlPattern || urlMatched;
    const selectorOk = !selectors || selectors.length === 0 || selectorMatched;
    
    if (urlOk && selectorOk) {
      console.log('[Sentinel] 成功信号双命中，准备回填');
      reported = true;
      reportSuccess();
    }
  }
  
  // 上报成功信号（background 代理回填，见头部注释）
  async function reportSuccess() {
    const publishedUrl = window.location.href;
    // 岗位映射（路径 A）：拿到就自动建立映射；拿不到就留空，由中台走人工绑定兜底。
    const jobBinding = collectPlatformJobId();
    console.log('[Sentinel] 成功信号命中，上报 background 代理回填:', publishedUrl, jobBinding);

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SENTINEL_REPORT',
        payload: {
          recordId,
          publishedUrl,
          platformTabId,
          ...jobBinding,
        },
      });
      if (!resp || !resp.ok) {
        console.error('[Sentinel] 回填失败:', (resp && resp.error) || 'background 无响应');
      } else {
        console.log('[Sentinel] 回填成功');
      }
    } catch (e) {
      console.error('[Sentinel] 上报异常:', e);
    }
  }
  
  // 初始检查
  checkUrlMatch();
  checkSelectorMatch();
  // 若注入前已拿到发布接口信号（或此刻刚到），立即回填，不必等 DOM
  if (publishedByApi) checkAndReport();
  
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
        // ★ 刻意**不**上报 failed ★
        //   发布由人手动触发（插件不自动点发布，这是既定设计），等多久完全取决于人，
        //   固定窗口必然时灵时不灵。而一旦把台账标成 failed，它就终结了 ——
        //   之后真正的发布接口信号到达时也无法再回填（report 只对 pending 生效），
        //   等于**堵死**了正确的信号，比继续等下去更糟。
        //   所以这里只停掉 DOM 轮询（省资源）；message 监听仍在，
        //   发布接口响应任何时候到达都能触发回填。
        console.log('[Sentinel] DOM 监听窗口已过（' + Math.round(timeout / 1000)
                    + 's），停止 DOM 轮询；仍在监听发布接口（job/save）响应');
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
})();
