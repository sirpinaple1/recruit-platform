SET NAMES utf8mb4;
-- ====================================
-- publish_record 增加「平台侧岗位 ID」映射三列 + 唯一索引
-- 依据：docs/design/candidate-position-linking.md（路径 A）
--
-- 存在理由：中台需求单与平台岗位之间**没有任何锚点**，导致采集到的
--   resume_version.fields_json.jobId 无法反查到 hr_request。
--   本列把「这次发布产生的是平台上的哪个岗位」记下来，映射即成立：
--     candidate_application.platform_job_id → 本列 → request_id → hr_request
--
-- 为什么落在 publish_record 而不是新建映射表：
--   台账本就一对一挂草稿、草稿挂需求单，加一列后「平台岗位 → 需求单」是
--   一次等值查询，不需要第二份真源（也就不会出现两份真源不同步）。
--
-- ★ 唯一键 (channel_id, platform_job_id) 是数据一致性的核心防线 ★
--   一个平台岗位**只能属于一个需求单**。若不加约束，同一个 BOSS 岗位被两条台账
--   各自绑定，同一候选人的投递就会被解析到两个需求单，投递数据直接分裂。
--   ⚠️ platform_job_id 可 NULL（尚未捕获），而 MySQL 唯一索引允许多个 NULL ——
--   正是我们要的语义：未绑定的行互相不冲突，已绑定的一旦重复立即报错。
--
-- bind_source 三态语义（自动与人工的边界，防「自动覆盖人工」）：
--   NULL   = 尚未绑定
--   auto   = 扩展发布成功后自动捕获（路径 A 写入）
--   manual = 中台人工绑定/更正（路径 B 写入）
--   规则：自动流程**只在 bind_source IS NULL 时**写入；人工可覆盖任何状态。
--   没有这一列的话，「HR 手工纠正过的绑定」会在下一次自动上报时被静默改回。
--
-- ⚠️ 执行顺序陷阱：scripts/db-bootstrap.sh 用 `ls sql/*.sql | sort` 全量执行，
--     字典序下 `publish_record_alter_*` 排在 `publish_record_create_*` **之前**
--     （'a' < 'c'）。故对「表尚不存在」必须跳过而不是报错：
--       · 全新库 → 跳过；正确性由 publish_record_create_*.sql 的列定义保证（已同步补列）
--       · 存量库 → 表在、列缺 → 执行 ALTER 收敛
--     两条路径终态一致。改动本表结构时 create 与 alter **必须成对同步**。
--
-- 幂等策略：查 information_schema 判表/列/索引存在性后再 PREPARE/EXECUTE，可重复执行。
-- ====================================

-- ---------- 0) 表存在性（后续各步共用） ----------
SET @tbl_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'publish_record'
);

-- ---------- 1) 列 platform_job_id ----------
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'publish_record'
      AND COLUMN_NAME = 'platform_job_id'
);

SET @want_comment_job := '平台侧岗位 ID（BOSS jobId，如 575500411）；机器映射键，与 published_url（人工可读链接）语义不同';

SET @ddl := IF(@tbl_exists = 0,
    'SELECT ''publish_record 表不存在（全新库），跳过加列 platform_job_id——由 publish_record_create_*.sql 负责'' AS note',
    IF(@col_exists > 0,
        'SELECT ''publish_record.platform_job_id 已存在，跳过'' AS note',
        'ALTER TABLE publish_record ADD COLUMN platform_job_id VARCHAR(64) NULL COMMENT ''平台侧岗位 ID（BOSS jobId，如 575500411）；机器映射键，与 published_url（人工可读链接）语义不同'' AFTER published_url'
    )
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2) 列 platform_job_bind_source ----------
SET @col_exists_src := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'publish_record'
      AND COLUMN_NAME = 'platform_job_bind_source'
);

SET @want_comment_src := '岗位 ID 来源：NULL 未绑定 / auto 扩展自动捕获（路径 A）/ manual 中台人工绑定（路径 B）；自动流程只在为 NULL 时写入';

SET @ddl_src := IF(@tbl_exists = 0,
    'SELECT ''publish_record 表不存在（全新库），跳过加列 platform_job_bind_source'' AS note',
    IF(@col_exists_src > 0,
        'SELECT ''publish_record.platform_job_bind_source 已存在，跳过'' AS note',
        'ALTER TABLE publish_record ADD COLUMN platform_job_bind_source VARCHAR(16) NULL COMMENT ''岗位 ID 来源：NULL 未绑定 / auto 扩展自动捕获（路径 A）/ manual 中台人工绑定（路径 B）；自动流程只在为 NULL 时写入'' AFTER platform_job_id'
    )
);

PREPARE stmt_src FROM @ddl_src;
EXECUTE stmt_src;
DEALLOCATE PREPARE stmt_src;

-- ---------- 3) 列 platform_job_bound_by ----------
SET @col_exists_by := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'publish_record'
      AND COLUMN_NAME = 'platform_job_bound_by'
);

