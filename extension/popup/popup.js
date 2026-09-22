/**
 * 招聘发布助手 · popup（设计文档 §7 popup 流）：
 * 拉草稿列表 → 选草稿 → 打开渠道发布页 → 两步注入引擎填充 → 人工核对提交
 * → 标记已发布/失败 → 调回填接口 → 台账闭环。
 *
 * 红线 1：扩展只做表单预填充，绝不自动点击平台提交按钮（提交必须是人的手）；
 * 红线 4：不上传平台页面内容，回填仅提交状态与备注文本。
 */
'use strict';

const listEl = document.querySelector('#list');
const bannerEl = document.querySelector('#banner');
const connEl = document.querySelector('#conn');

const cfg = { baseUrl: '', extToken: '' };

/* ---------- 通用 UI ---------- */

function showBanner(text, withSettingsLink) {
  bannerEl.hidden = false;
  bannerEl.className = 'banner err';
  bannerEl.textContent = text;
  if (withSettingsLink) {
    const link = document.createElement('span');
    link.className = 'banner-btn';
    link.textContent = '打开配置页';
    link.addEventListener('click', () => chrome.runtime.openOptionsPage());
    bannerEl.appendChild(link);
  }
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.textContent = '';
}

function renderEmpty(text) {
  listEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  listEl.appendChild(div);
}

/* ---------- 配置与草稿列表 ---------- */

async function load() {
  const local = await chrome.storage.local.get('baseUrl');
  const session = await chrome.storage.session.get('extToken');
  cfg.baseUrl = local.baseUrl || 'http://localhost:6017';
  cfg.extToken = session.extToken || '';
  if (!cfg.extToken) {
    connEl.hidden = false;
    connEl.textContent = '未配置';
    renderEmpty('尚未配置扩展授权 Token');
    showBanner('请先在配置页粘贴管理端「扩展授权」生成的 Token', true);
    return;
  }
  await fetchDrafts();
}

async function fetchDrafts() {
  hideBanner();
  connEl.hidden = false;
  connEl.textContent = '加载中…';
  let resp;
  try {
    resp = await fetch(cfg.baseUrl + '/api/ext/drafts', {
      headers: { 'X-Extension-Token': cfg.extToken },
    });
  } catch (err) {
    connEl.textContent = '后端不可达';
    renderEmpty('无法连接后端：' + err.message);
    return;
  }
  if (resp.status === 401) {
    connEl.textContent = 'Token 失效';
    renderEmpty('Token 无效或已吊销');
    showBanner('Token 无效或已吊销，请在管理端重新生成并到配置页更新', true);
    return;
  }
  if (!resp.ok) {
    connEl.textContent = 'HTTP ' + resp.status;
    renderEmpty('拉取草稿失败：HTTP ' + resp.status);
    return;
  }
  const body = await resp.json();
  const drafts = Array.isArray(body.data) ? body.data : [];
  connEl.textContent = drafts.length ? drafts.length + ' 条待发布' : '';
  renderDrafts(drafts);
}

/* ---------- 渲染 ---------- */

function renderDrafts(drafts) {
  listEl.innerHTML = '';
  if (!drafts.length) {
    renderEmpty('暂无待发布草稿');
    return;
  }
  for (const d of drafts) listEl.appendChild(draftCard(d));
}

function draftCard(d) {
  const card = document.createElement('div');
  card.className = 'draft';

  const head = document.createElement('div');
  head.className = 'draft-head';
  const title = document.createElement('span');
  title.className = 'draft-title';
  title.textContent = d.title || '(无标题)';
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = d.channelName || d.channelCode || '';
  head.append(title, chip);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = (d.requestNo || '') + (d.recordId ? ' · 台账 ' + d.recordId : '');

  const reportEl = document.createElement('div');
  reportEl.className = 'report';
  reportEl.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btnFill = document.createElement('button');
  btnFill.className = 'primary';
  btnFill.type = 'button';
  btnFill.textContent = '去发布页填充';
  const btnPublished = document.createElement('button');
  btnPublished.type = 'button';
  btnPublished.textContent = '标记已发布';
  btnPublished.hidden = true;
  const btnFailed = document.createElement('button');
  btnFailed.className = 'danger';
  btnFailed.type = 'button';
  btnFailed.textContent = '标记失败';
  btnFailed.hidden = true;
  actions.append(btnFill, btnPublished, btnFailed);

  card.append(head, meta, reportEl, actions);

  btnFill.addEventListener('click', () => fillDraft(d, { btnFill, reportEl, btnPublished }));
  btnPublished.addEventListener('click', () => showReportForm('published', card, d, btnPublished, btnFailed));
  btnFailed.addEventListener('click', () => showReportForm('failed', card, d, btnPublished, btnFailed));
  return card;
}

