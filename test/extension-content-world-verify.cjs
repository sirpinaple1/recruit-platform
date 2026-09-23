/**
 * Content Script 隔离世界 · 离线回归（不依赖浏览器、不依赖后端）
 *
 * 用法：
 *   node test/extension-content-world-verify.cjs
 *
 * 为什么要固化这份脚本：
 *   同一个 content_scripts 条目里的多个 js 文件，注入的是**同一个隔离世界**，
 *   顶层作用域共享。2026-09-22 曾在 message-relay.js 与 bridge.js 里各写了一句
 *   顶层 `let contextDead`，后执行的那支直接抛
 *     Uncaught SyntaxError: Identifier 'contextDead' has already been declared
 *   —— 整支 bridge 不运行，页面收不到 EXT_READY，表现成「检测不到插件」，
 *   而 DevTools 只把错误指到 `bridge.js:1:1`，几乎指不到真凶。
 *   语法错误发生在解析阶段，脚本内任何 `if (window[FLAG]) return` 守卫都救不了，
 *   所以只能靠「每个文件整体包 IIFE」这条纪律 + 本脚本兜底。
 *
 * 覆盖四组断言：
 *   T1–T3 正序注入（manifest 里的真实顺序，也是当初炸掉的顺序）
 *   T4–T6 消息链路：页面 FILL_REQUEST → bridge 重发 → relay 转发，且恰好一次（双发是老 bug）
 *   T7–T8 反序注入不炸（文件顺序被调换时不能塌）
 *   T9–T11 重复注入：各自 window 标记生效，心跳与监听器不叠加
 *   T12–T13 另一组同世界组合（BOSS 发布页：message-relay + sentinel）同样不抛错
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONTENT_DIR = path.join(__dirname, '..', 'extension', 'content');
const RELAY = path.join(CONTENT_DIR, 'message-relay.js');
const BRIDGE = path.join(CONTENT_DIR, 'bridge.js');
const SENTINEL = path.join(CONTENT_DIR, 'sentinel.js');
const ORIGIN = 'http://118.145.246.201';

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: Boolean(cond), extra });
}

/** 造一个「隔离世界」：window / chrome / storage 的最小可用替身 */
function makeWorld() {
  const posted = [];
  const captured = {};
  const sentToBg = [];
  let depth = 0;

  const win = {
    location: { origin: ORIGIN },
    // 真实浏览器里 postMessage 会回灌给同源的 message 监听器；这里同步回灌
    // （带深度护栏，防止监听器之间互相触发成环），否则「bridge 重发 → relay 转发」
    // 这条链根本跑不通，测出来是假阴性。
    postMessage: (msg) => {
      posted.push({ msg });
      if (depth > 10) return;
      depth++;
      (captured.message || []).slice().forEach((fn) => fn({ source: win, data: msg }));
      depth--;
    },
    addEventListener: (type, fn) => {
      (captured[type] = captured[type] || []).push(fn);
    },
  };

  const sandbox = {
    window: win,
    localStorage: { getItem: (k) => (k === 'recruit_token' ? 'jwt-token' : null) },
    sessionStorage: { getItem: () => null },
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    chrome: {
      runtime: {
        id: 'fake-extension-id',
        getManifest: () => ({ version: 'test' }),
        lastError: null,
        sendMessage: (msg, cb) => {
          sentToBg.push(msg);
          if (cb) cb({ ok: true });
        },
        onMessage: { addListener: () => {} },
      },
    },
  };
  vm.createContext(sandbox);
  return { sandbox, posted, captured, sentToBg, win };
}

function run(ctx, file, label) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: label || path.basename(file) });
}

