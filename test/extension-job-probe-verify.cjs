/**
 * 岗位探针 + 转发层 · 离线回归（不依赖浏览器、不依赖后端）
 *
 * 用法：
 *   node test/extension-job-probe-verify.cjs
 *
 * 为什么要固化这份脚本：
 *   录制链路有三个**静默**故障模式，都不会报错、只会让诊断结论偏掉：
 *     1. 探针被注入两次 → 再包一层 fetch/XHR → 每条响应录两遍（数据看着像翻倍）
 *     2. 录制开关没传到页面 → 人以为在录、实际一条没录 → 误判成「平台没返回岗位信息」
 *     3. 关闭录制后台仍继续落库 → 导出里混着无关页面的流量
 *   这三条都只能靠断言锁住，肉眼看代码看不出来。
 *
 * 覆盖断言：
 *   P1  探针注入不抛错，并注册防重入守卫
 *   P2  录制**关闭**时：拿到 JSON 也**不产生**任何外发（合规底线）
 *   P3  录制开启时：产生且仅产生一条 RECORD，字段（url/method/status/bodyText）正确
 *   P4  RECORD_OFF 下行后不再产生 RECORD
 *   P5  探针**重复注入不双录**（守住 fetch 只被包一层）
 *   P6  fetch 的请求体（POST body）被带上，供取证
 *   P7  非文本响应只留元数据、**不读内容**
 *   P8  超长响应被截断并标记 truncated
 *   P9  XHR 链路同样会录（与 fetch 对称，不是只测一条路）
 *   P10 relay 把 RECORD 转发给 background，且**恰好一次**
 *   P11 relay 重复注入不叠加监听器
 *   P12 relay 不转发与探针命名空间无关的 postMessage
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONTENT_DIR = path.join(__dirname, '..', 'extension', 'content');
const PROBE = path.join(CONTENT_DIR, 'job-probe.js');
const RELAY = path.join(CONTENT_DIR, 'job-probe-relay.js');

const NS = '__recruit_job_probe';
const NS_VAL = 'v1';

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: Boolean(cond), extra: cond ? undefined : extra });
}

/** 同一个页面的「两条世界」：MAIN（探针）与 ISOLATED（转发层），共享一个 postMessage 总线 */
function makePage(opts = {}) {
  const listeners = { MAIN: {}, ISO: {} };
  const postedByMain = [];
  const sentToBg = [];

  function dispatch(world, msg) {
    // ★ ev.source 必须按「接收方所在世界」给 ★
    //   真实浏览器里 MAIN 与 ISOLATED 是同一个帧的同一个 WindowProxy，
    //   所以两侧 `ev.source === window` 都成立（collect-bridge / job-probe-relay 正是靠它
    //   判断「这条消息是不是本帧发出的」）。harness 里两个世界是不同对象，
    //   若统一给同一个 source，转发层的过滤就会误判、把消息全丢光 —— 测出来是假阴性。
    const source = world === 'MAIN' ? mainWin : isoWin;
    const bag = listeners[world];
    (bag.message || []).slice().forEach((fn) => {
      try { fn({ source, data: msg }); } catch (e) { /* 交回被测代码内部处理 */ }
    });
  }

  // 总线：任一侧 postMessage，两侧的 message 监听器都会收到（真实浏览器行为）
  function bus(msg, fromWorld) {
    if (fromWorld === 'MAIN') postedByMain.push(msg);
    dispatch('MAIN', msg);
    dispatch('ISO', msg);
  }

  const mainWin = {
    location: { origin: 'https://www.zhipin.com', href: 'https://www.zhipin.com/web/geek/job/publish' },
    postMessage: (msg) => bus(msg, 'MAIN'),
    addEventListener: (type, fn) => { (listeners.MAIN[type] = listeners.MAIN[type] || []).push(fn); },
  };
  mainWin.top = opts.top === false ? { postMessage: () => {} } : mainWin;

  const isoWin = {
    location: { origin: 'https://www.zhipin.com' },
    postMessage: (msg) => bus(msg, 'ISO'),
    addEventListener: (type, fn) => { (listeners.ISO[type] = listeners.ISO[type] || []).push(fn); },
  };
  isoWin.top = isoWin;

  const xhrInstances = [];
  class FakeXHR {
    constructor() {
      this.responseType = '';
      this.status = 0;
      this.responseURL = '';
      this.responseText = '';
      this._headers = {};
      xhrInstances.push(this);
    }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader() {}
    getResponseHeader(k) { return this._headers[String(k).toLowerCase()] || null; }
    addEventListener(type, fn) { (this._ev = this._ev || {})[type] = fn; }
    send() { /* 由测试手动触发完成 */ }
    /** 测试辅助：模拟服务端返回并触发 loadend */
    finish({ ct = 'application/json', status = 200, body = '' }) {
      this.status = status;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this._headers['content-type'] = ct;
      if (this._ev && this._ev.loadend) this._ev.loadend();
    }
  }

  const chromeStub = {
    runtime: {
      id: 'fake-extension-id',
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      sendMessage: (msg, cb) => { sentToBg.push(msg); if (cb) cb({ ok: true }); },
      onMessage: { addListener: (fn) => { listeners.isoOnMessage = listeners.isoOnMessage || []; listeners.isoOnMessage.push(fn); } },
    },
  };

  const base = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Promise,
    Date,
    JSON,
    URL,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    performance: { now: () => Date.now() },
  };

  const mainSandbox = Object.assign({}, base, {
    window: mainWin,
    self: mainWin,
    fetch: opts.fetchImpl,
    XMLHttpRequest: FakeXHR,
  });
  const isoSandbox = Object.assign({}, base, {
    window: isoWin,
    self: isoWin,
    chrome: chromeStub,
  });

  mainSandbox.window.fetch = opts.fetchImpl;
  mainSandbox.window.XMLHttpRequest = FakeXHR;
  mainSandbox.window.console = console;
  mainSandbox.window.setTimeout = setTimeout;
  mainSandbox.window.document = base.document;
  mainSandbox.window.performance = base.performance;

  vm.createContext(mainSandbox);
  vm.createContext(isoSandbox);

  /** 模拟「别的帧（子帧）投递给本帧」：ev.source 是一个不同的 window */
  function emitForeign(world, msg) {
    const bag = listeners[world];
    (bag.message || []).slice().forEach((fn) => {
      try { fn({ source: { __foreign: true }, data: msg }); } catch (e) { /* ignore */ }
    });
  }

  return { mainSandbox, isoSandbox, postedByMain, sentToBg, xhrInstances, listeners, emitForeign };
}

