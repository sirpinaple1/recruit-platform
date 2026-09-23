/**
 * 简历采集链路 · 离线回归（不依赖浏览器、不依赖后端）
 *
 * 用法：
 *   node test/extension-collect-verify.cjs
 *
 * 覆盖两块：
 *   A. background.js —— 在 node:vm 里跑真实 SW 代码，验证「附件补采」链路
 *      （扩展层 webRequest 观察 → 归属判定 → 并入提交载荷 → 下载上传）
 *   B. collect-hook.js —— 从源码里切出 DOM 兜底函数单独执行，验证附件 URL 识别
 *
 * 为什么要固化这份脚本：附件是这条链路上最脆的一环，历史上连续踩过三次
 *   （① hook 根本没看见 PDF 请求；② 补采时认错人；③ 文档侧以数字 uid 为幂等键、
 *    而真机附件 URL 带的是**加密** geekId，永远比不中）。改动采集代码后先跑它，
 *   比在浏览器里点一遍快得多，也不会留下脏数据。
 *
 * 关键设计：T9–T13 用的是**真机取证的 URL 形态**（2026-09-21 从 Chrome 下载链里挖出的
 * docdownload.zhipin.com/wflow/zpgeek/download/download4boss/<加密geekId>?…），
 * 不再是推断出来的样例。断言里带「映射表」「兜底认领」「幂等键折叠」三组边界，
 * 因为这三处任何一处错了都会导致「同一份简历挂到别人名下」或「同一份简历入库两行」。
 *
 * T14–T18（同日新增）：**附件主动探测**。真机取证发现下载 URL 里没有任何签名参数
 * （query 只有 d / previewType / geekId），说明它是页面自己拼的 ——
 * 于是「HR 必须先点开预览」这件事被推翻：有加密 geekId 就能自己拼 URL 发一次请求。
 * 这组断言锁住四件事：命中路径、无加密 ID 时跳过、非 PDF（200 + HTML 的错误页）必须丢弃、
 * 以及「已有附件时不探测」—— 探测要多打一次平台请求，只有在零收获时才值得动用。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
const HOOK_SRC = fs.readFileSync(path.join(ROOT, 'extension/content/collect-hook.js'), 'utf8');

const HR_UID = '618821200';
const GEEK_UID = '720875604';

const RESUME_BODY = JSON.stringify({
  code: 0,
  zpData: {
    chatInfo: { from: { uid: Number(HR_UID) }, to: { uid: Number(GEEK_UID) } },
    messages: [{
      body: {
        resume: {
          user: { uid: Number(GEEK_UID), name: '陈诗健' },
          education: '本科',
          expectSalary: '20-30K',
          workYear: 3,
          workExpList: [{ company: '某公司', positionName: 'Java' }],
        },
      },
    }],
  },
});

const RESUME_KEYS = [
  'geekName', 'expectSalary', 'geekCard', 'advantage', 'workExp', 'eduExp',
  'workExpList', 'eduExpList', 'experiences', 'content1', 'content2', 'content3',
  'workYear', 'positionCategory', 'applyStatus', 'education', 'salary', 'jobSalary',
  'bottomText', 'ageDesc',
];

const ATTACH_URL = `https://www.zhipin.com/wflow/zpgeek/download/preview4boss/${GEEK_UID}?d=abc&id=xyz&authType=0&previewType=1`;
const ATTACH_URL_OTHER = 'https://www.zhipin.com/wflow/zpgeek/download/preview4boss/999999999?d=abc&id=xyz&authType=0&previewType=1';

// ============================================================ 真机取证的 URL 形态
// 来源：2026-09-21 从 Chrome 下载链（History/downloads_url_chains）里挖出的真实请求。
// 三个关键事实，每一个都推翻了此前的一处推断：
//   ① host 是 docdownload.zhipin.com —— 旧 manifest 只授权了 www.zhipin.com，
//      webRequest 观察器**根本收不到**这个域的事件，重放下载也带不上 cookie；
//   ② 端点是 download4boss（不是推断的 preview4boss）；
//   ③ 末段与 query 里的 geekId 都是**加密**形态（01858de…），
//      而文档侧存的 platform_user_id 是**数字** uid（608120464）——同一人、两个 ID 空间。
const REAL_ENC_GEEK = '01858de472ad39180XRy2t-9FFRU';        // 陈诗健
const REAL_ENC_GEEK_OTHER = 'f4c1f17734410c500Xx70tm9E1NR';  // 谢建广
const REAL_UID_GEEK = '608120464';                            // 陈诗健（数字 uid）
const REAL_ATTACH_URL = `https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/${REAL_ENC_GEEK}?d=1789957125000&geekId=${REAL_ENC_GEEK}&previewType=1`;
const REAL_ATTACH_URL_BARE = `https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/${REAL_ENC_GEEK}`;
const REAL_ATTACH_URL_OTHER = `https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/${REAL_ENC_GEEK_OTHER}?geekId=${REAL_ENC_GEEK_OTHER}&previewType=1`;

// 候选人本体：只有数字 uid，没有加密 ID —— 真机上 6 个候选人里 5 个都是这样
const REAL_RESUME_BODY = JSON.stringify({
  code: 0,
  zpData: {
    messages: [{
      body: {
        resume: {
          user: { uid: Number(REAL_UID_GEEK), name: '陈诗健' },
          education: '本科',
          expectSalary: '20-30K',
          workYear: 3,
          workExpList: [{ company: '某公司', positionName: 'Java' }],
        },
      },
    }],
  },
});

// 多人列表响应：**不能当采集来源**，但同一行里同时带数字 uid 与加密 geekId，
// 是「查映射表」的唯一凭据（见 background.js bridgeIdentityIds 注释）
const REAL_PEER_LIST_BODY = JSON.stringify({
  code: 0,
  zpData: {
    friendList: [
      { uid: Number(REAL_UID_GEEK), encryptGeekId: REAL_ENC_GEEK, name: '陈诗健' },
      { uid: 681940311, encryptGeekId: REAL_ENC_GEEK_OTHER, name: '谢建广' },
    ],
  },
});

const REAL_SOURCE_URL = 'https://www.zhipin.com/wapi/zpjob/chat/geek/info';

// ============================================================ 岗位 ID 的两套形态（2026-09-22 真机取证）
// 真机录制 326 条 / 2.9MB 的结论：
//   数字 jobId 575500411            → 只在聊天/候选人侧（getBossFriendListV2、chatted/jobList）
//   加密 encryptJobId 352f92eda…    → 只在职位管理侧（job/data/list）+ 发布响应 job/save
// 而发布台账 publish_record.platform_job_id 记的是**加密**形态，
// 采集节点上的 body.resume.jobId 是**数字** —— 两者永不相等，映射永远解析不到。
// 唯一出路：拿「同一个对象节点里两种形态同框」的配对做翻译（实测 613 次同框）。
const REAL_JOB_NUM = '575500411';
const REAL_JOB_ENC = '352f92eda67db1080nN_3t29FFNR';
const REAL_JOB_ENC_OTHER = 'a5d0bf426e1373a90nN92dS_F1RX';

/** 候选人节点上带岗位 ID 的简历体（真机形态：数字 jobId + bottomText 同节点） */
const REAL_RESUME_BODY_JOB = JSON.stringify({
  code: 0,
  zpData: {
    messages: [{
      body: {
        resume: {
          user: { uid: Number(REAL_UID_GEEK), name: '陈诗健' },
          encryptUid: REAL_ENC_GEEK,
          education: '本科',
          expectSalary: '20-30K',
          workYear: 3,
          workExpList: [{ company: '某公司', positionName: 'Java' }],
          jobId: Number(REAL_JOB_NUM),
          bottomText: '9月21日 沟通的职位-Java',
        },
      },
    }],
  },
});

