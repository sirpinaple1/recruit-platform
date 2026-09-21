SET NAMES utf8mb4;
-- ====================================
-- 一次性迁移：把「同一人的两种 ID 形态」分裂出的重复候选人收敛成一行
-- 依据：用户决策「陈诗健的两条候选举止采用写入时归一」（2026-09-21）
--
-- ⚠️ 本脚本属 sql/upgrade/，**人工单独执行**，不会被 db-bootstrap.sh 自动跑。
--    执行前请先备份：mysqldump ... recruit_platform candidate resume_version attachment collect_audit > /tmp/before.sql
--    必须在同一会话内执行（用到 TEMPORARY TABLE；mysql CLI 跑单文件即满足）。
--
-- ⚠️ 本脚本 v1 首跑在「简历版本改挂」那一步失败（ERROR 1062），已修：
--    `resume_version` 上有唯一键 `uk_candidate_hash (candidate_id, content_hash)`，
--    而本场景的两行**内容完全相同**（同 hash），所以「把落后方的版本直接改挂到幸存者」
--    必然撞唯一键。正确顺序是：**先把与幸存者同 hash 的落后版本挑出来 → 救附件 → 删掉 →
--    再把剩下的（hash 不冲突的）改挂**，而不是先改挂再去重。
--    首跑已落库的部分（幸存者补 alt / 时间取并集 / 落后方标记 merged_into）是**幂等**的，
--    重跑本脚本会自动补完剩余步骤，不需要回滚。
--
-- 适用场景（只处理这一种，别的重复一律不碰）：
--   同一 platform 下，一个人因为「先采到数字 uid、后采到加密 geekId」而分裂成两行。
--   实测已产生两对：
--     陈诗健：608120464 + 01858de472ad39180XRy2t-9FFRU
--     谢建广：681940311 + f4c1f17734410c500Xx70tm9E1NR
--
-- 配对规则（**精确**，不用姓名模糊匹配）：
--   加密键行的 source_platform_user_raw = 数字键行的 platform_user_id
--   该字段由扩展上报的「备用 ID」写入，语义就是「同一个人的另一种形态」。
--   再叠加三条保险：platform 相同、id 不同、姓名相同（<=> 含 NULL 安全比较）。
--   收敛之后再产生的分裂由**运行时代码**（CollectService 按「主键 ∪ 备用键」查）拦住，
--   所以本脚本是一次性清历史，不是长期机制。
--
-- 归一后的终态（幸存者 = 加密键那一行）：
--   · 幸存者 platform_user_id_alt = 被兼并方的数字 uid
--   · 幸存者 first/last_collected_at 取两行的最早/最晚（别丢「首次见到他」的时刻）
--   · 幸存者 version_count 重算
--   · 简历版本、附件全部落到幸存者名下；**被兼并方那份重复版本（同 hash）删除**
--   · 被兼并方 merged_into 指向幸存者（列表已按 merged_into IS NULL 过滤）
--
-- 为什么被兼并方那份版本是「删」而不是「改挂」：
--   两行内容哈希完全相同（陈诗健都是 0418b86c…；谢建广都是 0382ace0…），
--   而 (candidate_id, content_hash) 是**数据库唯一键**，改挂必然 ERROR 1062。
--   保留幸存者那一份（而不是落后方那份更早的 id）的理由：
--   ① 现有 attachment 就指向幸存者那份，保留它不需要改附件指针，风险最小；
--   ② 两份的 content_hash 相同 = 字段内容完全一致，不存在信息损失。
--
-- 为什么不动 collect_audit：
--   审计是 append-only（代码注释明确「永不 UPDATE/DELETE」），本脚本一行都不改。
--   归并前那几条审计的 candidate_id 仍指向被兼并行 —— 这是**刻意**的。
--   它们不会丢：审计行自带 platform_user_id，中台详情页已按「主键 ∪ 备用键」把它们一并查出。
--
-- 幂等 / 可续跑策略：
--   配对条件允许「落后方已指向本幸存者」（`num.merged_into = enc.id`），因此
--   首跑中断后重跑能接着做完；已完成的步骤（COALESCE / LEAST / GREATEST / 同值赋值）本身幂等，
--   零副作用。真正的终态不变量由 §8 的三条自检把守。
-- ====================================

DROP TEMPORARY TABLE IF EXISTS tmp_dual_pair;
DROP TEMPORARY TABLE IF EXISTS tmp_ver_dup;
DROP TEMPORARY TABLE IF EXISTS tmp_ver_keep;

-- ---------- 0) 执行前预览：将要归并哪些对（请先看一眼再往下） ----------
SELECT enc.id                AS 幸存者id,
       enc.platform_user_id  AS 幸存者规范键,
       num.id                AS 被兼并id,
       num.platform_user_id  AS 被兼并备用键,
       enc.name              AS 姓名,
       enc.version_count     AS 幸存者版本数,
       num.version_count     AS 被兼并版本数
FROM candidate enc
JOIN candidate num
  ON  num.platform = enc.platform
  AND num.platform_user_id = enc.source_platform_user_raw
  AND num.id <> enc.id
WHERE enc.merged_into IS NULL
  AND (num.merged_into IS NULL OR num.merged_into = enc.id)
  AND enc.platform_user_id REGEXP '[A-Za-z]'
  AND num.platform_user_id REGEXP '^[0-9]+$'
  AND num.name <=> enc.name;

