/**
 * 招聘助手 · 简历采集 · 页面内采集按钮（ISOLATED world）
 *
 * 为什么是「页面内的浮层按钮」而不是只在 popup 里操作：
 * HR 正在看哪个候选人就采哪个，是最贴近「逐条、主动、可审计」的形态
 * （框架 §6 红线第 1 条）。在 popup 里让 HR 从列表挑，既别扭又容易滑向批量选择。
 *
 * 用 Shadow DOM 承载 UI：BOSS 页面样式复杂且有全局重置，
 * 直接插 DOM 一定会被影响；Shadow DOM 把样式彻底隔离。
 *
 * 只在顶层帧渲染：iframe 里出现按钮会让 HR 分不清点在哪个上下文，
 * 而采集本身会由 background 广播到所有帧去取数据（iframe 才是数据所在的地方）。
 */
(() => {
  'use strict';

  let isTop = false;
  try { isTop = window.top === window; } catch (e) { isTop = false; }
  if (!isTop) return;

  /** 按当前路径推断采集场景与来源渠道（口径与后端 CollectRules 一致） */
  function inferContext() {
    const p = (() => { try { return location.pathname; } catch (e) { return ''; } })();
    if (p.indexOf('/bzl-office/pdf-viewer') === 0) return { scene: 'attach', sourceChannel: 'chat' };
    if (p.indexOf('/web/frame/c-resume') === 0) return { scene: 'detail', sourceChannel: 'chat' };
    if (p.indexOf('/web/frame/recommend') === 0 || p.indexOf('recommend') >= 0) {
      // 推荐牛人：我方主动发信息给平台推荐的候选人
      return { scene: 'list', sourceChannel: 'recommend' };
    }
    return { scene: 'chat', sourceChannel: 'chat' };
  }

  const host = document.createElement('div');
  host.id = '__recruit_collect_host__';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:20px;bottom:24px;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      .wrap { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .btn {
        display:flex; align-items:center; gap:8px;
        padding:10px 16px; border:none; border-radius:24px; cursor:pointer;
        background:#2b5fd9; color:#fff; font-size:14px; font-weight:500;
        box-shadow:0 4px 14px rgba(15,23,42,.24); transition:background .15s;
      }
      .btn:hover { background:#2450bb; }
      .btn:disabled { background:#8ea6dd; cursor:default; }
      .dot { width:8px; height:8px; border-radius:50%; background:#7ee2a8; flex:0 0 auto; }
      .btn:disabled .dot { background:#dbe4f6; }
      .toast {
        position:fixed; right:20px; bottom:78px; max-width:360px;
        padding:12px 14px; border-radius:10px; font-size:13px; line-height:1.6;
        background:#fff; color:#1d2129; border-left:4px solid #2b5fd9;
        box-shadow:0 8px 28px rgba(15,23,42,.22); white-space:pre-wrap;
      }
      .toast.ok { border-left-color:#1f9254; }
      .toast.err { border-left-color:#c8362f; }
      .toast b { font-weight:600; }
    </style>
    <div class="wrap">
      <button class="btn" id="btn"><span class="dot"></span><span id="label">采集到人才库</span></button>
    </div>
  `;

  const btn = shadow.getElementById('btn');
  const label = shadow.getElementById('label');
  let toastEl = null;

  function showToast(text, kind) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'toast ' + (kind || '');
    toastEl.textContent = text;
    shadow.appendChild(toastEl);
    const el = toastEl;
    setTimeout(() => { try { el.remove(); if (toastEl === el) toastEl = null; } catch (e) { /* ignore */ } }, 9000);
  }

  function setBusy(busy, text) {
    btn.disabled = busy;
    label.textContent = text;
  }

  btn.addEventListener('click', () => {
    const ctx = inferContext();
    setBusy(true, '采集中…');
    try {
      chrome.runtime.sendMessage({
        type: 'COLLECT_REQUEST',
        payload: { scene: ctx.scene, sourceChannel: ctx.sourceChannel, pageUrl: location.href }
      }, (res) => {
        void chrome.runtime.lastError;
        setBusy(false, '采集到人才库');
        if (!res) {
          showToast('采集失败：扩展后台无响应。请在 chrome://extensions 重新加载扩展后刷新本页。', 'err');
          return;
        }
        if (!res.ok) {
          showToast('采集未完成\n' + (res.error || '未知原因'), 'err');
          return;
        }
        const s = res.summary || {};
        let text = '已采集 ' + (res.candidateName || '候选人') + '\n'
          + '· 候选人：' + (s.candidateCreated ? '新建' : '已存在（复用）') + '\n'
          + '· 简历版本：' + (s.resumeVersionCreated ? '新建 1 份' : '内容相同，已去重跳过');
        if (s.attachmentTotal) {
          text += '\n· 附件：' + s.attachmentStored + '/' + s.attachmentTotal + ' 份已入库';
        }
        if (res.warning) {
          text += '\n⚠️ ' + res.warning;
        }
        showToast(text, 'ok');
      });
    } catch (e) {
      setBusy(false, '采集到人才库');
      showToast('采集失败：' + ((e && e.message) || e), 'err');
    }
  });

  function mount() {
    try {
      if (!document.body) return false;
      document.body.appendChild(host);
      return true;
    } catch (e) { return false; }
  }

  if (!mount()) {
    // 平台早期版本可能 body 尚未建立（按钮是 document_idle 注入，正常已存在）
    const t = setInterval(() => { if (mount()) clearInterval(t); }, 500);
    setTimeout(() => clearInterval(t), 10000);
  }
})();
