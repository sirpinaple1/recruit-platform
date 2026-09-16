/**
 * 招聘发布助手 · 填充引擎（设计文档 §8，三级匹配）
 *
 * 使用方式（popup 通过 chrome.scripting.executeScript 注入本文件后调用）：
 *   const report = window.__recruitFillEngine(config);
 *   config = {
 *     fields:    [{ key, type, match: [...] }, ...],  // 渠道 field_map_json.fields
 *     selectors: { key: cssSelector, ... },           // 渠道 field_map_json.selectors
 *     values:    { key: value, ... }                  // 草稿 fields_json 渲染产物
 *   }
 *
 * 三级匹配（按序尝试，逐级降级）：
 *   1. 文本匹配：name 属性 / 关联 label / placeholder / aria-label（归一化后与 match 比对，相等优先于包含）
 *   2. 属性匹配：data-* 属性值 / title 属性（与 match ∪ {key} 比对）
 *   3. 选择器兜底：selectors[key]
 *
 * 控件类型（红线 1、4：遇 file/验证码/提交按钮一律跳过，不自动点击提交）：
 *   input[text|number|date|email|url|tel] / textarea → 直接赋值并派发 input+change 事件
 *   select   → 按值或文本匹配 option 后选中
 *   radio 组 → 按值选中
 */