// —— T1–T3：正序注入（manifest 中 js 数组的真实顺序）——
const w1 = makeWorld();
let err1 = null;
try {
  run(w1.sandbox, RELAY);
  run(w1.sandbox, BRIDGE);
} catch (e) {
  err1 = String((e && e.message) || e);
}
check('T1 正序注入不抛 SyntaxError（核心回归）', err1 === null, err1);
check(
  'T2 bridge 发出 EXT_READY 心跳（页面据此判定「已安装」）',
  w1.posted.some((p) => p.msg.type === 'EXT_READY'),
  JSON.stringify(w1.posted.map((p) => p.msg.type))
);
check(
  'T3 bridge 发出 RECRUIT_SESSION_DETECTED（零配置换权入口）',
  w1.posted.some((p) => p.msg.type === 'RECRUIT_SESSION_DETECTED')
);

// —— T4–T6：完整消息链路 ——
(w1.captured.message || []).forEach((fn) =>
  fn({ source: w1.win, data: { source: 'recruit-platform', type: 'FILL_REQUEST', payload: { recordId: 'r1' } } })
);
check(
  'T4 FILL_REQUEST 恰好转发一次（未双发，双发会导致开两个 tab）',
  w1.sentToBg.filter((m) => m.type === 'FILL_REQUEST').length === 1,
  '转发 ' + w1.sentToBg.filter((m) => m.type === 'FILL_REQUEST').length + ' 次'
);
check(
  'T5 初始化时的 RECRUIT_SESSION_DETECTED 也到达 background',
  w1.sentToBg.filter((m) => m.type === 'RECRUIT_SESSION_DETECTED').length === 1
);
check(
  'T6 页面原始消息（source=recruit-platform）不被 relay 直接转发',
  w1.sentToBg.every((m) => m.source === 'recruit-bridge'),
  JSON.stringify(w1.sentToBg.map((m) => m.source))
);

// —— T7–T8：反序注入 ——
const w2 = makeWorld();
let err2 = null;
try {
  run(w2.sandbox, BRIDGE);
  run(w2.sandbox, RELAY);
} catch (e) {
  err2 = String((e && e.message) || e);
}
check('T7 反序注入不抛错（文件顺序被调换也不能塌）', err2 === null, err2);
check('T8 反序注入后心跳仍正常', w2.posted.some((p) => p.msg.type === 'EXT_READY'));

// —— T9–T11：重复注入 ——
const w3 = makeWorld();
let err3 = null;
try {
  const relaySrc = fs.readFileSync(RELAY, 'utf8');
  const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
  vm.runInContext(relaySrc, w3.sandbox, { filename: 'message-relay.js' });
  vm.runInContext(bridgeSrc, w3.sandbox, { filename: 'bridge.js' });
  vm.runInContext(relaySrc, w3.sandbox, { filename: 'message-relay.js#dup' });
  vm.runInContext(bridgeSrc, w3.sandbox, { filename: 'bridge.js#dup' });
} catch (e) {
  err3 = String((e && e.message) || e);
}
check('T9 重复注入不抛错', err3 === null, err3);
check(
  'T10 重复注入后心跳未翻倍',
  w3.posted.filter((p) => p.msg.type === 'EXT_READY').length === 1,
  String(w3.posted.filter((p) => p.msg.type === 'EXT_READY').length)
);
check(
  'T11 重复注入后 message 监听未叠加（每支各一个）',
  (w3.captured.message || []).length === 2,
  String((w3.captured.message || []).length)
);

// —— T12–T13：BOSS 发布页的同世界组合（message-relay + sentinel）——
const w4 = makeWorld();
w4.sandbox.document = { body: {} };
w4.sandbox.MutationObserver = class {
  observe() {}
};
let err4 = null;
try {
  run(w4.sandbox, RELAY);
  run(w4.sandbox, SENTINEL);
} catch (e) {
  err4 = String((e && e.message) || e);
}
check('T12 同世界注入 message-relay + sentinel 不抛错', err4 === null, err4);
check(
  'T13 sentinel 因缺配置而安全退出（不应中断脚本）',
  w4.sandbox.window['recruit-sentinel-active'] === true,
  String(w4.sandbox.window['recruit-sentinel-active'])
);

