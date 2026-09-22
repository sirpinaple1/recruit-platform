/**
 * 招聘助手 · 简历采集 · MAIN world hook
 *
 * 运行环境：页面主世界（manifest content_scripts world:"MAIN"），
 *          run_at:document_start，all_frames:true。
 *
 * 职责：把页面用到的四条网络通道（fetch / XHR / WebSocket / EventSource）换成扩展版本，
 *      复制响应体（clone），写入**内存环形缓冲**。
 *
 * ★ 与 Phase 0 POC（嗅探器）的关键差异 —— 合规形态（框架 §2 Phase 1.1）★
 *   POC 是「持续上报」：命中即外发，用于接口考古。
 *   本文件是「主动触发」：hook 全程只写内存，**只有 HR 点击采集按钮时**
 *   才被要求提取一份数据外发（见 onExtract）。
 *   环形缓冲不产生网络请求、不落盘，因此 hook 本身是廉价的被动行为；
 *   每一次数据外发都对应 HR 的一次明示动作，可审计、可解释。
 *
 * 三条铁律：
 *   1) 绝不阻断、绝不改写响应、绝不给页面请求增加延迟（不把原生 fetch 包成 async）
 *   2) 自身任何异常都吞掉 —— hook 挂掉也不能影响页面
 *   3) 二进制绝不穿消息通道（Blob 经 sendMessage 会变空对象）
 */