-- ---------- 1) 配对表 ----------
CREATE TEMPORARY TABLE tmp_dual_pair AS
SELECT enc.id                 AS survivor_id,
       enc.platform           AS platform,
       num.id                 AS loser_id,
       num.platform_user_id   AS loser_pid,
       num.first_collected_at AS loser_first_at,
       num.last_collected_at  AS loser_last_at
FROM candidate enc
JOIN candidate num
  ON  num.platform = enc.platform
  AND num.platform_user_id = enc.source_platform_user_raw
  AND num.id <> enc.id
WHERE enc.merged_into IS NULL
  AND (num.merged_into IS NULL OR num.merged_into = enc.id)
  AND enc.platform_user_id REGEXP '[A-Za-z]'
  AND num.platform_user_id REGEXP '^[0-9]+$'
  AND num.name <=> enc.name;

-- 已收敛的对会被重复列出（刻意如此，保证可续跑）；真正的判定看 §8
SELECT COUNT(*) AS 本轮涉及归并对数 FROM tmp_dual_pair;   -- 期望 2（陈诗健、谢建广）

-- ---------- 2) 幸存者：补备用键 + 时间取并集 ----------
UPDATE candidate s
JOIN tmp_dual_pair p ON p.survivor_id = s.id
SET s.platform_user_id_alt = COALESCE(s.platform_user_id_alt, p.loser_pid),
    s.first_collected_at   = LEAST(s.first_collected_at, p.loser_first_at),
    s.last_collected_at    = GREATEST(s.last_collected_at, p.loser_last_at);

-- ---------- 3) 被兼并方：标记归并目标 ----------
UPDATE candidate c
JOIN tmp_dual_pair p ON p.loser_id = c.id
SET c.merged_into = p.survivor_id;

-- ---------- 4) 版本去重（**必须在改挂之前**）----------
-- 4a) 落后方中「幸存者已有同 hash」的版本 → 待删；并记下对应的保留版本
--     这里用 `=`（不是 `<=>`）：NULL hash 不参与判重 —— 唯一键对 NULL 视为互不相同，
--     把 NULL 当重复删掉会平白丢一份快照。
CREATE TEMPORARY TABLE tmp_ver_dup AS
SELECT v.id           AS drop_id,
       k.id           AS keep_id,
       v.candidate_id AS loser_cid
FROM resume_version v
JOIN tmp_dual_pair p ON p.loser_id = v.candidate_id
JOIN resume_version k
  ON  k.candidate_id = p.survivor_id
  AND k.content_hash = v.content_hash;

SELECT COUNT(*) AS 待删的冲突版本数 FROM tmp_ver_dup;

-- 4b) 先救附件：指向「待删版本」的附件改指到保留版本（**必须在 DELETE 之前**，
--     否则附件会指到一个不存在的 resume_version_id）
UPDATE attachment a
JOIN tmp_ver_dup d ON d.drop_id = a.resume_version_id
SET a.resume_version_id = d.keep_id;

-- 4c) 再删冲突版本
DELETE v FROM resume_version v JOIN tmp_ver_dup d ON d.drop_id = v.id;

-- ---------- 5) 剩余版本改挂到幸存者 ----------
-- 走到这一步的版本，hash 与幸存者现有版本都不冲突，不会触发 uk_candidate_hash
UPDATE resume_version v
JOIN tmp_dual_pair p ON p.loser_id = v.candidate_id
SET v.candidate_id = p.survivor_id;

-- ---------- 6) 附件改挂到幸存者 ----------
UPDATE attachment a
JOIN tmp_dual_pair p ON p.loser_id = a.candidate_id
SET a.candidate_id = p.survivor_id;

-- ---------- 7) 幸存者冗余计数重算 ----------
UPDATE candidate s
JOIN tmp_dual_pair p ON p.survivor_id = s.id
SET s.version_count = (
    SELECT COUNT(*) FROM resume_version v WHERE v.candidate_id = s.id
);

-- ---------- 8) 执行后自检 ----------
-- 8a) 不应再有「版本仍挂在已归并的行上」
SELECT COUNT(*) AS 残留在已归并行上的版本
FROM resume_version v
JOIN candidate c ON c.id = v.candidate_id
WHERE c.merged_into IS NOT NULL;
-- 期望 0

-- 8b) 不应再有「附件仍挂在已归并的行上」
SELECT COUNT(*) AS 残留在已归并行上的附件
FROM attachment a
JOIN candidate c ON c.id = a.candidate_id
WHERE c.merged_into IS NOT NULL;
-- 期望 0

-- 8c) 不应存在悬空附件（resume_version_id 指向不存在的版本）
SELECT COUNT(*) AS 悬空附件数
FROM attachment a
LEFT JOIN resume_version v ON v.id = a.resume_version_id
WHERE a.resume_version_id IS NOT NULL AND v.id IS NULL;
-- 期望 0

-- 8d) 唯一键不变量：「同一 candidate + 同 content_hash」不可能多行（uk_candidate_hash 保证）
SELECT COUNT(*) AS 同候选人重复版本组数 FROM (
    SELECT candidate_id, content_hash
    FROM resume_version
    GROUP BY candidate_id, content_hash
    HAVING COUNT(*) > 1
) t;
-- 期望 0

-- 8e) 归并后全貌（人工核对：陈诗健/谢建广 应各剩一行，带备用键，且 merged_into 为 NULL）
SELECT c.id, c.platform_user_id, c.platform_user_id_alt, c.name, c.version_count, c.merged_into,
       c.first_collected_at, c.last_collected_at
FROM candidate c
ORDER BY c.name, c.id;