SET @want_comment_by := '绑定岗位的操作人 sys_user.id；bind_source=manual 时有值（人工动作须可追溯）';

SET @ddl_by := IF(@tbl_exists = 0,
    'SELECT ''publish_record 表不存在（全新库），跳过加列 platform_job_bound_by'' AS note',
    IF(@col_exists_by > 0,
        'SELECT ''publish_record.platform_job_bound_by 已存在，跳过'' AS note',
        'ALTER TABLE publish_record ADD COLUMN platform_job_bound_by BIGINT UNSIGNED NULL COMMENT ''绑定岗位的操作人 sys_user.id；bind_source=manual 时有值（人工动作须可追溯）'' AFTER platform_job_bind_source'
    )
);

PREPARE stmt_by FROM @ddl_by;
EXECUTE stmt_by;
DEALLOCATE PREPARE stmt_by;

-- ---------- 4) 唯一索引 uk_channel_platform_job ----------
-- 复合 (channel_id, platform_job_id)：一个平台岗位只能属于一个需求单。
-- 也天然充当「按平台岗位查映射」的查询索引（恒定带 channel_id 等值）。
SET @uk_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'publish_record'
      AND INDEX_NAME = 'uk_channel_platform_job'
);

SET @ddl_uk := IF(@tbl_exists = 0,
    'SELECT ''publish_record 表不存在（全新库），跳过建唯一索引'' AS note',
    IF(@uk_exists > 0,
        'SELECT ''publish_record.uk_channel_platform_job 已存在，跳过'' AS note',
        'ALTER TABLE publish_record ADD UNIQUE KEY uk_channel_platform_job (channel_id, platform_job_id)'
    )
);

PREPARE stmt_uk FROM @ddl_uk;
EXECUTE stmt_uk;
DEALLOCATE PREPARE stmt_uk;

-- ---------- 5) 注释收敛（列已存在时对齐 COMMENT） ----------
-- 与 publish_record_create_20260915_V1.sql 的同名列注释**必须逐字一致**，否则新库/老库注释分叉。
SET @cur_job := (SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record' AND COLUMN_NAME = 'platform_job_id');
SET @cur_src := (SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record' AND COLUMN_NAME = 'platform_job_bind_source');
SET @cur_by := (SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record' AND COLUMN_NAME = 'platform_job_bound_by');

SET @ddl_c1 := IF(@tbl_exists = 0 OR @col_exists = 0 OR @cur_job <=> @want_comment_job,
    'SELECT ''publish_record.platform_job_id 注释已一致或列不存在，跳过'' AS note',
    'ALTER TABLE publish_record MODIFY COLUMN platform_job_id VARCHAR(64) NULL COMMENT ''平台侧岗位 ID（BOSS jobId，如 575500411）；机器映射键，与 published_url（人工可读链接）语义不同''');

SET @ddl_c2 := IF(@tbl_exists = 0 OR @col_exists_src = 0 OR @cur_src <=> @want_comment_src,
    'SELECT ''publish_record.platform_job_bind_source 注释已一致或列不存在，跳过'' AS note',
    'ALTER TABLE publish_record MODIFY COLUMN platform_job_bind_source VARCHAR(16) NULL COMMENT ''岗位 ID 来源：NULL 未绑定 / auto 扩展自动捕获（路径 A）/ manual 中台人工绑定（路径 B）；自动流程只在为 NULL 时写入''');

SET @ddl_c3 := IF(@tbl_exists = 0 OR @col_exists_by = 0 OR @cur_by <=> @want_comment_by,
    'SELECT ''publish_record.platform_job_bound_by 注释已一致或列不存在，跳过'' AS note',
    'ALTER TABLE publish_record MODIFY COLUMN platform_job_bound_by BIGINT UNSIGNED NULL COMMENT ''绑定岗位的操作人 sys_user.id；bind_source=manual 时有值（人工动作须可追溯）''');

PREPARE stmt_c1 FROM @ddl_c1; EXECUTE stmt_c1; DEALLOCATE PREPARE stmt_c1;
PREPARE stmt_c2 FROM @ddl_c2; EXECUTE stmt_c2; DEALLOCATE PREPARE stmt_c2;
PREPARE stmt_c3 FROM @ddl_c3; EXECUTE stmt_c3; DEALLOCATE PREPARE stmt_c3;

-- ---------- 6) 结论自检 ----------
SELECT
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record'
        AND COLUMN_NAME = 'platform_job_id')             AS col_job_ok,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record'
        AND COLUMN_NAME = 'platform_job_bind_source')    AS col_src_ok,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record'
        AND COLUMN_NAME = 'platform_job_bound_by')       AS col_by_ok,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'publish_record'
        AND INDEX_NAME = 'uk_channel_platform_job')      AS uk_ok;
-- 期望：col_job_ok=1 / col_src_ok=1 / col_by_ok=1 / uk_ok>=1
-- （全新库期望全 0，因为此时表尚不存在，由 create 脚本负责）
