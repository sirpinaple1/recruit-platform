/**
 * 岗位探针导出分析器
 *
 * 用法：
 *   node test/analyze-job-probe-export.cjs ~/Downloads/recruit-job-probe-*.json
 *
 * 输入：扩展 popup「诊断录制 → 导出 JSON」下来的文件。
 * 输出（三部分）：
 *   1. 录制概况：条数 / 体积 / 是否被环形缓冲截断过
 *   2. 接口清单：本次会话命中的所有端点 + 各自条数（先看「有哪些接口」）
 *   3. 岗位 ID 候选：所有「键名像岗位 ID」的标量及其出处，按出现次数排序
 *
 * 为什么要单独写这个脚本，而不是拿到 JSON 人肉翻：
 *   一次发布能录到几百条响应，人肉翻必然漏；而「岗位 ID 藏在哪个接口的哪个字段」
 *   正是路径 A 成不成立的全部依据。漏一个就等于得出错误结论。
 *
 * 判定口径（脚本只做客观归集，结论由人下）：
 *   · jobId 键名命中 + 值形态合理（正整数或 16–64 位字母数字混排）→ 记为候选
 *   · 同一个值在多个端点出现 → 更可能是真岗位 ID（埋点里不会重复出现同一个业务 ID）
 *   · 值只出现在 1 个端点且该端点不是职位相关路径 → 谨慎，可能是无关 ID
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('用法: node test/analyze-job-probe-export.cjs <导出的 JSON 路径>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error('文件不存在: ' + file);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('不是合法 JSON: ' + e.message);
  process.exit(1);
}

const records = Array.isArray(data.records) ? data.records : [];
if (!records.length) {
  console.error('导出文件里没有 records（先确认在 BOSS 页面开过录制、并做了一次发布）');
  process.exit(1);
}

/** 键名像岗位 ID 的（与后端 CollectRules.JOB_ID_KEYS 同口径 + 常见变体） */
const JOB_ID_KEY_RE = /^(jobid|job_id|encryptjobid|encrypt_job_id|jobidencrypt|securityid)$/i;
/** 岗位相关旁证键：命中说明这条响应是「岗位对象」而不是无关流量 */
const JOB_CTX_RE = /^(jobname|jobtitle|jobstatus|positionname|jobdescription|jobsalary|brandname|bossname|encryptbrandid)$/i;
/** 噪声路径：埋点/APM，Phase 0 实测占全部请求约 46%，单独统计以免淹没有效信息 */
const NOISE_PATH_RE = /\/wapi\/z(pcommon|papm)\/actionlog\/|\/wapi\/zpapm\/(actionlog|httpmetrics)\//i;
/** 发布/保存岗位的接口（真机实测：新版 BOSS 走 /wapi/zpjob/job/save）——本文件会原样 dump 它的响应 */
const PUBLISH_PATH_RE = /\/zpjob\/job\/(save|publish|add)/i;

function isNumericJobId(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && String(v).length <= 12;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^\d{1,12}$/.test(s) && Number(s) > 0;
}

function isEncryptedJobId(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 16 || s.length > 64) return false;
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) && /^[A-Za-z0-9_~-]+$/.test(s);
}

function isPlausibleJobId(v) {
  return isNumericJobId(v) || isEncryptedJobId(v);
}

function endpointOf(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch (e) {
    return String(url || '').slice(0, 120);
  }
}

const endpoints = new Map();      // pathname -> { count, noise, hasJobKey, hasJobCtx }
const jobIdHits = new Map();      // `${key} = ${value}` -> { key, value, endpoints:Set, count }

/**
 * 遍历每个「对象节点」（非数组），用于回答一个特定问题：
 * **有没有哪个对象同时带着数字形态与加密形态的岗位 ID** —— 那是两套 ID 空间之间
 * 唯一的搭桥证据。只有键扫描（不看节点）是发现不了配对的。
 */
function walkNodes(root, visit) {
  let budget = 4000;
  const seen = new Set();
  const stack = [[root, 0]];
  while (stack.length && budget-- > 0) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 30); i += 1) stack.push([node[i], depth + 1]);
      continue;
    }
    visit(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push([v, depth + 1]);
    }
  }
}

function walk(root, visit) {
  let budget = 4000;
  const seen = new Set();
  const stack = [[root, '$', 0]];
  while (stack.length && budget-- > 0) {
    const [node, path$, depth] = stack.pop();
    if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 30); i += 1) {
        visit(node[i], path$ + '[' + i + ']', i);
        if (node[i] && typeof node[i] === 'object') stack.push([node[i], path$ + '[' + i + ']', depth + 1]);
      }
      continue;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      visit(v, path$ + '.' + k, k);
      if (v && typeof v === 'object') stack.push([v, path$ + '.' + k, depth + 1]);
    }
  }
}

