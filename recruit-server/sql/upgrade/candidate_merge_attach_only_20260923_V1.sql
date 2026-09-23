SET NAMES utf8mb4;
-- ====================================
-- 一次性迁移（2026-09-23）：纯附件采集分裂记录收敛 + 投递 request_id 名称兜底回填
--
-- ⚠️ 本脚本属 sql/upgrade/，**人工单独执行**，不会被 db-bootstrap.sh 自动跑。
--    执行前请先备份：
--      mysqldump ... recruit_platform candidate resume_version attachment resume_score candidate_application > /tmp/before_20260923.sql
--    必须在同一会话内执行（用到 TEMPORARY TABLE；mysql CLI 跑单文件即满足）。
--
-- 背景（程春灿案例，分裂根因已在代码层修复）：
--   HR 在 PDF 预览页点了「采集」，页面只有附件、无简历字段。旧逻辑拿附件下载 URL 里的
--   加密 geekId 直接当身份新建候选人，与聊天页已采集的数字 uid 记录无键交集 → 分裂成两行：
--     · 2102596062935773186  程春灿（uid 780769434）—— 有简历字段、有打分 58、无附件  【幸存者】
--     · 2102596185669496834  姓名 NULL（geekId dfdbf89aea6360150nB_3Nu7GVNX）
--                            —— 空版本（fields_json='{}'）+ 空打分 50 + 附件 1 份      【被兼并方】
--   运行时修复（同日已上线）：
--     · CollectService：空字段不新建候选人、不建空版本、不触发打分（400 拒绝 + 引导）；
--     · 扩展 background.js：纯附件采集改挂「5 分钟内最近采集的候选人」身份槽（0.6.1）。
--   本脚本是**存量清历史**，不是长期机制 —— 分裂不再产生。
--
-- 归并终态：
--   · 附件（preview4boss:dfdbf89…）改挂幸存者，版本指针指向幸存者的唯一版本
--     2102596062952550401（不再留空版本指针）
--   · 被兼并方的空打分行、空版本删除（fields_json='{}' 无信息量，打分 50 是空字段的垃圾分）
--   · 幸存者 platform_user_id_alt = dfdbf89aea6360150nB_3Nu7GVNX（学下另一种 ID 形态，
--     以后任何一条形态的采集都归一到这一行）
--   · 幸存者 first/last_collected_at 取两行最早/最晚；version_count 重算
--   · 被兼并方 merged_into 指向幸存者（列表按 merged_into IS NULL 过滤）
--   · collect_audit 一行不动（append-only，审计行自带 platform_user_id 可溯源）
--
-- 投递回填（§5，与 CandidateApplicationService.resolveRequestIdByName 同一套规则）：
--   candidate_application 里 request_id IS NULL 的行，按「排除法 + 唯一才认」用
--   platform_job_hint 里的岗位名兜底归类：
--     · 先按 publish_record.platform_job_id **精确映射**回填（权威优先）；
--     · 无精确映射的，从 hint「9月23日 沟通的职位-Java初级工程师」提取岗位名，
--       与 hr_request.title 精确匹配（仅 open），**排除**已有 platform_job_id 绑定的同名需求单，
--       过滤后必须**恰好一条**才回填（零条/多条都不猜）。
--   实测预期（本地库 2026-09-23）：
--     · 程春灿投递 2102596063019659266（job 600fe3fb…）→ 2102594395649601537（Java初级工程师，
--       未绑定台账的同名需求单唯一）；旧需求单 2102585842704576514 已绑定 77e56237… 被排除。
--     · E2E 测试行（hint「E2E 沟通的职位-Java」→ 岗位名「Java」）无同名 open 需求单，不动。
--
-- 幂等 / 可续跑：
--   所有 UPDATE 带旧值守卫（WHERE merged_into IS NULL / request_id IS NULL），
--   DELETE 按具体 id 且存在性判定；重跑零副作用。真正的终态由 §7 自检把守。
-- ====================================

DROP TEMPORARY TABLE IF EXISTS tmp_name_fallback;

-- ---------- 0) 执行前预览：分裂对现状（请先看一眼再往下） ----------
SELECT c.id, c.platform_user_id, c.platform_user_id_alt, c.name, c.version_count,
       c.merged_into, c.first_collected_at, c.last_collected_at,
       (SELECT COUNT(*) FROM attachment a WHERE a.candidate_id = c.id) AS attachments
FROM candidate c
WHERE c.id IN (2102596062935773186, 2102596185669496834);

-- 被兼并方的空版本与空打分（删除对象，确认只有这一份）
SELECT v.id AS 空版本id, v.candidate_id, v.fields_json
FROM resume_version v
WHERE v.candidate_id = 2102596185669496834 AND v.fields_json = '{}';
SELECT s.id AS 空打分id, s.resume_version_id, s.score
FROM resume_score s
JOIN resume_version v ON v.id = s.resume_version_id
WHERE v.candidate_id = 2102596185669496834 AND v.fields_json = '{}';

-- ---------- 1) 附件改挂到幸存者 ----------
-- 版本指针必须同时改指幸存者的版本（不能留空版本的 id，删完就是悬空指针）
UPDATE attachment a
SET a.candidate_id = 2102596062935773186,
    a.resume_version_id = 2102596062952550401
WHERE a.candidate_id = 2102596185669496834;

-- ---------- 2) 删被兼并方的空打分行 ----------
-- （空字段打的分没有信息量，留着会把「58 分的程春灿」和「50 分的未知」混淆视线）
DELETE s FROM resume_score s
JOIN resume_version v ON v.id = s.resume_version_id
WHERE v.candidate_id = 2102596185669496834
  AND v.fields_json = '{}'
  AND s.score = 50;