(() => {
  'use strict';

  /** 归一化：小写、全角→半角、去空白、去冒号与必填星号 */
  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, '')
      .replace(/[:：*＊]/g, '');
  }

  /** 不安全/不该由引擎碰的 input 类型（红线） */
  const UNSAFE_TYPES = new Set(['file', 'submit', 'button', 'reset', 'image', 'hidden', 'password']);

  /** 收集控件的文本匹配线索（归一化后） */
  function textClues(el) {
    const clues = [];
    if (el.name) clues.push(el.name);
    if (el.placeholder) clues.push(el.placeholder);
    const aria = el.getAttribute('aria-label');
    if (aria) clues.push(aria);
    // 关联 label：label[for=id] 与祖先 label
    if (el.id) {
      document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]').forEach((lb) => clues.push(lb.textContent));
    }
    const ancestorLabel = el.closest('label');
    if (ancestorLabel) clues.push(ancestorLabel.textContent);
    return clues.map(normalize).filter(Boolean);
  }

  /** 验证码控件启发式（红线 1、4）：name/id/placeholder/aria-label/class 含特征词一律跳过 */
  function looksLikeCaptcha(el) {
    const hay = normalize(
      [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('class')]
        .filter(Boolean)
        .join(' ')
    );
    return /captcha|验证码|vcode|verifycode|checkcode|yanzhengma/.test(hay);
  }

  /** 收集控件的属性匹配线索：data-* 与 title 属性值（归一化后） */
  function attrClues(el) {
    const clues = [];
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') || attr.name === 'title') {
        clues.push(attr.value);
      }
    }
    return clues.map(normalize).filter(Boolean);
  }

  /**
   * 匹配评分：候选词与线索比对。
   * 返回 2（归一化后相等）> 1（线索包含候选词，词长>=2）> 0（不匹配）。
   */
  function score(clue, term) {
    if (!clue || !term) return 0;
    if (clue === term) return 2;
    if (term.length >= 2 && clue.includes(term)) return 1;
    return 0;
  }

  /** 在候选单元中按文本级别找最佳命中（返回 {unit, best} 或 null） */
  function matchByLevel(clueFn, terms, units) {
    let best = null;
    for (const unit of units) {
      for (const clue of clueFn(unit.root)) {
        for (const term of terms) {
          const s = score(clue, term);
          if (s > 0 && (!best || s > best.s)) {
            best = { unit, s };
          }
        }
      }
      // radio 组：legend 与组内 label 文本也是线索
      if (unit.legend) {
        const legend = normalize(unit.legend);
        for (const term of terms) {
          const s = score(legend, term);
          if (s > 0 && (!best || s > best.s)) best = { unit, s };
        }
      }
    }
    return best;
  }

  /** 填充单个可输入控件，派发 input + change 事件（框架受控组件需要） */
  function setValuish(control, value) {
    control.value = value == null ? '' : String(value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** select：按值或文本匹配 option（相等优先，其次包含） */
  function fillSelect(select, value) {
    const target = normalize(value);
    let hit = null;
    for (const opt of select.options) {
      const byValue = score(normalize(opt.value), target);
      const byText = score(normalize(opt.textContent), target);
      if (byValue === 2 || byText === 2) { hit = opt; break; }
      if (byValue === 1 || byText === 1) { hit = hit || opt; }
    }
    if (!hit) return false;
    select.value = hit.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** radio 组：按 value 选中 */
  function fillRadioGroup(radios, value) {
    const target = normalize(value);
    const hit = radios.find((r) => normalize(r.value) === target);
    if (!hit) return false;
    hit.checked = true;
    hit.dispatchEvent(new Event('input', { bubbles: true }));
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * 执行填充。返回报告：
   *   filled  [{ key, method, target }]   method: text | attr | selector
   *   skipped [{ key, reason }]           值缺失 / 不安全控件类型
   *   failed  [{ key, reason }]           找不到控件 / select、radio 无匹配项
   */
  function runFill(config) {
    const report = { filled: [], skipped: [], failed: [] };
    const fields = (config && config.fields) || [];
    const selectors = (config && config.selectors) || {};
    const values = (config && config.values) || {};

    // 构建候选控件单元：单控件 + radio 组
    const units = [];
    const radioGroups = new Map();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'radio') {
        if (!radioGroups.has(el.name)) radioGroups.set(el.name, []);
        radioGroups.get(el.name).push(el);
        continue;
      }
      units.push({ kind: 'single', root: el, control: el });
    }
    for (const radios of radioGroups.values()) {
      const first = radios[0];
      const fieldset = first.closest('fieldset');
      units.push({
        kind: 'radio',
        root: first,
        radios,
        legend: fieldset ? fieldset.querySelector('legend').textContent : '',
      });
    }

    for (const field of fields) {
      const key = field.key;
      if (!(key in values) || values[key] == null || values[key] === '') {
        report.skipped.push({ key, reason: 'value-missing' });
        continue;
      }
      const value = values[key];
      const terms = (field.match || []).map(normalize).filter(Boolean);
      if (!terms.length) {
        report.skipped.push({ key, reason: 'no-match-terms' });
        continue;
      }

      // 三级匹配
      let hit = null;
      let method = null;
      const byText = matchByLevel(textClues, terms, units);
      if (byText) { hit = byText.unit; method = 'text'; }
      if (!hit) {
        const attrTerms = terms.concat([normalize(key)]);
        const byAttr = matchByLevel(attrClues, attrTerms, units);
        if (byAttr) { hit = byAttr.unit; method = 'attr'; }
      }
      if (!hit && selectors[key]) {
        const el = document.querySelector(selectors[key]);
        if (el) {
          const unit = units.find((u) => u.control === el || (u.kind === 'radio' && u.radios.includes(el)));
          hit = unit || (el.type === 'radio' ? null : { kind: 'single', root: el, control: el });
          method = 'selector';
        }
      }
      if (!hit) {
        report.failed.push({ key, reason: 'control-not-found' });
        continue;
      }

      // 红线：不安全控件类型一律跳过（file/提交/隐藏/密码等）
      const control = hit.kind === 'radio' ? hit.radios[0] : hit.control;
      if (control.tagName === 'INPUT' && UNSAFE_TYPES.has(control.type)) {
        report.skipped.push({ key, reason: 'unsafe-control-type:' + control.type });
        continue;
      }
      if (looksLikeCaptcha(control)) {
        report.skipped.push({ key, reason: 'captcha-field' });
        continue;
      }
      if (control.disabled) {
        report.skipped.push({ key, reason: 'control-disabled' });
        continue;
      }

      // 填充
      const targetDesc = control.id ? '#' + control.id : (control.name || control.tagName.toLowerCase());
      if (hit.kind === 'radio') {
        if (fillRadioGroup(hit.radios, value)) {
          report.filled.push({ key, method, target: targetDesc });
        } else {
          report.failed.push({ key, reason: 'radio-no-matching-value' });
        }
      } else if (control.tagName === 'SELECT') {
        if (fillSelect(control, value)) {
          report.filled.push({ key, method, target: targetDesc });
        } else {
          report.failed.push({ key, reason: 'select-no-matching-option' });
        }
      } else {
        setValuish(control, value);
        report.filled.push({ key, method, target: targetDesc });
      }
    }

    report.summary = {
      total: fields.length,
      filled: report.filled.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
    };
    return report;
  }

  window.__recruitFillEngine = runFill;

  // 自动执行模式：注入前已放置配置则立即填充（popup 两步注入场景）
  if (window.__RECRUIT_FILL_CONFIG__) {
    window.__RECRUIT_FILL_RESULT__ = runFill(window.__RECRUIT_FILL_CONFIG__);
    window.dispatchEvent(new CustomEvent('recruit-fill-done', { detail: window.__RECRUIT_FILL_RESULT__ }));
  }
})();
