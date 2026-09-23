/**
 * 招聘助手 · 岗位捕获探针（发布页 MAIN world hook）
 *
 * 运行环境：页面主世界（world:"MAIN"），document_start，all_frames:true。
 * 注入方式：由 background 在填充完成后经 chrome.scripting 显式注入
 *          （不是声明式 content_scripts —— 避免在每个 zhipin 页面常驻）。
 *
 * 职责：在**发布页**旁观 fetch / XHR 响应，尝试识别「这次发布产生的是平台上的哪个岗位」
 *      （BOSS jobId），把结果放进内存并 postMessage 给哨兵（ISOLATED 世界）。
 *
 * ★ 为什么需要它（而不是只读 URL）★
 *   sentinel.js 只能看到 window.location.href。BOSS 发布成功后的落地 URL
 *   （实测发布编辑页 /web/frame/job/publish-edit?…&encryptId=0）里并不保证含岗位 ID，
 *   而「发布提交的响应体」与「发布页随后拉取的职位列表接口」里几乎一定有。
 *   只读 URL 等于把成败押在平台的路由习惯上，所以这里多开一条通道。
 *
 * ★ 为什么不做成「抓到就外发」★
 *   与 collect-hook.js 同一条合规原则：hook 全程只写内存，**只有哨兵判定发布成功时**
 *   才把结果带走。缓冲区不产生网络请求、不落盘，因此探针本身是廉价的被动行为。
 *
 * ★ 与 collect-hook.js 的区别（别混）★
 *   collect-hook 抓的是**候选人简历**（被判为 PII，逐条需 HR 明示）；
 *   本探针只认**岗位 ID**（不含个人信息），且只在发布页生效。
 *   二者键表互不共用：本探针绝不使用 resumeKeys。
 *
 * 三条铁律（同 collect-hook）：
 *   1) 绝不阻断、绝不改写响应、绝不增加页面请求延迟
 *   2) 自身任何异常都吞掉 —— 探针挂了也不能影响发布流程
 *   3) 只读 JSON 文本，二进制一律跳过
 *
 * ⚠️ 本文件整体包 IIFE：与其它注入脚本可能共享顶层作用域，
 *    顶层裸写 let/const 会在同名时抛 SyntaxError 并让整支脚本不运行（见 bridge.js 事故）。
 */
