SET NAMES utf8mb4;
-- ====================================
-- BOSS 渠道配置更新：哨兵自动回执 success 节点（Phase 2.6 §6）
--
-- 背景：哨兵链路（填充完成后注入 sentinel.js 监听发布成功信号 → 自动回填
--      台账 → 广播中台）代码早已就绪，但 channel.field_map_json 一直没有
--      success 节点——background.js 的注入条件是 fieldMap.success 存在，
--      导致哨兵从未被注入，发布结果始终要人工回填。
--
-- 信号依据（2026-09-18 实测探测 BOSS 发布页）：
--   · 发布按钮组件 saveJob 成功分支（case 33）执行
--     $toast("保存成功","success") + gotoJobListPage()
--   · $toast 渲染的真实 DOM：
--     <div class="toast"><div class="toast-con"><i class="icon-toast-success">…
--     存活约 2.3s，哨兵的 MutationObserver + 1s 轮询均可捕捉
--   · 故成功选择器定为 .toast .icon-toast-success
--
-- 不配 urlPattern：发布成功 1s 后页面跳职位列表，URL 模式无法稳定命中；
--      sentinel.js 对无配置的判定方直接跳过，等效选择器单判定。
-- timeoutMs 120000：填充完成后用户需要核对/微调表单再手动发布，
--      60s 默认值偏紧，放宽到 120s。
--
-- 实施方式：JSON_SET 合并（保留现有 fields 数组原样，不动 valueMap/_unit），
--      幂等：重复执行结果一致。
-- ====================================

UPDATE channel
SET field_map_json = JSON_SET(field_map_json, '$.success',
    JSON_OBJECT('selectors', JSON_ARRAY('.toast .icon-toast-success'), 'timeoutMs', 120000))
WHERE code = 'boss';
