SET NAMES utf8mb4;
-- ====================================
-- T3.3 publish_record 发布台账建表
-- 依据：docs/design/channel-publish.md §5.4、docs/design/candidate-position-linking.md
-- 规则：与 publish_draft 一对一（draft_id UNIQUE）；approve 渲染草稿时同步建 pending 台账，
--      扩展端回填终结为 published/failed；需求关闭/重渲染时未回填台账置 failed（保留审计）
--
-- ★ 平台岗位映射三列（2026-09-22 增，路径 A）★
--   platform_job_id / platform_job_bind_source / platform_job_bound_by 用来把
--   「平台上的一个岗位」锚定到「中台的一个需求单」，否则候选人的投递无法归类。
--   唯一键 uk_channel_platform_job (channel_id, platform_job_id) 是一致性核心防线：
--   一个平台岗位只能属于一个需求单；未绑定（NULL）的行互不冲突（MySQL 唯一索引允许多 NULL）。
--   与同名 alter 脚本 publish_record_alter_add_platform_job_id_20260922_V1.sql
--   **必须成对同步**（列注释也须逐字一致），否则新库/老库结构静默分叉。
-- ====================================

CREATE TABLE IF NOT EXISTS publish_record (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '台账ID（雪花ID）',
    draft_id BIGINT UNSIGNED NOT NULL COMMENT '关联草稿 publish_draft.id（一对一）',
    request_id BIGINT UNSIGNED NOT NULL COMMENT '冗余：所属需求 hr_request.id',
    channel_id BIGINT UNSIGNED NOT NULL COMMENT '冗余：渠道 channel.id',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/published/failed',
    account_label VARCHAR(64) NULL COMMENT '平台账号文本标识（非凭据，红线：永不采集凭据）',
    published_url VARCHAR(512) NULL COMMENT '发布成功后的岗位链接（HR 回填）',
    platform_job_id VARCHAR(64) NULL COMMENT '平台侧岗位 ID（BOSS jobId，如 575500411）；机器映射键，与 published_url（人工可读链接）语义不同',
    platform_job_bind_source VARCHAR(16) NULL COMMENT '岗位 ID 来源：NULL 未绑定 / auto 扩展自动捕获（路径 A）/ manual 中台人工绑定（路径 B）；自动流程只在为 NULL 时写入',
    platform_job_bound_by BIGINT UNSIGNED NULL COMMENT '绑定岗位的操作人 sys_user.id；bind_source=manual 时有值（人工动作须可追溯）',
    result_note VARCHAR(512) NULL COMMENT '结果备注（回填写入/系统终结原因）',
    operated_by BIGINT UNSIGNED NULL COMMENT '操作人 sys_user.id（扩展 token 关联用户）',
    published_at DATETIME(3) NULL COMMENT '发布成功时间（UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_draft (draft_id),
    UNIQUE KEY uk_channel_platform_job (channel_id, platform_job_id),
    INDEX idx_request (request_id),
    INDEX idx_channel (channel_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发布台账';
