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
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__RECRUIT_FILL_RESULT__,
    });
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

/* ---------- 事件绑定 ---------- */

document.querySelector('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#btn-refresh').addEventListener('click', () => {
  if (cfg.extToken) fetchDrafts();
  else load();
});

load();
