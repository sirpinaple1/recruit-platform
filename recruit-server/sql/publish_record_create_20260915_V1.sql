SET NAMES utf8mb4;
-- ====================================
-- T3.3 publish_record 发布台账建表
-- 依据：docs/design/channel-publish.md §5.4
-- 规则：与 publish_draft 一对一（draft_id UNIQUE）；approve 渲染草稿时同步建 pending 台账，
--      扩展端回填终结为 published/failed；需求关闭/重渲染时未回填台账置 failed（保留审计）
-- ====================================

CREATE TABLE IF NOT EXISTS publish_record (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '台账ID（雪花ID）',
    draft_id BIGINT UNSIGNED NOT NULL COMMENT '关联草稿 publish_draft.id（一对一）',
    request_id BIGINT UNSIGNED NOT NULL COMMENT '冗余：所属需求 hr_request.id',
    channel_id BIGINT UNSIGNED NOT NULL COMMENT '冗余：渠道 channel.id',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/published/failed',
    account_label VARCHAR(64) NULL COMMENT '平台账号文本标识（非凭据，红线：永不采集凭据）',
    published_url VARCHAR(512) NULL COMMENT '发布成功后的岗位链接（HR 回填）',
    result_note VARCHAR(512) NULL COMMENT '结果备注（回填写入/系统终结原因）',
    operated_by BIGINT UNSIGNED NULL COMMENT '操作人 sys_user.id（扩展 token 关联用户）',
    published_at DATETIME(3) NULL COMMENT '发布成功时间（UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_draft (draft_id),
    INDEX idx_request (request_id),
    INDEX idx_channel (channel_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发布台账';