/* ---------- 填充（两步注入，引擎自动执行模式） ---------- */

async function fillDraft(d, ui) {
  ui.btnFill.disabled = true;
  ui.btnFill.textContent = '正在填充…';
  try {
    const tab = await openPublishPage(d.publishUrlPattern);
    if (!tab) {
      ui.btnFill.disabled = false;
      ui.btnFill.textContent = '去发布页填充';
      return;
    }
    const fieldMap = d.fieldMapJson || {};
    const config = {
      fields: fieldMap.fields || [],
      selectors: fieldMap.selectors || {},
      values: d.fieldsJson || {},
    };
    // 第一步：放置配置（引擎注入时检测到即自动执行）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => {
        window.__RECRUIT_FILL_CONFIG__ = c;
        window.__RECRUIT_FILL_RESULT__ = null;
      },
      args: [config],
    });
    // 第二步：注入引擎源码（IIFE 内自动 runFill 并落 __RECRUIT_FILL_RESULT__）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/fill-engine.js'],
    });
    // 引擎为异步顺序填充（下拉点选/推荐等待需数秒），轮询结果而非单次读取
    const result = await pollFillResult(tab.id, 30000);
    renderFillReport(ui.reportEl, result);
    if (result && result.summary && result.summary.failed === 0 && result.summary.filled > 0) {
      ui.btnPublished.hidden = false;
    }
    ui.btnFill.textContent = '重新填充';
  } catch (err) {
    ui.reportEl.hidden = false;
    ui.reportEl.textContent = '填充失败：' + err.message;
  } finally {
    ui.btnFill.disabled = false;
  }
}

/** 轮询页面上的填充结果（引擎异步顺序填充，完成后落 __RECRUIT_FILL_RESULT__） */
async function pollFillResult(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__RECRUIT_FILL_RESULT__,
      });
      if (result && result.summary) return result;
    } catch {
      // tab 可能正在导航，继续轮询
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function renderFillReport(reportEl, result) {
  reportEl.hidden = false;
  if (!result || !result.summary) {
    reportEl.textContent = '未获取到填充结果';
    return;
  }
  const s = result.summary;
  reportEl.innerHTML = '';
  const line = document.createElement('div');
  line.innerHTML =
    '填充 <span class="num-ok">' + s.filled + '</span> / ' + s.total +
    ' · 跳过 <span class="num-warn">' + s.skipped + '</span>' +
    ' · 失败 <span class="num-err">' + s.failed + '</span>';
  reportEl.appendChild(line);
  const bad = [].concat(result.failed || [], result.skipped || []);
  if (bad.length) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = '未处理字段：' + bad.map((x) => x.key + '(' + x.reason + ')').join('、');
    reportEl.appendChild(detail);
  }
}

async function openPublishPage(pattern) {
  if (!pattern) {
    showBanner('该渠道未配置发布页地址（publish_url_pattern）', false);
    return null;
  }
  if (!pattern.includes('*')) {
    const tab = await chrome.tabs.create({ url: pattern, active: true });
    await waitTabComplete(tab.id);
    return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && matchUrl(active.url, pattern)) return active;
  showBanner('请先打开该渠道的发布页，再点「去发布页填充」', false);
  return null;
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

/** 简单通配匹配：pattern 中的 * 视作任意串 */
function matchUrl(url, pattern) {
  try {
    const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(url || '');
  } catch {
    return false;
  }
}

/* ---------- 回填（标记已发布 / 失败） ---------- */

function showReportForm(kind, card, d, btnPublished, btnFailed) {
  card.querySelector('.report-form')?.remove();
  const form = document.createElement('form');
  form.className = 'report-form';
  if (kind === 'published') {
    form.innerHTML =
      '<input name="publishedUrl" placeholder="发布链接（选填）" spellcheck="false">' +
      '<input name="accountLabel" placeholder="账号标识，如 BOSS-招聘专员01（选填）">' +
      '<div class="form-actions"><button type="submit" class="primary">确认已发布</button>' +
      '<button type="button" class="cancel">取消</button></div>';
  } else {
    form.innerHTML =
      '<input name="resultNote" placeholder="失败原因（选填）">' +
      '<input name="accountLabel" placeholder="账号标识（选填）">' +
      '<div class="form-actions"><button type="submit" class="danger">确认失败</button>' +
      '<button type="button" class="cancel">取消</button></div>';
  }
  form.querySelector('.cancel').addEventListener('click', () => form.remove());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitReport(kind, new FormData(form), d, card, btnPublished, btnFailed);
  });
  card.appendChild(form);
  form.querySelector('input').focus();
}

