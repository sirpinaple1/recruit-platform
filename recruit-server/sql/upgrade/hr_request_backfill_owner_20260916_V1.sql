SET NAMES utf8mb4;
-- ====================================
-- 【一次性迁移 · 人工执行】hr_request 存量行回填 owner_user_id
-- 依据：docs/architecture/adr/ADR-008-resource-ownership-authorization.md
--
-- ✅ 执行状态：**2026-09-16 已在本地库执行完毕**（`owner_null` 10 → 0，无残留 NULL 行）。
--      本节以下内容保留为说明与复核路径；新环境首次部署时仍需人工跑一次。
--
-- ⚠️ 本脚本放在 sql/upgrade/，scripts/db-bootstrap.sh **不会自动执行**，必须人工跑：
--      docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 \
--        -uroot -precruit2024 recruit_platform \
--        < recruit-server/sql/upgrade/hr_request_backfill_owner_20260916_V1.sql
--
-- 适用场景：环境曾跑过「只有 created_by、没有 owner_user_id」的旧版建表脚本，
--      且 hr_request_alter_add_owner_20260916_V1.sql 已执行（列已存在）。
--
-- 为什么必须跑（这不是可选的数据整理）：
--      ADR-008 的归属规则是 fail-closed——owner_user_id IS NULL 的岗位
--      对 HR **一律不可见、不可操作**，只有 ADMIN 能看。
--      即：本脚本漏跑的唯一表现是「HR 登录后岗位全都不见了」，
--      而且**不会报任何错**。这是本项目最容易踩的一个静默故障。
--
-- 幂等策略：WHERE owner_user_id IS NULL 天然幂等，重复执行不会覆盖已指派的值。
--      也正因如此，**它不会覆盖后来通过改派接口设置的负责人**——可以安全重跑。
--
-- 对全新库执行：表存在但为空，UPDATE 影响 0 行，无副作用。
--      （按 docs/architecture/database-schema.md §5 的判定标准它仍归 upgrade/：
--        因为它修改业务数据而非结构。）
--
-- ⚠️⚠️ 实测数据提醒（2026-09-16 只读核对，务必先读这一段）：
--      本地库 hr_request 共 10 行，**全部 created_by = 1（admin）**，
--      没有一行属于 hr001。原因是此前所有需求单都是 E2E 验收时用 admin 的 token 建的。
--
--      因此「回填 owner = created_by」在本库的结果是：
--        · 全部 10 条岗位归 admin
--        · hr001 登录后**一条岗位都看不到**（fail-closed 按设计工作）
--
--      这不是脚本 bug，是数据事实。要让 HR 侧验收可跑，必须**另造一条 owner = hr001
--      的岗位**（最简做法：用 hr001 登录中台，自己建一条需求单并提交、审批）。
--      详见 docs/design/channel-publish-seamless.md §10.1 验收数据前置。
-- ====================================

-- ---------- 1) 执行前快照 ----------
SELECT
    '执行前' AS phase,
    COUNT(*)                                              AS total,
    SUM(owner_user_id IS NULL)                            AS owner_null,
    SUM(owner_user_id IS NULL AND created_by IS NULL)     AS both_null
FROM hr_request;

-- ---------- 2) 回填：以创建人作为默认负责人 ----------
UPDATE hr_request
SET owner_user_id = created_by
WHERE owner_user_id IS NULL
  AND created_by IS NOT NULL;

-- ---------- 3) 执行后核对 ----------
SELECT
    '执行后' AS phase,
    COUNT(*)                  AS total,
    SUM(owner_user_id IS NULL) AS owner_null
FROM hr_request;

-- ---------- 4) 残留检查：仍为 NULL 的行需要人工指派 ----------
-- 这些行的 created_by 也是 NULL（历史数据缺创建人），无法自动推断负责人。
-- 按 ADR-008 §5，它们对 HR 不可见、仅 ADMIN 可见/可代发——
-- 若这类行数为 0，回填即告完成；若大于 0，请人工确认后再单独指派。
SELECT id, request_no, title, status, created_by, created_at
FROM hr_request
WHERE owner_user_id IS NULL;
