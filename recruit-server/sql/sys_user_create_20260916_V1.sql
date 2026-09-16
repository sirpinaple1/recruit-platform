SET NAMES utf8mb4;
-- ====================================
-- 系统用户表建表（T1 基础表，原 docker/mysql/init/001_schema.sql 迁入）
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
-- 说明：DDL 与迁入前保持一致，仅两处改动：
--      1) 补齐时间列 UTC 标注；
--      2) 删除列上的冗余索引 idx_username —— username 已由 UNIQUE 约束
--         建成名为 `username` 的唯一索引，再建同列普通索引纯属双份写入开销。
--         存量库的收敛见同目录 sys_user_drop_redundant_idx_20260916_V1.sql。
--      CREATE TABLE IF NOT EXISTS 可重复执行。
-- ====================================

CREATE TABLE IF NOT EXISTS sys_user (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '用户ID',
    username VARCHAR(64) NOT NULL UNIQUE COMMENT '用户名',
    password VARCHAR(255) NOT NULL COMMENT '密码（BCrypt加密）',
    real_name VARCHAR(64) COMMENT '真实姓名',
    email VARCHAR(128) COMMENT '邮箱',
    phone VARCHAR(32) COMMENT '手机号',
    role VARCHAR(32) NOT NULL DEFAULT 'HR' COMMENT '角色：ADMIN/HR/INTERVIEWER（见 com.recruit.common.Roles）',
    status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '状态：active/inactive',
    last_login_at DATETIME(3) COMMENT '最后登录时间（UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统用户表';