async function submitReport(kind, fd, d, card, btnPublished, btnFailed) {
  const payload = { status: kind };
  const accountLabel = String(fd.get('accountLabel') || '').trim();
  const publishedUrl = String(fd.get('publishedUrl') || '').trim();
  const resultNote = String(fd.get('resultNote') || '').trim();
  if (accountLabel) payload.accountLabel = accountLabel;
  if (kind === 'published' && publishedUrl) payload.publishedUrl = publishedUrl;
  if (kind === 'failed' && resultNote) payload.resultNote = resultNote;

  btnPublished.disabled = true;
  btnFailed.disabled = true;
  let resp;
  try {
    resp = await fetch(cfg.baseUrl + '/api/ext/records/' + d.recordId + '/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': cfg.extToken },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    showBanner('回填请求失败：' + err.message, false);
    btnPublished.disabled = false;
    btnFailed.disabled = false;
    return;
  }
  if (resp.status === 401) {
    showBanner('Token 无效或已吊销，请在管理端重新生成并到配置页更新', true);
    btnPublished.disabled = false;
    btnFailed.disabled = false;
    return;
  }
  if (!resp.ok) {
    showBanner('回填失败：HTTP ' + resp.status + '（若已回填过，刷新列表即可）', false);
    btnPublished.disabled = false;
    btnFailed.disabled = false;
    return;
  }
  card.querySelector('.report-form')?.remove();
  const done = document.createElement('div');
  done.className = 'done';
  done.textContent = kind === 'published' ? '已回填：发布成功' : '已回填：发布失败';
  card.appendChild(done);
  setTimeout(fetchDrafts, 800);
}

/* ---------- 诊断录制（岗位 ID 取证） ---------- */

/**
 * 用途：BOSS 到底在哪个接口、哪个字段给出「这次发布的是哪个岗位」是未经验证的平台行为。
 * 路径 A 若只靠猜键表就是赌博 —— 这里让人做一次真机发布、把响应全录下来，事后离线翻查。
 *
 * 合规：默认关闭；数据只落 chrome.storage.session（本地、会话级）；
 *      **不自动外发任何一条**，只有人点「导出」才下载成文件。
 */

const diagEl = {
  status: document.querySelector('#diag-status'),
  msg: document.querySelector('#diag-msg'),
  start: document.querySelector('#btn-diag-start'),
  stop: document.querySelector('#btn-diag-stop'),
  export: document.querySelector('#btn-diag-export'),
  copy: document.querySelector('#btn-diag-copy'),
  clear: document.querySelector('#btn-diag-clear'),
};

function diagMsg(text, kind) {
  diagEl.msg.hidden = !text;
  diagEl.msg.className = 'diag-msg' + (kind ? ' ' + kind : '');
  diagEl.msg.textContent = text || '';
}

function fmtKb(bytes) {
  if (!bytes) return '0 KB';
  return bytes < 1024 * 1024
    ? Math.round(bytes / 1024) + ' KB'
    : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function diagRefresh() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'DIAG_STATUS' });
    if (!s || !s.ok) {
      diagEl.status.textContent = '状态读取失败';
      return;
    }
    diagEl.status.textContent = (s.recording ? '录制中 · ' : '未开始 · ')
      + s.count + ' 条 / ' + fmtKb(s.bytes)
      + (s.recording && !s.registered ? ' · ⚠️ 脚本未注册' : '')
      + (s.trimmed ? '（已丢弃最早 ' + s.trimmed + ' 条）' : '');
    diagEl.status.className = 'diag-status' + (s.recording ? ' on' : '');
  } catch (e) {
    diagEl.status.textContent = '状态读取失败';
  }
}

