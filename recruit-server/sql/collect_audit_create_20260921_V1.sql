SET NAMES utf8mb4;
-- ====================================
-- collect_audit 采集审计建表
-- 依据：《Chrome插件简历采集-分阶段任务框架》§2 Phase 1.4 审计日志、
--      §3 Phase 3.3 审计完善、§6 全局红线第 1 条（只做主动触发）
--
-- 存在理由：每一次采集动作都要能从「授权基础 / 审计记录 / 留存策略」三方面解释
--   （框架 §3 验收标准）。审计表就是被质疑时的自证材料。
--
-- 为什么**不复用 domain_event**：
--   domain_event 的列注释明确写着「payload_json 严禁写入候选人 PII
--   （红线 3：数据流向即合规边界）」。而采集审计必须记录 page_url，
--   BOSS 的候选人页 URL 形如 .../chat/index?uid=608120464&securityId=...，
--   uid 即候选人标识 —— 写进 domain_event 就是违反它自己的红线。
--   故独立建表，明确承载「who / when / what / 来源 URL」。
--
-- 读写约定：
--   * append-only —— 只 INSERT，永不 UPDATE/DELETE（审计可信度的前提）；
--   * operator_id 来自扩展 token 关联的 sys_user（ExtensionAuthInterceptor 挂载）；
--   * ext_token_id 一并记录，用于 token 泄露时的溯源定位；
--   * occurred_at 为客户端上报的动作时刻，created_at 为落库时刻，均 UTC。
-- ====================================

CREATE TABLE IF NOT EXISTS collect_audit (
    id BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    action VARCHAR(32) NOT NULL COMMENT '动作：consent 采集前确认 / collect 提交采集 / attach_download 附件下载 / merge 归并 / skip 去重跳过',
    result VARCHAR(16) NOT NULL DEFAULT 'ok' COMMENT '结果：ok / failed / skipped',
    operator_id BIGINT UNSIGNED NOT NULL COMMENT '操作人 sys_user.id（扩展 token 关联用户）',
    ext_token_id BIGINT UNSIGNED NULL COMMENT '扩展授权 extension_token.id，泄露溯源用',
    platform VARCHAR(32) NOT NULL COMMENT '来源平台，如 boss',
    platform_user_id VARCHAR(64) NULL COMMENT '被采集候选人的平台 ID',
    candidate_id BIGINT UNSIGNED NULL COMMENT '落库后的 candidate.id；未落库（失败/跳过）为 NULL',
    scene VARCHAR(32) NULL COMMENT '采集场景：list 列表 / detail 详情 / chat 聊天 / attach 附件',
    page_url VARCHAR(1024) NULL COMMENT '采集时页面 URL（含平台会话参数，合规自证材料）',
    source_api VARCHAR(255) NULL COMMENT '数据实际来源接口路径',
    client_note VARCHAR(512) NULL COMMENT '客户端补充说明（如去重原因、被拦提示）',
    occurred_at DATETIME(3) NOT NULL COMMENT '动作发生时刻（客户端上报，UTC）',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '落库时刻（UTC）',
    PRIMARY KEY (id),
    INDEX idx_operator_time (operator_id, occurred_at),
    INDEX idx_candidate (candidate_id),
    INDEX idx_platform_user (platform, platform_user_id),
    INDEX idx_action_time (action, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='采集审计（append-only，合规自证材料）';
