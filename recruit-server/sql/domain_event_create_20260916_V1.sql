SET NAMES utf8mb4;
-- ====================================
-- 领域事件流水表建表（P1-2：为指标口径提供可回溯的事件源）
-- 依据：docs/architecture/adr/ADR-002-database-single-source.md
--
-- 存在理由：工作台/报表若只 COUNT 当前行，只能回答「现在有多少」，
--   无法回答「上月审批通过多少」「平均审批耗时多久」——这类口径需要事件时间线。
--   本期不引入 MQ 与 CQRS 读模型（设计文档 §10：异步化后置），
--   只落 append-only 事件表，与状态变更同事务写入，保证「状态与事件」原子一致。
--
-- 读写约定：
--   * append-only —— 只 INSERT，永不 UPDATE/DELETE（审计可信度的前提）；
--   * payload_json 严禁写入候选人 PII（红线 3：数据流向即合规边界）；
--   * occurred_at 为事件发生时刻，created_at 为落库时刻，二者均按 UTC 写入
--     （会话时区由 application.yml 的 hikari connection-init-sql 钉为 +00:00）。
-- ====================================

CREATE TABLE IF NOT EXISTS domain_event (
    id             BIGINT UNSIGNED NOT NULL COMMENT '雪花 ID',
    event_type     VARCHAR(64)     NOT NULL COMMENT '事件类型：<聚合>.<动作过去式>，如 hr_request.approved',
    aggregate_type VARCHAR(32)     NOT NULL COMMENT '聚合类型，如 hr_request',
    aggregate_id   BIGINT UNSIGNED NOT NULL COMMENT '聚合根 ID',
    from_status    VARCHAR(32)     DEFAULT NULL COMMENT '转移前状态（状态机事件专有，其余事件为 NULL）',
    to_status      VARCHAR(32)     DEFAULT NULL COMMENT '转移后状态（状态机事件专有，其余事件为 NULL）',
    payload_json   JSON            DEFAULT NULL COMMENT '事件附加数据（可读性冗余，严禁写入候选人 PII）',
    operator_id    BIGINT UNSIGNED DEFAULT NULL COMMENT '操作人 sys_user.id',
    occurred_at    DATETIME(3)     NOT NULL COMMENT '事件发生时刻（UTC）',
    created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '落库时刻（UTC）',
    PRIMARY KEY (id),
    INDEX idx_aggregate (aggregate_type, aggregate_id, occurred_at),
    INDEX idx_type_occurred (event_type, occurred_at),
    INDEX idx_operator (operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='领域事件流水（append-only，指标口径回溯与审计）';