/** 桥端点响应：同一个对象节点里两种形态同框（真实形态） */
const REAL_BRIDGE_BODY = JSON.stringify({
  code: 0,
  zpData: {
    jobList: [
      { jobId: Number(REAL_JOB_NUM), encryptJobId: REAL_JOB_ENC, jobName: 'Java工程师' },
      { jobId: 575500400, encryptJobId: REAL_JOB_ENC_OTHER, jobName: '测试工程师' },
    ],
  },
});

// 带加密 ID 的候选人：真机上**只有一部分人**有（多数只回数字 uid）。
// 「主动探测」这条路只在有加密 geekId 时才谈得上 —— 数字 uid 拼进下载端点解析不出东西。
const REAL_RESUME_BODY_ENC = JSON.stringify({
  code: 0,
  zpData: {
    messages: [{
      body: {
        resume: {
          user: { uid: Number(REAL_UID_GEEK), name: '陈诗健' },
          encryptUid: REAL_ENC_GEEK,
          education: '本科',
          expectSalary: '20-30K',
          workYear: 3,
          workExpList: [{ company: '某公司', positionName: 'Java' }],
        },
      },
    }],
  },
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

// ============================================================ A. background.js

function resp(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

/** 平台附件端点的默认响应：4 字节 %PDF 魔数 + application/pdf */
function pdfResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    blob: async () => new Blob([new Uint8Array(bytes || [37, 80, 68, 70])], { type: 'application/pdf' }),
  };
}

/** 平台用 200 + HTML 回应「这位候选人没有附件简历」—— 探测必须能识别出来并丢弃 */
function htmlResponse() {
  const body = '<!DOCTYPE html><html><body>暂无附件简历</body></html>';
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html;charset=utf-8' },
    blob: async () => new Blob([body], { type: 'text/html' }),
  };
}

function makeHarness({ sourceUrl, cacheHits, hookAttachments, body, extraCaptures, attachResponse, jobPairs, noFields, localExtra }) {
  const bodyText = body || RESUME_BODY;
  const local = Object.assign({ ext_token: 'EXTTOK', collect_self_uid: HR_UID }, localExtra || {});
  const session = { collect_recent_attachments: cacheHits || [] };
  const calls = { submits: [], uploads: [], downloads: [], tabMsgs: [] };
  const handlers = {};

  const area = (bag) => ({
    async get(keys) {
      if (keys == null) return Object.assign({}, bag);
      const arr = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
      const o = {};
      arr.forEach((k) => { if (k in bag) o[k] = bag[k]; });
      return o;
    },
    async set(obj) { Object.assign(bag, obj); },
    async remove(k) { delete bag[k]; },
  });

  // 主命中 + 附加命中：真机聊天页同一帧里就有多条命中（historyMsg 字段全但无加密 ID、
  // 好友/会话列表带 encryptGeekId 但属「多人响应」不能当来源），必须能一起喂进 harness。
  // noFields=true 模拟 PDF 预览页：页面只有附件请求、没有任何简历接口响应（captures 为空）。
  const captures = (noFields ? [] : [{
    _id: 1,
    url: sourceUrl,
    method: 'GET',
    status: 200,
    contentType: 'application/json',
    chars: bodyText.length,
    truncated: false,
    matchedKeys: ['education', 'expectSalary', 'workYear', 'workExpList'],
    matchedKeyCount: 4,
    bodyText,
  }]).concat((extraCaptures || []).map((c, i) => ({
    _id: i + 2,
    url: c.url || 'https://www.zhipin.com/wapi/zpjob/chat/friend/list',
    method: 'GET',
    status: 200,
    contentType: 'application/json',
    chars: (c.bodyText || '').length,
    truncated: false,
    matchedKeys: c.matchedKeys || ['geekName'],
    matchedKeyCount: c.matchedKeyCount == null ? 1 : c.matchedKeyCount,
    bodyText: c.bodyText,
  })));

  const frames = [{
    ok: true,
    payload: {
      empty: false,
      scene: 'chat',
      pageUrl: 'https://www.zhipin.com/web/chat/index',
      frameUrl: 'https://www.zhipin.com/web/chat/index',
      isTopFrame: true,
      rulesVersion: 'test',
      selfUidHint: HR_UID,
      captures,
      // 页面侧看到的「岗位 ID 数字 ↔ 加密」配对（桥端点的响应），供采集侧归一
      jobPairs: jobPairs || [],
      attachments: hookAttachments || [],
      ringSize: 40,
      hitCount: captures.length,
    },
  }];

  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { handlers.onMessage = fn; } },
      onInstalled: { addListener() {} },
      sendMessage: async () => ({}),
      lastError: null,
      id: 'test',
    },
    storage: {
      local: area(local),
      session: area(session),
      // background.js 顶层会挂 storage.onChanged（切后端地址时刷新缓存）。
      // 不补这一项，整个 harness 在装载 background.js 时就崩，
      // 采集链路会**一条断言都跑不到** —— 实测踩过：报错只指到 background.js:56，
      // 看起来像被测代码有 bug，实际是替身缺 API。
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: {
      sendMessage: async (tabId, msg) => { calls.tabMsgs.push(msg && msg.type); return frames; },
      query: async () => [],
      get: async () => ({}),
      onUpdated: { addListener() {} },
    },
    webRequest: { onCompleted: { addListener(fn) { handlers.webRequest = fn; } } },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  const chromeProxy = new Proxy(chrome, {
    get(t, k) {
      if (k in t) return t[k];
      return { addListener() {}, removeListener() {}, get() {}, set() {}, sendMessage() {}, query() {}, executeScript() {} };
    },
  });

  async function fetchStub(url, init) {
    const u = String(url);
    if (u.indexOf('/api/ext/collect/rules') >= 0) {
      return resp({
        code: 200,
        data: {
          version: 'test-rules',
          resumeKeys: RESUME_KEYS,
          attachUrlPattern: '/wflow/[^/]+/download/',
          attachContentTypePattern: 'application/pdf',
          noisePathPrefixes: [],
        },
      });
    }
    if (u.indexOf('/api/ext/collect/resumes') >= 0) {
      calls.submits.push(JSON.parse(init.body));
      const n = calls.submits[calls.submits.length - 1].candidates[0].attachments.length;
      return resp({
        code: 200,
        data: {
          candidateCreated: true,
          resumeVersionCreated: true,
          candidateId: '1',
          resumeVersionId: '2',
          attachmentIds: Array.from({ length: n }, (_, i) => 'A' + (i + 1)),
        },
      });
    }
    if (u.indexOf('/api/ext/collect/attachments/') >= 0) {
      calls.uploads.push(u);
      return resp({ code: 200, data: { status: 'stored' } });
    }
    calls.downloads.push(u);
    // 附件端点：观察重放与主动探测共用这一支（扩展侧对二者没有任何区分）
    return attachResponse ? attachResponse(u) : pdfResponse();
  }

  const ctx = vm.createContext({
    console,
    fetch: fetchStub,
    chrome: chromeProxy,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, FormData, Blob, TextEncoder, TextDecoder,
  });

  vm.runInContext(BG_SRC, ctx, { filename: 'background.js' });
  return { ctx, calls, handlers, session, local };
}

