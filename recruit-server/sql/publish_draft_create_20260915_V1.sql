SET NAMES utf8mb4;
-- ====================================
-- T3.2 publish_draft 发布草稿建表
-- 依据：docs/design/channel-publish.md §5.3
-- 规则：同一 (request, channel) 只允许一条 pending；
--      重新生成时旧草稿置 cancelled，台账 record 保留审计（T3.3）
-- ====================================

CREATE TABLE IF NOT EXISTS publish_draft (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '草稿ID（雪花ID）',
    request_id BIGINT UNSIGNED NOT NULL COMMENT '所属需求 hr_request.id',
    channel_id BIGINT UNSIGNED NOT NULL COMMENT '渠道 channel.id',
    fields_json JSON NOT NULL COMMENT '按渠道映射渲染好的字段值（仅白名单公开字段，§5.3）',
    deep_link VARCHAR(512) COMMENT '实例化深链（{requestNo} 已替换，随 JD 粘贴到平台）',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/consumed/cancelled',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    INDEX idx_request (request_id),
    INDEX idx_channel (channel_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发布草稿';