(() => {
  'use strict';

  const NS = '__recruit_job_probe';
  const NS_VAL = 'v1';
  const GUARD = '__recruit_job_probe_active';

  // ★ 重复注入守卫（必须有）★
  //   本文件既由「发布填充任务」注入，也可由 popup 的「开始录制」注入 ——
  //   同一页面命中两次时，如果不守卫就会**再包一层 fetch/XHR**，
  //   于是每条响应被录两次（数据看着像翻倍，会误导诊断结论），
  //   而且原生调用链被叠多层，页面也会变慢。
  //   已注入时只同步录制开关，不重新挂 hook。
  if (window[GUARD]) {
    try { window[GUARD].setRecording(window.__RECRUIT_JOB_PROBE_RECORD__ === true); } catch (e) { /* ignore */ }
    return;
  }

  const BODY_MAX = 256 * 1024;
  const BIG_BODY = 5 * 1024 * 1024;
  const SCAN_DEPTH = 6;
  const SCAN_BUDGET = 800;

  /**
   * 默认键表 —— 与后端 CollectRules.JOB_ID_KEYS / JOB_HINT_KEYS 保持一致（改动必须同步）。
   * 后端通过 window.__RECRUIT_JOB_PROBE_RULES__ 覆盖（逻辑后置，平台改版不改扩展发版）。
   */
  const DEFAULT_RULES = {
    jobIdKeys: ['jobId', 'encryptJobId', 'jobIdEncrypt'],
    jobHintKeys: ['bottomText']
  };

  /**
   * 「这是一个岗位对象」的旁证键。
   *
   * 为什么要旁证：响应体里出现 jobId 的地方不止职位本身（例如埋点、推荐位）。
   * 只按「第一个叫 jobId 的标量」取值，有把无关 ID 记成岗位的风险 —— 而错误的映射
   * 会把该岗位下所有候选人归到错误的需求单，比没有映射危险得多（未归类看得见）。
   * 命中旁证才取强证据；没有旁证时只在响应 URL 含 /job 的接口上取弱证据。
   */
  const JOB_CONTEXT_KEYS = [
    'jobName', 'jobTitle', 'positionName', 'jobStatus', 'encryptJobId',
    'jobSalary', 'jobDescription', 'brandName', 'bossName'
  ];

  // ★ 发布接口识别（2026-09-23 真机取证）★
  //   取证来源：Downloads/recruit-job-probe-2026-09-23T01-53-32.json
  //   BOSS 发布成功后**不跳转**（停留原页）→ URL 判定这条路根本走不通；
  //   而配置的 toast 选择器 .toast .icon-toast-success 实测从未命中。
  //   唯一可靠证据是发布接口自己的响应：
  //     POST https://www.zhipin.com/wapi/zpjob/job/save
  //     {"code":0,"zpData":{"rescode":1,"blockTitle":"职位发布成功",
  //                         "jobId":"a25a740f0f32506a0nN939q1FFpR"}}
  //   jobId 在 zpData 下，且**是加密形态**（即规范形），可直接入库。
  //   ⚠️ 键名仍是 jobId —— 与聊天侧同名却装数字形态正好相反，
  //     所以这里按「接口 + 位置」取值，形态判定一律交给服务端 CollectRules。
  const PUBLISH_URL_RE = /\/wapi\/zpjob\/job\/save(\?|$|\/)/i;

  // ★ JOB_HINT 污染黑名单（同样是取证实证，不是推测）★
  //   聊天页这几个接口的响应里也带 jobId + 旁证键，会被 scanForJob 判成 strong=true。
  //   实测同一次录制里污染 8 次，且发布后仅 2.9 秒就把哨兵手里的岗位 ID
  //   覆盖成了**数字形态**、还是**别的岗位**的 ID。
  //   错映射比没映射危险得多（未归类看得见，错归类看不见），故明确挡掉。
  //   这些接口对「桥配对」仍有用 —— 那是 collect-hook 的职责，与本文件的发布取证无关。
  //   另：job/save **本身也进黑名单** —— 它的岗位 ID 只在「成功」时才有意义，
  //   失败响应里那个 jobId（可能是待发布的草稿 ID 或空壳）不该被当成岗位提示走 JOB_HINT，
  //   否则「发布失败」会被误当成「拿到了岗位 ID」。成功一律走 JOB_PUBLISHED。
  const JOB_HINT_DENY_RE =
    /\/(zpjob\/chat\/|zpjob\/view\/geek|zprelation\/friend\/|zpjob\/job\/save)/i;

  let rules = compile(DEFAULT_RULES);
  const state = { seen: 0, matched: 0, errors: [], lastAt: null };

  // ============================================================ 全量录制（诊断用）
  //
  // ★ 为什么需要它 ★
  //   路径 A 依赖「发布成功时能从页面里取到岗位 ID」。BOSS 到底在哪个接口、哪个字段
  //   给出岗位 ID，是**未经验证的平台行为** —— 只靠猜 jobIdKeys 是在赌。
  //   所以补一个「把这段会话里所有响应都录下来」的开关：真人发一次岗位，
  //   事后离线把录到的响应翻一遍，就能用事实回答「职位 ID 从哪来、字段叫什么」。
  //
  // ★ 合规边界（与 collect-hook 同一条原则，不能因为"是诊断"就松）★
  //   录制**默认关闭**，必须由人在 popup 里显式开启；
  //   数据只留在浏览器本地（页面内存 + chrome.storage.session），
  //   **不自动外发任何一条**；只有人点「导出」才会下载成文件。
  //   绝不录像二进制（PDF 等）—— 只记元数据，二进制一律跳过。
  //
  // 容量：单条截断 + 页面侧条数硬上限（真正生效的环形缓冲在 background）。
  // 页面侧上限取得比 background 宽，是为了让「超额」这件事由 background 的
  // 丢最旧策略来处理（保留最近的行为更有诊断价值），而不是让页面先停止录制。
  const REC_MAX_ITEMS = 3000;
  const REC_MAX_BODY = 128 * 1024;

  let recording = false;
  let recItems = 0;
  let recBytes = 0;
  try {
    // 由 background 在注入前写入（与规则同一条通道）
    recording = window.__RECRUIT_JOB_PROBE_RECORD__ === true;
  } catch (e) { /* 默认关闭 */ }

  function postToTop(msg) {
    try { window.postMessage(msg, '*'); } catch (e) { markError('post-self', e); }
    try {
      if (window.top && window.top !== window) window.top.postMessage(msg, '*');
    } catch (e) { /* 跨源，正常，忽略 */ }
  }

  /** 录一条响应/请求。只在 recording 打开时调用。 */
  function record(entry) {
    if (!recording) return;
    try {
      const body = entry.bodyText || '';
      recItems += 1;
      recBytes += body.length;
      // 页面侧只计数不囤数据（真正存储由 background 的环形缓冲负责），
      // 所以这里**不因为量大就自行停录** —— 静默停录会让人以为「平台没返回」，
      // 从而得出错误结论。到硬上限时明确上报一次，让人看得见。
      if (recItems > REC_MAX_ITEMS) {
        recording = false;
        postToTop({ [NS]: NS_VAL, type: 'RECORD_LIMIT', payload: { recItems, recBytes } });
        return;
      }
      postToTop({ [NS]: NS_VAL, type: 'RECORD', payload: entry });
    } catch (e) { markError('record', e); }
  }

  function clipBody(text) {
    const s = typeof text === 'string' ? text : '';
    if (s.length <= REC_MAX_BODY) return { text: s, truncated: false, chars: s.length };
    return { text: s.slice(0, REC_MAX_BODY), truncated: true, chars: s.length };
  }

  // 允许 background 在注入本文件**之前**先写规则（与 collect-hook 的 SET_RULES 等价，但更省一次往返）
  try {
    const injected = window.__RECRUIT_JOB_PROBE_RULES__;
    if (injected && typeof injected === 'object') {
      rules = compile({
        jobIdKeys: Array.isArray(injected.jobIdKeys) && injected.jobIdKeys.length
          ? injected.jobIdKeys : DEFAULT_RULES.jobIdKeys,
        jobHintKeys: Array.isArray(injected.jobHintKeys) && injected.jobHintKeys.length
          ? injected.jobHintKeys : DEFAULT_RULES.jobHintKeys
      });
    }
  } catch (e) { /* 规则不可用则用默认 */ }

  function compile(raw) {
    return {
      jobIdKeys: raw.jobIdKeys || DEFAULT_RULES.jobIdKeys,
      jobHintKeys: raw.jobHintKeys || DEFAULT_RULES.jobHintKeys
    };
  }

  function markError(where, e) {
    if (state.errors.length > 20) state.errors.shift();
    state.errors.push({ where, msg: String((e && e.message) || e), ts: Date.now() });
  }

  function safeHref() { try { return location.href; } catch (e) { return ''; } }
  function now() { try { return performance.now(); } catch (e) { return Date.now(); } }

  /**
   * 岗位 ID 合法性（保守口径，宁缺勿错）。
   *   · 数字 ID：正整数，≤ 12 位（BOSS jobId 实测 9 位）
   *   · 加密 ID：字母数字混排 16–64 位（与 CollectService.looksEncryptedId 同口径）
   * 其它形态（0 / 空串 / 过长 / 明显不是 ID 的文本）一律不收。
   */
  function isPlausibleJobId(v) {
    if (typeof v === 'number') {
      return Number.isInteger(v) && v > 0 && String(v).length <= 12;
    }
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

  /**
   * 在一棵 JSON 里找岗位 ID。
   * @returns {{jobId:string, hint:string|null, keyName:string, strong:boolean}|null}
   */
  function scanForJob(root) {
    if (!root || typeof root !== 'object') return null;
    let budget = SCAN_BUDGET;
    const seen = new Set();
    const stack = [[root, 0]];
    let weak = null;
    while (stack.length) {
      if (budget-- <= 0) break;
      const cur = stack.pop();
      const node = cur[0];
      const depth = cur[1];
      if (!node || typeof node !== 'object' || depth > SCAN_DEPTH) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = 0; i < Math.min(node.length, 20); i += 1) stack.push([node[i], depth + 1]);
        continue;
      }
      let keys;
      try { keys = Object.keys(node); } catch (e) { continue; }

      let jobId = null;
      let jobIdKey = null;
      let hint = null;
      let hasContext = false;

      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const v = node[k];
        if (jobId === null && rules.jobIdKeys.indexOf(k) >= 0 && isPlausibleJobId(v)) {
          jobId = typeof v === 'number' ? String(v) : String(v).trim();
          jobIdKey = k;
        } else if (hint === null && rules.jobHintKeys.indexOf(k) >= 0
                   && typeof v === 'string' && v.trim()) {
          hint = v.trim();
        } else if (JOB_CONTEXT_KEYS.indexOf(k) >= 0 && v != null && v !== '') {
          hasContext = true;
        }
        if (v && typeof v === 'object') stack.push([v, depth + 1]);
      }

      if (jobId !== null) {
        const found = { jobId, hint, keyName: jobIdKey, strong: hasContext };
        // 强证据（岗位对象）直接返回；弱证据先记着，继续找更好的
        if (hasContext) return found;
        if (!weak) weak = found;
      }
    }
    return weak;
  }

  function hintFromUrl() {
    try {
      const u = new URL(location.href);
      const keys = ['jobId', 'jobid', 'encryptJobId', 'id'];
      for (const k of keys) {
        const v = u.searchParams.get(k);
        if (v && isPlausibleJobId(v)) {
          return { jobId: v.trim(), hint: null, keyName: 'url:' + k, strong: false };
        }
      }
      // 路径形态兜底：/job_detail/<encryptId>.html
      const m = /\/job_detail\/([A-Za-z0-9_~-]{16,64})\.html/.exec(u.pathname);
      if (m) return { jobId: m[1], hint: null, keyName: 'url:path', strong: false };
    } catch (e) { /* ignore */ }
    return null;
  }

  function publish(found, sourceUrl, strong) {
    if (!found) return;
    state.matched += 1;
    state.lastAt = Date.now();
    const payload = {
      [NS]: NS_VAL,
      type: 'JOB_HINT',
      payload: {
        jobId: found.jobId,
        keyName: found.keyName,
        hint: found.hint || null,
        // 强度只用于**诊断与人工判断**：强弱都不影响后端写入（后端一律标 auto，可被人工覆盖）。
        // 记录它是为了真机排障时能看出「这个 ID 是从哪来的」。
        strong: !!strong,
        sourceUrl: String(sourceUrl || '').slice(0, 1024),
        pageUrl: safeHref(),
        ts: Date.now(),
        rulesVersion: NS_VAL
      }
    };
    emit(payload);
  }

  function readJson(text, url) {
    const s = typeof text === 'string' ? text : '';
    if (!s) return;
    if (s.length > BODY_MAX) return;
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) return;
    let body;
    try { body = JSON.parse(s); } catch (e) { return; }

    // 发布接口优先：它是「发布成功」的权威信号，且岗位 ID 就在响应里，
    // 不依赖任何 DOM 猜测，也不需要 scanForJob 的旁证（该响应里没有旁证键）。
    const sig = readPublishSignal(body, url);
    if (sig) { publishSignal(sig, url); return; }

    const found = scanForJob(body);
    if (!found) return;
    // 挡掉聊天侧污染（理由见 JOB_HINT_DENY_RE 处注释）
    if (JOB_HINT_DENY_RE.test(url || '')) return;
    const urlIsJob = /\/job/i.test(url || '');
    // 弱证据 + 接口不像职位相关 → 丢弃。宁可漏，不可错。
    if (!found.strong && !urlIsJob) return;
    publish(found, url, found.strong);
  }

  /**
   * 从发布接口响应里读「发布成功」信号。
   *
   * <p>双标志（HTTP 层 code 与业务层 rescode）都要求成功：只认其一会在
   * 「接口 200 但业务失败」或反之的边界上误判，而误判成功会把一个
   * 根本没发出去的岗位写进台账，还会占住唯一键（占位式错误最难排查）。</p>
   *
   * @returns {{jobId:string, blockTitle:string|null, resmsg:string|null}|null}
   */
  function readPublishSignal(body, url) {
    if (!body || typeof body !== 'object') return null;
    if (!PUBLISH_URL_RE.test(url || '')) return null;
    if (body.code !== 0) return null;
    const z = body.zpData;
    if (!z || typeof z !== 'object') return null;
    if (z.rescode !== 1) return null;
    let jobId = null;
    if (typeof z.jobId === 'string' && z.jobId.trim()) jobId = z.jobId.trim();
    else if (typeof z.jobId === 'number') jobId = String(z.jobId);
    if (!jobId) {
      // 成功却没给 ID：不该静默 —— 打点后按「无信号」处理（哨兵会继续等 DOM 兜底）
      markError('publish-no-jobid', new Error('job/save 成功但未返回 jobId'));
      return null;
    }
    return {
      jobId: jobId,
      blockTitle: typeof z.blockTitle === 'string' ? z.blockTitle : null,
      resmsg: typeof z.resmsg === 'string' ? z.resmsg : null
    };
  }

  /** 发布成功信号：交给哨兵据此判定成功（见 sentinel.js 的 JOB_PUBLISHED 分支） */
  function publishSignal(sig, sourceUrl) {
    state.matched += 1;
    state.lastAt = Date.now();
    emit({
      [NS]: NS_VAL,
      type: 'JOB_PUBLISHED',
      payload: {
        jobId: sig.jobId,
        keyName: 'zpData.jobId',
        hint: sig.blockTitle || sig.resmsg || null,
        // 接口识别本身就是最强证据，不走旁证逻辑
        strong: true,
        sourceUrl: String(sourceUrl || '').slice(0, 1024),
        pageUrl: safeHref(),
        ts: Date.now(),
        rulesVersion: NS_VAL
      }
    });
  }

  /**
   * 投递消息：同时投给本帧与顶层帧。
   * 发布流程可能发生在 iframe 内，而哨兵只注在顶层；同源时 top 可达，
   * 跨源则跳过，不影响自身帧的投递。
   */
  function emit(payload) {
    try { window.postMessage(payload, '*'); } catch (e) { markError('post-self', e); }
    try {
      if (window.top && window.top !== window) window.top.postMessage(payload, '*');
    } catch (e) { /* 跨源，正常情况，忽略 */ }
  }

  // ============================================================ fetch

  const raw = {};
  try { raw.fetch = window.fetch; } catch (e) { raw.fetch = null; }
  try { raw.XHR = window.XMLHttpRequest; } catch (e) { raw.XHR = null; }

  if (typeof raw.fetch === 'function') {
    const hookedFetch = function (...args) {
      let url = '';
      let method = 'GET';
      let reqBody = null;
      try {
        const input = args[0];
        const init = args[1] || {};
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') { url = input.url; method = input.method || 'GET'; }
        else if (init.url) url = init.url;
        if (init.method) method = init.method;
        // 请求体也是证据：提交发布的 payload 里可能就带岗位信息
        if (typeof init.body === 'string') reqBody = init.body;
      } catch (e) { markError('fetch-url', e); }
      // 铁律 1：原生 Promise 原样还给页面
      const p = raw.fetch.apply(this, args);
      try {
        if (url) {
          Promise.resolve(p).then((res) => {
            try { observeFetch(res, { url, method, reqBody }); } catch (e) { markError('fetch-observe', e); }
          }, () => { /* 网络失败由页面处理 */ });
        }
      } catch (e) { markError('fetch-attach', e); }
      return p;
    };
    try { window.fetch = hookedFetch; } catch (e) { markError('install-fetch', e); }
  }

  function observeFetch(res, meta) {
    const url = meta.url;
    let ct = '';
    let status = 0;
    try {
      ct = res.headers.get('content-type') || '';
      status = res.status;
      const len = Number(res.headers.get('content-length') || 0) || 0;
      if (len > BIG_BODY) return;
    } catch (e) { return; }

    const isText = ct.indexOf('json') >= 0 || ct.indexOf('text/') >= 0
      || ct.indexOf('html') >= 0 || ct.indexOf('xml') >= 0;
    // 录制模式下不是文本也记一条元数据（知道「这里有个二进制/其他响应」本身有价值），
    // 但绝不读它的内容。
    if (!isText) {
      if (recording) {
        record(Object.assign(base_meta(url, meta.method, status, ct, null), {
          kind: 'non-text', note: '非文本响应，未读内容'
        }));
      }
      return;
    }
    try {
      // 铁律 2：clone 的流异步读，同步等会拖慢页面
      res.clone().text().then((t) => {
        try {
          readJson(t, url);
          if (recording) {
            const b = clipBody(t);
            record(Object.assign(base_meta(url, meta.method, status, ct, meta.reqBody), {
              kind: 'text', bodyText: b.text, chars: b.chars, truncated: b.truncated
            }));
          }
        } catch (e) { markError('fetch-json', e); }
      }).catch(() => { /* ignore */ });
    } catch (e) { /* 不可 clone 的响应直接跳过 */ }
  }

  /** 录制条目的公共元数据（与 collect-hook 的字段命名保持一致，便于对照排障） */
  function base_meta(url, method, status, ct, reqBody) {
    let req = null;
    if (typeof reqBody === 'string' && reqBody) {
      req = reqBody.length > 4096 ? reqBody.slice(0, 4096) + '…(截断)' : reqBody;
    }
    return {
      url: String(url || ''),
      method: String(method || 'GET').toUpperCase(),
      status: status || null,
      contentType: ct || '',
      reqBody: req,
      frameUrl: safeHref(),
      isTopFrame: (() => { try { return window.top === window; } catch (e) { return false; } })(),
      ts: Date.now(),
      tsIso: new Date().toISOString()
    };
  }

  // ============================================================ XHR

  if (raw.XHR && raw.XHR.prototype) {
    const XP = raw.XHR.prototype;
    const rawOpen = XP.open;
    const rawSend = XP.send;
    XP.open = function (method, url) {
      const r = rawOpen.apply(this, arguments);
      try {
        this.__rjp = {
          url: typeof url === 'string' ? url : String(url),
          method: String(method || 'GET').toUpperCase()
        };
      } catch (e) { /* ignore */ }
      return r;
    };
    XP.send = function (body) {
      const r = rawSend.apply(this, arguments);
      try {
        const meta = this.__rjp;
        if (meta && meta.url) {
          if (typeof body === 'string') meta.reqBody = body;
          this.addEventListener('loadend', () => {
            try { observeXhr(this, meta); } catch (e) { markError('xhr-observe', e); }
          }, { once: true });
        }
      } catch (e) { markError('xhr-send', e); }
      return r;
    };
  }

  function observeXhr(xhr, meta) {
    try {
      let ct = '';
      let status = 0;
      try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) { /* ignore */ }
      try { status = xhr.status || 0; } catch (e) { /* ignore */ }
      let finalUrl = meta.url;
      try { if (xhr.responseURL) finalUrl = xhr.responseURL; } catch (e) { /* ignore */ }

      const isText = ct.indexOf('json') >= 0 || ct.indexOf('text/') >= 0
        || ct.indexOf('html') >= 0 || ct.indexOf('xml') >= 0;
      if (!isText) {
        if (recording) {
          record(Object.assign(base_meta(finalUrl, meta.method, status, ct, meta.reqBody), {
            kind: 'non-text', note: '非文本响应，未读内容'
          }));
        }
        return;
      }
      let text = '';
      const rt = xhr.responseType || '';
      if (rt === 'json') text = xhr.response == null ? '' : JSON.stringify(xhr.response);
      else if (!rt || rt === 'text') text = xhr.responseText || '';
      else return;
      // 推下一轮宏任务，避免主线程卡顿
      setTimeout(() => {
        try {
          readJson(text, finalUrl);
          if (recording) {
            const b = clipBody(text);
            record(Object.assign(base_meta(finalUrl, meta.method, status, ct, meta.reqBody), {
              kind: 'text', bodyText: b.text, chars: b.chars, truncated: b.truncated
            }));
          }
        } catch (e) { markError('xhr-json', e); }
      }, 0);
    } catch (e) { /* ignore */ }
  }

  // ============================================================ 状态（诊断用）

  function status() {
    return {
      probe: NS_VAL,
      frameUrl: safeHref(),
      isTopFrame: (() => { try { return window.top === window; } catch (e) { return false; } })(),
      matched: state.matched,
      lastAt: state.lastAt,
      recording,
      recItems,
      recBytes,
      urlHint: hintFromUrl(),
      rules: { jobIdKeys: rules.jobIdKeys.length, jobHintKeys: rules.jobHintKeys.length },
      errors: state.errors.slice(-5)
    };
  }

  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d[NS] !== NS_VAL) return;
      switch (d.type) {
        case 'STATUS':
          window.postMessage({ [NS]: NS_VAL, type: 'STATUS_RESULT', payload: status() }, '*');
          break;
        case 'RECORD_ON':
          recording = true;
          postToTop({ [NS]: NS_VAL, type: 'RECORD_STATE', payload: status() });
          break;
        case 'RECORD_OFF':
          recording = false;
          postToTop({ [NS]: NS_VAL, type: 'RECORD_STATE', payload: status() });
          break;
        default:
          break;
      }
    } catch (e) { markError('on-message', e); }
  }, false);

  // 注册防重入守卫（供二次注入时只同步开关、不重复挂 hook）
  try {
    window[GUARD] = {
      setRecording: (v) => { recording = v === true; },
      status
    };
  } catch (e) { /* ignore */ }

  // 宣告就绪，便于 background/哨兵诊断「探针到底注进来了没有」
  try {
    window.postMessage({ [NS]: NS_VAL, type: 'PROBE_READY', payload: status() }, '*');
  } catch (e) { /* ignore */ }
})();
