SET NAMES utf8mb4;
-- ====================================
-- 【一次性迁移 · 人工执行】channel 存量行回填 publish_entry_url
-- 依据：docs/design/channel-publish-seamless.md §7
-- 前置：channel_alter_add_publish_entry_url_20260916_V1.sql 已执行（列已存在）
--
-- ✅ 执行状态：**2026-09-16 已在本地库执行完毕**（`mock_demo` / `boss` 两行 entry_url = pattern，无残留 NULL）。
--      本节以下内容保留为说明与复核路径；新环境首次部署时仍需人工跑一次。
--
-- ⚠️ 本脚本放在 sql/upgrade/，scripts/db-bootstrap.sh **不会自动执行**，必须人工跑：
--      docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 \
--        -uroot -precruit2024 recruit_platform \
--        < recruit-server/sql/upgrade/channel_backfill_publish_entry_url_20260916_V1.sql
--
-- 回填规则：把**不含通配符**的 publish_url_pattern 抄进 publish_entry_url。
--
-- 为什么这条规则成立：
--      当前 pattern 事实上就在兼任导航入口（background.js 直接拿它 tabs.create）。
--      把原值抄进新列 = 对齐现状，不改变任何已可用行为。
--
-- 为什么不回填含通配的 pattern：
--      通配串（如 https://www.zhipin.com/*publish*）**反推不出具体 URL**——
--      这才是 publish_entry_url 必须独立存在的根本原因。
--      这类渠道留 NULL，由人工在浏览器里确认真实入口后手动填入。
--      （扩展遇到 NULL 应明确报错，不得猜 URL——猜错等于往错误页面注入表单。）
--
-- ⚠️ 这是**迁移中间态**，不是终态：
--      publish_url_pattern 的正式语义是「注入校验模式」，应改为通配形式；
--      publish_entry_url 才是具体入口。等 extension/background.js 的通配处理
--      与注入校验逻辑就绪后，需再补一次迁移把 pattern 收成通配。
--      现在不动 pattern，避免在扩展未就绪时改变现有可用行为。
--
-- 幂等策略：WHERE publish_entry_url IS NULL 天然幂等，可重复执行；
--      也不会覆盖此后人工填入的入口地址。
-- ====================================

-- ---------- 1) 执行前快照 ----------
SELECT
    '执行前' AS phase,
    COUNT(*)                                                    AS total,
    SUM(publish_entry_url IS NULL)                               AS entry_null,
    SUM(publish_entry_url IS NULL AND publish_url_pattern LIKE '%*%') AS entry_null_and_wildcard
FROM channel;

-- ---------- 2) 回填：不含通配的 pattern 原值抄入 entry ----------
UPDATE channel
SET publish_entry_url = publish_url_pattern
WHERE publish_entry_url IS NULL
  AND publish_url_pattern IS NOT NULL
  AND publish_url_pattern NOT LIKE '%*%';

-- ---------- 3) 执行后核对 ----------
SELECT id, code, name, publish_url_pattern, publish_entry_url
FROM channel
ORDER BY sort_order, id;

-- ---------- 4) 残留检查：仍为 NULL 的渠道需人工填入口 ----------
-- 这些渠道的 pattern 含通配（反推不出 URL）或本身为空，
-- 无法自动回填。在人工填好之前，扩展对这些渠道应明确报错。
SELECT id, code, name, publish_url_pattern
FROM channel
WHERE publish_entry_url IS NULL;
