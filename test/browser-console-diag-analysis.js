/**
 * 浏览器控制台一段式诊断分析（Service Worker DevTools 专用）
 *
 * 用法：chrome://extensions → 招聘发布助手 → 点「Service Worker」→ 打开 Console
 *      → 粘贴本文件 `── 粘贴以下内容 ──` 以下的整段 → 把控制台输出发回来。
 *
 * 为什么需要它：
 *   · `copy()` 属于 DevTools **命令行 API**，Service Worker 的 console 里没有它
 *     （实测报 `ReferenceError: copy is not defined`），所以不能靠它把数据带出来。
 *   · popup 的「导出」依赖 popup 保持打开，大 JSON 的 blob 下载可能没起来。
 *   本片段把「读取 → 解析 → 归集」全在 worker 里做完，只吐一份**人能读、也能直接发回**
 *   的报告 —— 不需要文件传输，也不需要剪贴板权限。
 *
 * 本文件同时可被 node 当模块跑（自带 stub），用于自测，避免给用户一段会报错的代码：
 *   node test/browser-console-diag-analysis.js
 */

/* ────────── 粘贴以下内容 ────────── */
const DIAG_ANALYZE = () => chrome.storage.session.get(['diag_records', 'diag_meta']).then((d) => {
  const recs = d.diag_records || [];
  const meta = d.diag_meta || {};

  // 与后端 CollectRules.JOB_ID_KEYS 同口径 + 常见变体
  const JOB = /^(jobid|job_id|encryptjobid|encrypt_job_id|jobidencrypt|securityid)$/i;
  // 「这条响应是岗位对象」的旁证键
  const CTX = /^(jobname|jobtitle|jobstatus|positionname|jobdescription|jobsalary|brandname|bossname|encryptbrandid)$/i;
  // 埋点/APM 噪声路径（实测约占全部请求 46%）
  const NOISE = /\/wapi\/z(pcommon|papm)\/actionlog\/|\/wapi\/zpapm\/(actionlog|httpmetrics)\//i;

  const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return String(u || '').slice(0, 80); } };

  const epMap = new Map();   // pathname -> {n, job, ctx, noise}
  const hits = new Map();    // "key=value" -> {n, eps:Set}
  const hosts = new Map();   // host -> n（判断有没有跨域资源）
  const inv = new Map();     // 键名画像：keyName -> {num:Set, enc:Set, eps:Set}
  const pairs = new Map();   // "数字 <-> 加密" -> {n, eps:Set}
  const pubDumps = [];       // 发布/保存接口的响应（回答「发布时平台返回什么」）

  const PUBLISH_RE = /\/zpjob\/job\/(save|publish|add)/i;

  const isNum = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 && String(v).length <= 12;
    if (typeof v !== 'string') return false;
    const s = v.trim();
    return /^\d{1,12}$/.test(s) && Number(s) > 0;
  };
  const isEnc = (v) => {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s.length < 16 || s.length > 64) return false;
    return /[0-9]/.test(s) && /[A-Za-z]/.test(s) && /^[A-Za-z0-9_~-]+$/.test(s);
  };

  const walk = (node, depth, ep) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    // 先看「本对象自己」带没带双形态岗位 ID —— 这是两套 ID 空间唯一可搭桥的证据，
    // 只有键扫描（不看节点归组）是发现不了的。
    let num = null;
    let enc = null;
    let numKey = null;
    let encKey = null;
    for (const k of Object.keys(node)) {
      if (typeof k !== 'string' || !JOB.test(k)) continue;
      const v = node[k];
      if (num === null && isNum(v)) { num = String(v).trim(); numKey = k; }
      if (enc === null && isEnc(v)) { enc = String(v).trim(); encKey = k; }
    }
    if (num && enc && num !== enc) {
      const p = numKey + '(' + num + ') <-> ' + encKey + '(' + enc + ')';
      const rec = pairs.get(p) || { n: 0, eps: new Set() };
      rec.n += 1;
      rec.eps.add(ep);
      pairs.set(p, rec);
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      const e = epMap.get(ep);
      if (e && typeof k === 'string') {
        if (JOB.test(k) && (isNum(v) || isEnc(v))) {
          e.job = true;
          const id = k + ' = ' + String(v).trim();
          const h = hits.get(id) || { n: 0, eps: new Set() };
          h.n += 1;
          h.eps.add(ep);
          hits.set(id, h);

          const iv = inv.get(k) || { num: new Set(), enc: new Set(), eps: new Set() };
          if (isNum(v)) iv.num.add(String(v).trim());
          if (isEnc(v)) iv.enc.add(String(v).trim());
          iv.eps.add(ep);
          inv.set(k, iv);
        }
        if (CTX.test(k) && v != null && v !== '') e.ctx = true;
      }
      if (v && typeof v === 'object') walk(v, depth + 1, ep);
    }
  };

  for (const r of recs) {
    const ep = pathOf(r.url);
    const e = epMap.get(ep) || { n: 0, job: false, ctx: false, noise: NOISE.test(String(r.url || '')) };
    e.n += 1;
    epMap.set(ep, e);
    try {
      const h = new URL(r.url).host;
      hosts.set(h, (hosts.get(h) || 0) + 1);
    } catch (err) { /* ignore */ }
    if (!r.bodyText) continue;
    let body;
    try { body = JSON.parse(r.bodyText); } catch (err) { continue; }
    walk(body, 0, ep);
    // 发布/保存接口的响应原样留档 —— 「发布时平台返回什么」的唯一直接证据
    if (PUBLISH_RE.test(String(r.url || '')) && pubDumps.length < 5) {
      pubDumps.push({ url: r.url, method: r.method, status: r.status,
                      body: String(r.bodyText || '').slice(0, 2000).replace(/\s+/g, ' ') });
    }
  }

  const line = '─'.repeat(60);
  console.log('%c' + line, 'color:#888');
  console.log('%c录制概况', 'font-weight:bold');
  console.log('  条数=' + recs.length
    + '  体积KB=' + Math.round((meta.bytes || 0) / 1024)
    + '  trimmed=' + (meta.trimmed || 0)
    + (meta.trimmed ? '  ⚠️ 环形缓冲丢过最早的条目' : ''));
  console.log('  startedAt=' + (meta.startedAt || '-') + '  updatedAt=' + (meta.updatedAt || '-'));
  console.log('  lastHint=' + JSON.stringify(meta.lastHint || null));
  if (meta.pageLimitHit) console.log('  ⚠️ 页面侧到过上限并停录=' + JSON.stringify(meta.pageLimitHit));
  console.log('  域名分布=' + [...hosts.entries()].map(([h, n]) => h + '×' + n).join(', '));

  console.log('%c接口清单（条数 / 岗位键 / 岗位旁证 / 噪声 / 路径）', 'font-weight:bold');
  const eps = [...epMap.entries()].sort((a, b) => b[1].n - a[1].n);
  eps.slice(0, 60).forEach(([p, i]) => {
    console.log('  ' + String(i.n).padStart(4) + '  '
      + (i.job ? 'JOBKEY' : '  -   ') + '  '
      + (i.ctx ? ' CTX ' : '  -  ') + '  '
      + (i.noise ? 'noise' : '  -  ') + '  ' + p);
  });
  if (eps.length > 60) console.log('  …（还有 ' + (eps.length - 60) + ' 个端点未显示）');

  console.log('%c岗位 ID 候选（按出现次数降序）', 'font-weight:bold');
  const hs = [...hits.entries()].sort((a, b) => b[1].n - a[1].n || b[1].eps.size - a[1].eps.size);
  if (!hs.length) {
    console.log('  ❌ 一条都没录到 —— 路径 A 的「响应体自动捕获」不成立');
  } else {
    hs.slice(0, 30).forEach(([id, h]) => {
      console.log('  ' + id + '   出现' + h.n + '次 / 端点' + h.eps.size + '个: ' + [...h.eps].join(', '));
    });
  }
  console.log('%c键名画像（同一键名装的是什么形态）', 'font-weight:bold');
  const invs = [...inv.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  invs.forEach(([k, v]) => {
    console.log('  ' + k + '  数字 ' + v.num.size + ' 个 / 加密 ' + v.enc.size + ' 个  端点 ' + v.eps.size + ' 个');
    if (v.num.size) console.log('      数字样例: ' + [...v.num].slice(0, 3).join(', '));
    if (v.enc.size) console.log('      加密样例: ' + [...v.enc].slice(0, 3).join(', '));
  });
  console.log('  （同一个键名在不同接口里既装数字又装加密 → 该键不能当稳定标识）');

  console.log('%c双形态配对（两套 ID 空间的桥）', 'font-weight:bold');
  const ps = [...pairs.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!ps.length) {
    console.log('  ❌ 没有任何「同一对象同时含数字与加密岗位 ID」的配对');
    console.log('     → 无法直接建翻译表，需另找桥（按岗位名+时间对齐等）');
  } else {
    console.log('  ✅ 找到 ' + ps.length + ' 组配对：');
    ps.slice(0, 20).forEach(([p, v]) => {
      console.log('    ' + p + '   出现' + v.n + '次  端点: ' + [...v.eps].join(', '));
    });
  }

  console.log('%c发布/保存接口的原始响应', 'font-weight:bold');
  if (!pubDumps.length) {
    console.log('  ❌ 没有命中发布/保存接口（' + PUBLISH_RE + '）');
    console.log('     请到上面接口清单里找形如 .../job/... 且只有 1 条的 POST 端点');
  } else {
    pubDumps.forEach((d, i) => {
      console.log('  --- #' + (i + 1) + ' ' + d.method + ' ' + d.url + '  status=' + d.status);
      console.log('      ' + d.body.slice(0, 1200));
    });
    console.log('  判读：这个接口响应里的岗位 ID 就是「发布后自动关联」该取的字段；');
    console.log('        注意它是**数字**还是**加密**形态 —— 采集侧拿到的是数字形态，');
    console.log('        两者不等时映射永远解析不到（真机已实测到这一现象）。');
  }

  console.log('%c' + line, 'color:#888');
  console.log('把以上输出整段发回即可（不含任何候选人 PII，只有接口路径与岗位 ID）。');
  return { count: recs.length, candidates: hs.length, pairs: ps.length, publishes: pubDumps.length };
});
// 浏览器里 chrome 一定存在；node 自测时先跳过，由下面的 stub 块显式调用
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
  DIAG_ANALYZE();
}
/* ────────── 粘贴到此为止 ────────── */