(() => {
  'use strict';

  const NS = '__recruit_collect';
  const NS_VAL = 'v1';

  const RING_MAX = 300;                 // 内存环形缓冲条数
  const BODY_MAX = 256 * 1024;          // 响应体保留上限（Phase 0 实测：48KB 会切掉整页候选人列表）
  const BIG_BODY = 5 * 1024 * 1024;     // 超此值只记元数据
  const WS_MSG_MAX = 64 * 1024;
  const SCAN_DEPTH = 7;
  const SCAN_ARRAY = 40;
  const SCAN_BUDGET = 1200;
  const STR_JSON_MAX = 8 * 1024;        // 字符串化 JSON 的解析上限

  /**
   * 默认命中键表 —— 与后端 CollectRules 保持一致（改动必须同步）。
   * 全部来自 Phase 0 真机实测：初版猜的 fileId/fileName 在真实响应里零命中，
   * 简历字段至少三套命名（workExpList / experiences / geekCard）。
   * 后端可通过 'SET_RULES' 指令覆盖（逻辑后置，平台改版不用发版扩展）。
   */
  const DEFAULT_RULES = {
    version: 'local-boss-20260922-V3',
    /**
     * 岗位 ID 键（兜底；后端 CollectRules.JOB_ID_KEYS 为真源）。
     *
     * ★ 为什么这里要单独留一份「数字 ↔ 加密」配对扫描 ★
     *   真机取证（2026-09-22）：BOSS 的岗位 ID 有**两套 ID 空间** ——
     *     · 数字 jobId 575500411      → 只出现在聊天/候选人侧
     *     · 加密 encryptJobId 352f9…  → 只出现在职位管理侧（含发布响应 job/save）
     *   而简历采集拿到的 body.resume.jobId 是**数字**，发布台账记的是**加密**，
     *   两者永不相等 → 映射永远解析不到。唯一出路是拿「同一个对象里同时出现两种形态」
     *   的配对做翻译（实测 getBossFriendListV2 / chatted/jobList 613 次同框）。
     *   这个扫描必须发生在**页面侧**：只有页面看得到这些响应，
     *   而且必须与简历命中判定同一次遍历完成（响应体最大 256KB，扫两遍不划算）。
     *
     * ⚠️ 注意：jobId 这个键名**本身不可信** —— job/data/list 里它是数字、
     *   job/save 里它是加密。所以判定一律**按值的形态**，不按键名。
     */
    jobIdKeys: ['jobId', 'encryptJobId', 'jobIdEncrypt'],
    resumeKeys: [
      'geekName', 'expectSalary', 'geekCard', 'advantage',
      'workExp', 'eduExp', 'workExpList', 'eduExpList',
      'experiences', 'content1', 'content2', 'content3',
      'workYear', 'positionCategory', 'applyStatus', 'education',
      'salary', 'jobSalary', 'bottomText', 'ageDesc'
    ],
    noisyKeys: ['jobStatus', 'status', 'name', 'position'],
    attachUrlPattern: '/wflow/[^/]+/download/',
    attachContentTypePattern: 'application/(pdf|octet-stream|msword|zip)|officedocument|image/(jpeg|png)',
    noisePathPrefixes: [
      '/wapi/zpCommon/actionLog/',
      '/wapi/zpApm/actionLog/',
      '/wapi/zpApm/httpMetrics/'
    ]
  };

  let rules = compileRules(DEFAULT_RULES);

  function compileRules(raw) {
    const resume = new Set(raw.resumeKeys || []);
    const noisy = new Set(raw.noisyKeys || []);
    const job = new Set(raw.jobIdKeys || DEFAULT_RULES.jobIdKeys);
    return {
      version: raw.version || 'unknown',
      resumeKeys: raw.resumeKeys || [],
      noisyKeys: raw.noisyKeys || [],
      jobIdKeys: raw.jobIdKeys || DEFAULT_RULES.jobIdKeys,
      resume,
      noisy,
      job,
      attachUrlRe: raw.attachUrlPattern ? new RegExp(raw.attachUrlPattern, 'i') : /$^/,
      attachCtRe: raw.attachContentTypePattern ? new RegExp(raw.attachContentTypePattern, 'i') : /$^/,
      noisePrefixes: raw.noisePathPrefixes || []
    };
  }

  // ============================================================ 状态

  const state = {
    frameId: Math.random().toString(36).slice(2, 8),
    seq: 0,
    bridgeReady: false,
    workerCount: 0,
    errors: [],
    startedAt: Date.now()
  };
  const ring = [];

  function markError(where, e) {
    if (state.errors.length > 20) state.errors.shift();
    state.errors.push({ where, msg: String((e && e.message) || e), ts: Date.now() });
  }

  const safeHref = () => { try { return location.href; } catch (e) { return ''; } };
  const now = () => { try { return performance.now(); } catch (e) { return Date.now(); } };

  function absolutize(u) {
    try {
      if (typeof u !== 'string' || !u) return '';
      // 相对 URL 必须在页面侧绝对化，否则后端重放会指向扩展来源
      return new URL(u, location.href).href;
    } catch (e) { return String(u || ''); }
  }

  function isNoise(url) {
    try {
      if (!url) return false;
      for (const p of rules.noisePrefixes) {
        if (url.indexOf(p) >= 0) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // ============================================================ 通道

  function post(msg) {
    try {
      window.postMessage(Object.assign({ [NS]: NS_VAL }, msg), '*');
    } catch (e) { markError('post', e); }
  }

  function record(item) {
    if (!item._id) {
      state.seq += 1;
      item._id = state.frameId + '-' + state.seq.toString(36);
    }
    item.ts = item.ts || Date.now();
    item.frameUrl = safeHref();
    ring.push(item);
    while (ring.length > RING_MAX) ring.shift();
    return item;
  }

  function clip(text, max) {
    const s = typeof text === 'string' ? text : '';
    if (s.length <= max) return { text: s, truncated: false, chars: s.length };
    return { text: s.slice(0, max), truncated: true, chars: s.length };
  }

  // ============================================================ 岗位 ID 形态判定

  /**
   * 数字形态岗位 ID（如 575500411）。
   * 下限取 6 位：与 background.js 的 looksNumericId 同口径，避免把「状态码 0/1」当 ID。
   */
  function isNumericJobId(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 && String(v).length >= 6;
    if (typeof v !== 'string') return false;
    const s = v.trim();
    return /^\d{6,15}$/.test(s) && Number(s) > 0;
  }

  /** 加密形态岗位 ID（如 352f92eda67db1080nN_3t29FFNR）—— 大小写+数字混合、16~64 位 */
  function isEncryptedJobId(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (!/^[0-9A-Za-z_~-]{16,64}$/.test(s)) return false;
    return /[0-9]/.test(s) && /[A-Za-z]/.test(s);
  }

  /** 单条响应最多保留多少组配对（一个人一次采集用不到几组，多了纯占内存） */
  const JOB_PAIR_MAX = 24;

  /**
   * 从一个**对象节点**里找「数字 ↔ 加密」同框配对。
   *
   * 为什么必须在同一节点内：不同节点的两个岗位 ID 拼出来的配对是**假的** ——
   * 那会把 A 岗位的数字 ID 安到 B 岗位的加密 ID 上，直接造成候选人归错岗。
   * 真机实测的 613 次同框就是这种同节点配对。
   */
  function pairFromNode(node) {
    let num = null;
    let enc = null;
    try {
      for (const k of Object.keys(node)) {
        if (!rules.job.has(k)) continue;
        const v = node[k];
        if (num === null && isNumericJobId(v)) num = String(v).trim();
        else if (enc === null && isEncryptedJobId(v)) enc = String(v).trim();
      }
    } catch (e) { return null; }
    return (num && enc) ? { num, enc } : null;
  }

  // ============================================================ 命中探测

  function detectHit(root) {
    const matched = new Set();
    const noisy = new Set();
    const jobPairs = [];
    if (!root || typeof root !== 'object') {
      return { hit: '', matchedKeys: [], matchedKeyCount: 0, noisyKeys: [], jobPairs };
    }
    let budget = SCAN_BUDGET;
    const seen = new Set();
    const stack = [[root, 0]];
    while (stack.length) {
      if (budget-- <= 0) break;
      const cur = stack.pop();
      const node = cur[0];
      const depth = cur[1];
      if (!node || typeof node !== 'object' || depth > SCAN_DEPTH) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        const n = Math.min(node.length, SCAN_ARRAY);
        for (let i = 0; i < n; i += 1) stack.push([node[i], depth + 1]);
        continue;
      }
      let keys;
      try { keys = Object.keys(node); } catch (e) { continue; }
      // 顺路做岗位 ID 配对（同一节点内的 数字↔加密）。
      // 放在 keys 循环之前：Object.keys 已经拿到了，避免再遍历一次。
      if (jobPairs.length < JOB_PAIR_MAX) {
        const pair = pairFromNode(node);
        if (pair) jobPairs.push(pair);
      }
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        if (rules.resume.has(k)) matched.add(k);
        else if (rules.noisy.has(k)) noisy.add(k);
        let v;
        try { v = node[k]; } catch (e) { continue; }
        if (v && typeof v === 'object') {
          stack.push([v, depth + 1]);
        } else if (typeof v === 'string' && v.length > 1 && v.length <= STR_JSON_MAX && budget > 40) {
          // Phase 0 实测坑：字段会藏在「字符串化的 JSON」里（如 hyperLink.extraJson），
          // 深度递归扫描穿不过字符串，必须做一次有预算限制的二次解析。
          const c0 = v.charCodeAt(0);
          if (c0 === 123 || c0 === 91) {
            try { stack.push([JSON.parse(v), depth + 1]); } catch (e) { /* 非 JSON */ }
          }
        }
      }
    }
    const keys = Array.from(matched);
    return {
      hit: keys.length ? 'resume' : '',
      matchedKeys: keys.slice(0, 24),
      matchedKeyCount: keys.length,
      noisyKeys: Array.from(noisy).slice(0, 24),
      jobPairs
    };
  }

  function probeText(text) {
    if (!text) return null;
    const s = text.trim();
    const c = s.charCodeAt(0);
    if (c === 123 || c === 91) {
      try { return detectHit(JSON.parse(s)); } catch (e) { /* 落到正则 */ }
    }
    return null;
  }

  /**
   * 附件识别：Phase 0 实测 —— 附件**不在任何 JSON 里**，
   * 是平台生成的 PDF，走独立下载端点，响应头 application/pdf。
   * 因此只能按 URL 特征 + content-type 判定，不能靠字段名。
   */
  function isAttachment(url, ct, disp) {
    try {
      if (disp && /attachment/i.test(disp)) return true;
      if (ct && rules.attachCtRe.test(ct)) return true;
      if (url && rules.attachUrlRe.test(url)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // ============================================================ fetch

  const raw = {};
  try { raw.fetch = window.fetch; } catch (e) { raw.fetch = null; }
  try { raw.XHR = window.XMLHttpRequest; } catch (e) { raw.XHR = null; }
  try { raw.WS = window.WebSocket; } catch (e) { raw.WS = null; }
  try { raw.ES = window.EventSource; } catch (e) { raw.ES = null; }
  try { raw.Worker = window.Worker; } catch (e) { raw.Worker = null; }

  function base(url, method, channel, extra) {
    return Object.assign({
      url: absolutize(url),
      method: String(method || 'GET').toUpperCase(),
      channel,
      ts: Date.now()
    }, extra || {});
  }

  function classify(ct) {
    const s = (ct || '').toLowerCase();
    if (s.indexOf('json') >= 0) return 'json';
    if (s.indexOf('html') >= 0 || s.indexOf('xml') >= 0 || s.indexOf('text/plain') >= 0) return 'html';
    return 'other';
  }

  if (typeof raw.fetch === 'function') {
    const hookedFetch = function (...args) {
      let url = '';
      let method = 'GET';
      let reqHeaders = {};
      let reqBody = null;
      try {
        const input = args[0];
        const init = args[1] || {};
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') { url = input.url; method = input.method || 'GET'; }
        if (init.method) method = init.method;
        if (input && input.headers && typeof input.headers.forEach === 'function') {
          input.headers.forEach((v, k) => { reqHeaders[k] = v; });
        }
        if (init.headers) {
          const h = init.headers;
          if (typeof h.forEach === 'function') h.forEach((v, k) => { reqHeaders[k] = v; });
          else if (typeof h === 'object') Object.keys(h).forEach((k) => { reqHeaders[k] = h[k]; });
        }
        if (typeof init.body === 'string') reqBody = init.body;
      } catch (e) { markError('fetch-req', e); }

      const t0 = now();
      // 铁律 1：原封不动把原生 Promise 还给页面；观察是旁路挂载，不在关键路径上 await
      const p = raw.fetch.apply(this, args);
      if (url && !isNoise(url)) {
        try {
          Promise.resolve(p).then((res) => {
            try { observeFetch(res, url, method, reqHeaders, reqBody, t0); }
            catch (e) { markError('fetch-observe', e); }
          }, () => { /* 网络失败由页面处理 */ });
        } catch (e) { markError('fetch-attach', e); }
      }
      return p;
    };
    try { window.fetch = hookedFetch; } catch (e) { markError('install-fetch', e); }
  }

  function observeFetch(res, url, method, reqHeaders, reqBody, t0) {
    const ct = res.headers.get('content-type') || '';
    const len = Number(res.headers.get('content-length') || 0) || 0;
    const disp = res.headers.get('content-disposition') || '';
    const meta = base(url, method, 'fetch', {
      status: res.status,
      contentType: ct,
      bytes: len || null,
      contentDisposition: disp,
      reqHeaders,
      reqBody,
      durMs: Math.round(now() - t0)
    });

    if (isAttachment(url, ct, disp)) {
      record(Object.assign(meta, { kind: 'binary', attach: true, hit: 'attach' }));
      return;
    }
    const kind = classify(ct);
    if (kind === 'other') {
      record(Object.assign(meta, { kind: 'binary', note: '非文本响应' }));
      return;
    }
    if (len > BIG_BODY) {
      record(Object.assign(meta, { kind, skipped: 'oversize', note: 'content-length > 5MB' }));
      return;
    }
    let copy;
    try { copy = res.clone(); } catch (e) {
      record(Object.assign(meta, { kind, note: 'clone 失败' }));
      return;
    }
    // 铁律 2：clone 的流异步读，同步等会拖慢页面
    copy.text().then((text) => {
      try {
        const body = clip(text, BODY_MAX);
        const probe = probeText(text);
        record(Object.assign(meta, {
          kind,
          bodyText: body.text,
          chars: body.chars,
          truncated: body.truncated,
          hit: probe ? probe.hit : '',
          matchedKeys: probe ? probe.matchedKeys : [],
          matchedKeyCount: probe ? probe.matchedKeyCount : 0,
          noisyKeys: probe ? probe.noisyKeys : [],
          jobPairs: probe ? probe.jobPairs : []
        }));
      } catch (e) { markError('fetch-body', e); }
    }).catch((e) => { markError('fetch-text', e); });
  }

  // ============================================================ XHR

  if (raw.XHR && raw.XHR.prototype) {
    const XP = raw.XHR.prototype;
    const rawOpen = XP.open;
    const rawSend = XP.send;
    const rawSRH = XP.setRequestHeader;

    XP.open = function (method, url) {
      const r = rawOpen.apply(this, arguments);   // 原生先跑，异常语义保持一致
      try {
        this.__rc = {
          method: String(method || 'GET').toUpperCase(),
          url: absolutize(typeof url === 'string' ? url : String(url)),
          headers: {}
        };
      } catch (e) { markError('xhr-open', e); }
      return r;
    };
    XP.setRequestHeader = function (name, value) {
      try { if (this.__rc) this.__rc.headers[String(name)] = String(value); } catch (e) { /* ignore */ }
      return rawSRH.apply(this, arguments);
    };
    XP.send = function (body) {
      const r = rawSend.apply(this, arguments);
      try {
        const meta = this.__rc || (this.__rc = { method: 'GET', url: '', headers: {} });
        if (typeof body === 'string') meta.reqBody = body;
        meta.t0 = now();
        if (meta.url && !isNoise(meta.url)) {
          this.addEventListener('loadend', () => {
            try { observeXhr(this, meta); } catch (e) { markError('xhr-observe', e); }
          }, { once: true });
        }
      } catch (e) { markError('xhr-send', e); }
      return r;
    };
  }

  function observeXhr(xhr, meta) {
    const t0 = meta.t0 || now();
    let ct = '';
    let len = 0;
    let disp = '';
    try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) { /* ignore */ }
    try { len = Number(xhr.getResponseHeader('content-length') || 0) || 0; } catch (e) { /* ignore */ }
    try { disp = xhr.getResponseHeader('content-disposition') || ''; } catch (e) { /* ignore */ }
    let finalUrl = meta.url;
    try { if (xhr.responseURL) finalUrl = absolutize(xhr.responseURL); } catch (e) { /* ignore */ }

    const info = base(finalUrl, meta.method, 'xhr', {
      status: xhr.status,
      contentType: ct,
      bytes: len || null,
      contentDisposition: disp,
      reqHeaders: meta.headers,
      reqBody: meta.reqBody || null,
      durMs: Math.round(now() - t0)
    });

    if (isAttachment(finalUrl, ct, disp)) {
      record(Object.assign(info, { kind: 'binary', attach: true, hit: 'attach' }));
      return;
    }
    const rt = xhr.responseType || '';
    if (rt && rt !== 'text' && rt !== 'json') {
      record(Object.assign(info, { kind: 'binary', note: 'responseType=' + rt }));
      return;
    }
    const kind = classify(ct);
    if (kind === 'other') {
      record(Object.assign(info, { kind: 'binary', note: '非文本响应' }));
      return;
    }
    if (len > BIG_BODY) {
      record(Object.assign(info, { kind, skipped: 'oversize' }));
      return;
    }
    let text = '';
    try {
      text = (rt === 'json')
        ? (xhr.response == null ? '' : JSON.stringify(xhr.response))
        : (xhr.responseText || '');
    } catch (e) {
      record(Object.assign(info, { kind: 'event', event: 'body-unreadable' }));
      return;
    }
    const body = clip(text, BODY_MAX);
    // 把 JSON.parse 推到下一轮宏任务，避免主线程卡顿
    setTimeout(() => {
      try {
        const probe = probeText(text);
        record(Object.assign(info, {
          kind,
          bodyText: body.text,
          chars: body.chars,
          truncated: body.truncated,
          hit: probe ? probe.hit : '',
          matchedKeys: probe ? probe.matchedKeys : [],
          matchedKeyCount: probe ? probe.matchedKeyCount : 0,
          noisyKeys: probe ? probe.noisyKeys : [],
          jobPairs: probe ? probe.jobPairs : []
        }));
      } catch (e) { markError('xhr-parse', e); }
    }, 0);
  }

  // ============================================================ WebSocket

  if (typeof raw.WS === 'function') {
    const SniffWS = function (url, protocols) {
      if (new.target === undefined) {
        throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
      }
      const ws = arguments.length > 1 ? new raw.WS(url, protocols) : new raw.WS(url);
      try {
        const href = absolutize(typeof url === 'string' ? url : String(url));
        if (!isNoise(href)) {
          // 只记录连通性事件：Phase 0 实测聊天 WS 全是 ArrayBuffer（protobuf）帧，
          // 拿不到明文，内容一律走 HTTP 接口，这里不做无用功。
          ws.addEventListener('open', () => {
            record(base(href, 'WS', 'ws', { kind: 'event', event: 'ws-open' }));
          }, { once: true });
          ws.addEventListener('message', (ev) => {
            const d = ev.data;
            const size = typeof d === 'string' ? d.length : (d && d.size) || (d && d.byteLength) || 0;
            record(base(href, 'WS', 'ws', {
              kind: 'ws',
              event: 'ws-message',
              chars: size,
              note: typeof d === 'string' ? 'text 帧' : 'binary 帧（不读内容）'
            }));
          });
        }
      } catch (e) { markError('ws-attach', e); }
      return ws;
    };
    SniffWS.prototype = raw.WS.prototype;
    try { Object.setPrototypeOf(SniffWS, raw.WS); } catch (e) { /* ignore */ }
    try { window.WebSocket = SniffWS; } catch (e) { markError('install-ws', e); }
  }

  // ============================================================ Worker（仅观测）

  if (typeof raw.Worker === 'function') {
    const Wrapper = function (url, options) {
      if (new.target === undefined) {
        throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
      }
      try {
        state.workerCount += 1;
        // Worker 内的请求不经过主线程 hook，只记次数与 URL（Phase 0 V3 的观测口径）
        record(base(url && url.url ? url.url : String(url), 'WORKER', 'worker', {
          kind: 'worker',
          note: 'Worker 构造（内部请求不可拦截）',
          count: state.workerCount
        }));
      } catch (e) { markError('worker-wrap', e); }
      return arguments.length > 1 ? new raw.Worker(url, options) : new raw.Worker(url);
    };
    Wrapper.prototype = raw.Worker.prototype;
    try { Object.setPrototypeOf(Wrapper, raw.Worker); } catch (e) { /* ignore */ }
    try { window.Worker = Wrapper; } catch (e) { markError('install-worker', e); }
  }

  // ============================================================ 按需提取（主动触发的核心）

  /**
   * 从环形缓冲里挑出「当前候选人」的采集结果。
   *
   * ★ 为什么返回**多条**候选而不是一条（真机踩过的坑）★
   *   聊天页同时会有两条命中且各有优势：
   *     · /wapi/zpchat/boss/historyMsg  字段最丰富（22 个键，含 experiences/content1..3），
   *       但**没有加密 ID**，只有数字 uid；
   *     · /wapi/zpjob/chat/geek/info    字段少，但**带 encryptUid**。
   *   只取一条的话必然二选一：要么字段全但幂等键落成数字（与其它链路分裂），
   *   要么键对但字段贫。所以这里把前几条都交出去，由背景脚本「字段取最丰富的、
   *   身份取带加密 ID 的」——两个都要。
   *
   *   · 附件条目：取最近的 N 条（附件不在 JSON 里，是独立的 binary 响应）。
   * 兜底：若缓冲里没有任何命中，返回 empty=true，由背景脚本提示 HR
   *      「请先打开候选人简历」，而不是硬凑一条无关数据。
   */
  const HIT_LOOKBACK = 12;
  const CAPTURE_TOP_N = 3;

  function toCapture(it) {
    return {
      _id: it._id,
      url: it.url,
      method: it.method,
      status: it.status,
      contentType: it.contentType || '',
      chars: it.chars || 0,
      truncated: !!it.truncated,
      matchedKeys: it.matchedKeys || [],
      matchedKeyCount: it.matchedKeyCount || 0,
      bodyText: it.bodyText
    };
  }

  function extract(scene) {
    const hits = ring.filter((it) => it.kind === 'json' && it.hit === 'resume' && it.bodyText);
    const attachments = ring.filter((it) => it.attach === true);

    // 最近 N 条里按「命中键数量」降序取前几条（同分取更新的）
    const recent = hits.slice(-HIT_LOOKBACK)
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => {
        const d = (b.it.matchedKeyCount || 0) - (a.it.matchedKeyCount || 0);
        return d !== 0 ? d : (b.idx - a.idx);
      })
      .slice(0, CAPTURE_TOP_N)
      .map((x) => toCapture(x.it));

    // 附件按 URL 去重（同一次预览会重复请求）
    const seen = new Set();
    const attachOut = [];
    for (let i = attachments.length - 1; i >= 0 && attachOut.length < 10; i -= 1) {
      const a = attachments[i];
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      attachOut.push({
        originUrl: a.url,
        contentType: a.contentType || '',
        bytes: a.bytes || null,
        sourceScene: 'attach',
        platformFileId: buildPlatformFileId(a.url)
      });
    }

    // DOM 兜底合并：网络通道没看到、但 DOM 里确实挂着预览载体时补上（同一 URL 去重）
    domAttachments().forEach((d) => {
      if (seen.has(d.originUrl) || attachOut.length >= 10) return;
      seen.add(d.originUrl);
      attachOut.push(d);
    });

    // 岗位 ID「数字 ↔ 加密」配对：跨整条环形缓冲汇总（桥端点可能在页面加载时就到了，
    // 远早于 HR 点采集，所以不能只取最近几条）。逐条响应内已去重，这里再全局去重。
    const JOB_PAIR_OUT_MAX = 60;
    const pairSeen = new Set();
    const pairOut = [];
    for (let i = ring.length - 1; i >= 0 && pairOut.length < JOB_PAIR_OUT_MAX; i -= 1) {
      const ps = ring[i] && ring[i].jobPairs;
      if (!ps || !ps.length) continue;
      for (let j = 0; j < ps.length; j += 1) {
        const pr = ps[j];
        if (!pr || !pr.num || !pr.enc) continue;
        const key = pr.num + '|' + pr.enc;
        if (pairSeen.has(key)) continue;
        pairSeen.add(key);
        pairOut.push({ num: pr.num, enc: pr.enc });
        if (pairOut.length >= JOB_PAIR_OUT_MAX) break;
      }
    }

    return {
      empty: recent.length === 0 && attachOut.length === 0,
      scene: scene || 'chat',
      pageUrl: safeHref(),
      frameUrl: safeHref(),
      isTopFrame: (() => { try { return window.top === window; } catch (e) { return false; } })(),
      rulesVersion: rules.version,
      selfUidHint: findSelfUidHint(),
      // 按命中键数量降序的多条候选：背景脚本用「字段取最丰富的、身份取带加密 ID 的」
      captures: recent,
      // 岗位 ID 两套形态的翻译表（同节点同框配对），供采集侧把数字 ID 归一成加密形态
      jobPairs: pairOut,
      attachments: attachOut,
      ringSize: ring.length,
      hitCount: hits.length
    };
  }

  /**
   * 附件幂等键：由 URL **路径**构造，不含易变票据。
   * 口径与后端 attachment 建表脚本头注释一致：
   *   <端点段>:<文件 ID>   例如 download4boss:01858de472ad39180XRy2t-9FFRU
   */
  function buildPlatformFileId(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean);
      const kind = seg.length >= 2 ? seg[seg.length - 2] : 'file';
      const id = seg.length ? decodeURIComponent(seg[seg.length - 1]) : 'unknown';
      // ★ 刻意不含 query —— 必须与 background.js 的同名函数完全一致 ★
      //   真机同一份附件有两种 URL（带/不带 ?previewType=1，后者是前者的重定向形态）；
      //   把 previewType 拼进键会让同一份文件算出两个键，而平台侧键是全局唯一的，
      //   同一份简历就会入库两行。附件身份 = 端点 + 末段文件 ID。
      return kind + ':' + id;
    } catch (e) {
      return 'file:unknown';
    }
  }

  /**
   * DOM 兜底：PDF 预览不一定经过页面 JS。
   *
   * 实测踩过（2026-09-21）：HR 点开简历预览、PDF 也渲染出来了，但 hook 在
   * 聊天页一个附件请求都没看到，采集结果里 attachment 一片空白。
   * 原因是这类预览常走「浏览器内置阅读器 / iframe 导航」——请求不穿 fetch/XHR，
   * 而承载它的 <iframe>/<embed>/<object> 是留在 DOM 里的。
   *
   * 所以补一条纯 DOM 的识别路径：扫 src/data/href，命中附件 URL 规则即收录。
   * 安全性由背景脚本把关（按 geekId 与当前候选人比对，不匹配就丢弃），
   * 所以这里宁可多收，不要漏收。
   */
  function domAttachments() {
    const out = [];
    const seen = Object.create(null);
    const push = (rawUrl) => {
      if (!rawUrl) return;
      const abs = absolutize(rawUrl);
      if (!abs || seen[abs]) return;
      seen[abs] = 1;
      try {
        if (!rules.attachUrlRe.test(abs)) return;
      } catch (e) { return; }
      out.push({
        originUrl: abs,
        contentType: '',
        bytes: null,
        sourceScene: 'dom',
        platformFileId: buildPlatformFileId(abs)
      });
    };
    try {
      document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
        push(el.getAttribute('src') || el.getAttribute('data'));
      });
      document.querySelectorAll('a[href]').forEach((el) => {
        push(el.getAttribute('href'));
      });
    } catch (e) { /* 扫描失败绝不能影响主流程 */ }
    return out.slice(0, 10);
  }

  /**
   * 找「本账号（HR 自己）的 uid」线索。
   *
   * 为什么需要：实测 /wapi/zpchat/boss/historyMsg 的消息体里 from / to
   * **同时**包含 HR 本人与候选人（uid=618821200 是 HR）。若身份解析退到
   * 数字 uid 兜底，就可能把 HR 自己采成候选人。
   *
   * 线索位置：会话进入接口本身不带，但 /wapi/batch/requests 里内嵌的
   * chat/config 响应带 userInfo.userBaseInfo.id。所以不去猜接口，
   * 而是在近期环形缓冲的响应文本里做一次有界正则查找。
   */
  function findSelfUidHint() {
    const lookback = Math.min(ring.length, 25);
    for (let i = ring.length - 1; i >= ring.length - lookback && i >= 0; i -= 1) {
      const t = ring[i].bodyText;
      if (!t || t.indexOf('userBaseInfo') < 0) continue;
      const m = /"userBaseInfo"\s*:\s*\{[^}]{0,600}?"id"\s*:\s*(\d+)/.exec(t);
      if (m) return m[1];
    }
    return null;
  }

  function status() {
    return {
      frameId: state.frameId,
      frameUrl: safeHref(),
      isTopFrame: (() => { try { return window.top === window; } catch (e) { return false; } })(),
      ringSize: ring.length,
      hitCount: ring.filter((it) => it.hit === 'resume').length,
      attachCount: ring.filter((it) => it.attach === true).length,
      workerCount: state.workerCount,
      rulesVersion: rules.version,
      uptimeMs: Date.now() - state.startedAt,
      errors: state.errors.slice(-5)
    };
  }

  // ============================================================ 消息

  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d[NS] !== NS_VAL) return;
      switch (d.type) {
        case 'BRIDGE_READY':
          state.bridgeReady = true;
          break;
        case 'STATUS':
          post({ type: 'STATUS_RESULT', requestId: d.requestId, payload: status() });
          break;
        case 'EXTRACT':
          post({ type: 'EXTRACT_RESULT', requestId: d.requestId, payload: extract(d.scene) });
          break;
        case 'SET_RULES':
          try {
            rules = compileRules(d.payload || {});
            post({ type: 'RULES_ACK', requestId: d.requestId,
              payload: { version: rules.version } });
          } catch (e) {
            markError('set-rules', e);
            post({ type: 'RULES_ACK', requestId: d.requestId,
              payload: { version: rules.version, error: String((e && e.message) || e) } });
          }
          break;
        default:
          break;
      }
    } catch (e) { markError('on-message', e); }
  }, false);

  // 反复宣告，避免与 bridge 的注入顺序竞争（Phase 0 的教训：外发不要做成数据闸门）
  const announce = () => post({ type: 'HOOK_READY', payload: status() });
  announce();
  setTimeout(announce, 800);
  setTimeout(announce, 2200);
})();
