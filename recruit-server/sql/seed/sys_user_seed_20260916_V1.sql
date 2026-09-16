SET NAMES utf8mb4;
-- ====================================
-- 种子账号（原 docker/mysql/init/002_data.sql 迁入）
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
-- 幂等：INSERT IGNORE 依赖 PK(id) 与 UNIQUE(username)，可重复执行
-- 账号：admin/admin123（管理员）、hr001/hr123456（HR）
-- 注意：BCrypt 哈希由工具生成，勿手改；生产环境须改密
-- ====================================

INSERT IGNORE INTO sys_user (id, username, password, real_name, role, status) VALUES
(1, 'admin', '$2a$10$fXCKeAyxtbw/P2qlvMzrvO3EZtSDRbXVCxu7nwCv03nYLk7Wvgupy', '系统管理员', 'ADMIN', 'active'),
(2, 'hr001', '$2a$10$wAF4a73ZFo33vCwhPYZH9uZ/q1qPMVncJ1xSek1jdBgHaW5TMJAJm', 'HR张三', 'HR', 'active');
