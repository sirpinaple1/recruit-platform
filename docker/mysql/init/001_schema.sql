SET NAMES utf8mb4;
-- ====================================
-- recruit-platform 数据库初始化脚本
-- ====================================

-- 候选人表
CREATE TABLE IF NOT EXISTS candidate (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '候选人ID（雪花ID）',
    name VARCHAR(64) NOT NULL COMMENT '姓名',
    phone_encrypted VARCHAR(128) COMMENT '手机号（加密）',
    email VARCHAR(128) COMMENT '邮箱',
    gender VARCHAR(8) COMMENT '性别：male/female',
    birth_date DATE COMMENT '出生日期',
    source VARCHAR(32) COMMENT '来源：upload/referral/talent_pool',
    status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT '状态：active/inactive/blacklist',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_phone (phone_encrypted),
    INDEX idx_email (email),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='候选人表';

-- 简历表
CREATE TABLE IF NOT EXISTS candidate_resume (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '简历ID',
    candidate_id BIGINT UNSIGNED NOT NULL COMMENT '候选人ID',
    file_url VARCHAR(512) NOT NULL COMMENT '简历文件URL（MinIO）',
    file_name VARCHAR(255) NOT NULL COMMENT '文件名',
    file_type VARCHAR(16) NOT NULL COMMENT '文件类型：pdf/docx/doc',
    file_size BIGINT COMMENT '文件大小（字节）',
    parse_status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '解析状态：pending/parsing/success/failed',

    -- AI解析结果
    parsed_data JSON COMMENT '解析后的结构化数据',
    ai_score DECIMAL(5,2) COMMENT 'AI评分（0-100）',
    confidence DECIMAL(5,4) COMMENT '置信度（0-1）',

    -- 敏感信息标记
    has_sensitive BOOLEAN DEFAULT FALSE COMMENT '是否包含敏感信息',
    sensitive_fields JSON COMMENT '敏感字段列表',

    -- 版本控制
    parse_version VARCHAR(32) COMMENT '解析模型版本',
    parsed_at DATETIME(3) COMMENT '解析时间',
    parse_error TEXT COMMENT '解析失败原因',

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_candidate (candidate_id),
    INDEX idx_status (parse_status),
    INDEX idx_score (ai_score),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='简历表';

-- 简历评分表
CREATE TABLE IF NOT EXISTS resume_score (
    id BIGINT UNSIGNED PRIMARY KEY,
    resume_id BIGINT UNSIGNED NOT NULL COMMENT '简历ID',
    job_id BIGINT UNSIGNED COMMENT '职位ID（可选）',

    -- 评分维度
    education_score DECIMAL(5,2) COMMENT '学历评分',
    experience_score DECIMAL(5,2) COMMENT '经验评分',
    skill_score DECIMAL(5,2) COMMENT '技能匹配评分',
    vector_similarity DECIMAL(5,4) COMMENT '向量相似度',

    -- 综合评分
    total_score DECIMAL(5,2) NOT NULL COMMENT '总分',
    score_algorithm VARCHAR(64) COMMENT '评分算法版本',
    score_detail JSON COMMENT '详细评分数据',

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_resume (resume_id),
    INDEX idx_job (job_id),
    INDEX idx_total_score (total_score),
    UNIQUE KEY uk_resume_job (resume_id, job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='简历评分表';

-- AI训练样本表
CREATE TABLE IF NOT EXISTS ai_training_sample (
    id VARCHAR(64) PRIMARY KEY COMMENT '样本ID（UUID）',
    task_type VARCHAR(32) NOT NULL COMMENT '任务类型：resume_parse/resume_score',

    -- 输入输出
    input_data JSON NOT NULL COMMENT '输入数据',
    ai_output JSON NOT NULL COMMENT 'AI原始输出',
    human_corrected JSON COMMENT 'HR修正后的输出',

    -- 元数据
    model_version VARCHAR(64) NOT NULL COMMENT '模型版本',
    file_url VARCHAR(512) COMMENT '关联文件URL',
    resume_id BIGINT UNSIGNED COMMENT '关联简历ID',

    -- 标注状态
    annotation_status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/reviewed/trained/discarded',
    annotated_by BIGINT UNSIGNED COMMENT '标注人ID',
    annotated_at DATETIME(3) COMMENT '标注时间',

    -- 质量评估
    quality_score TINYINT COMMENT '样本质量分数（1-5）',
    quality_notes TEXT COMMENT '质量备注',

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_task_type (task_type),
    INDEX idx_status (annotation_status),
    INDEX idx_model (model_version),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI训练样本表';

-- 幂等性记录表
CREATE TABLE IF NOT EXISTS idempotency_record (
    idempotency_key VARCHAR(128) PRIMARY KEY COMMENT '幂等性Key',
    request_data JSON NOT NULL COMMENT '请求数据',
    response_data JSON COMMENT '响应数据',
    status VARCHAR(16) NOT NULL COMMENT '状态：processing/success/failed',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expired_at DATETIME(3) NOT NULL COMMENT '过期时间',
    INDEX idx_expired (expired_at),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='幂等性记录表';

-- AI调用指标表
CREATE TABLE IF NOT EXISTS ai_metric (
    id BIGINT UNSIGNED PRIMARY KEY,
    trace_id VARCHAR(64) NOT NULL COMMENT '链路追踪ID',
    model_version VARCHAR(64) NOT NULL COMMENT '模型版本',
    task_type VARCHAR(32) NOT NULL COMMENT '任务类型',

    -- 性能指标
    duration_ms INT NOT NULL COMMENT '耗时（毫秒）',
    tokens_used INT COMMENT '消耗Token数',

    -- 质量指标
    confidence DECIMAL(5,4) COMMENT '置信度',
    user_feedback VARCHAR(16) COMMENT '用户反馈：correct/wrong/adjusted',

    -- 成本
    cost_amount DECIMAL(10,4) COMMENT '成本（元）',

    -- 错误信息
    error_code VARCHAR(32) COMMENT '错误码',
    error_message TEXT COMMENT '错误信息',

    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_trace (trace_id),
    INDEX idx_model (model_version),
    INDEX idx_task_type (task_type),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI调用指标表';

-- 系统用户表（HR账号）
CREATE TABLE IF NOT EXISTS sys_user (
    id BIGINT UNSIGNED PRIMARY KEY COMMENT '用户ID',
    username VARCHAR(64) NOT NULL UNIQUE COMMENT '用户名',
    password VARCHAR(255) NOT NULL COMMENT '密码（BCrypt加密）',
    real_name VARCHAR(64) COMMENT '真实姓名',
    email VARCHAR(128) COMMENT '邮箱',
    phone VARCHAR(32) COMMENT '手机号',
    role VARCHAR(32) NOT NULL DEFAULT 'HR' COMMENT '角色：ADMIN/HR/INTERVIEWER',
    status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '状态：active/inactive',
    last_login_at DATETIME(3) COMMENT '最后登录时间',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_username (username),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统用户表';

-- 系统字典表
CREATE TABLE IF NOT EXISTS sys_dict (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '字典ID',
    type VARCHAR(64) NOT NULL COMMENT '字典类型',
    code VARCHAR(64) NOT NULL COMMENT '字典编码',
    label VARCHAR(128) NOT NULL COMMENT '字典标签',
    value VARCHAR(256) COMMENT '字典值',
    sort_order INT DEFAULT 0 COMMENT '排序',
    status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT '状态',
    remark VARCHAR(256) COMMENT '备注',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_type_code (type, code),
    INDEX idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统字典表';
