SET NAMES utf8mb4;
-- ====================================
-- extension_token 增加过期时间列 expires_at
-- 依据：docs/design/channel-publish-seamless.md §4.1 接口契约 / §4.4 信任边界
--
-- 背景：无感化改造引入「中台登录态自动换取扩展 token」（POST /api/extension/session-token）
--      后，token 的签发从「人工在管理端生成、明文只出现一次」变成了
--      「任何能登录中台的人都能随时自动领到一张」。
--
--      风险面因此变化：
--        · 旧模型：签发是**人工动作**，天然有节流，泄露面小。
--        · 新模型：签发是**自动动作**，任何能在中台页面执行脚本的东西
--                 （例如用户另外装的恶意扩展）都能领到 token。
--      没有过期时间的话，一次泄露 = 永久有效。
--
-- 因此必须补 expires_at。配套约束（写在代码里，不靠 DDL）：
--        1. 只签发给 status='active' 的 sys_user；
--        2. 校验 Origin 白名单（扩展 ID 固定靠 manifest 的 key 字段）；
--        3. 新签发的 token 必须带 expires_at（建议 30 天）；
--        4. 权限语义不扩大——仍只有「拉 pending 草稿 + 回填 record」。
--
-- 存量行保持 NULL（= 永不过期）：不为已在用的扩展制造突然失效。
--      如需收敛存量，另行评估后再补 upgrade 脚本。
--
-- 索引 idx_status_expires (status, expires_at)：
--      供「按状态 + 是否过期」筛选使用（如管理端列表展示、将来的清理任务）。
--      注意不单独建 idx_expires——过期判定总是与 status 同时出现，
--      单列索引会让优化器有机会选错。
--
-- ⚠️ 执行顺序陷阱：db-bootstrap.sh 用 `ls sql/*.sql | sort` 全量执行，字典序下
--      `extension_token_alter_*` 排在 `extension_token_create_*` **之前**，
--      故对「表尚不存在」必须跳过。全新库由 create 脚本保证（已同步补列）。
--
-- 幂等策略：查 information_schema 判表/列/索引存在性后再 PREPARE/EXECUTE，可重复执行。
--
-- 注释收敛（第 3 段）：列注释**不引文档节号**，只引文档名。
--      原因：节号会随文档重构漂移，而列注释一旦落库就被冻结在 DB 里
--      （已有实例显示旧注释仍指向重构前的 §3.4），没人会回头扫全库改注释。
--      本脚本在「列已存在但注释与真源不一致」时才发 MODIFY COLUMN 收敛，
--      注释一致则完全跳过——保证重复执行依旧零改动。
-- ====================================

-- ---------- 0) 表存在性 ----------
SET @tbl_exists := (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'extension_token'
);

-- ---------- 1) 列 expires_at ----------
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'extension_token'
      AND COLUMN_NAME = 'expires_at'
);

SET @ddl := IF(@tbl_exists = 0,
    'SELECT ''extension_token 表不存在（全新库），跳过加列——由 extension_token_create_*.sql 负责'' AS note',
    IF(@col_exists > 0,
        'SELECT ''extension_token.expires_at 已存在，跳过'' AS note',
        'ALTER TABLE extension_token ADD COLUMN expires_at DATETIME(3) NULL COMMENT ''过期时间（UTC）；NULL=永不过期。登录态自动签发场景必须填。见docs/design/channel-publish-seamless.md'' AFTER revoked_at'
    )
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 2) 索引 idx_status_expires ----------
SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'extension_token'
      AND INDEX_NAME = 'idx_status_expires'
);

SET @ddl2 := IF(@tbl_exists = 0,
    'SELECT ''extension_token 表不存在（全新库），跳过建索引'' AS note',
    IF(@idx_exists > 0,
        'SELECT ''extension_token.idx_status_expires 已存在，跳过'' AS note',
        'ALTER TABLE extension_token ADD INDEX idx_status_expires (status, expires_at)'
    )
);

PREPARE stmt2 FROM @ddl2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- ---------- 3) 注释收敛（列已存在时对齐 COMMENT，消除节号漂移） ----------
-- 与 extension_token_create_20260915_V1.sql 的列注释**必须逐字一致**，否则新库/老库注释分叉。
SET @want_comment := '过期时间（UTC）；NULL=永不过期。登录态自动签发场景必须填。见docs/design/channel-publish-seamless.md';

SET @cur_comment := (
    SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'extension_token'
      AND COLUMN_NAME = 'expires_at'
);

SET @ddl_comment := IF(@tbl_exists = 0 OR @col_exists = 0,
    'SELECT ''extension_token.expires_at 尚不存在，跳过注释收敛'' AS note',
    IF(@cur_comment <=> @want_comment,
        'SELECT ''extension_token.expires_at 注释已一致，跳过'' AS note',
        'ALTER TABLE extension_token MODIFY COLUMN expires_at DATETIME(3) NULL COMMENT ''过期时间（UTC）；NULL=永不过期。登录态自动签发场景必须填。见docs/design/channel-publish-seamless.md'' AFTER revoked_at'
    )
);

PREPARE stmt3 FROM @ddl_comment;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
