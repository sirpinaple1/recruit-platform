SET NAMES utf8mb4;
-- ====================================
-- hr_request 增加「招聘负责人」归属列 owner_user_id
-- 依据：docs/architecture/adr/ADR-008-resource-ownership-authorization.md
--
-- 背景：岗位与发布草稿此前**没有任何数据级归属隔离**——任意登录用户（或任意扩展 token）
--      都能看到并操作全部岗位。ADR-008 引入归属维度，用于「只有负责该岗位的 HR
--      才能看到并发布」的授权判定。
--
-- 为什么不能复用 created_by：
--      created_by 是**审计字段**（谁创建了这行），owner 是**业务字段**（现在谁负责）。
--      人员交接、请假代管需要改 owner，但不应改写审计记录，故独立成列。
--      本轮两者取值相同（创建时 owner_user_id = created_by），语义已解耦。
--
-- NULL 语义（fail-closed，重要）：
--      owner_user_id IS NULL 表示「未指派」，该岗位对 HR **一律不可见、不可操作**，
--      仅 ADMIN 可见/可代发。存量行由 upgrade/hr_request_backfill_owner_20260916_V1.sql
--      回填为 created_by；若该回填漏跑，表现为「岗位凭空消失」——这是**有意设计**，
--      宁可响亮失败，也不让「未指派」静默退化成「人人可见」。
--
-- ⚠️ 执行顺序陷阱（本脚本存在的前提）：
--      scripts/db-bootstrap.sh 用 `ls sql/*.sql | sort` 全量执行，而字典序下
--      `hr_request_alter_*` 排在 `hr_request_create_*` **之前**。
--      因此本脚本对「表尚不存在」的情形必须**跳过而不是报错**：
--        · 全新库 → 跳过；正确性由 hr_request_create_*.sql 的列定义保证（已同步补列）
--        · 存量库 → 表在、列缺 → 执行 ALTER 收敛
--      两条路径终态一致。改动本表结构时，create 与 alter 必须成对同步，
--      否则新老库结构会静默分叉。
--
-- 幂等策略：先查 information_schema 判表/列/索引是否存在，不存在才 PREPARE/EXECUTE。
--      可重复执行（db-bootstrap.sh 每次都会跑本文件）。
--
-- 注释收敛（第 3 段）：列注释**不引文档节号**，只引文档名或 ADR 编号。
--      本段还会把 owner_user_id / created_by 的注释对齐 create 脚本，
--      仅在「已存在但注释不同」时才发 MODIFY COLUMN，一致则跳过 → 重复执行零改动。
-- ====================================

-- ---------- 0) 表存在性（后续两步共用） ----------
SET @tbl_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hr_request'
);

-- ---------- 1) 列 owner_user_id ----------
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hr_request'
      AND COLUMN_NAME = 'owner_user_id'
);

SET @ddl := IF(@tbl_exists = 0,
    'SELECT ''hr_request 表不存在（全新库），跳过加列——由 hr_request_create_*.sql 负责'' AS note',
    IF(@col_exists > 0,
        'SELECT ''hr_request.owner_user_id 已存在，跳过'' AS note',
        'ALTER TABLE hr_request ADD COLUMN owner_user_id BIGINT UNSIGNED NULL COMMENT ''招聘负责人sys_user.id（发布责任人；NULL=未指派，仅ADMIN可见、可操作。见ADR-008）'' AFTER created_by'
    )
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2) 索引 idx_owner ----------
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hr_request'
      AND INDEX_NAME = 'idx_owner'
);

SET @ddl2 := IF(@tbl_exists = 0,
    'SELECT ''hr_request 表不存在（全新库），跳过建索引'' AS note',
    IF(@idx_exists > 0,
        'SELECT ''hr_request.idx_owner 已存在，跳过'' AS note',
        'ALTER TABLE hr_request ADD INDEX idx_owner (owner_user_id)'
    )
);

PREPARE stmt2 FROM @ddl2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ---------- 3) 注释收敛（列已存在时对齐 COMMENT） ----------
-- 依据：docs/architecture/database-schema.md §5 —— 列注释不引文档节号，只引文档名。
--      与 hr_request_create_20260915_V1.sql 的同名列注释**必须逐字一致**，
--      否则新库/老库注释分叉（本节的 3b 就是实测抓到的这种分叉）。
--      仅在注释与期望值不一致时才发 MODIFY COLUMN，一致则跳过 → 重复执行零改动。

-- 3a) owner_user_id
SET @want_owner_comment := '招聘负责人sys_user.id（发布责任人；NULL=未指派，仅ADMIN可见、可操作。见ADR-008）';

SET @cur_owner_comment := (
    SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hr_request'
      AND COLUMN_NAME = 'owner_user_id'
);

SET @ddl_c1 := IF(@tbl_exists = 0 OR @col_exists = 0,
    'SELECT ''hr_request.owner_user_id 尚不存在，跳过注释收敛'' AS note',
    IF(@cur_owner_comment <=> @want_owner_comment,
        'SELECT ''hr_request.owner_user_id 注释已一致，跳过'' AS note',
        'ALTER TABLE hr_request MODIFY COLUMN owner_user_id BIGINT UNSIGNED NULL COMMENT ''招聘负责人sys_user.id（发布责任人；NULL=未指派，仅ADMIN可见、可操作。见ADR-008）'' AFTER created_by'
    )
);

PREPARE stmt3 FROM @ddl_c1;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- 3b) created_by —— ADR-008 把它的语义钉成「审计字段，业务上不承载归属」，
--     这句限定必须出现在库里（开发者查 DDL 时看得到），否则容易被拿去当归属字段用。
--     实测：存量库仍是旧注释「创建人sys_user.id」，全新库已是新注释 → 分叉，在此收敛。
--     注意 MODIFY COLUMN **不写 AFTER**，让列留在原位（写错 AFTER 会静默改列序）。
SET @want_createdby_comment := '创建人sys_user.id（审计字段，业务上不承载归属）';

SET @cur_createdby_comment := (
    SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hr_request'
      AND COLUMN_NAME = 'created_by'
);

SET @ddl_c2 := IF(@tbl_exists = 0,
    'SELECT ''hr_request 表不存在，跳过 created_by 注释收敛'' AS note',
    IF(@cur_createdby_comment <=> @want_createdby_comment,
        'SELECT ''hr_request.created_by 注释已一致，跳过'' AS note',
        'ALTER TABLE hr_request MODIFY COLUMN created_by BIGINT UNSIGNED NULL COMMENT ''创建人sys_user.id（审计字段，业务上不承载归属）'''
    )
);

PREPARE stmt4 FROM @ddl_c2;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;
