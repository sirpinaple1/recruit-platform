/**
 * 招聘发布助手 · 配置页逻辑（见设计文档 §7）：
 * - 后端地址：chrome.storage.local（持久，重启浏览器保留）
 * - 扩展 token：chrome.storage.session（会话级，重启浏览器自动清除——安全优先，有意为之）
 * - 测试连接：GET {baseUrl}/api/ext/drafts（X-Extension-Token），用输入框当前值即时验证
 */
'use strict';

const baseUrlInput = document.querySelector('#base-url');
const extTokenInput = document.querySelector('#ext-token');
const statusBox = document.querySelector('#status');
const form = document.querySelector('#config-form');

const DEFAULT_BASE_URL = 'http://localhost:6017';

/** 归一化后端地址：去首尾空白与尾部斜杠 */
function normalizeBaseUrl(raw) {
  return raw.trim().replace(/\/+$/, '');
}

function setStatus(text, type) {
  statusBox.hidden = false;
  statusBox.textContent = text;
  statusBox.className = 'status ' + type;
}

/** 打开页面时回显已存配置（session token 若还在则回显） */
async function load() {
  const local = await chrome.storage.local.get('baseUrl');
  const session = await chrome.storage.session.get('extToken');
  baseUrlInput.value = local.baseUrl || DEFAULT_BASE_URL;
  extTokenInput.value = session.extToken || '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  const extToken = extTokenInput.value.trim();
  await chrome.storage.local.set({ baseUrl });
  if (extToken) {
    await chrome.storage.session.set({ extToken });
  } else {
    await chrome.storage.session.remove('extToken');
  }
  baseUrlInput.value = baseUrl;
  setStatus('已保存（token 存于当前浏览器会话，关闭浏览器后需重新粘贴）', 'ok');
});

document.querySelector('#btn-test').addEventListener('click', async () => {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  const extToken = extTokenInput.value.trim();
  if (!extToken) {
    setStatus('请先粘贴扩展授权 token', 'err');
    return;
  }
  setStatus('正在连接 ' + baseUrl + ' …', 'info');
  try {
    const resp = await fetch(baseUrl + '/api/ext/drafts', {
      headers: { 'X-Extension-Token': extToken },
    });
    if (resp.ok) {
      const body = await resp.json();
      const count = Array.isArray(body.data) ? body.data.length : 0;
      setStatus('连接成功，当前待发布草稿 ' + count + ' 条', 'ok');
    } else if (resp.status === 401) {
      setStatus('Token 无效或已吊销，请在管理端重新生成', 'err');
    } else {
      setStatus('后端响应异常：HTTP ' + resp.status, 'err');
    }
  } catch (err) {
    setStatus('无法连接后端（' + err.message + '），请检查地址与后端服务', 'err');
  }
});

load();