async function collect(h, payload) {
  h.ctx.__payload = payload;
  h.ctx.__tabId = 77;
  return vm.runInContext('handleCollectRequest(__payload, __tabId)', h.ctx);
}

async function runPartA() {
  // T1：真机场景复现 —— hook 看不到附件，webRequest 看到了
  {
    const h = makeHarness({
      sourceUrl: `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${GEEK_UID}&msgId=1`,
      cacheHits: [{ url: ATTACH_URL, tabId: 88, ts: Date.now() }],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T1 采集成功', r.ok === true, r.error);
    check('A/T1 附件被补入 1 个', atts.length === 1, JSON.stringify(atts));
    check('A/T1 附件幂等键正确', atts[0] && atts[0].platformFileId === `preview4boss:${GEEK_UID}`, atts[0] && atts[0].platformFileId);
    check('A/T1 toast 显示 1/1 入库', r.summary.attachmentTotal === 1 && r.summary.attachmentStored === 1, JSON.stringify(r.summary));
    check('A/T1 真的发起了下载+上传', h.calls.downloads.length === 1 && h.calls.uploads.length === 1, JSON.stringify(h.calls.uploads));
    check('A/T1 expectedGeekId 取自 URL 的 gid', r.diag.expectedGeekId === GEEK_UID, r.diag.expectedGeekId);
  }

  // T2：附件属于别人 → 必须丢弃（不能张冠李戴）
  {
    const h = makeHarness({
      sourceUrl: `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${GEEK_UID}`,
      cacheHits: [{ url: ATTACH_URL_OTHER, tabId: 88, ts: Date.now() }],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T2 不匹配的附件被丢弃', atts.length === 0, JSON.stringify(atts));
    check('A/T2 diag 记录了丢弃数', r.diag.cachedRejected === 1, r.diag.cachedRejected);
    check('A/T2 提示里有"不匹配"', /不匹配/.test(r.warning || ''), r.warning);
  }

  // T3：附件末段 ID 与本候选人的两种 ID 都不沾边 → 丢弃（并告知看到了什么）
  {
    const h = makeHarness({
      sourceUrl: 'https://www.zhipin.com/wapi/zpjob/chat/geek/info',
      cacheHits: [{ url: 'https://www.zhipin.com/wflow/zpgeek/download/preview4boss/555555555?previewType=1', tabId: 88, ts: Date.now() }],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T3 不沾边的附件被丢弃', atts.length === 0, JSON.stringify(atts));
    check('A/T3 提示里带出「看到的 ID」以便自证', /555555555/.test(r.warning || ''), r.warning);
    check('A/T3 提示里带出本候选人 ID', /720875604/.test(r.warning || ''), r.warning);
  }

  // T3b：URL 里没有 gid，身份只来自响应体的数字 uid —— 附件末段 ID 与之相同 → 仍应采纳
  //      （守卫同时比数字 uid 与加密 ID，比只比 URL 参数更宽也更准）
  {
    const h = makeHarness({
      sourceUrl: 'https://www.zhipin.com/wapi/zpjob/chat/geek/info',
      cacheHits: [{ url: ATTACH_URL, tabId: 88, ts: Date.now() }],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T3b URL 无 gid 时仍按 body 数字 uid 认领', atts.length === 1, JSON.stringify(atts));
    check('A/T3b expectedGeekId 为空但守卫仍生效', r.diag.expectedGeekId === null && r.diag.platformUserId === GEEK_UID,
      JSON.stringify(r.diag));
  }

  // T4：hook 已拿到同一附件 → 不重复登记
  {
    const h = makeHarness({
      sourceUrl: `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${GEEK_UID}`,
      cacheHits: [{ url: ATTACH_URL, tabId: 88, ts: Date.now() }],
      hookAttachments: [{
        originUrl: ATTACH_URL,
        contentType: 'application/pdf',
        bytes: 131072,
        sourceScene: 'attach',
        platformFileId: `preview4boss:${GEEK_UID}`,
      }],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T4 只登记 1 条（不重复）', atts.length === 1, JSON.stringify(atts));
    check('A/T4 未把缓存条目当候选', r.diag.cachedCandidates === 0, r.diag.cachedCandidates);
  }

  // T5：过期缓存不生效（30 分钟窗口）
  {
    const h = makeHarness({
      sourceUrl: `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${GEEK_UID}`,
      cacheHits: [{ url: ATTACH_URL, tabId: 88, ts: Date.now() - 45 * 60 * 1000 }],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T5 过期附件不补采', atts.length === 0 && r.diag.cachedCandidates === 0,
      JSON.stringify({ atts: atts.length, cached: r.diag.cachedCandidates }));
  }

  // T6：HR 自己仍被排除（回归）
  {
    const h = makeHarness({
      sourceUrl: `https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=${GEEK_UID}`,
      cacheHits: [],
      hookAttachments: [],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('A/T6 没把 HR 当候选人', r.diag.platformUserId === GEEK_UID, r.diag.platformUserId);
  }

  // T8：密文 ID 形态 —— 附件 URL 末段是加密 ID 时也要能认（不只有数字 uid 一种）
  {
    const ENC_GEEK = 'aBcD1234efGh5678ijKl';
    const body = JSON.stringify({
      code: 0,
      zpData: {
        messages: [{
          body: {
            resume: {
              user: { uid: Number(GEEK_UID), name: '陈诗健' },
              encryptUid: ENC_GEEK,
              education: '本科',
              expectSalary: '20-30K',
              workYear: 3,
              workExpList: [{ company: '某公司' }],
            },
          },
        }],
      },
    });
    const h = makeHarness({
      sourceUrl: 'https://www.zhipin.com/wapi/zpjob/chat/geek/info',
      cacheHits: [{ url: `https://www.zhipin.com/wflow/zpgeek/download/preview4boss/${ENC_GEEK}?previewType=1`, tabId: 88, ts: Date.now() }],
      hookAttachments: [],
      body,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T8 身份取到加密 ID', r.diag.platformUserId === ENC_GEEK, r.diag.platformUserId);
    check('A/T8 附件 URL 末段是加密 ID 时也能认', atts.length === 1, JSON.stringify(atts));
  }

  // T7：webRequest 观察器行为
  {
    const h = makeHarness({ sourceUrl: 'https://x', cacheHits: [], hookAttachments: [] });
    check('A/T7 webRequest.onCompleted 已注册', typeof h.handlers.webRequest === 'function');
    h.handlers.webRequest({ tabId: 42, statusCode: 200, url: ATTACH_URL });
    await new Promise((r) => setTimeout(r, 30));
    const cached = h.session.collect_recent_attachments || [];
    check('A/T7 命中附件的响应被缓存（含 tabId）', cached.length === 1 && cached[0].tabId === 42, JSON.stringify(cached));
    h.handlers.webRequest({ tabId: 42, statusCode: 200, url: 'https://www.zhipin.com/wapi/zpjob/chat/geek/info' });
    await new Promise((r) => setTimeout(r, 30));
    check('A/T7 普通接口不入缓存', (h.session.collect_recent_attachments || []).length === 1);
    h.handlers.webRequest({ tabId: 42, statusCode: 403, url: ATTACH_URL_OTHER });
    await new Promise((r) => setTimeout(r, 30));
    check('A/T7 4xx 响应不入缓存', (h.session.collect_recent_attachments || []).length === 1);

    // 真机形态必须被识别：域名换成 docdownload、端点换成 download4boss 后仍要命中
    h.handlers.webRequest({ tabId: 42, statusCode: 200, url: REAL_ATTACH_URL });
    h.handlers.webRequest({ tabId: 42, statusCode: 200, url: REAL_ATTACH_URL_BARE });   // 重定向后的形态
    await new Promise((r) => setTimeout(r, 30));
    const cachedReal = h.session.collect_recent_attachments || [];
    check('A/T7b 真机 download4boss URL 能被识别',
      cachedReal.some((x) => /download4boss/.test(x.url)), JSON.stringify(cachedReal.map((x) => x.url)));
    check('A/T7b 带/不带 query 的两种形态折叠为一条',
      cachedReal.filter((x) => /download4boss/.test(x.url)).length === 1,
      JSON.stringify(cachedReal.map((x) => x.url)));
  }

  // T9：真机形态回归 —— 候选人是数字 uid，附件 URL 是**加密** geekId，
  //     靠「多人列表响应」里查到的映射表建立精确相等。这是真机上被卡住的那一脚。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [{ url: REAL_ATTACH_URL, tabId: 88, ts: Date.now() }],   // tabId≠采集页：兜底不生效，只能靠强证据
      hookAttachments: [],
      body: REAL_RESUME_BODY,
      extraCaptures: [{ bodyText: REAL_PEER_LIST_BODY, matchedKeyCount: 1 }],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T9 身份是数字 uid（真机现状）', r.diag.platformUserId === REAL_UID_GEEK, r.diag.platformUserId);
    check('A/T9 映射表查出加密 geekId', r.diag.bridgedIds.indexOf(REAL_ENC_GEEK) >= 0, JSON.stringify(r.diag.bridgedIds));
    check('A/T9 加密形态附件被认领', atts.length === 1, JSON.stringify(atts));
    check('A/T9 未走兜底（是强证据认领）', r.diag.weakClaimed === 0 && atts[0].sourceScene === 'attach', JSON.stringify(r.diag));
    check('A/T9 幂等键为 download4boss:加密geekId',
      atts[0] && atts[0].platformFileId === `download4boss:${REAL_ENC_GEEK}`, atts[0] && atts[0].platformFileId);
    check('A/T9 真的发起了下载+上传', h.calls.downloads.length === 1 && h.calls.uploads.length === 1);
  }

  // T10：没有映射表时（好友列表没被抓到）→ 加密 geekId 无从佐证，只能靠兜底；
  //      此时若不在同一标签页/不在时效窗内，必须丢弃，绝不能张冠李戴。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [{ url: REAL_ATTACH_URL, tabId: 88, ts: Date.now() }],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T10 无映射表且非本标签页 → 丢弃', atts.length === 0, JSON.stringify(atts));
    check('A/T10 提示带出附件端点路径供核对',
      /download4boss/.test(r.warning || ''), r.warning);
  }

  // T11：兜底认领 —— 同一标签页 + 2 分钟内 + 该标签页最近一条 → 认领，但要显式警告 + 消费掉缓存
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [{ url: REAL_ATTACH_URL, tabId: 77, ts: Date.now() }],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T11 兜底认领成功', atts.length === 1, JSON.stringify(atts));
    check('A/T11 来源标记为 attach_tab', atts[0] && atts[0].sourceScene === 'attach_tab', atts[0] && atts[0].sourceScene);
    check('A/T11 明确警告要求核对', /核对/.test(r.warning || ''), r.warning);
    check('A/T11 用掉即从缓存移除（不会漂给下一位）',
      (h.session.collect_recent_attachments || []).length === 0,
      JSON.stringify(h.session.collect_recent_attachments));
  }

  // T12：兜底认领的边界 —— 超时不认；同一标签页有多条时只认最近一条
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [{ url: REAL_ATTACH_URL, tabId: 77, ts: Date.now() - 5 * 60 * 1000 }],  // 5 分钟前 > 2 分钟窗
      hookAttachments: [],
      body: REAL_RESUME_BODY,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('A/T12a 超出时效窗不兜底', h.calls.submits[0].candidates[0].attachments.length === 0,
      JSON.stringify(r.diag));

    const h2 = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [
        { url: REAL_ATTACH_URL_OTHER, tabId: 77, ts: Date.now() - 10 * 1000 },  // 较早：别人的
        { url: REAL_ATTACH_URL, tabId: 77, ts: Date.now() },                    // 最近：本次预览的
      ],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
    });
    const r2 = await collect(h2, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts2 = h2.calls.submits[0].candidates[0].attachments;
    check('A/T12b 只认最近一条', atts2.length === 1 && atts2[0].originUrl === REAL_ATTACH_URL,
      JSON.stringify({ claimed: atts2.map((a) => a.platformFileId), rejected: r2.diag.rejectedEndpoints }));
    check('A/T12b 较早那条被丢弃', r2.diag.cachedRejected === 1, r2.diag.cachedRejected);
  }

  // T13：幂等键必须把「带 query」与「重定向后不带 query」两种 URL 折叠成同一个键，
  //      否则 uk_platform_file 全局唯一，同一份简历会入库两行。
  {
    const h = makeHarness({ sourceUrl: REAL_SOURCE_URL, cacheHits: [], hookAttachments: [] });
    const keyed = vm.runInContext(
      '[' + 'buildPlatformFileId(' + JSON.stringify(REAL_ATTACH_URL) + '),'
      + 'buildPlatformFileId(' + JSON.stringify(REAL_ATTACH_URL_BARE) + ')]',
      h.ctx,
    );
    check('A/T13 两种 URL 形态幂等键一致', keyed[0] === keyed[1], JSON.stringify(keyed));
    check('A/T13 键里不含 previewType（附件身份不随票据变）',
      keyed[0] === `download4boss:${REAL_ENC_GEEK}`, keyed[0]);
  }

  // T14：★ 主动探测 —— HR 没点预览也能拿到附件 ★
  //      身份是加密 ID、观察路径零收获 → 用 geekId 自己拼下载端点发一次请求。
  //      这是「点开预览不是必要条件」这一判断的落地验证。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY_ENC,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    const probeUrl = h.calls.downloads.find((u) => /preview4boss/.test(u)) || '';
    check('A/T14 身份取到加密 ID', r.diag.platformUserId === REAL_ENC_GEEK, r.diag.platformUserId);
    check('A/T14 未点预览也采到附件', atts.length === 1, JSON.stringify(atts));
    check('A/T14 来源标记为 probe', atts[0] && atts[0].sourceScene === 'probe', atts[0] && atts[0].sourceScene);
    check('A/T14 幂等键按探测端点生成',
      atts[0] && atts[0].platformFileId === `preview4boss:${REAL_ENC_GEEK}`, atts[0] && atts[0].platformFileId);
    check('A/T14 探测 URL 与真机形态一致（host/path/query 全对上）',
      new RegExp('^https://www\\.zhipin\\.com/wflow/zpgeek/download/preview4boss/'
        + REAL_ENC_GEEK + '\\?d=\\d+&previewType=1&geekId=' + REAL_ENC_GEEK + '$').test(probeUrl),
      probeUrl);
    check('A/T14 探测拿到的字节被复用（只打 1 趟平台，不重复下载）',
      h.calls.downloads.length === 1, JSON.stringify(h.calls.downloads));
    check('A/T14 入库成功', r.summary.attachmentTotal === 1 && r.summary.attachmentStored === 1, JSON.stringify(r.summary));
    check('A/T14 命中时不打扰 HR（不该出现「没采到附件」类提示）',
      !/没有采集到附件|自动探测附件端点/.test(r.warning || ''), r.warning);
    check('A/T14 diag 记录探测结果',
      r.diag.probe && r.diag.probe.geekId === REAL_ENC_GEEK && !r.diag.probe.missed,
      JSON.stringify(r.diag.probe));
  }

  // T15：没有加密 ID 就探测不了 —— 必须明确记成「跳过」，
  //      而不是静默不做，否则事后分不清「没试」和「试了没中」。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('A/T15 无加密 ID 时不发探测请求', h.calls.downloads.length === 0, JSON.stringify(h.calls.downloads));
    check('A/T15 diag 标记为跳过',
      !!r.diag.probe && r.diag.probe.skipped === 'no-encrypted-id', JSON.stringify(r.diag.probe));
    check('A/T15 提示里说明「无法自动探测」', /无法自动探测/.test(r.warning || ''), r.warning);
  }

  // T16：探测落空必须能识别 —— 平台对「没有附件简历」很可能用 200 + HTML 回应，
  //      只看 HTTP 200 会把一个错误页当简历存进库（比没采到更糟：脏数据 + 需人工核）。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY_ENC,
      attachResponse: () => htmlResponse(),
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('A/T16 非 PDF 响应不被当成附件',
      h.calls.submits[0].candidates[0].attachments.length === 0,
      JSON.stringify(h.calls.submits[0].candidates[0].attachments));
    check('A/T16 两个端点都试过（preview4boss → download4boss）',
      h.calls.downloads.length === 2
        && /preview4boss/.test(h.calls.downloads[0])
        && /download4boss/.test(h.calls.downloads[1]),
      JSON.stringify(h.calls.downloads));
    check('A/T16 diag 标记为未命中', !!r.diag.probe && r.diag.probe.missed === true, JSON.stringify(r.diag.probe));
    check('A/T16 明确告知已探测过（免得 HR 反复重试同一件事）',
      /自动探测附件端点/.test(r.warning || ''), r.warning);
  }

  // T17：preview4boss 不通时回退 download4boss —— 真机上挖到的 URL 正是 download4boss，
  //      说明预览端点会重定向、或对某些候选人不适用；两条都试才稳。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY_ENC,
      attachResponse: (u) => (/preview4boss/.test(u)
        ? { ok: false, status: 404, headers: { get: () => '' }, blob: async () => new Blob([]) }
        : pdfResponse()),
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const atts = h.calls.submits[0].candidates[0].attachments;
    check('A/T17 preview 不通时回退 download4boss', atts.length === 1, JSON.stringify(atts));
    check('A/T17 幂等键用回退端点的口径',
      atts[0] && atts[0].platformFileId === `download4boss:${REAL_ENC_GEEK}`, atts[0] && atts[0].platformFileId);
    check('A/T17 命中后不再二次请求平台', h.calls.downloads.length === 2, JSON.stringify(h.calls.downloads));
  }

  // T18：观察路径已经拿到附件时**不探测** —— 探测要多打一次平台请求（多一分风控暴露面），
  //      只在零收获时才值得动用。
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [{ url: REAL_ATTACH_URL, tabId: 77, ts: Date.now() }],
      hookAttachments: [],
      body: REAL_RESUME_BODY_ENC,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('A/T18 已有附件时不发起探测', r.diag.probe === null, JSON.stringify(r.diag.probe));
    check('A/T18 只打 1 趟下载，用的是观察到的 URL',
      h.calls.downloads.length === 1 && /docdownload\.zhipin\.com/.test(h.calls.downloads[0]),
      JSON.stringify(h.calls.downloads));
  }

  // T19–T22：★ 写入时归一 —— 上报「同一个人的另一种 ID 形态」★
  //   后端按「主键 ∪ 备用键」查候选人，任一形态都落回同一行。
  //   这个值一旦报错人，会把别人的采集吸到这条记录上（候选人级张冠李戴），
  //   所以既验证「该带上时带上了」，也验证「不该带的绝不带」。
  {
    // T19：真机现状 —— 身份是数字 uid，加密 geekId 来自跨 ID 空间映射表
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
      extraCaptures: [{ bodyText: REAL_PEER_LIST_BODY, matchedKeyCount: 1 }],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const sub = h.calls.submits[0].candidates[0];
    check('A/T19 主键是数字 uid（真机现状）', sub.platformUserId === REAL_UID_GEEK, sub.platformUserId);
    check('A/T19 备用键带上了加密 geekId（后端据此归一）',
      sub.secondaryPlatformUserId === REAL_ENC_GEEK, sub.secondaryPlatformUserId);
    check('A/T19 备用键绝不是**别人**的加密 ID',
      sub.secondaryPlatformUserId !== REAL_ENC_GEEK_OTHER, sub.secondaryPlatformUserId);
    check('A/T19 diag 暴露上报值（排查分裂时第一眼看它）',
      r.diag.altPlatformUserId === REAL_ENC_GEEK, JSON.stringify(r.diag.altPlatformUserId));
  }

  {
    // T20：身份本身就是加密 ID 时，备用键要取数字 uid（方向相反，同样必须覆盖）
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY_ENC,
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const sub = h.calls.submits[0].candidates[0];
    check('A/T20 主键是加密 ID', sub.platformUserId === REAL_ENC_GEEK, sub.platformUserId);
    check('A/T20 备用键带上了数字 uid',
      sub.secondaryPlatformUserId === REAL_UID_GEEK, sub.secondaryPlatformUserId);
  }

  {
    // T21：counterpartIdOf 的纯函数边界 —— 挑「另一个」、丢弃非法形态、没有则 null
    const h = makeHarness({ sourceUrl: REAL_SOURCE_URL, cacheHits: [], hookAttachments: [] });
    const got = vm.runInContext(
      'counterpartIdOf(' + JSON.stringify(REAL_UID_GEEK) + ', [null, "", '
      + JSON.stringify(REAL_UID_GEEK) + ', ' + JSON.stringify(REAL_ENC_GEEK) + '])',
      h.ctx,
    );
    check('A/T21 跳过与主键相同的值与空值，取到另一种形态', got === REAL_ENC_GEEK, String(got));

    const invalid = vm.runInContext(
      'counterpartIdOf(' + JSON.stringify(REAL_UID_GEEK) + ', [null, "abc", "中文名字", "12"])',
      h.ctx,
    );
    check('A/T21 非法形态（过短/非字母数字）一律不取，返回 null',
      invalid === null, String(invalid));

    const selfOnly = vm.runInContext(
      'counterpartIdOf(' + JSON.stringify(REAL_UID_GEEK) + ', [' + JSON.stringify(REAL_UID_GEEK) + '])',
      h.ctx,
    );
    check('A/T21 只有一种形态时返回 null（不写脏备用键）', selfOnly === null, String(selfOnly));
  }

  {
    // T22：★ 最要紧的一条安全性质 ★ 多人列表里「别人的加密 ID」绝不能落进备用键。
    //      多人列表同时带来本人与别人的配对，映射表按主键精确命中，别人那条不得进候选。
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      cacheHits: [],
      hookAttachments: [],
      body: REAL_RESUME_BODY,
      extraCaptures: [{ bodyText: REAL_PEER_LIST_BODY, matchedKeyCount: 1 }],
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const sub = h.calls.submits[0].candidates[0];
    const others = [REAL_ENC_GEEK_OTHER, '681940311'];
    check('A/T22 备用键不取自多人列表里的其他人',
      others.indexOf(sub.secondaryPlatformUserId) < 0, sub.secondaryPlatformUserId);
    check('A/T22 映射表只收本人那一对（不含别人的配对）',
      !r.diag.bridgedIds.includes(REAL_ENC_GEEK_OTHER), JSON.stringify(r.diag.bridgedIds));
  }
}

// ============================================================ B. collect-hook.js（DOM 兜底）

/** 从源码里按大括号配对切出一个具名函数的完整源码 */
function sliceFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
    }
  }
  throw new Error('函数未闭合: ' + name);
}

function runPartB() {
  const els = {
    'iframe[src], embed[src], object[data]': [
      // 相对 URL（PDF 阅读器常见形态）——必须被绝对化后命中
      { getAttribute: (n) => (n === 'src' ? `/wflow/zpgeek/download/preview4boss/${GEEK_UID}?previewType=1` : null) },
      // 同一个 URL 再来一次 —— 必须去重
      { getAttribute: (n) => (n === 'src' ? `https://www.zhipin.com/wflow/zpgeek/download/preview4boss/${GEEK_UID}?previewType=1` : null) },
      // 无关外链 —— 不该被当成附件
      { getAttribute: (n) => (n === 'src' ? 'https://cdn.example.com/assets/logo.svg' : null) },
    ],
    'a[href]': [
      { getAttribute: () => `https://www.zhipin.com/wflow/zpgeek/download/preview4boss/999999999?previewType=2` },
      { getAttribute: () => 'https://www.zhipin.com/web/chat/index' },
    ],
  };

  const documentStub = {
    querySelectorAll(sel) { return (els[sel] || []).slice(); },
  };

  const ctx = vm.createContext({
    document: documentStub,
    location: { href: 'https://www.zhipin.com/web/chat/index' },
    rules: { attachUrlRe: /\/wflow\/[^/]+\/download\//i },
    URL,
    Object,
    Array,
  });

  ['absolutize', 'buildPlatformFileId', 'domAttachments'].forEach((fn) => {
    vm.runInContext(sliceFunction(HOOK_SRC, fn), ctx, { filename: fn + '.js' });
  });

  const out = vm.runInContext('domAttachments()', ctx);

  check('B/T1 DOM 兜底能认出 iframe 里的附件',
    out.filter((a) => a.originUrl.indexOf(`/preview4boss/${GEEK_UID}`) > 0).length === 1, JSON.stringify(out.map((a) => a.originUrl)));
  check('B/T2 相对 URL 被绝对化成平台域名', out.some((a) => a.originUrl.indexOf('https://www.zhipin.com/wflow/') === 0), JSON.stringify(out));
  check('B/T3 同一 URL 去重（2 条，不是 3 条）', out.filter((a) => /preview4boss/.test(a.originUrl)).length === 2, JSON.stringify(out.map((a) => a.originUrl)));
  check('B/T4 无关外链不被误收', !out.some((a) => /logo\.svg/.test(a.originUrl)), JSON.stringify(out.map((a) => a.originUrl)));
  check('B/T5 幂等键与 background 口径一致', out.some((a) => a.platformFileId === `preview4boss:${GEEK_UID}`), JSON.stringify(out.map((a) => a.platformFileId)));
  check('B/T6 标记来源为 dom', out.every((a) => a.sourceScene === 'dom' || a.sourceScene === 'attach'), JSON.stringify(out.map((a) => a.sourceScene)));
}

// ============================================================ C. 岗位 ID 归一（数字 → 加密）
// 2026-09-22 真机取证：岗位 ID 有两套 ID 空间。发布台账记加密、采集节点给数字，
// 不归一则映射永远解析不到（候选人永远「未归类」）。这组断言锁住归一方向与失败兜底。
async function runPartC() {
  // C/T1 主路径：数字 jobId + 桥里恰好有这一对 → 归一成加密
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body: REAL_RESUME_BODY_JOB,
      jobPairs: [{ num: REAL_JOB_NUM, enc: REAL_JOB_ENC }],
      attachResponse: () => htmlResponse(),
    });
    await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const p = h.calls.submits[0].candidates[0];
    check('C/T1 数字岗位 ID 被归一成加密形态', p.platformJobId === REAL_JOB_ENC, String(p.platformJobId));
    check('C/T1 岗位提示原样带出（仅供人工辨认）',
      p.platformJobHint === '9月21日 沟通的职位-Java', String(p.platformJobHint));
  }

  // C/T2 桥里有多个岗位，不能张冠李戴（只能翻译**同一个**数字 ID）
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body: REAL_RESUME_BODY_JOB,
      jobPairs: [
        { num: '575500400', enc: REAL_JOB_ENC_OTHER },
        { num: REAL_JOB_NUM, enc: REAL_JOB_ENC },
      ],
      attachResponse: () => htmlResponse(),
    });
    await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const p = h.calls.submits[0].candidates[0];
    check('C/T2 多岗位并存时取的是自己那一对（不串岗）', p.platformJobId === REAL_JOB_ENC, String(p.platformJobId));
  }

  // C/T3 没拿到桥：照常落行，落原始数字形态 —— 投递事实不能丢
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body: REAL_RESUME_BODY_JOB,
      jobPairs: [],
      attachResponse: () => htmlResponse(),
    });
    await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const p = h.calls.submits[0].candidates[0];
    check('C/T3 无桥时仍落行（值为原始数字形态，未归类但事实不丢）',
      p.platformJobId === REAL_JOB_NUM, String(p.platformJobId));
  }

  // C/T4 值已是加密形态（真机 job/save 就是这个形态：键名 jobId、值加密）→ 原样透传
  {
    const body = JSON.stringify({
      code: 0,
      zpData: { messages: [{ body: { resume: {
        user: { uid: Number(REAL_UID_GEEK), name: '陈诗健' },
        encryptUid: REAL_ENC_GEEK,
        education: '本科', expectSalary: '20-30K', workYear: 3,
        workExpList: [{ company: '某公司', positionName: 'Java' }],
        jobId: REAL_JOB_ENC,
      } } }] },
    });
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body,
      jobPairs: [{ num: REAL_JOB_NUM, enc: REAL_JOB_ENC }],
      attachResponse: () => htmlResponse(),
    });
    await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const p = h.calls.submits[0].candidates[0];
    check('C/T4 键名 jobId 但值是加密形态时不被误换（按值的形状判定，不按键名）',
      p.platformJobId === REAL_JOB_ENC, String(p.platformJobId));
  }

  // C/T5 候选人节点上没有岗位 ID → 明确为 null（后端据此不落投递行）
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body: REAL_RESUME_BODY,
      jobPairs: [{ num: REAL_JOB_NUM, enc: REAL_JOB_ENC }],
      attachResponse: () => htmlResponse(),
    });
    await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const p = h.calls.submits[0].candidates[0];
    check('C/T5 没有岗位 ID 时提交 null（不拿桥里的值硬凑）',
      p.platformJobId === null, JSON.stringify(p.platformJobId));
  }

  // C/T6 脏配对必须被挡掉：形态不合法的配对如果混进翻译表，会把岗位译成垃圾值
  {
    const h = makeHarness({ sourceUrl: REAL_SOURCE_URL, attachResponse: () => htmlResponse() });
    const m = vm.runInContext(`collectJobPairs([
      { jobPairs: [{ num: REAL_JOB_NUM_PLACEHOLDER, enc: REAL_JOB_ENC_PLACEHOLDER }] },
      { jobPairs: [{ num: '1', enc: REAL_JOB_ENC_PLACEHOLDER }] },        // 数字太短（状态码 0/1）
      { jobPairs: [{ num: REAL_JOB_NUM_PLACEHOLDER, enc: 'abc' }] },      // 加密形态不合法
      { jobPairs: [null, { num: null }, { enc: null }] },                 // 残缺
    ])`.replace(/REAL_JOB_NUM_PLACEHOLDER/g, `'${REAL_JOB_NUM}'`)
        .replace(/REAL_JOB_ENC_PLACEHOLDER/g, `'${REAL_JOB_ENC}'`), h.ctx);
    check('C/T6 只有形态合法的配对进翻译表', m.size === 1 && m.get(REAL_JOB_NUM) === REAL_JOB_ENC,
      JSON.stringify(Array.from(m.entries())));
  }

  // C/T7 归一函数的四种结局（直接打点，便于定位线上「未归类」属于哪一种）
  {
    const h = makeHarness({ sourceUrl: REAL_SOURCE_URL, attachResponse: () => htmlResponse() });
    // 翻译表在 vm 内部构造：跨 realm 传 Map 会因为原型不同而 `instanceof` 判不出来，
    // 这里直接用上下文自带的 Map 构造，跟真实调用路径一致。
    const run = (raw, pairs) => vm.runInContext(
      `normalizeJobId(${JSON.stringify(raw)}, new Map(Object.entries(${JSON.stringify(pairs)})))`, h.ctx);
    const bridged = run(REAL_JOB_NUM, { [REAL_JOB_NUM]: REAL_JOB_ENC });
    check('C/T7a 数字+有桥 → 归一', bridged.jobId === REAL_JOB_ENC && bridged.normalized === true
      && bridged.reason === 'bridged', JSON.stringify(bridged));
    const noBridge = run(REAL_JOB_NUM, {});
    check('C/T7b 数字+无桥 → 原样返回数字（不丢投递）', noBridge.jobId === REAL_JOB_NUM
      && noBridge.normalized === false && noBridge.reason === 'no-bridge', JSON.stringify(noBridge));
    const already = run(REAL_JOB_ENC, {});
    check('C/T7c 已是加密 → 原样', already.jobId === REAL_JOB_ENC && already.reason === 'already-encrypted',
      JSON.stringify(already));
    const junk = run('未知岗位', {});
    check('C/T7d 形状都不像 ID → 原样（不臆造）', junk.jobId === '未知岗位'
      && junk.reason === 'unrecognized-shape', JSON.stringify(junk));
  }

  // C/T8 页面侧配对扫描：只在**同一对象节点内**配对（跨节点配对 = 张冠李戴）
  {
    const ctx = vm.createContext({
      rules: { job: new Set(['jobId', 'encryptJobId', 'jobIdEncrypt']) },
      Object, String, Number,
    });
    ['isNumericJobId', 'isEncryptedJobId', 'pairFromNode'].forEach((fn) => {
      vm.runInContext(sliceFunction(HOOK_SRC, fn), ctx, { filename: fn + '.js' });
    });
    const pair = vm.runInContext(
      `pairFromNode({ jobId: ${Number(REAL_JOB_NUM)}, encryptJobId: '${REAL_JOB_ENC}', jobName: 'Java' })`, ctx);
    check('C/T8 同节点两种形态 → 产出配对',
      pair && pair.num === REAL_JOB_NUM && pair.enc === REAL_JOB_ENC, JSON.stringify(pair));

    // 数字与加密分别在不同节点 → 括号里的 `pairFromNode` 只看单层，必须返回 null。
    // 这条保证 getBossFriendListV2 这种「一个数组里塞很多岗位」的响应不会把 A 的数字配给 B。
    const cross = vm.runInContext(
      `pairFromNode({ jobId: ${Number(REAL_JOB_NUM)}, sub: { encryptJobId: '${REAL_JOB_ENC}' } })`, ctx);
    check('C/T8b 跨节点的两种形态不配对（防串岗）', cross === null, JSON.stringify(cross));

    const shapes = vm.runInContext(
      `[isNumericJobId(${Number(REAL_JOB_NUM)}), isNumericJobId('1'), isNumericJobId('0'),
        isEncryptedJobId('${REAL_JOB_ENC}'), isEncryptedJobId('${REAL_JOB_NUM}')]`, ctx);
    check('C/T8c 形态判定：数字 9 位是、1 位不是、纯数字不是加密',
      shapes[0] === true && shapes[1] === false && shapes[2] === false
      && shapes[3] === true && shapes[4] === false, JSON.stringify(shapes));
  }

  // C/T9 端到端：真实形态的桥响应整份过一遍 hook 的命中扫描，
  // 必须顺路带出配对 —— 这条断掉的话，前面 C/T1 的「有桥」在真机上根本不会发生。
  {
    const ctx = vm.createContext({
      rules: {
        resume: new Set(RESUME_KEYS),
        noisy: new Set(['jobStatus', 'status', 'name', 'position']),
        job: new Set(['jobId', 'encryptJobId', 'jobIdEncrypt']),
      },
      SCAN_DEPTH: 7, SCAN_ARRAY: 40, SCAN_BUDGET: 1200, STR_JSON_MAX: 8192,
      JOB_PAIR_MAX: 24,
      JSON, Object, Array, Set, Math,
    });
    ['isNumericJobId', 'isEncryptedJobId', 'pairFromNode', 'detectHit'].forEach((fn) => {
      vm.runInContext(sliceFunction(HOOK_SRC, fn), ctx, { filename: fn + '.js' });
    });
    const out = vm.runInContext(`detectHit(JSON.parse(${JSON.stringify(REAL_BRIDGE_BODY)}))`, ctx);
    check('C/T9 真实桥响应一次扫描带出 2 组配对',
      out.jobPairs && out.jobPairs.length === 2, JSON.stringify(out.jobPairs));
    check('C/T9b 岗位列表不会被误判成简历（无 resume 命中键）',
      out.hit === '' && out.matchedKeyCount === 0, JSON.stringify(out.matchedKeys));
  }
}

