# 架构决策记录（ADR）索引

本目录记录**为什么这样设计**。ADR 只增不改：决策变更时新增一份并标注 `Superseded by ADR-XXX`，不覆盖历史。

| # | 决策 | 状态 | 一句话 |
|---|---|---|---|
| [ADR-001](ADR-001-authorization-model.md) | 授权模型：`@RequireRole` + 拦截器实时读 DB | Accepted | 角色不进 token，账号停用立即生效 |
| [ADR-002](ADR-002-database-single-source.md) | 数据库结构单一真源，docker init 退出业务建表 | Accepted | `recruit-server/sql/` 是唯一真源，分 DDL/seed/upgrade 三层 |
| [ADR-003](ADR-003-state-transfer-concurrency.md) | 状态转移用条件更新（CAS）做并发保护 | Accepted | 状态判断下推到 `WHERE`，0 行 → 409，不依赖 `useAffectedRows` |
| [ADR-004](ADR-004-domain-event-log.md) | 用同步落库的 `domain_event` 替代异步消息 | Accepted | 事件与状态变更同事务，宁可写放大也不丢事件 |
| [ADR-005](ADR-005-auth-check-ordering.md) | 拦截器中账号有效性检查先于 `@RequireRole` | Accepted | 修正 ADR-001 实现缺陷：无注解接口曾有停用绕过 |
| [ADR-006](ADR-006-timezone-discipline.md) | 会话时区在连接层钉死为 UTC，不依赖 JDBC URL | Accepted | 默认安全：prod 漏配 URL 也不会错 8 小时 |
| ADR-007 | 候选人与应聘流程分离模型 | 📝 **待写**（模块 4 开工前必写） | 旧 `candidate` 表替换策略、`candidate_application` 聚合边界 |

> **编号说明**：ADR 按**实际写下的顺序**编号，不按"计划编号"。初版架构评估报告曾建议 ADR-005 = 时区、ADR-006 = 候选人模型；实际落地时 ADR-005 先给了修复授权绕过缺陷的决策，时区因此顺延为 ADR-006。报告已同步修正。


## 何时该写 ADR

满足**任一条**即可写：

- 决策**难以回退**（改表结构、选持久化方案、定协议契约）
- 决策**违反直觉**，后人看到代码会想"为什么不那样写"
- 有**多个合理选项**，且被放弃的选项代价不明显
- 决策引入了**约束前提**（如 ADR-003 的"无自环"、ADR-005 的"公开接口需排查排除列表"）——这类前提一旦被后人无意破坏就会静默失效，必须写下来

## 何时不需要

- 纯风格/命名选择 → 放 `docs/conventions/`
- 单模块内部实现细节 → 放模块代码注释
- 显而易见的做法 → 不写

## 模板

```markdown
# ADR-00X：<决策标题>

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXX

## Context
我们看到了什么问题，迫使要做这个决定？（含实测证据）

## Decision
我们决定做什么？（可执行的规则，不是愿景）

## Consequences
**变得更容易**：…
**变得更难 / 需要注意**：…（必须写代价，否则不是决策而是宣传）

## 验证
怎么证明这个决策真的生效了？（单测 / 变异测试 / 端到端证据）
```