// ── 下面是 node 自测用的 stub（浏览器里不会执行）──
if (typeof module !== 'undefined' && require.main === module) {
  // 样本刻意贴近 2026-09-22 真机实测形态：数字形态在聊天/候选人侧、加密形态在职位管理侧、
  // job/save 返回的键名是 jobId 但值是加密形态 —— 四种情况都要能被识别出来
  const fake = {
    meta: {
      startedAt: '2026-09-22T06:19:33.131Z', bytes: 3066880, trimmed: 0,
      lastHint: { jobId: '352f92eda67db1080nN_3t29FFNR', keyName: 'encryptJobId', strong: true },
    },
    records: [
      {
        url: 'https://www.zhipin.com/wapi/zpjob/job/save', method: 'POST', status: 200,
        bodyText: '{"code":0,"zpData":{"jobId":"a5d0bf426e1373a90nN92dS_F1RX","jobName":"测试岗位"}}',
      },
      {
        url: 'https://www.zhipin.com/wapi/zpjob/job/data/list?page=1', method: 'GET', status: 200,
        bodyText: '{"code":0,"zpData":{"list":[{"jobId":575500411,"encryptJobId":"a5d0bf426e1373a90nN92dS_F1RX","jobName":"Java工程师","jobStatus":1}]}}',
      },
      {
        url: 'https://www.zhipin.com/wapi/zprelation/friend/getBossFriendListV2.json', method: 'GET', status: 200,
        bodyText: '{"code":0,"zpData":{"friendList":[{"jobId":575500411,"name":"某候选人"}]}}',
      },
      {
        url: 'https://www.zhipin.com/wapi/zpCommon/actionLog/common.json', method: 'POST', status: 200,
        bodyText: '{"code":0}',
      },
      { url: 'https://static.zhipin.com/assets/x.svg', method: 'GET', status: 200, bodyText: '' },
    ],
  };
  global.chrome = {
    storage: { session: { get: () => Promise.resolve({ diag_records: fake.records, diag_meta: fake.meta }) } },
  };
  module.exports = DIAG_ANALYZE;
  DIAG_ANALYZE().then((r) => console.log('\n自测返回:', JSON.stringify(r)));
}