/** 取当前活动 tab；录制必须在 zhipin 页面上才有意义 */
async function activeZhipinTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) return null;
  if (!/^https?:\/\/([^/]*\.)?zhipin\.com\//.test(tab.url || '')) return null;
  return tab;
}

diagEl.start.addEventListener('click', async () => {
  diagMsg('');
  const tab = await activeZhipinTab();
  if (!tab) {
    diagMsg('请先切到 BOSS 页面再点开始录制（录制只在该页生效）', 'err');
    return;
  }
  diagEl.start.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DIAG_START', payload: { tabId: tab.id } });
    if (!r || !r.ok) {
      diagMsg('启动失败：' + ((r && r.error) || '未知错误'), 'err');
      return;
    }
    diagMsg(r.injected
      ? '已开始录制：当前页面已注入，且之后打开的每个 BOSS 页面都会自动带上探针。'
        + '现在正常发一次岗位，完成后回来点「导出 JSON」。'
      : '录制开关已打开，但当前页面注入未全部成功 —— 当前页可能录不到（刷新该页即可，'
        + '之后加载的页面不受影响）。',
      r.injected ? 'ok' : 'err');
    await diagRefresh();
  } catch (e) {
    diagMsg('启动失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    diagEl.start.disabled = false;
  }
});

diagEl.stop.addEventListener('click', async () => {
  diagEl.stop.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DIAG_STOP' });
    diagMsg(r && r.ok ? ('已停止，共录到 ' + r.count + ' 条，可导出。') : '停止失败', r && r.ok ? 'ok' : 'err');
    await diagRefresh();
  } catch (e) {
    diagMsg('停止失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    diagEl.stop.disabled = false;
  }
});

diagEl.clear.addEventListener('click', async () => {
  diagEl.clear.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'DIAG_CLEAR' });
    diagMsg('已清空录制内容。');
    await diagRefresh();
  } catch (e) {
    diagMsg('清空失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    diagEl.clear.disabled = false;
  }
});

diagEl.export.addEventListener('click', async () => {
  diagEl.export.disabled = true;
  try {
    const data = await chrome.runtime.sendMessage({ type: 'DIAG_EXPORT' });
    if (!data || !data.ok) {
      diagMsg('导出失败：' + ((data && data.error) || '未知错误'), 'err');
      return;
    }
    if (!data.count) {
      diagMsg('还没有录到内容。先点「开始录制」，然后在 BOSS 页面操作。', 'err');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recruit-job-probe-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会打断下载，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    diagMsg('已导出 ' + data.count + ' 条到下载目录。', 'ok');
  } catch (e) {
    diagMsg('导出失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    diagEl.export.disabled = false;
  }
});

// 录制时条数在涨，popup 开着就 2s 刷一次状态（popup 关掉自然停）
setInterval(diagRefresh, 2000);
void diagRefresh();

/**
 * 导出兜底：把 JSON 放进剪贴板。
 *
 * 为什么必须有这一条：popup 是个**会被点击外部就关闭**的页面，
 * 而大文件的 blob 下载要等浏览器接手下发；popup 一关，下载有可能没起来，
 * 表现成「点了导出但下载目录里什么都没有」—— 实测就卡在这一步。
 * 剪贴板是同步写入的，不依赖页面活着；拿到文本后粘进任意文件即可。
 */
diagEl.copy.addEventListener('click', async () => {
  diagEl.copy.disabled = true;
  try {
    const data = await chrome.runtime.sendMessage({ type: 'DIAG_EXPORT' });
    if (!data || !data.ok || !data.count) {
      diagMsg('没有可复制的内容（先开始录制并在 BOSS 页面操作）', 'err');
      return;
    }
    const text = JSON.stringify(data);
    await navigator.clipboard.writeText(text);
    diagMsg('已复制 ' + data.count + ' 条（' + Math.round(text.length / 1024)
      + ' KB）到剪贴板。粘到一个 .json 文件里即可。', 'ok');
  } catch (e) {
    diagMsg('复制失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    diagEl.copy.disabled = false;
  }
});

/* ---------- 事件绑定 ---------- */

document.querySelector('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#btn-refresh').addEventListener('click', () => {
  if (cfg.extToken) fetchDrafts();
  else load();
});

load();
