# ADR-003：状态转移用条件更新（CAS）做并发保护

## Status

Accepted（2026-09-16）

## Context

`hr_request` 是状态机聚合（`draft → pending_approval → open → closed`，5 条合法转移）。原实现是**先读后写**：

```java
HrRequest r = getById(id);              // 读
if (!valid(r.getStatus(), action)) throw ...;  // 判
r.setStatus(next);
updateById(r);                          // 写
```

这条链在并发下是「检查—使用」竞态：两个请求同时读到 `pending_approval`，都通过校验，都写入 `open`。后果不是数据格式错乱，而是**业务副作用被执行两次**——`approved` 事件落两条、`opened_at` 被覆盖、后续「招满自动关闭」可能重复触发。

一期没有分布式锁/乐观锁版本号，也没有 MQ 串行化消费者。需要一种**不引入新组件、正确性可证**的方案。

## Decision

**所有状态转移改为条件更新（Compare-And-Set），把状态判断下推到 `WHERE` 子句：**

```java
private void casStatus(Long id, String expectedStatus, String action, LambdaUpdateWrapper<HrRequest> sets) {
    int rows = hrRequestMapper.update(null, sets
            .eq(HrRequest::getId, id)
            .eq(HrRequest::getStatus, expectedStatus));   // ← 状态是 WHERE 的一部分
    if (rows == 0) {
        throw new MyException(409, "操作失败：" + action + " 期望需求单处于 " + expectedStatus
                + " 状态，但已被其他操作变更，请刷新后重试");
    }
}
```

- 转移前后状态从 `TRANSFERS` 表读取（`from → to`），`from` 即 `expectedStatus`。
- 冲突返回 **HTTP 200 + `body.code=409`**（沿用项目错误契约，见 `overview.md` §请求链路），前端收到 409 **重新加载详情**而不是停在陈旧状态。
- 事件写入放在 CAS 成功之后，与状态变更同一事务。

### 关键次要决策：不依赖 `useAffectedRows`

MySQL 默认 `useAffectedRows=false`，会把「匹配但值未变」的行也算作 affected。若某次转移可能出现 `from == to`（自环），`rows` 就不可信。

**本方案的正确性不依赖该开关**：`TRANSFERS` 表内**无自环**（`draft→draft` 这类不存在），因此任何被 `WHERE id=? AND status=?` 匹配到的行，其 `status` 必然被改写为不同的值 → `rows=1`。于是 `rows==0` 的唯一解释就是**状态不匹配**。

> 这是一条**约束而非巧合**：将来若新增自环转移（如「刷新时间戳」类动作），必须改用 `updated_at` 或版本号列参与 CAS，否则 409 判定会失效。已在 `TRANSFERS` 定义处留注释。

## Consequences

**变得更容易**：
- 并发安全由**数据库单条 UPDATE 的原子性**保证，不引入锁、版本号列、Redis、MQ，零部署变更。
- 无重试循环、无 ABA 问题（状态机是单向推进，ABA 不适用）。
- 正确性可被单测证明：mock `update` 返回 1/0 即可覆盖两条分支；实测并发双 approve → 一个 200、一个 409，草稿数保持 2 无重复。

**变得更难 / 需要注意**：
- **每次转移多一次 `TRANSFERS` 查表**（内存常量，非 IO），可忽略。
- **`rows==0` 的语义被绑定到「无自环」前提**。这是隐性耦合，已用注释与 ADR 固化。
- 冲突时用户看到 409 而不是静默成功——这是**有意的**：宁可让第二个操作者知道"你的操作没生效"，也不要悄悄覆盖前一个人的结果。前端必须处理 409（已实现）。
- 本方案只解决**同一聚合根内**的并发。跨聚合（如"扣减渠道配额"）仍需另想办法，当前无此场景。

## 验证

| 手段 | 结果 |
|---|---|
| 单测 | 48 项全绿；`HrRequestStateMachineTest` 覆盖全部 20 种状态组合，硬编码黄金转移表 |
| 变异测试 | 从 CAS 的 `WHERE` 移除 `status` 条件 → **6 项测试失败**，证明"条件钉在 WHERE 上"被测试真实约束 |
| 端到端 | 并发双 `approve` → 一个 200、一个 409；`publish_draft` 与 `publish_record` 各保持 2 条，无重复写入 |
