SET NAMES utf8mb4;
-- ====================================
-- resume_score 简历打分建表
-- 依据：docs/conventions/java-python-integration.md §1.1 同步调用（简历评分）
--
-- 存在理由：采集落库后异步触发 LLM 分析（match=与需求单JD匹配打分 /
--   general=无JD时退化通用分析），结果落本表。打分失败不影响采集主流程，
--   只落 failed 行，可手动重打。
--
-- 幂等键：uk_version_request (resume_version_id, request_key)。
--   request_key 为合成键：match 模式 = 'req:{hr_request.id}'，general = 'general'。
--   刻意不用 request_id 裸列做唯一键 —— MySQL 唯一索引对 NULL 不去重，
--   general 行的 request_id 为 NULL 会绕开唯一约束导致重复行。
--
-- 兼任 AI 调用记录（recruit-ai-service/AGENTS.md「数据积累规范」的一期落地）：
--   input_json 存组装后的打分输入快照，details_json 存 LLM 完整输出，
--   model 记录模型名 —— 后续微调取数直接读本表，Python 服务保持无状态不直连 MySQL。
-- ====================================

CREATE TABLE IF NOT EXISTS resume_score (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    candidate_id BIGINT UNSIGNED NOT NULL COMMENT '关联 candidate.id（冗余，按人查询用）',
    resume_version_id BIGINT UNSIGNED NOT NULL COMMENT '打分对象 resume_version.id',
    application_id BIGINT UNSIGNED NULL COMMENT '关联 candidate_application.id（有投递事实时冗余）',
    request_id BIGINT UNSIGNED NULL COMMENT '参照需求单 hr_request.id；match 模式非空，general 为 NULL',
    request_key VARCHAR(64) NOT NULL COMMENT '幂等合成键：req:{request_id} / general',
    score_type VARCHAR(16) NOT NULL COMMENT 'match=与需求单JD匹配打分 / general=通用简历分析',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending=排队中 / success=完成 / failed=失败',
    score TINYINT UNSIGNED NULL COMMENT '总分 0-100；success 前为 NULL',
    summary VARCHAR(2048) NULL COMMENT 'LLM 总评（一段话）',
    details_json JSON NULL COMMENT 'LLM 完整输出：维度分数组/亮点/风险/推荐结论',
    input_json JSON NULL COMMENT '打分输入快照（简历文本+JD文本），微调数据源',
    model VARCHAR(64) NULL COMMENT 'LLM 模型名（如 glm-4-flash）',
    fail_reason VARCHAR(512) NULL COMMENT '失败原因（超时/上游错误/解析失败）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    PRIMARY KEY (id),
    UNIQUE KEY uk_version_request (resume_version_id, request_key),
    INDEX idx_candidate (candidate_id, updated_at),
    INDEX idx_request (request_id, score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='简历 LLM 打分（match 匹配需求单 / general 通用分析）';
