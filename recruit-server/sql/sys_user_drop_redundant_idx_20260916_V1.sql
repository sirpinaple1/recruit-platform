SET NAMES utf8mb4;
-- ====================================
-- 删除 sys_user 上的冗余索引 idx_username
-- 依据：docs/architecture/database-schema.md「已知缺陷」
--
-- 背景：username 列声明为 `VARCHAR(64) NOT NULL UNIQUE`，MySQL 会据此建立名为
--      `username` 的唯一索引；原 DDL 又额外声明了 `INDEX idx_username (username)`，
--      形成同列双索引。唯一索引已能服务等值查找（登录查询就走它），
--      普通索引属于纯冗余：多一份写入开销与存储，无任何查询收益。
--
-- 为什么需要单独脚本：CREATE TABLE IF NOT EXISTS 对已存在的表不生效，
--      所以修正后的 DDL 只能保证「新库」正确，存量库必须靠这条 ALTER 收敛。
--
-- 幂等策略：MySQL 8 不支持 DROP INDEX IF EXISTS，故先查 information_schema，
--      不存在则执行一句无害的 SELECT 跳过。可重复执行。
-- ====================================

SET @idx_exists := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sys_user'
      AND INDEX_NAME = 'idx_username'
);

SET @ddl := IF(@idx_exists > 0,
    'ALTER TABLE sys_user DROP INDEX idx_username',
    'SELECT ''sys_user.idx_username 不存在，跳过'' AS note');

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