// —— T14–T16：发布接口信号驱动哨兵回填（2026-09-23 取证后的新逻辑）——
// ★ 为什么必须固化这几条 ★
//   旧的「发布成功」判定 = toast 选择器 + 120s 固定窗口。BOSS 发布后不跳转
//   （urlPattern 无从判定），而 .toast .icon-toast-success 实测从未命中，
//   结果是台账永远 pending、岗位映射永远缺失，且**全程无报错**。
//   现在改为听发布接口（job/save）的响应，下面几条就是防止它再退化回「猜 DOM」。
const w5 = makeWorld();
w5.sandbox.document = { body: {}, querySelector: () => null };
w5.sandbox.MutationObserver = class { observe() {} };
w5.win.location.href = 'https://www.zhipin.com/web/frame/job/publish-edit?encryptId=0';
// 成功配置故意保留旧的 toast 选择器：T15 要证明「即使它匹配不上，接口信号也能回填」
w5.sandbox.window.__RECRUIT_SENTINEL_CONFIG__ = {
  // ★ 必须是字符串 ★ 雪花 ID 超过 2^53，写成数字字面量会静默丢精度
  //   （实测 2102576864096415745 → 2102576864096415700）。
  //   后端 PublishRecordVO.id 也是按字符串返回的，这里与真实链路保持一致。
  recordId: '2102576864096415745',
  successConfig: { selectors: ['.toast .icon-toast-success'], timeoutMs: 120000 },
  platformTabId: 1,
};

let err5 = null;
try {
  run(w5.sandbox, SENTINEL);
} catch (e) {
  err5 = String((e && e.message) || e);
}
check('T14 带配置注入 sentinel 不抛错', err5 === null, err5);

// 探针在 MAIN 世界捕获到 job/save 成功响应后发的信号
w5.sandbox.window.postMessage({
  __recruit_job_probe: 'v1',
  type: 'JOB_PUBLISHED',
  payload: {
    jobId: 'a25a740f0f32506a0nN939q1FFpR',
    keyName: 'zpData.jobId',
    hint: '职位发布成功',
    strong: true,
    ts: Date.now(),
  },
});

(async () => {
  // reportSuccess 内部 await 了 sendMessage，需放行微任务
  await new Promise((r) => setTimeout(r, 10));

  const reports = w5.sentToBg.filter((m) => m.type === 'SENTINEL_REPORT');
  check('T15 发布接口信号命中即触发回填（不依赖 toast 选择器匹配）',
    reports.length === 1, '实际 ' + reports.length + ' 条');
  check('T15b 回填带上发布响应里的加密岗位 ID',
    reports[0] && reports[0].payload.platformJobId === 'a25a740f0f32506a0nN939q1FFpR',
    JSON.stringify(reports[0] && reports[0].payload));
  check('T15c 岗位 ID 来源标记为接口，便于排障',
    reports[0] && reports[0].payload.platformJobSource === 'api:job/save',
    reports[0] && reports[0].payload.platformJobSource);

  // 再来一次同信号（比如页面重发），不能重复回填
  w5.sandbox.window.postMessage({
    __recruit_job_probe: 'v1',
    type: 'JOB_PUBLISHED',
    payload: { jobId: 'a25a740f0f32506a0nN939q1FFpR', ts: Date.now() },
  });
  await new Promise((r) => setTimeout(r, 10));
  check('T16 重复信号不重复回填（reported 幂等）',
    w5.sentToBg.filter((m) => m.type === 'SENTINEL_REPORT').length === 1,
    '实际 ' + w5.sentToBg.filter((m) => m.type === 'SENTINEL_REPORT').length + ' 条');

  let failed = 0;
  for (const r of results) {
    console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.extra ? '  → ' + r.extra : ''));
    if (!r.ok) failed++;
  }
  console.log(failed === 0 ? '\n全部通过（' + results.length + ' 项）' : `\n失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
})();
