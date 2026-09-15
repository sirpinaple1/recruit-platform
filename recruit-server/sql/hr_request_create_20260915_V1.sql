SET NAMES utf8mb4;
-- ====================================
-- T2.1 hr_request 人力需求单建表
-- 依据：docs/design/channel-publish.md §5.1
-- ====================================

CREATE TABLE IF NOT EXISTS hr_request (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '需求单ID（雪花ID）',
    request_no VARCHAR(32) NOT NULL COMMENT '需求编号（REQ-YYYYMMDD-XXXX）',
    title VARCHAR(128) NOT NULL COMMENT '岗位名称',
    dept_name VARCHAR(64) NOT NULL COMMENT '用人部门（一期不做组织表）',
    headcount_total INT NOT NULL DEFAULT 1 COMMENT '计划招聘人数',
    headcount_filled INT NOT NULL DEFAULT 0 COMMENT '已入职数（手动修正）',
    job_description TEXT NOT NULL COMMENT 'JD正文（公开信息）',
    job_requirement TEXT COMMENT '任职要求（公开信息）',
    salary_min INT COMMENT '月薪下限（元）',
    salary_max INT COMMENT '月薪上限（元）',
    location VARCHAR(128) COMMENT '工作地点',
    education VARCHAR(32) COMMENT '学历要求（字典education_level）',
    experience_years INT COMMENT '要求工作年限',
    employment_type VARCHAR(32) COMMENT '用工性质：full_time/part_time/internship/contract',
    status VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT '状态：draft/pending_approval/open/closed',
    close_reason VARCHAR(32) COMMENT '关闭原因（closed时必填）：filled/cancelled/frozen',
    auto_close TINYINT(1) NOT NULL DEFAULT 1 COMMENT '招满自动关闭开关',
    reject_reason VARCHAR(256) COMMENT '最近一次驳回原因',
    opened_at DATETIME(3) COMMENT '开放时间（指标口径）',
    closed_at DATETIME(3) COMMENT '关闭时间（指标口径）',
    created_by BIGINT UNSIGNED COMMENT '创建人sys_user.id',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    UNIQUE KEY uk_request_no (request_no),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='人力需求单';
