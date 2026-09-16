# ADR-004：用同步落库的 domain_event 替代异步消息

## Status

Accepted（2026-09-16）

## Context

系统需要回答「这条需求单被谁、在什么时候、从什么状态改到什么状态」——用于**指标口径回溯**与审计。原先这个信息**只存在于 `hr_request` 的当前状态里**：

- `status` 只有现在值，没有历史；
- `opened_at`/`closed_at` 是覆盖写，重开一次就丢失上一轮开放时长；
- `reject_reason` 只保留"最近一次"；
- `updated_at` 无法区分是被哪类动作改的。

而 `updated_at` 一旦被任何无关字段更新（比如改个标题）就会漂移，**指标据此计算必然失真**。

团队已有 RabbitMQ 基础设施，因此"发消息到 MQ、消费者落库"是自然联想。但本期只有 4 个域、单库单服务，且指标需要**强一致**（统计"当日提交的需求数"时不能少算一条还没被消费的消息）。

## Decision

**新建 `domain_event` 追加表，事件与状态变更写在同一个 `@Transactional` 内、同步落库。**

```java
// DomainEventService
@Transactional(propagation = Propagation.REQUIRED)   // 加入调用方事务，不自开新事务
public void hrRequestTransition(String eventType, Long requestId, String requestNo,
                                String fromStatus, String toStatus, Long operatorId) { ... }
```

- **表结构 append-only**：只有 `INSERT`，无 `UPDATE`/`DELETE` 路径。`occurred_at`（事件发生时刻）与 `created_at`（落库时刻）**分列**，便于事后区分时间漂移。
- **事件命名**：`<聚合>.<动作过去式>`，如 `hr_request.approved`。已定义 6 种（`submitted`/`approved`/`rejected`/`closed`/`auto_closed`/`reopened`），集中在 `common/DomainEventTypes`。
- **`payload_json` 用 `JSONObject` 构造，不做字符串拼接**（防注入、防引号转义 bug）。
- 🔴 **`payload_json` 严禁写入候选人 PII**。事件是长期留存的审计流水，PII 一旦进入就难以清除；一期 payload 只放 `requestNo` 等非敏感标识。
- **同步而非异步**：明确接受"写放大"（一次状态变更 = 1 次 UPDATE + 1 次 INSERT），换取**事件不丢**。设计文档 §10 把异步投递（MQ/outbox）列为后期优化，届时可改为「同事务写 outbox 表 + 异步投递」，本 ADR 的表结构可平滑承接（`domain_event` 本身即近似 outbox 的落库形态）。

## Consequences

**变得更容易**：
- 「状态改了但事件没记」在当前实现下**不可能发生**——两者同事务，要么一起提交要么一起回滚。指标口径有了可证的完整性。
- 幂等重试安全：整个操作（状态 + 事件）要么全成要么全败，不需要去重消费者。
- 无需部署 MQ 消费者，无消息积压/顺序/重复投递问题。已实测：并发双 approve 后库中恰好 2 条事件（submitted + approved），不多不少。
- 预留了演进空间：`aggregate_type` + `aggregate_id` + `occurred_at` 的三列联合索引天然支持"按聚合回放时间线"。

**变得更难 / 需要注意**：
- **写路径变长**，事务持有时间增加。当前 4 域规模无压力；若将来出现"一次操作产生大量事件"的场景需重新评估。
- **同步意味着事件写入失败会回滚业务操作**。这是**有意选择**（宁可操作失败，也不要产生无审计的状态变更），但要求 `DomainEventService` 自身足够简单、不引入外部 IO —— 目前只做一次 INSERT，满足。
- **`domain_event` 会无限增长**。当前没有归档/分区策略。数据量到千万级前需决定：按 `occurred_at` 分区、或定期归档到冷表。已登记为待决项。
- **无重放消费者**：事件目前只被"读"，没有人订阅它做投影。一旦引入读模型（CQRS），需要补消费者与位点管理——那时才真正需要 outbox 模式。

## 验证

| 手段 | 结果 |
|---|---|
| 单测 | 覆盖事件类型正确性（4 类事件断言）、**状态未变时不产生事件**、**CAS 冲突时不产生事件** |
| 端到端 | 并发双 `approve` → `domain_event` 恰好 2 条（submitted + approved），无重复、无丢失 |
| 表结构实测 | 10 列、索引 3 个、注释为正确 UTF-8（非乱码） |
