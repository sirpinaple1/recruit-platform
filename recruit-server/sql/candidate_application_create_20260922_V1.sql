SET NAMES utf8mb4;
-- ====================================
-- candidate_application 候选人投递事实建表
-- 依据：docs/design/candidate-position-linking.md
--
-- 存在理由：采集已经拿到「候选人投递了哪个平台岗位」（真机 6/6 命中 fields_json.jobId），
--   但缺一张表把这条事实**按「人 × 岗位」落下来**。旧结构里岗位线索只是
--   resume_version.fields_json 里的一个不透明 JSON 键，既不能查（无索引）、
--   也不能与 hr_request 关联（无外键列）。
--
-- 为什么单独立表，而不是往 candidate 加一列：
--   1) candidate 是**人的主体**（幂等键 platform + platform_user_id），职位是**行为**：
--      同一个人可以投多个岗位，1:N；
--   2) CollectService.applySummary 的语义是「只补空不覆盖」（低质量采集不得污染
--      已有更完整字段），把职位塞进 candidate 单列会让**第二次投递被静默吞掉**；
--   3) 与既有分层一致：resume_version 是「同一事实的多个快照」，
--      application 是「不同的事实」，两者不可混。
--
-- 为什么 platform_job_id 是 NOT NULL 而 request_id 可 NULL：
--   采集侧拿到的是**平台岗位 ID**（事实，必然存在才值得落行）；
--   中台需求单 ID 是**派生值**——要先把平台岗位映射到需求单（经 publish_record.platform_job_id）。
--   映射未建立时留 NULL，**绝不**用标题模糊匹配去猜（标题是人工两次输入，必漂移；
--   实测库里同时存在「Java高级工程师」与「Java工程师」）。
--   映射建立后由 CandidateApplicationService 级联重算补齐，见 design 文档 §4.2。
--
-- 幂等键：platform + candidate_id + platform_job_id
--   同一候选人对同一岗位重复采集**不产生新行**（与 resume_version 的 content_hash 去重
--   是同一个手法）。注意这里刻意**不含 applied_at**：投递行为的时间是首次观测时刻，
--   后续重复采集不得改写它，否则「第一次投递时间」会因子表更新而漂移。
--
-- 红线：本表不含 PII（姓名/手机号/邮箱一律不落），只有 ID 与平台原始提示文本。
--
-- 时间列一律 UTC DATETIME(3)（会话时区由 hikari connection-init-sql 钉为 +00:00）。
-- ====================================

CREATE TABLE IF NOT EXISTS candidate_application (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    candidate_id BIGINT UNSIGNED NOT NULL COMMENT '候选人 candidate.id',
    platform VARCHAR(32) NOT NULL COMMENT '平台标识，取值口径同 channel.code（如 boss）；用于解析渠道与映射',
    platform_job_id VARCHAR(64) NOT NULL COMMENT '平台侧岗位 ID（BOSS jobId，真机实测 575500411）',
    platform_job_hint VARCHAR(128) NULL COMMENT '平台原文岗位线索（如 bottomText「9月21日 沟通的职位-Java」）；仅供人工辨认，不参与任何自动判定',
    request_id BIGINT UNSIGNED NULL COMMENT '派生快照：由 (platform, platform_job_id) 经 publish_record 映射解析出的 hr_request.id；映射未建立时为 NULL，绝不猜测',
    source_channel VARCHAR(32) NULL COMMENT '采集来源渠道：chat 候选人主动来 / recommend 我方主动发（取自 candidate.source_channel）',
    first_resume_version_id BIGINT UNSIGNED NULL COMMENT '首次落该投递时对应的简历版本 resume_version.id（追溯来源用，非外键）',
    applied_at DATETIME(3) NOT NULL COMMENT '投递时刻（UTC）：取自简历版本 collected_at，非入库时刻；重复采集不改写',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    PRIMARY KEY (id),
    -- 三元组幂等：同一人 × 同一平台岗位 只应有一行。重复采集走「已存在则跳过」，
    -- 人工改绑走 UPDATE（不新增行），故唯一约束不会与业务流程冲突。
    UNIQUE KEY uk_platform_candidate_job (platform, candidate_id, platform_job_id),
    -- 按职位看候选人（中台「某岗位下有哪些投递」的主查询）
    INDEX idx_request (request_id),
    -- 映射建立后按平台岗位批量重算（级联重算的驱动键）
    INDEX idx_platform_job (platform, platform_job_id),
    INDEX idx_candidate (candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='候选人投递事实（人 × 平台岗位，幂等）';
