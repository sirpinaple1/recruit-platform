SET NAMES utf8mb4;
-- ====================================
-- 一次性迁移：旧一代孤儿表改名冻结
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
-- 场景：仅适用于「曾执行过旧版 docker/mysql/init/001_schema.sql」的既有环境。
--      全新环境不会再创建这 6 张表，无需执行本脚本。
-- 目的：这 6 张表来自旧一代「职位中心」设计（candidate_resume.job_id 等），
--      与现行「候选人与应聘流程分离」模型冲突，且无任何代码引用。
--      改名加 _legacy_ 前缀并冻结：保留数据可回退，同时杜绝被误认为现行设计。
-- 幂等：仅当「原名存在 且 目标名不存在」时执行，重复运行安全
-- 执行：mysql -h 127.0.0.1 -P 3307 -uroot -p recruit_platform < 本文件
-- ====================================

-- 前置校验：必须已选定数据库，否则下方条件全部不成立（静默不生效）
SELECT IF(
    DATABASE() IS NULL,
    '【警告】未选择数据库，本脚本不会生效。请以 `mysql ... recruit_platform < 本文件` 方式执行',
    CONCAT('目标库: ', DATABASE())
) AS precheck;

-- candidate -> _legacy_candidate
SET @src := 'candidate'; SET @dst := '_legacy_candidate';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- candidate_resume -> _legacy_candidate_resume
SET @src := 'candidate_resume'; SET @dst := '_legacy_candidate_resume';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- resume_score -> _legacy_resume_score
SET @src := 'resume_score'; SET @dst := '_legacy_resume_score';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ai_training_sample -> _legacy_ai_training_sample
SET @src := 'ai_training_sample'; SET @dst := '_legacy_ai_training_sample';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- idempotency_record -> _legacy_idempotency_record
SET @src := 'idempotency_record'; SET @dst := '_legacy_idempotency_record';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ai_metric -> _legacy_ai_metric
SET @src := 'ai_metric'; SET @dst := '_legacy_ai_metric';
SET @sql := IF(
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @src) = 1
    AND (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = @dst) = 0,
    CONCAT('RENAME TABLE `', @src, '` TO `', @dst, '`'), 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 核对：预期现行 7 张业务表 + 6 张 _legacy_ 表
SELECT table_name, table_comment
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY (table_name LIKE '\_legacy\_%') ASC, table_name ASC;