const pairs = new Map();        // "数字 <-> 加密" -> 出现次数
const pairEndpoints = new Map();// 同一配对的来源端点
const publishDumps = [];        // 发布/保存接口的原始响应（回答「发布时平台返回什么」）
const keyInventory = new Map(); // "keyName" -> {numeric:Set, encrypted:Set, endpoints:Set}

for (const r of records) {
  const ep = endpointOf(r.url);
  const noise = NOISE_PATH_RE.test(String(r.url || ''));
  const entry = endpoints.get(ep) || { count: 0, noise, hasJobKey: false, hasJobCtx: false };
  entry.count += 1;
  endpoints.set(ep, entry);

  if (!r.bodyText) continue;
  let body;
  try { body = JSON.parse(r.bodyText); } catch (e) { continue; }

  walk(body, (val, path$, key) => {
    if (typeof key === 'string' && JOB_CTX_RE.test(key) && val != null && val !== '') {
      entry.hasJobCtx = true;
    }
    if (typeof key === 'string' && JOB_ID_KEY_RE.test(key) && isPlausibleJobId(val)) {
      entry.hasJobKey = true;
      const value = String(val).trim();
      const id = key + ' = ' + value;
      const hit = jobIdHits.get(id) || { key, value, endpoints: new Set(), count: 0, path: path$ };
      hit.count += 1;
      hit.endpoints.add(ep);
      jobIdHits.set(id, hit);

      // 键名画像：同一个键名在不同接口里到底装的是数字还是加密形态？
      const inv = keyInventory.get(key) || { numeric: new Set(), encrypted: new Set(), endpoints: new Set() };
      if (isNumericJobId(val)) inv.numeric.add(value);
      if (isEncryptedJobId(val)) inv.encrypted.add(value);
      inv.endpoints.add(ep);
      keyInventory.set(key, inv);
    }
  });

  // ★ 双形态配对：同一个对象里同时出现数字与加密岗位 ID → 这就是两套 ID 空间的桥 ★
  walkNodes(body, (node) => {
    let num = null;
    let enc = null;
    let numKey = null;
    let encKey = null;
    for (const k of Object.keys(node)) {
      if (!JOB_ID_KEY_RE.test(k)) continue;
      const v = node[k];
      if (num === null && isNumericJobId(v)) { num = String(v).trim(); numKey = k; }
      if (enc === null && isEncryptedJobId(v)) { enc = String(v).trim(); encKey = k; }
    }
    if (num && enc && num !== enc) {
      const pair = numKey + '(' + num + ')  <->  ' + encKey + '(' + enc + ')';
      pairs.set(pair, (pairs.get(pair) || 0) + 1);
      const eps = pairEndpoints.get(pair) || new Set();
      eps.add(ep);
      pairEndpoints.set(pair, eps);
    }
  });

  // 发布/保存接口的响应原样留档 —— 这是「发布时平台到底返回什么」的唯一直接证据
  if (PUBLISH_PATH_RE.test(String(r.url || '')) && publishDumps.length < 6) {
    publishDumps.push({ url: r.url, method: r.method, status: r.status, body: String(r.bodyText || '').slice(0, 12000) });
  }
}

// ---------- 1. 概况 ----------
const meta = data.meta || {};
console.log('==================== 录制概况 ====================');
console.log('导出时间     : ' + (data.exportedAt || '-'));
console.log('扩展版本     : ' + (data.extensionVersion || '-'));
console.log('开始录制于   : ' + (meta.startedAt || '-'));
console.log('条目数       : ' + records.length);
console.log('体积         : ' + Math.round((meta.bytes || 0) / 1024) + ' KB');
if (meta.trimmed) {
  console.log('⚠️ 环形缓冲已丢弃最早 ' + meta.trimmed + ' 条 —— 若发布发生在录制早期，可能已被丢掉，建议重录一次');
}
if (meta.pageLimitHit) {
  console.log('⚠️ 页面侧命中上限并停止录制：' + JSON.stringify(meta.pageLimitHit));
}
if (meta.lastHint) {
  console.log('探针抓到的岗位提示: ' + JSON.stringify(meta.lastHint));
}

// ---------- 2. 接口清单 ----------
const eps = [...endpoints.entries()].sort((a, b) => b[1].count - a[1].count);
console.log('\n==================== 接口清单（按条数降序）====================');
console.log('条数\t岗位键\t岗位旁证\t噪声\t端点');
for (const [ep, info] of eps) {
  console.log([
    info.count,
    info.hasJobKey ? 'YES' : '-',
    info.hasJobCtx ? 'YES' : '-',
    info.noise ? 'noise' : '-',
    ep,
  ].join('\t'));
}
console.log('（噪声 = 埋点/APM 路径，实测约占全部请求 46%，看结论时可忽略）');

