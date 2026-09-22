SET NAMES utf8mb4;
-- ====================================
-- schema_migration —— DDL 执行台账（scripts/db-migrate.sh 维护）
-- 依据：docs/conventions/db-migration-cd.md
-- 事故来源：docs/troubleshooting/collect-500-schema-drift-20260922.md
--
-- 存在理由：在此之前 sql/*.sql 的 DDL 只靠「人工记得执行」。
--   2026-09-22 漏掉一步 ALTER，导致上线的新代码对着旧结构跑
--   （candidate.platform_user_id_alt 缺列 → 采集入库第一步 Unknown column → 全局兜底 500）。
--   本表让「跑过哪些脚本、内容是什么、什么时候跑的、成功还是失败」变成可核对的事实。
--
-- 为什么记 checksum 而不是只记文件名：
--   本仓库的 sql/*.sql 是**幂等收敛脚本**（不是 Flyway 那种不可变版本脚本），
--   改了守卫/注释后需要**重跑**才能收敛。记 checksum 才能区分
--   「已跑过且内容没变（跳过）」与「已跑过但内容变了（重跑）」。
--   注意这与 Flyway 的语义相反：Flyway 认为脚本不可变、checksum 变了要报错。
--
-- 为什么 PRIMARY KEY 是 script 而不是自增 id + 执行历史：
--   一个脚本在库里只应有「当前状态」这一行；重复执行 UPDATE 同一行即可。
--   历史执行记录在 CI job 日志里，不适合堆在一张会无限增长的表里。
--
-- 幂等：CREATE TABLE IF NOT EXISTS，可重复执行（与其它 sql/*.sql 口径一致）。
-- ====================================

CREATE TABLE IF NOT EXISTS schema_migration (
    script      VARCHAR(191) NOT NULL COMMENT 'sql/ 下相对路径（如 candidate_create_20260921_V1.sql）；upgrade 的带 upgrade/ 前缀',
    checksum    CHAR(64)     NOT NULL COMMENT '脚本内容的 SHA-256（小写十六进制），用于判断「内容变没变」',
    status      VARCHAR(16)  NOT NULL COMMENT 'applied=已成功；failed=执行失败（下次运行会重试该脚本）',
    duration_ms INT UNSIGNED NULL COMMENT '最近一次执行耗时（毫秒），用于发现「越跑越慢」的大表 DDL',
    applied_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最近一次执行时间（UTC，见 ADR-006；由 UTC_TIMESTAMP(3) 写入）',
    error       TEXT         NULL COMMENT '失败时的错误摘要（仅摘要，因引号已被剥离；完整输出见 CI job 日志）',
    PRIMARY KEY (script),
    INDEX idx_applied_at (applied_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='DDL 执行台账（scripts/db-migrate.sh 维护）';