function run(ctx, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
}

/** 造一个 fetch 响应替身（含 clone().text()，与真实 Response 的用法一致） */
function makeResponse(body, { ct = 'application/json', status = 200, contentLength = null } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'content-type') return ct;
        if (key === 'content-length') return String(contentLength == null ? text.length : contentLength);
        return null;
      },
    },
    clone: () => ({ text: () => Promise.resolve(text) }),
  };
}

/** 等微任务/宏任务跑完（探针的 observe 走 clone().text().then） */
function flush() {
  return new Promise((r) => setTimeout(r, 5));
}

function records(page) {
  return page.postedByMain.filter((m) => m && m[NS] === NS_VAL && m.type === 'RECORD');
}

(async () => {
  // ==================== P1–P2：注入 + 默认不外发 ====================
  const pageA = makePage({
    fetchImpl: () => Promise.resolve(makeResponse({ code: 0, zpData: { jobId: 575500411 } })),
  });
  let injectErr = null;
  try {
    run(pageA.mainSandbox, PROBE);
  } catch (e) { injectErr = String((e && e.message) || e); }
  check('P1 探针注入不抛错', injectErr === null, injectErr);
  check('P1b 注册了防重入守卫', Boolean(vm.runInContext('!!window.__recruit_job_probe_active', pageA.mainSandbox)));

  await pageA.mainSandbox.window.fetch('https://www.zhipin.com/wapi/zpjob/job/list', { method: 'GET' });
  await flush();
  check('P2 录制关闭时拿到了 JSON 也不产生 RECORD（合规底线：默认不外发）',
    records(pageA).length === 0, '实际 ' + records(pageA).length + ' 条');

  // ==================== P3：开启录制 → 恰好一条，字段正确 ====================
  pageA.mainSandbox.window.__RECRUIT_JOB_PROBE_RECORD__ = true;
  // 用下行指令开录（走 message 通路，验证真实开关路径而不是直接改内部变量）
  pageA.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  await pageA.mainSandbox.window.fetch('/wapi/zpjob/job/data/list?page=1', {
    method: 'POST',
    body: JSON.stringify({ foo: 'bar' }),
  });
  await flush();
  const recsA = records(pageA);
  check('P3 开启录制后产生且仅产生一条 RECORD', recsA.length === 1, '实际 ' + recsA.length + ' 条');
  const r0 = recsA[0] && recsA[0].payload;
  check('P3b url 为绝对化后的地址', Boolean(r0 && /job\/data\/list\?page=1$/.test(r0.url)), r0 && r0.url);
  check('P3c method 被记录', r0 && r0.method === 'POST', r0 && r0.method);
  check('P3d status 被记录', r0 && r0.status === 200, r0 && r0.status);
  check('P3e 响应体完整带上（诊断要看字段，不能空）',
    Boolean(r0 && r0.bodyText && r0.bodyText.indexOf('575500411') >= 0), r0 && r0.bodyText);
  check('P6 fetch 请求体被带上（POST payload 也是证据）',
    Boolean(r0 && r0.reqBody && r0.reqBody.indexOf('"foo"') >= 0), r0 && r0.reqBody);

  // ==================== P4：关录后不再产生 ====================
  pageA.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_OFF' });
  await pageA.mainSandbox.window.fetch('/wapi/zpjob/job/data/list?page=2', { method: 'GET' });
  await flush();
  check('P4 RECORD_OFF 后不再产生 RECORD', records(pageA).length === 1,
    '实际 ' + records(pageA).length + ' 条');

  // ==================== P5：重复注入不双录（关键回归） ====================
  pageA.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  run(pageA.mainSandbox, PROBE); // 第二次注入
  await pageA.mainSandbox.window.fetch('/wapi/zpjob/job/data/list?page=3', { method: 'GET' });
  await flush();
  const afterDup = records(pageA).filter((m) => m.payload && /page=3$/.test(m.payload.url));
  check('P5 重复注入探针不双录（同一条响应只录一次）', afterDup.length === 1,
    '实际 ' + afterDup.length + ' 条 —— 说明 fetch 被包了不止一层');

  // ==================== P7–P8：非文本 / 超长 ====================
  const pageB = makePage({
    fetchImpl: () => Promise.resolve(makeResponse('binary-ish', { ct: 'application/pdf' })),
  });
  run(pageB.mainSandbox, PROBE);
  pageB.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  await pageB.mainSandbox.window.fetch('/wflow/x/download/y.pdf', { method: 'GET' });
  await flush();
  const recsB = records(pageB);
  check('P7 非文本响应也留一条元数据', recsB.length === 1, '实际 ' + recsB.length + ' 条');
  check('P7b 非文本响应不读内容（bodyText 为空）',
    recsB[0] && !recsB[0].payload.bodyText, JSON.stringify(recsB[0] && recsB[0].payload));

  const big = 'x'.repeat(200 * 1024);
  const pageC = makePage({
    fetchImpl: () => Promise.resolve(makeResponse({ big }, { contentLength: big.length + 20 })),
  });
  run(pageC.mainSandbox, PROBE);
  pageC.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  await pageC.mainSandbox.window.fetch('/wapi/zpjob/big', { method: 'GET' });
  await flush();
  const recsC = records(pageC);
  check('P8 超长响应被截断并标记',
    recsC.length === 1 && recsC[0].payload.truncated === true
      && recsC[0].payload.bodyText.length === 128 * 1024,
    recsC[0] ? ('truncated=' + recsC[0].payload.truncated + ' len=' + (recsC[0].payload.bodyText || '').length) : '无记录');

  // ==================== P9：XHR 链路 ====================
  const pageD = makePage({ fetchImpl: () => Promise.resolve(makeResponse({})) });
  run(pageD.mainSandbox, PROBE);
  pageD.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  const xhr = new pageD.mainSandbox.XMLHttpRequest();
  xhr.open('GET', '/wapi/zpjob/xhr/list');
  xhr.send();
  xhr.finish({ body: { zpData: { jobId: 4242 } } });
  await flush();
  const recsD = records(pageD);
  check('P9 XHR 链路同样会录（不是只测了 fetch）', recsD.length === 1, '实际 ' + recsD.length + ' 条');
  check('P9b XHR 的 url 用 responseURL 兜底后仍正确',
    recsD[0] && /xhr\/list$/.test(recsD[0].payload.url), recsD[0] && recsD[0].payload.url);

  // ==================== P10–P12：转发层 ====================
  const pageE = makePage({ fetchImpl: () => Promise.resolve(makeResponse({})) });
  run(pageE.isoSandbox, RELAY);
  run(pageE.mainSandbox, PROBE);
  pageE.mainSandbox.window.postMessage({ [NS]: NS_VAL, type: 'RECORD_ON' });
  await pageE.mainSandbox.window.fetch('/wapi/zpjob/job/data/list?relay=1', { method: 'GET' });
  await flush();
  const forwarded = pageE.sentToBg.filter((m) => m && m.type === 'JOB_PROBE_RECORD');
  check('P10 relay 把 RECORD 转发给 background，且恰好一次', forwarded.length === 1,
    '实际 ' + forwarded.length + ' 条');
  check('P10b 转发内容就是探针的原载荷',
    forwarded[0] && forwarded[0].payload && /relay=1$/.test(forwarded[0].payload.url),
    JSON.stringify(forwarded[0]));

  run(pageE.isoSandbox, RELAY); // 第二次注入 relay
  await pageE.mainSandbox.window.fetch('/wapi/zpjob/job/data/list?relay=2', { method: 'GET' });
  await flush();
  const forwarded2 = pageE.sentToBg.filter((m) => m && m.type === 'JOB_PROBE_RECORD'
    && m.payload && /relay=2$/.test(m.payload.url));
  check('P11 relay 重复注入不叠加监听器（同一条只转发一次）', forwarded2.length === 1,
    '实际 ' + forwarded2.length + ' 条');

  const before = pageE.sentToBg.length;
  pageE.isoSandbox.window.postMessage({ hello: 'unrelated' });
  pageE.isoSandbox.window.postMessage({ [NS]: 'other-ns', type: 'RECORD', payload: {} });
  await flush();
  check('P12 与探针命名空间无关的 postMessage 一律不转发',
    pageE.sentToBg.length === before, '多转发 ' + (pageE.sentToBg.length - before) + ' 条');

  // ==================== P13–P14：跨帧去重 + 开关自同步 ====================
  // ★ P13 是防「数据翻倍」的关键断言 ★
  //   探针会同时投递到本帧与顶层（投顶层是为了让顶层哨兵收到 JOB_HINT）。
  //   若转发层不按 ev.source 过滤，顶层会把「子帧投给顶层」的那一份再转一次，
  //   同一条响应入库两次 —— 数据看起来翻倍，诊断结论直接失真。
  const beforeRec = pageE.sentToBg.filter((m) => m.type === 'JOB_PROBE_RECORD').length;
  pageE.emitForeign('ISO', {
    [NS]: NS_VAL, type: 'RECORD', payload: { url: 'https://www.zhipin.com/wapi/foreign/frame' },
  });
  await flush();
  const afterRec = pageE.sentToBg.filter((m) => m.type === 'JOB_PROBE_RECORD').length;
  check('P13 子帧投给顶层的消息不被顶层转发层重复上报（防数据翻倍）',
    afterRec === beforeRec, '多上报 ' + (afterRec - beforeRec) + ' 条');

  check('P14 relay 装载时主动问一次录制开关（否则探针以为自己是关的，静默录不到）',
    pageE.sentToBg.some((m) => m.type === 'DIAG_GET_FLAG'),
    JSON.stringify(pageE.sentToBg.map((m) => m.type).slice(0, 6)));

  // ==================== 汇总 ====================
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    if (r.ok) {
      console.log('  ✅ ' + r.name);
    } else {
      console.log('  ❌ ' + r.name + (r.extra ? '\n       ' + r.extra : ''));
    }
  }
  console.log('\n结果：✅ 通过 ' + (results.length - failed.length) + ' 项，❌ 失败 ' + failed.length + ' 项');
  process.exit(failed.length === 0 ? 0 : 1);
})();