// ============================================================ D. 纯附件补挂（最近采集身份槽）
// 2026-09-23 程春灿案例：PDF 预览页只有附件、无简历字段，旧逻辑拿附件 URL 里的
// 加密 geekId 直接当身份 → 新建「姓名未知 + 空版本 + 空打分」三无记录（服务端已同步加守卫）。
// 修复后的契约：身份从「5 分钟内最近一次成功采集」的槽里取；
// URL geekId 能取到时必须与槽的任一 ID 形态相符（防张冠李戴）；取不到时信任窗口 + 显式警告。
async function runPartD() {
  const SLOT = {
    platformUserId: REAL_UID_GEEK,   // 聊天页采集的主键（数字 uid，真机现状）
    secondary: REAL_ENC_GEEK,        // 好友列表映射出的加密 geekId（附件 URL 同形态）
    name: '陈诗健',
    platformJobId: REAL_JOB_ENC,
    platformJobHint: '9月23日 沟通的职位-Java初级工程师',
    ts: Date.now(),
  };
  const hookAttach = (url) => ({
    originUrl: url, contentType: 'application/pdf', bytes: 131072,
    sourceScene: 'attach', platformFileId: 'download4boss:' + url.split('/').pop().split('?')[0],
  });

  // D/T1 没有槽（本浏览器 5 分钟内没采过人）→ 拒绝并引导先采人
  {
    const h = makeHarness({ noFields: true, hookAttachments: [hookAttach(REAL_ATTACH_URL)] });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T1 无槽时拒绝补挂并引导先采人',
      r.ok === false && /聊天窗口或简历详情页/.test(r.error || ''), r.error);
    check('D/T1 没有向服务端提交任何东西', h.calls.submits.length === 0, String(h.calls.submits.length));
  }

  // D/T2 槽过期（> 5 分钟）→ 同无槽处理，拒绝
  {
    const h = makeHarness({
      noFields: true,
      hookAttachments: [hookAttach(REAL_ATTACH_URL)],
      localExtra: { collect_last_identity: Object.assign({}, SLOT, { ts: Date.now() - 6 * 60 * 1000 }) },
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T2 槽过期时拒绝（不认 5 分钟外的人）',
      r.ok === false && /纯附件采集/.test(r.error || ''), r.error);
  }

  // D/T3 主路径：槽命中（URL geekId == 槽的加密形态）→ 补挂成功，身份/岗位全用槽值
  {
    const h = makeHarness({
      noFields: true,
      hookAttachments: [hookAttach(REAL_ATTACH_URL)],
      localExtra: { collect_last_identity: SLOT },
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T3 补挂成功', r.ok === true, r.error);
    const sub = h.calls.submits[0].candidates[0];
    check('D/T3 主键用槽里的数字 uid（不再拿 URL geekId 当身份）',
      sub.platformUserId === REAL_UID_GEEK, sub.platformUserId);
    check('D/T3 备用键带槽里的加密 geekId（服务端双键归一，不分裂）',
      sub.secondaryPlatformUserId === REAL_ENC_GEEK, sub.secondaryPlatformUserId);
    check('D/T3 字段为空对象（服务端据此走空字段守卫，不建空版本）',
      sub.fields && Object.keys(sub.fields).length === 0, JSON.stringify(sub.fields));
    check('D/T3 岗位 ID 用槽值（本页取不到）', sub.platformJobId === REAL_JOB_ENC, String(sub.platformJobId));
    check('D/T3 岗位提示用槽值', sub.platformJobHint === SLOT.platformJobHint, String(sub.platformJobHint));
    check('D/T3 附件并入提交（1 份）',
      sub.attachments.length === 1 && sub.attachments[0].originUrl === REAL_ATTACH_URL,
      JSON.stringify(sub.attachments.map((a) => a.originUrl)));
    check('D/T3 姓名来自槽（toast 显示正确的人）', r.candidateName === '陈诗健', String(r.candidateName));
    check('D/T3 显式警告补挂来源（HR 有权核对）', /补挂到最近采集的候选人/.test(r.warning || ''), r.warning);
    check('D/T3 真的发起了下载+上传', h.calls.downloads.length === 1 && h.calls.uploads.length === 1,
      JSON.stringify(h.calls.downloads));
  }

  // D/T4 防张冠李戴：附件 URL 的 geekId 是别人的（谢建广）→ 拒绝，绝不挂错人
  {
    const h = makeHarness({
      noFields: true,
      hookAttachments: [hookAttach(REAL_ATTACH_URL_OTHER)],
      localExtra: { collect_last_identity: SLOT },
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T4 URL geekId 与槽不符时拒绝（防张冠李戴）',
      r.ok === false && /不属于最近采集的候选人/.test(r.error || ''), r.error);
    check('D/T4 没有向服务端提交任何东西', h.calls.submits.length === 0, String(h.calls.submits.length));
  }

  // D/T5 URL 取不到 geekId（重定向后的裸形态，无 query）→ 信任 5 分钟窗口，补挂 + 警告
  {
    const h = makeHarness({
      noFields: true,
      hookAttachments: [hookAttach(REAL_ATTACH_URL_BARE)],
      localExtra: { collect_last_identity: SLOT },
    });
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T5 URL 无 geekId 时信任窗口补挂', r.ok === true, r.error);
    check('D/T5 身份仍是槽里的人', h.calls.submits[0].candidates[0].platformUserId === REAL_UID_GEEK,
      h.calls.submits[0].candidates[0].platformUserId);
    check('D/T5 警告要求核对（无 ID 佐证必须显式告知）', /核对/.test(r.warning || ''), r.warning);
  }

  // D/T6 槽刷新：补采成功后槽的 ts 被刷新（同一人连续补多份附件不因窗口过期中断）
  {
    const h = makeHarness({
      noFields: true,
      hookAttachments: [hookAttach(REAL_ATTACH_URL)],
      localExtra: { collect_last_identity: Object.assign({}, SLOT, { ts: Date.now() - 4 * 60 * 1000 }) },
    });
    const beforeTs = h.local.collect_last_identity.ts;
    await new Promise((res) => setTimeout(res, 5));
    const r = await collect(h, { scene: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    const after = h.local.collect_last_identity;
    check('D/T6 补采成功后槽仍保留', r.ok === true && !!after, r.error);
    check('D/T6 槽被刷新（ts 前移、身份不变）',
      after && after.ts > beforeTs && after.platformUserId === REAL_UID_GEEK
        && after.secondary === REAL_ENC_GEEK,
      JSON.stringify({ beforeTs, after }));
  }

  // D/T7 常规采集也写槽：聊天页带字段采集成功后，槽里有身份 + 岗位（供 5 分钟内补采用）
  {
    const h = makeHarness({
      sourceUrl: REAL_SOURCE_URL,
      body: REAL_RESUME_BODY_JOB,
      jobPairs: [{ num: REAL_JOB_NUM, enc: REAL_JOB_ENC }],
      extraCaptures: [{ bodyText: REAL_PEER_LIST_BODY, matchedKeyCount: 1 }],
      attachResponse: () => htmlResponse(),
    });
    const r = await collect(h, { scene: 'chat', sourceChannel: 'chat', pageUrl: 'https://www.zhipin.com/web/chat/index' });
    check('D/T7 常规采集成功', r.ok === true, r.error);
    const slot = h.local.collect_last_identity;
    // 该简历体带 encryptUid → 主键取加密形态、备用键取数字 uid（与 D/T3 的数字主键方向互补）
    check('D/T7 槽写入了主键（该 body 带加密 ID，主键为加密形态）',
      slot && slot.platformUserId === REAL_ENC_GEEK, JSON.stringify(slot));
    check('D/T7 槽写入了备用键与姓名',
      slot && slot.secondary === REAL_UID_GEEK && slot.name === '陈诗健', JSON.stringify(slot));
    check('D/T7 槽写入了岗位（归一后的加密形态）',
      slot && slot.platformJobId === REAL_JOB_ENC, JSON.stringify(slot));
  }
}

// ============================================================ 执行

(async () => {
  await runPartA();
  runPartB();
  await runPartC();
  await runPartD();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  results.forEach((r) => {
    console.log((r.ok ? '  ✅ ' : '  ❌ ') + r.name + (r.ok ? '' : '   → ' + r.detail));
  });
  console.log('\n  ' + pass + '/' + results.length + ' 通过' + (fail ? '，' + fail + ' 失败' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness 崩溃:', e);
  process.exit(2);
});
