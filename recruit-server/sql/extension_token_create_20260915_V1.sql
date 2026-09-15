SET NAMES utf8mb4;
-- ====================================
-- T3.3 extension_token 扩展授权建表
-- 依据：docs/design/channel-publish.md §5.5
-- 红线：token_hash 只存 SHA-256，明文仅创建响应返回一次，不落库不落日志；
--      权限语义：仅可 ①拉 pending 草稿 ②回填 record（最小权限），吊销即 401
-- ====================================

CREATE TABLE IF NOT EXISTS extension_token (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '授权ID（雪花ID）',
    token_hash VARCHAR(128) NOT NULL COMMENT 'SHA-256(token) 十六进制，明文永不落库',
    name VARCHAR(64) NOT NULL COMMENT '授权名称（如：HR张三的浏览器扩展）',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '关联 sys_user.id（operated_by 来源）',
    status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '状态：active/revoked',
    last_used_at DATETIME(3) NULL COMMENT '最近一次扩展端请求时间（UTC）',
    revoked_at DATETIME(3) NULL COMMENT '吊销时间（UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_token_hash (token_hash),
    INDEX idx_user (user_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='扩展授权（浏览器扩展独立鉴权）';
