SET NAMES utf8mb4;
-- ====================================
-- candidate 增加「同一人的另一种 ID 形态」列 platform_user_id_alt
-- 依据：《Chrome插件简历采集-分阶段任务框架》§2 Phase 1.3 幂等与归并（本轮按用户决策改为「写入时归一」）
--
-- 背景（真机实测后果，不是假设）：
--   BOSS 同一个人有两种 ID 形态 ——
--     · 聊天消息 / 会话列表给**数字** uid：608120464
--     · 候选人卡片 / 简历详情给**加密** geekId：01858de472ad39180XRy2t-9FFRU
--   而旧实现只按 platform_user_id **单键**查候选人，于是「先采到数字、后采到加密」
--   就分裂成两条记录。实测已产生两对：
--     陈诗健：608120464（06:41）+ 01858de472ad39180XRy2t-9FFRU（07:16）
--     谢建广：681940311（06:40）+ f4c1f17734410c500Xx70tm9E1NR（07:49）
--   用户决策：**写入时归一** —— 任一形态都要落回同一行；有新的简历时直接追加到该人的明细下。
--
-- 为什么单独立一列而不是复用 source_platform_user_raw：
--   后者语义是「**首次**采集时的原始 ID 文本」，只写一次、纯对账用（见 create 脚本注释）。
--   本列是**活的查找键**：会随「学习到的新形态」补齐，且参与幂等查询。两者不可混用。
--
-- 为什么不做唯一约束（刻意的）：
--   备用键是「学习到的另一种形态」，唯一约束会让归并脚本在同键冲突时整批失败，
--   而归并收敛本该由 upgrade 脚本自己负责。查候选人是
--   `platform_user_id IN (…) OR platform_user_id_alt IN (…)` 的 OR 形态，
--   两侧各自需要索引，故建**复合非唯一**索引 (platform, platform_user_id_alt)。
--
-- ⚠️ 执行顺序陷阱：scripts/db-bootstrap.sh 用 `ls sql/*.sql | sort` 全量执行，字典序下
--      `candidate_alter_*` 排在 `candidate_create_*` **之前**（'a' < 'c'）。
--      故对「表尚不存在」必须跳过而不是报错：
--        · 全新库 → 跳过；正确性由 candidate_create_*.sql 的列定义保证（已同步补列）
--        · 存量库 → 表在、列缺 → 执行 ALTER 收敛
--      两条路径终态一致。改动本表结构时 create 与 alter **必须成对同步**。
--
-- 幂等策略：查 information_schema 判表/列/索引存在性后再 PREPARE/EXECUTE，可重复执行。
--
-- 注释收敛（最后一段）：列注释不引文档节号，只引文档名。仅在「列已存在但注释不同」时
--      才发 MODIFY COLUMN，一致则跳过 → 重复执行零改动；且**不写 AFTER**，避免静默改列序。
-- ====================================

-- ---------- 0) 表存在性（后续各步共用） ----------
SET @tbl_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'candidate'
);

-- ---------- 1) 列 platform_user_id_alt ----------
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'candidate'
      AND COLUMN_NAME = 'platform_user_id_alt'
);

SET @want_col_comment := '同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId），参与幂等查找；与 source_platform_user_raw（只写一次的对账字段）语义不同';

SET @ddl := IF(@tbl_exists = 0,
    'SELECT ''candidate 表不存在（全新库），跳过加列——由 candidate_create_*.sql 负责'' AS note',
    IF(@col_exists > 0,
        'SELECT ''candidate.platform_user_id_alt 已存在，跳过'' AS note',
        'ALTER TABLE candidate ADD COLUMN platform_user_id_alt VARCHAR(64) NULL COMMENT ''同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId），参与幂等查找；与 source_platform_user_raw（只写一次的对账字段）语义不同'' AFTER platform_user_id'
    )
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2) 索引 idx_platform_user_alt ----------
-- 复合 (platform, platform_user_id_alt)：查询恒定带 platform，单列索引会让优化器有机会选错。
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'candidate'
      AND INDEX_NAME = 'idx_platform_user_alt'
);

SET @ddl2 := IF(@tbl_exists = 0,
    'SELECT ''candidate 表不存在（全新库），跳过建索引'' AS note',
    IF(@idx_exists > 0,
        'SELECT ''candidate.idx_platform_user_alt 已存在，跳过'' AS note',
        'ALTER TABLE candidate ADD INDEX idx_platform_user_alt (platform, platform_user_id_alt)'
    )
);

PREPARE stmt2 FROM @ddl2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ---------- 3) 注释收敛（列已存在时对齐 COMMENT） ----------
-- 与 candidate_create_20260921_V1.sql 的同名列注释**必须逐字一致**，否则新库/老库注释分叉。
SET @cur_col_comment := (
    SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'candidate'
      AND COLUMN_NAME = 'platform_user_id_alt'
);

SET @ddl3 := IF(@tbl_exists = 0 OR @col_exists = 0,
    'SELECT ''candidate.platform_user_id_alt 尚不存在，跳过注释收敛'' AS note',
    IF(@cur_col_comment <=> @want_col_comment,
        'SELECT ''candidate.platform_user_id_alt 注释已一致，跳过'' AS note',
        'ALTER TABLE candidate MODIFY COLUMN platform_user_id_alt VARCHAR(64) NULL COMMENT ''同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId），参与幂等查找；与 source_platform_user_raw（只写一次的对账字段）语义不同'''
    )
);

PREPARE stmt3 FROM @ddl3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- ---------- 4) 结论自检 ----------
SELECT
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'candidate'
        AND COLUMN_NAME = 'platform_user_id_alt')            AS col_ok,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'candidate'
        AND INDEX_NAME = 'idx_platform_user_alt')            AS idx_ok;
-- 期望：col_ok=1 且 idx_ok>=1