// ---------- 3. 岗位 ID 候选 ----------
const hits = [...jobIdHits.values()].sort((a, b) => b.count - a.count || b.endpoints.size - a.endpoints.size);
console.log('\n==================== 岗位 ID 候选 ====================');
if (!hits.length) {
  console.log('❌ 一条都没录到。');
  console.log('   结论方向：路径 A 的「从响应体自动捕获」不成立，需改用其它捕获点（URL / 已发布岗位列表）或只靠人工绑定。');
  console.log('   先确认三件事：① 录制是在发布【之前】开的吗？② 发布后有没有刷新职位列表页？');
  console.log('   ③ popup 里条目数是否明显 >0（为 0 说明脚本没注进去或页面不是 zhipin 域）。');
} else {
  for (const h of hits) {
    console.log('- ' + h.key + ' = ' + h.value);
    console.log('    出现 ' + h.count + ' 次，端点 ' + h.endpoints.size + ' 个：' + [...h.endpoints].join(', '));
  }
  console.log('\n判读建议：');
  console.log('  · 在【多个】端点反复出现的值 → 最可能是真岗位 ID，写进 CollectRules.JOB_ID_KEYS 即可让路径 A 生效');
  console.log('  · 只出现 1 次且端点与职位无关 → 谨慎，可能是列表里的其它岗位或无关 ID');
  console.log('  · 若候选里出现多个不同值 → 该接口返回的是【岗位列表】而非当前岗位，需要配合「最近创建」或标题匹配，不能直接取第一个');
}

console.log('\n==================== 键名画像（同一个键名装的是什么形态）====================');
const invs = [...keyInventory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [k, inv] of invs) {
  console.log('- ' + k
    + '  数字形态 ' + inv.numeric.size + ' 个'
    + ' / 加密形态 ' + inv.encrypted.size + ' 个'
    + '  端点 ' + inv.endpoints.size + ' 个');
  if (inv.numeric.size) console.log('    数字样例: ' + [...inv.numeric].slice(0, 3).join(', '));
  if (inv.encrypted.size) console.log('    加密样例: ' + [...inv.encrypted].slice(0, 3).join(', '));
}
console.log('（若同一个键名在不同接口里既装数字又装加密 → 该键**不能**当稳定标识，必须按形态分别处理）');

console.log('\n==================== 双形态配对（两套 ID 空间的桥）====================');
const ps = [...pairs.entries()].sort((a, b) => b[1] - a[1]);
if (!ps.length) {
  console.log('❌ 没有找到任何「同一对象里同时含数字与加密岗位 ID」的配对。');
  console.log('   含义：本段录制里两套 ID 空间没有同框出现 → 无法直接建翻译表，');
  console.log('   需要另找桥（例如按岗位名+发布时间对齐，或向平台再要一次含两种形态的接口）。');
} else {
  console.log('✅ 找到 ' + ps.length + ' 组配对（可用于建「数字 ↔ 加密」翻译表）：');
  ps.slice(0, 20).forEach(([pair, n]) => {
    console.log('  ' + pair + '   出现' + n + '次  端点: ' + [...(pairEndpoints.get(pair) || [])].join(', '));
  });
}

console.log('\n==================== 发布/保存接口的原始响应 ====================');
if (!publishDumps.length) {
  console.log('❌ 本段录制里没有命中发布/保存接口（' + PUBLISH_PATH_RE + '）');
  console.log('   含义：要么发布动作发生在录制之外，要么该平台的发布接口路径不在这个正则里 —— ');
  console.log('   请到「接口清单」里找形如 .../job/... 且只有 1 条的 POST 端点，把路径加进 PUBLISH_PATH_RE。');
} else {
  publishDumps.forEach((d, i) => {
    console.log('--- #' + (i + 1) + ' ' + d.method + ' ' + d.url);
    console.log('    status=' + d.status + '  body长度=' + d.body.length);
    console.log('    ' + d.body.slice(0, 3000).replace(/\s+/g, ' '));
  });
  console.log('\n判读：这个接口的响应里若出现岗位 ID，它就是「发布后自动关联」应该取的字段；');
  console.log('      注意区分它给的是**数字**还是**加密**形态 —— 采集侧拿到的是数字形态，');
  console.log('      两者不等时映射永远解析不到（真机已实测到这一现象）。');
}

console.log('\n提示：把这份输出连同导出文件一起给 AI，可直接据此定 CollectRules.JOB_ID_KEYS。');
