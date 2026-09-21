SET NAMES utf8mb4;
-- ====================================
-- candidate 候选人建表
-- 依据：docs/design/channel-publish.md（同目录既有脚本命名规范）、
--      《Chrome插件简历采集-分阶段任务框架》§2 Phase 1.3 幂等与归并
--
-- 存在理由：采集的主体是「候选人」而非「简历文件」。同一候选人可能在多个平台、
--   多次沟通中发来多份简历，必须归并为一个人的多个版本，而不是多条重复记录。
--
-- 幂等键分层（见框架 §1.3）：
--   候选人：platform + platform_user_id（本表唯一键）
--   跨平台归并：phone_hash / email_hash（退化为人工确认，不自动合并）
--
-- ★ 双 ID 空间（2026-09-21 实测后补列）★
--   BOSS 同一个人有两种 ID：聊天邮件给数字 uid（608120464）、候选人卡片给加密 geekId
--   （01858de472ad39180XRy2t-9FFRU）。只按 platform_user_id 单键查会分裂成两条记录
--   （陈诗健、谢建广各中一次，见 sql/upgrade/candidate_normalize_dual_id_space_20260921_V1.sql）。
--   故补 platform_user_id_alt 参与幂等查找；业务规则见 Candidate / CollectService 注释。
--   本列由 candidate_alter_add_alt_platform_user_id_20260921_V1.sql 对存量库补齐
--   （alter 与 create 必须成对同步，否则新老库结构静默分叉）。
--
-- 红线：
--   * 手机号 / 邮箱原文永不落库，只存 SHA-256（沿用 extension_token.token_hash 的口径）；
--   * 本表不含任何平台凭据。
--
-- 时间列一律 UTC DATETIME(3)（会话时区由 hikari connection-init-sql 钉为 +00:00）。
-- ====================================

CREATE TABLE IF NOT EXISTS candidate (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    platform VARCHAR(32) NOT NULL COMMENT '来源平台标识，如 boss',
    platform_user_id VARCHAR(64) NOT NULL COMMENT '平台内候选人唯一 ID（规范键；新建时加密 geekId 优先，附件端点用的就是这个形态）',
    platform_user_id_alt VARCHAR(64) NULL COMMENT '同一人的另一种 ID 形态（BOSS 数字 uid ↔ 加密 geekId），参与幂等查找；与 source_platform_user_raw（只写一次的对账字段）语义不同',
    name VARCHAR(64) NULL COMMENT '姓名',
    phone_hash CHAR(64) NULL COMMENT '手机号 SHA-256 十六进制，跨平台归并键；原文永不落库',
    email_hash CHAR(64) NULL COMMENT '邮箱 SHA-256 十六进制，跨平台归并键；原文永不落库',
    current_title VARCHAR(128) NULL COMMENT '当前/期望职位',
    expect_salary VARCHAR(64) NULL COMMENT '期望薪资文本（原始口径，不做归一）',
    city VARCHAR(64) NULL COMMENT '所在城市',
    education VARCHAR(32) NULL COMMENT '最高学历',
    school VARCHAR(128) NULL COMMENT '毕业院校',
    major VARCHAR(128) NULL COMMENT '专业',
    work_year VARCHAR(32) NULL COMMENT '工作年限 / 届别描述',
    age VARCHAR(16) NULL COMMENT '年龄（保留平台原文，如 23岁）',
    gender TINYINT NULL COMMENT '性别：1 男 2 女 0/NULL 未知',
    source_channel VARCHAR(32) NULL COMMENT '首次采集来源：chat 候选人主动来 / recommend 我方主动发',
    source_platform_user_raw VARCHAR(128) NULL COMMENT '首次采集时的平台原始 ID 文本（便于对账；只写一次，不参与查找）',
    merged_into BIGINT UNSIGNED NULL COMMENT '归并目标 candidate.id；非空表示本条已被合并，查询需跟随',
    version_count INT NOT NULL DEFAULT 0 COMMENT '冗余：简历版本数，避免列表页逐条 COUNT',
    first_collected_at DATETIME(3) NOT NULL COMMENT '首次入库时间（UTC）',
    last_collected_at DATETIME(3) NOT NULL COMMENT '最近一次入库时间（UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_user (platform, platform_user_id),
    -- 备用键索引：查候选人是 `platform_user_id IN (...) OR platform_user_id_alt IN (...)`
    -- 的 OR 形态，两个键各自要能走索引。**刻意不做唯一约束**：
    -- 备用键是「学习到的另一种形态」，唯一约束会让归并脚本在同键冲突时直接失败，
    -- 而这本该由归并脚本自己收敛（见 upgrade 脚本），不该让 DDL 把整批操作卡死。
    INDEX idx_platform_user_alt (platform, platform_user_id_alt),
    INDEX idx_phone_hash (phone_hash),
    INDEX idx_email_hash (email_hash),
    INDEX idx_name (name),
    INDEX idx_last_collected (last_collected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='候选人（采集主体，跨平台可归并）';