-- ---------- 3) 删被兼并方的空版本 ----------
DELETE v FROM resume_version v
WHERE v.candidate_id = 2102596185669496834
  AND v.fields_json = '{}';

-- ---------- 4) 被兼并方标记 merged_into；幸存者学备用键 + 时间并集 + 计数重算 ----------
UPDATE candidate c
SET c.merged_into = 2102596062935773186
WHERE c.id = 2102596185669496834
  AND c.merged_into IS NULL;

UPDATE candidate s
SET s.platform_user_id_alt = COALESCE(s.platform_user_id_alt, 'dfdbf89aea6360150nB_3Nu7GVNX'),
    s.first_collected_at = LEAST(s.first_collected_at, '2026-09-23 03:09:29.655'),
    s.last_collected_at  = GREATEST(s.last_collected_at, '2026-09-23 03:18:47.100'),
    s.version_count = (
        SELECT COUNT(*) FROM resume_version v WHERE v.candidate_id = s.id
    )
WHERE s.id = 2102596062935773186;

-- ---------- 5) 投递 request_id 回填（先精确映射，后名称兜底·唯一才认） ----------
-- 5a) 精确映射回填：platform + platform_job_id 在发布台账里有记录的，以台账为准
UPDATE candidate_application a
JOIN channel ch ON ch.code = a.platform
JOIN publish_record pr ON pr.channel_id = ch.id AND pr.platform_job_id = a.platform_job_id
SET a.request_id = pr.request_id
WHERE a.request_id IS NULL;

-- 5b) 名称兜底候选表：从 hint 提取岗位名 → 同名 open 需求单 → 排除已绑定 → 唯一才收
CREATE TEMPORARY TABLE tmp_name_fallback AS
SELECT TRIM(SUBSTRING_INDEX(a.platform_job_hint, '沟通的职位-', -1)) AS job_name,
       MIN(h.id) AS request_id
FROM candidate_application a
JOIN hr_request h
  ON h.title = TRIM(SUBSTRING_INDEX(a.platform_job_hint, '沟通的职位-', -1))
 AND h.status = 'open'
WHERE a.request_id IS NULL
  AND a.platform_job_hint LIKE '%沟通的职位-%'
  AND NOT EXISTS (SELECT 1 FROM publish_record pr
                  WHERE pr.request_id = h.id AND pr.platform_job_id IS NOT NULL)
GROUP BY job_name
HAVING COUNT(DISTINCT h.id) = 1;

SELECT job_name AS 兜底岗位名, request_id AS 兜底需求单id FROM tmp_name_fallback;

-- 5c) 按兜底表回填（5a 之后仍为 NULL 的行才会被这里碰到；映射权威性由 recompute 兜底）
UPDATE candidate_application a
JOIN tmp_name_fallback f
  ON f.job_name = TRIM(SUBSTRING_INDEX(a.platform_job_hint, '沟通的职位-', -1))
SET a.request_id = f.request_id
WHERE a.request_id IS NULL;

-- ---------- 6) 通用巡检：还有哪些疑似「纯附件分裂」的空壳候选人 ----------
-- 画像：merged_into 未标记 + （姓名 NULL 或 0 版本）+ 名下有附件 —— 与程春灿案例同款画像。
-- 查出有结果 ≠ 一定要并：先核对 platform_user_id 与哪位候选人的已知 ID 形态同源再决定。
SELECT c.id, c.platform_user_id, c.platform_user_id_alt, c.name, c.version_count,
       (SELECT COUNT(*) FROM attachment a WHERE a.candidate_id = c.id) AS attachments
FROM candidate c
WHERE c.merged_into IS NULL
  AND (c.name IS NULL OR c.version_count = 0)
HAVING attachments > 0;

-- ---------- 7) 执行后自检 ----------
-- 7a) 程春灿应只剩一行可见（另一行 merged_into 指向它），且带备用键、1 版本、1 附件
SELECT c.id, c.platform_user_id, c.platform_user_id_alt, c.name, c.version_count, c.merged_into
FROM candidate c
WHERE c.id IN (2102596062935773186, 2102596185669496834);
-- 期望：2102596062935773186 一行 merged_into NULL、alt=dfdbf89…、version_count=1；
--       2102596185669496834 一行 merged_into=2102596062935773186

-- 7b) 附件已挂幸存者且版本指针有效
SELECT a.id, a.candidate_id, a.resume_version_id, a.platform_file_id
FROM attachment a
WHERE a.platform_file_id = 'preview4boss:dfdbf89aea6360150nB_3Nu7GVNX';
-- 期望：candidate_id=2102596062935773186，resume_version_id=2102596062952550401

-- 7c) 无悬空附件 / 无残留空版本 / 无残留垃圾打分
SELECT COUNT(*) AS 悬空附件数 FROM attachment a
LEFT JOIN resume_version v ON v.id = a.resume_version_id
WHERE a.resume_version_id IS NOT NULL AND v.id IS NULL;   -- 期望 0
SELECT COUNT(*) AS 空版本残留数 FROM resume_version v
WHERE v.candidate_id = 2102596185669496834;               -- 期望 0

-- 7d) 投递归类情况：程春灿那条应已指向 2102594395649601537；剩余 NULL 应只剩 E2E 测试行
SELECT a.id, a.candidate_id, a.platform_job_id, a.platform_job_hint, a.request_id
FROM candidate_application a
WHERE a.request_id IS NULL OR a.candidate_id = 2102596062935773186;
