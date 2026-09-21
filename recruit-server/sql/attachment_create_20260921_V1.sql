SET NAMES utf8mb4;
-- ====================================
-- attachment 附件元数据建表
-- 依据：《Chrome插件简历采集-分阶段任务框架》§2 Phase 2.1 附件获取、
--      §2 Phase 1.3 附件幂等键（platform + platformFileId）
--
-- 存在理由：Phase 0 实测确认 —— 附件**不在任何 JSON 响应里**，
--   BOSS 的简历附件是平台生成的 PDF，走独立下载端点。
--   ★ 2026-09-21 真机取证修正 ★ 此前这里写的是「推断」出来的端点形态
--     （GET /wflow/zpgeek/download/preview4boss/<geekId>?d=&id=&authType=0&previewType=1），
--   实际从 Chrome 下载链（History / downloads_url_chains）取到的真实请求是：
--     GET https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/<加密geekId>
--           ?d=1789957125000&geekId=<加密geekId>&previewType=1
--   两处差别都致命：① 域名是 docdownload.zhipin.com（扩展只授权 www 就收不到该请求，
--     重放下载也带不上 cookie）；② 末段是**加密** geekId，而文档侧存的是**数字** uid，
--     同一个人两个 ID 空间 —— 按单一口径比对必然全部判为「不匹配」。
--
-- platform_file_id 构造口径（稳定、不含易变票据）：
--   <端点段>:<路径末段>    例如 download4boss:01858de472ad39180XRy2t-9FFRU
--   票据参数（d / geekId / previewType）只放进 origin_url，不作为身份。
--   刻意不把 previewType 拼进键：同一份文件有「带 query」与「重定向后不带 query」两种 URL，
--   拼进去会让它算出两个键，而 uk_platform_file 是全局唯一的 —— 同一份简历会入库两行。
--
-- 票据有效期：来自 /wapi/zpgeek/resume/boss/preview/check.json 的 expireDate，
--   一期实测为「有效期至 2026年12月20日」。过期后 origin_url 不可再重放，
--   但已 stored 的文件不受影响（文件已落盘）。
--
-- 文件本体存本地磁盘（storage_key 为相对路径）。
--   为什么不上 MinIO：docker-compose 虽已 provision MinIO，但后端代码未接线，
--   一期引入属于过度设计（recruit-server/AGENTS.md：不做过度设计）；
--   切换点已收敛在 AttachmentStorageService 一个实现类里，Phase 2 可整体替换。
-- ====================================

CREATE TABLE IF NOT EXISTS attachment (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    candidate_id BIGINT UNSIGNED NOT NULL COMMENT '关联 candidate.id',
    resume_version_id BIGINT UNSIGNED NULL COMMENT '关联 resume_version.id；若附件先于结构化数据到达则为 NULL',
    platform VARCHAR(32) NOT NULL COMMENT '来源平台，如 boss',
    platform_file_id VARCHAR(191) NOT NULL COMMENT '平台侧文件标识，构造口径见脚本头注释',
    file_name VARCHAR(255) NULL COMMENT '文件名（平台给的 name / 由 Content-Type 推断）',
    content_type VARCHAR(128) NULL COMMENT '响应 Content-Type，如 application/pdf;charset=utf-8',
    bytes BIGINT UNSIGNED NULL COMMENT '文件字节数（响应 content-length 或实读长度）',
    sha256 CHAR(64) NULL COMMENT '文件内容 SHA-256，内容级幂等；下载成功后回填',
    origin_url VARCHAR(1024) NOT NULL COMMENT '原始下载 URL（含票据参数，重放用）',
    origin_ticket_expires_at DATETIME(3) NULL COMMENT '票据有效期（UTC）；NULL=平台未返回',
    storage_key VARCHAR(255) NULL COMMENT '本地存储相对路径；未落盘为 NULL',
    status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending 待下载 / stored 已落盘 / failed 下载失败',
    fail_reason VARCHAR(512) NULL COMMENT '失败原因（含平台返回状态码，V4 命题的证据）',
    source_scene VARCHAR(32) NULL COMMENT '采集场景：attach 附件预览 / chat 聊天文件',
    collected_at DATETIME(3) NOT NULL COMMENT '发现附件时刻（客户端上报，UTC）',
    stored_at DATETIME(3) NULL COMMENT '文件落盘时刻（UTC）',
    operated_by BIGINT UNSIGNED NULL COMMENT '操作人 sys_user.id（扩展 token 关联用户）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_file (platform, platform_file_id),
    INDEX idx_candidate (candidate_id),
    INDEX idx_resume_version (resume_version_id),
    INDEX idx_status (status),
    INDEX idx_sha256 (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='简历附件（平台生成的 PDF 等，本地落盘）';
