SET NAMES utf8mb4;
-- ====================================
-- 系统字典表建表（T1 基础表，原 docker/mysql/init/001_schema.sql 迁入）
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
-- 说明：DDL 与迁入前保持一致（仅补齐时间列 UTC 标注）；
--      uk_type_code 是种子脚本 INSERT IGNORE 幂等的前提，勿删。
-- ====================================

CREATE TABLE IF NOT EXISTS sys_dict (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '字典ID',
    type VARCHAR(64) NOT NULL COMMENT '字典类型',
    code VARCHAR(64) NOT NULL COMMENT '字典编码',
    label VARCHAR(128) NOT NULL COMMENT '字典标签',
    value VARCHAR(256) COMMENT '字典值',
    sort_order INT DEFAULT 0 COMMENT '排序',
    status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '状态',
    remark VARCHAR(256) COMMENT '备注',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_type_code (type, code),
    INDEX idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统字典表';
