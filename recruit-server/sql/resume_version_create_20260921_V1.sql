SET NAMES utf8mb4;
-- ====================================
-- resume_version 简历版本建表
-- 依据：《Chrome插件简历采集-分阶段任务框架》§2 Phase 1.3 幂等与归并
--
-- 存在理由：候选人可被多次采集（会话变化、平台资料更新、不同链路各拿一份），
--   每次采集落一条版本，保留「什么时候从哪条链路拿到了什么」的完整证据链。
--
-- 幂等：同一候选人下按 content_hash（归一字段 JSON 的 SHA-256）去重，
--   内容一致则复用旧版本，不产生新行（重复点采集不污染数据）。
--
-- 为什么 raw_json 用 MEDIUMTEXT 而不是 JSON 列：
--   在线简历详情页（/wapi/zpjob/view/geek/info/v2）返回的是密文串
--   （encryptGeekDetailInfo），不是合法 JSON，用 JSON 列会被 MySQL 拒绝。
--   故 raw 一律按文本存，raw_encrypted 标记它是不是密文原文（一期不解密）。
--
-- 字段快照与原始快照都必须留（框架 §6 红线：保留 raw 便于重解析）。
-- ====================================

CREATE TABLE IF NOT EXISTS resume_version (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    candidate_id BIGINT UNSIGNED NOT NULL COMMENT '关联 candidate.id',
    platform VARCHAR(32) NOT NULL COMMENT '冗余：来源平台，便于按平台对账',
    source VARCHAR(32) NOT NULL COMMENT '采集链路：chat 聊天 / list 列表 / detail 详情页',
    source_api VARCHAR(255) NULL COMMENT '具体接口路径（如 /wapi/zpjob/chat/geek/info）',
    platform_resume_id VARCHAR(128) NULL COMMENT '平台侧简历 ID（如 encryptResumeId），有则填',
    fields_json JSON NULL COMMENT '归一后的结构化字段（工作经历/教育经历/期望等）',
    field_count INT NOT NULL DEFAULT 0 COMMENT '归一字段个数，用于快速判断质量',
    raw_json MEDIUMTEXT NULL COMMENT '原始响应体快照；详情页密文原样存于此',
    raw_encrypted TINYINT NOT NULL DEFAULT 0 COMMENT '1=raw_json 为密文原文，一期不解密（见 ADJUST-1）',
    raw_bytes INT UNSIGNED NULL COMMENT '原始快照字符数（截断前），判断是否被截断',
    raw_truncated TINYINT NOT NULL DEFAULT 0 COMMENT '1=原始快照在扩展端被截断，不可当完整证据',
    content_hash CHAR(64) NOT NULL COMMENT '归一字段 JSON 的 SHA-256，同候选人内去重键',
    source_url VARCHAR(1024) NULL COMMENT '采集时的来源 URL（页面侧绝对化后）',
    collected_at DATETIME(3) NOT NULL COMMENT '采集时刻（客户端上报，UTC）',
    operated_by BIGINT UNSIGNED NULL COMMENT '操作人 sys_user.id（扩展 token 关联用户）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '落库时间（UTC）',
    PRIMARY KEY (id),
    UNIQUE KEY uk_candidate_hash (candidate_id, content_hash),
    INDEX idx_candidate_time (candidate_id, collected_at),
    INDEX idx_platform (platform, platform_resume_id),
    INDEX idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='简历版本（候选人 1..n，保留原始快照）';
