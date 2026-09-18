/**
 * 招聘发布助手 · 填充引擎（设计文档 §8，三级匹配）
 *
 * 使用方式（popup/background 通过 chrome.scripting.executeScript 注入本文件后调用）：
 *   const report = await window.__recruitFillEngine(config);
 *   config = {
 *     fields:    [{ key, type, match: [...], nth?, valueMap? }, ...],  // 渠道 field_map_json.fields
 *     selectors: { key: cssSelector, ... },           // 渠道 field_map_json.selectors
 *     values:    { key: value, ... }                  // 草稿 fields_json 渲染产物（后端已应用 valueMap）
 *   }
 *
 * 三级匹配（按序尝试，逐级降级）：
 *   1. 文本匹配：name 属性 / 关联 label / placeholder / aria-label / 表单行标题 / 下拉触发器文本
 *   2. 属性匹配：data-* 属性值 / title 属性（与 match ∪ {key} 比对）
 *   3. 选择器兜底：selectors[key]
 *
 * 控件类型：
 *   input/textarea → 直接赋值并派发 input+change 事件
 *   select   → 按值或文本匹配 option 后选中
 *   radio 组 → 按值选中
 *   input[hidden]（BOSS 自定义下拉）→ fillCustomDropdown：点触发器开菜单 → 点匹配选项
 *   type: recommend（BOSS 职位类型）→ fillRecommendField：触发平台职位预测后选推荐项
 *
 * 时序约束（BOSS 实测 2026-09-18）：
 *   - 字段**顺序**填充，每个字段等待完成后再处理下一个（下拉点选后等框架落值）
 *   - 「最高月薪」下拉在选完「最低月薪」后才会渲染（级联依赖），因此每个字段
 *     匹配前重建候选单元（重扫 DOM），薪资行内按 DOM 顺序 nth 0/1 区分最低/最高
 *   - 职位类型推荐依赖「职位描述失焦」触发的预测接口：填充前对 JD 文本框
 *     执行 focus+blur，等预测返回后再点开输入框选择推荐项
 */
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 归一化：小写、全角→半角、去空白、去冒号与必填星号 */
  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, '')
      .replace(/[:：*＊]/g, '');
  }

  /** 不安全/不该由引擎碰的 input 类型（红线 1、4：遇 file/验证码/提交按钮一律跳过） */
  const UNSAFE_TYPES = new Set(['file', 'submit', 'button', 'reset', 'image', 'password']);

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
    // 同一表单行内的标题文本（BOSS：.publish-title，如「薪资范围」「职位类型」）
    const formRow = el.closest('.publish-edit-form-row, [class*="form-row"], [class*="form-item"], [class*="field"]');
    if (formRow) {
      const titleEl = formRow.querySelector('.publish-title, [class*="title"]:not(h1):not(h2):not(h3), [class*="label"]');
      if (titleEl && titleEl.textContent) {
        clues.push(titleEl.textContent);
      }
    }
    // 自定义下拉组件：触发器当前文本（占位符如「最低月薪」，或已选值）也是线索
    const uiSelect = el.closest('.ui-select');
    if (uiSelect) {
      const selection = uiSelect.querySelector('.ui-select-selection');
      if (selection && selection.textContent) {
        clues.push(selection.textContent);
      }
    }
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

  /**
   * 在候选单元中按文本级别找最佳命中。
   * nth：同分候选中按 DOM 顺序取第 nth 个（如薪资行 最低=0/最高=1）。
   * nth 超出范围返回 null——不回退到第 0 个（回退会让「最高月薪」打到「最低月薪」上，造成倒挂）。
   */
  function matchByLevel(clueFn, terms, units, nth) {
    const matches = [];
    for (const unit of units) {
      let bestScore = 0;
      for (const clue of clueFn(unit.root)) {
        for (const term of terms) {
          const s = score(clue, term);
          if (s > bestScore) {
            bestScore = s;
          }
        }
      }
      // radio 组：legend 与组内 label 文本也是线索
      if (unit.legend) {
        const legend = normalize(unit.legend);
        for (const term of terms) {
          const s = score(legend, term);
          if (s > bestScore) {
            bestScore = s;
          }
        }
      }
      if (bestScore > 0) {
        matches.push({ unit, s: bestScore });
      }
    }

    if (matches.length === 0) return null;

    // 按评分排序，评分相同时保持 DOM 顺序
    matches.sort((a, b) => b.s - a.s);

    if (nth != null && nth >= 0) {
      const topScore = matches[0].s;
      const sameScore = matches.filter((m) => m.s === topScore);
      if (nth >= sameScore.length) {
        console.warn('[FillEngine] nth 超出同分候选范围:', {
          nth, matchCount: sameScore.length,
          candidates: sameScore.map((m) => textClues(m.unit.root).slice(0, 3)),
        });
        return null;
      }
      return sameScore[nth];
    }
    return matches[0];
  }

  /** 构建候选控件单元：单控件 + radio 组（每次字段匹配前重建——级联渲染会新增控件） */
  function buildUnits() {
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
    return units;
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
   * 自定义下拉组件填充（BOSS 直聘等：hidden input + .ui-select）。
   * 点触发器开菜单 → 等菜单渲染 → 点匹配选项 → 等框架落值与级联渲染。
   * @returns {Promise<boolean>} 是否成功
   */
  async function fillCustomDropdown(hiddenInput, value) {
    const target = normalize(value);
    const uiSelect = hiddenInput.closest('.ui-select');
    if (!uiSelect) {
      console.warn('[FillEngine] 自定义下拉：hidden input 不在 .ui-select 内');
      return false;
    }
    const trigger = uiSelect.querySelector('.ui-select-selection');
    if (!trigger) {
      console.warn('[FillEngine] 自定义下拉：未找到触发器 .ui-select-selection');
      return false;
    }

    trigger.click(); // 打开菜单
    await sleep(300);

    const dropdown = uiSelect.querySelector('.ui-select-dropdown');
    const optionsList = dropdown && dropdown.querySelector('.ui-dropdown-list');
    const options = optionsList ? Array.from(optionsList.querySelectorAll('.ui-select-item')) : [];
    if (!options.length) {
      console.warn('[FillEngine] 自定义下拉：菜单未打开或无选项', { value });
      trigger.click(); // 尝试关闭
      return false;
    }

    let hit = null;
    let bestScore = 0;
    for (const opt of options) {
      const s = score(normalize(opt.textContent), target);
      if (s > bestScore) {
        bestScore = s;
        hit = opt;
      }
      if (s === 2) break;
    }
    if (!hit || bestScore === 0) {
      console.warn('[FillEngine] 自定义下拉：无匹配选项', {
        value,
        options: options.map((o) => o.textContent.trim()).slice(0, 12),
      });
      trigger.click(); // 关闭菜单
      return false;
    }

    hit.click();
    await sleep(700); // 等框架落值 + 级联渲染（选完最低月薪后最高月薪/月数下拉才出现）
    console.log('[FillEngine] 自定义下拉：已选', { value, option: hit.textContent.trim() });
    return true;
  }

  /**
   * 推荐选择字段填充（BOSS 职位类型，2026-09-18 实测流程）：
   * 1. JD 文本框 focus+blur —— 触发 BOSS onBlur 的职位预测接口（getJobPrefillData）
   * 2. 等预测返回（实测 ~1s，留 3s 余量）
   * 3. 点击职位类型只读输入框 —— 打开推荐对话框（.job-recommend-position-select-dialog）
   * 4. 点最优推荐项（.job-recommend-content_item，无匹配词时取第一条，BOSS 按相关度排序）
   * 兜底：预测无结果时 BOSS 会开普通职类对话框，尝试搜索职位名选第一条；再不行 ESC 关闭并失败。
   * @param {HTMLInputElement} control 职位类型只读输入框
   * @param {Object} values 全部字段值（取 title 作推荐评分/搜索兜底词）
   * @returns {Promise<boolean>}
   */
  async function fillRecommendField(control, values) {
    const fallbackTerm = values.jobCategory || values.title || '';
    // 记录点击前值：重复填充场景控件可能残留旧值，验证必须要求值发生变化
    const prevValue = control.value;

    // 1. 触发职位预测：JD 文本框失焦（Vue onBlur → 预测接口）
    const jd = document.querySelector('textarea');
    if (jd) {
      jd.focus();
      jd.blur();
    }
    await sleep(3000);

    // 2. 点开职位类型选择（readonly 输入框，Vue 监听鼠标事件序列）
    const wrap = control.closest('.ipt-wrap') || control.parentElement;
    for (const el of [wrap, control]) {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    }
    await sleep(1200);

    // 3. 推荐对话框：选最优推荐项
    const recItems = Array.from(document.querySelectorAll('.job-recommend-content_item')).filter(
      (e) => e.offsetParent !== null
    );
    if (recItems.length) {
      let hit = recItems[0]; // 默认第一条（BOSS 按预测相关度排序）
      let bestScore = 0;
      if (fallbackTerm) {
        const t = normalize(fallbackTerm);
        for (const item of recItems) {
          const s = score(normalize(item.textContent), t);
          if (s > bestScore) {
            bestScore = s;
            hit = item;
          }
        }
      }
      hit.click();
      // 值更新可迟于点击 1s+（BOSS 异步落值，实测 1~1.5s），轮询验证而非单次检查
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if (control.value && control.value !== prevValue) {
          console.log('[FillEngine] 职位类型：已选推荐项', { value: control.value });
          return true;
        }
        // 重复填充同值场景：值不变但推荐对话框已关闭 = 点击已生效（选中值即当前值）
        if (i >= 1 && control.value) {
          const stillOpen = Array.from(document.querySelectorAll('.job-recommend-content_item'))
            .some((e) => e.offsetParent !== null);
          if (!stillOpen) {
            console.log('[FillEngine] 职位类型：推荐对话框已关闭，值保持', { value: control.value });
            return true;
          }
        }
      }
      console.warn('[FillEngine] 职位类型：推荐项点击后输入框未变化', { prevValue, value: control.value });
      return false;
    }

    // 4. 兜底：普通职类对话框 → 搜索职位名选第一条结果
    const dialogs = Array.from(document.querySelectorAll('.boss-popup__wrapper')).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 50 && r.height > 50 && d.offsetParent !== null;
    });
    if (dialogs.length && fallbackTerm) {
      const dialog = dialogs[0];
      const searchInput = dialog.querySelector('input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
        document.execCommand('delete');
        document.execCommand('insertText', false, fallbackTerm);
        await sleep(1600);
        // 找文本含搜索词的可见结果项（搜索结果高亮元素或其可点击父级）
        let target = null;
        dialog.querySelectorAll('*').forEach((e) => {
          if (target || e.offsetParent === null) return;
          const own = Array.from(e.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent.trim())
            .join('');
          if (own && normalize(own) === normalize(fallbackTerm)) {
            target = e;
          }
        });
        const clickable = target && (target.closest('[class*="item"], li') || target.parentElement);
        if (clickable) {
          clickable.click();
          for (let i = 0; i < 6; i++) {
            await sleep(500);
            if (control.value && control.value !== prevValue) {
              console.log('[FillEngine] 职位类型：搜索兜底已选', { value: control.value });
              return true;
            }
          }
        }
      }
      // 未成功：ESC 关闭对话框，避免阻塞后续人工操作
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(300);
    }

    console.warn('[FillEngine] 职位类型：推荐流程失败', { fallbackTerm });
    return false;
  }

  /**
   * 渠道 valueMap 兜底（与后端 PublishDraftService.applyValueMap 同逻辑）：
   * - 普通映射：valueMap[原始值] -> 平台选项文本（bachelor -> 本科、3 -> 3-5年）
   * - 单位换算：_unit=yuanToK 时数字元转千（9000 -> "9k"）
   * 幂等性：后端渲染时已应用 valueMap 的值（已是 "本科"/"9k" 等平台文本）在此
   * 查不到原始 key，原样返回——因此扩展与后端版本不同步时仍能填对。
   */
  function applyValueMap(field, raw) {
    if (raw == null) return raw;
    const vm = field.valueMap;
    if (!vm) return raw;
    if (vm._unit === 'yuanToK' && typeof raw === 'number') {
      return Math.round(raw / 1000) + 'k';
    }
    const key = String(raw);
    return Object.prototype.hasOwnProperty.call(vm, key) ? vm[key] : raw;
  }

  /**
   * 执行填充（顺序异步：每个字段等待完成，级联安全）。返回报告：
   *   filled  [{ key, method, target }]   method: text | attr | selector（+custom-dropdown/+recommend）
   *   skipped [{ key, reason }]           值缺失 / 不安全控件类型
   *   failed  [{ key, reason }]           找不到控件 / 下拉无匹配项 / 推荐失败
   */
  async function runFill(config) {
    const report = { filled: [], skipped: [], failed: [] };
    const fields = (config && config.fields) || [];
    const selectors = (config && config.selectors) || {};
    const values = (config && config.values) || {};

    console.log('[FillEngine] 开始填充', {
      fieldCount: fields.length,
      fieldKeys: fields.map((f) => f.key),
      values,
    });

    for (const field of fields) {
      const key = field.key;
      const isRecommend = field.type === 'recommend';
      // valueMap 兜底：后端渲染时已应用则幂等通过；后端未升级（草稿为原始值）时在此转换
      const value = isRecommend ? values[key] : applyValueMap(field, values[key]);

      // recommend 字段无平台值也执行（用 BOSS 自己的预测推荐）；其余字段值缺失跳过
      if (!isRecommend && (value == null || value === '')) {
        report.skipped.push({ key, reason: 'value-missing' });
        continue;
      }
      const terms = (field.match || []).map(normalize).filter(Boolean);
      if (!terms.length) {
        report.skipped.push({ key, reason: 'no-match-terms' });
        continue;
      }

      // 每个字段重建候选单元：上一字段的级联渲染（如最高月薪）会新增控件
      const units = buildUnits();
      const nth = field.nth != null ? field.nth : undefined;

      // 三级匹配
      let hit = null;
      let method = null;
      const byText = matchByLevel(textClues, terms, units, nth);
      if (byText) { hit = byText.unit; method = 'text'; }
      if (!hit) {
        const attrTerms = terms.concat([normalize(key)]);
        const byAttr = matchByLevel(attrClues, attrTerms, units, nth);
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
        console.warn('[FillEngine] 字段匹配失败:', { key, terms });
        report.failed.push({ key, reason: 'control-not-found' });
        continue;
      }

      // 红线：不安全控件类型 / 验证码 / 禁用 一律跳过
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
      try {
        if (isRecommend) {
          if (await fillRecommendField(control, values)) {
            report.filled.push({ key, method: method + '+recommend', target: targetDesc });
          } else {
            report.failed.push({ key, reason: 'recommend-failed' });
          }
        } else if (hit.kind === 'radio') {
          if (fillRadioGroup(hit.radios, value)) {
            report.filled.push({ key, method, target: targetDesc });
          } else {
            console.warn('[FillEngine] radio 值不匹配:', { key, value });
            report.failed.push({ key, reason: 'radio-no-matching-value' });
          }
        } else if (control.tagName === 'SELECT') {
          if (fillSelect(control, value)) {
            report.filled.push({ key, method, target: targetDesc });
          } else {
            console.warn('[FillEngine] select 无匹配项:', { key, value });
            report.failed.push({ key, reason: 'select-no-matching-option' });
          }
        } else if (control.tagName === 'INPUT' && control.type === 'hidden') {
          if (await fillCustomDropdown(control, value)) {
            report.filled.push({ key, method: method + '+custom-dropdown', target: targetDesc });
          } else {
            report.failed.push({ key, reason: 'dropdown-no-match' });
          }
        } else {
          setValuish(control, value);
          await sleep(300); // 等框架同步（职位描述内容会驱动后续职位预测）
          report.filled.push({ key, method, target: targetDesc });
        }
      } catch (e) {
        console.error('[FillEngine] 字段填充异常:', { key, error: String(e) });
        report.failed.push({ key, reason: 'fill-error:' + (e && e.message) });
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

  // 自动执行模式：注入前已放置配置则立即填充（popup/background 两步注入场景）。
  // 引擎为异步顺序填充（下拉/推荐需等待），完成后才落结果——调用方轮询 __RECRUIT_FILL_RESULT__。
  if (window.__RECRUIT_FILL_CONFIG__) {
    const cfg = window.__RECRUIT_FILL_CONFIG__;
    window.__RECRUIT_FILL_RESULT__ = null;
    runFill(cfg)
      .then((r) => {
        window.__RECRUIT_FILL_RESULT__ = r;
        window.dispatchEvent(new CustomEvent('recruit-fill-done', { detail: r }));
      })
      .catch((e) => {
        window.__RECRUIT_FILL_RESULT__ = {
          filled: [], skipped: [],
          failed: [{ key: 'engine', reason: String(e) }],
          summary: { total: (cfg.fields || []).length, filled: 0, skipped: 0, failed: 1 },
        };
      });
  }
})();
