# ADR-006：会话时区在连接层钉死为 UTC，不依赖 JDBC URL 约定

## Status

Accepted（2026-09-16）

## Context

`hr_request.request_no = REQ-YYYYMMDD-XXXX` 与所有 `datetime(3)` 列共存，两者对时区的诉求**相反**：

- **业务编号面向人**：HR 说"今天建的"指的是**上海日期**。用 UTC 取号会出现在 **00:00–08:00 这段窗口**（上海已进入次日、UTC 还在前一日）编号日期比人认知**早一天**。
- **时间列面向机器**：统一 UTC 存储，才能让多环境、多时区读者得到一致解释。

同时存在一个**已经踩过的坑**（T4.5）：MySQL `DATETIME` **不带时区**，`DEFAULT CURRENT_TIMESTAMP(3)` 按**会话时区**取值，而应用写入的是 **UTC 的 `LocalDateTime`**。两者基准不一致 → 同一列里混了两种基准 → 前端显示出现 **±8 小时偏差**，且已因此修过一次存量数据。

原先的时区纪律**只写在 JDBC URL 里**：

```
jdbc:mysql://...?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true
```

这条链的问题是**它是每个 profile、每个环境各写一次的自由文本**。生产 profile 的 URL 来自环境变量 `${MYSQL_URL}`——**没人能保证运维注入的 URL 带了这两个参数**。一旦漏掉，配置不会报错，只会静默地让时间列错 8 小时。这是**静默失效**，是最难发现、代价最高的失败模式。

## Decision

**把时区从"URL 约定"上移为"连接建立的代码级保证"，分三层：**

| 层 | 做法 | 保证什么 |
|---|---|---|
| ① 连接层（权威） | 基线 `application.yml` 配 `spring.datasource.hikari.connection-init-sql: SET time_zone = '+00:00'` | **每条**物理连接建立时都执行，dev/prod 共同继承。不依赖任何 profile 的 URL 内容 |
| ② 序列化层 | `spring.jackson.time-zone: UTC` | 出入参 JSON 的时区解释一致 |
| ③ 业务取号层 | `HrRequestService.NUMBERING_ZONE = ZoneId.of("Asia/Shanghai")`（包可见常量，供测试锁定） | 编号用**上海日期**，与人认知一致 |

**为什么放基线而非各 profile**：放在基线，新环境/prod **默认就是对的**；放在 profile，则每加一个环境都要记得复制一次——**默认安全（secure by default）优于要求自觉**。

**为什么用 `'+00:00'` 而不是 `'UTC'`**：`SET time_zone = 'UTC'` 需要 MySQL **导入了时区命名表**（`mysql_tzinfo_to_sql` 灌过 `time_zone_name`）。数字偏移量 `'+00:00'` 在任何实例上都能执行成功，不引入"某些容器镜像里这条语句会报错"的隐患。

**dev 的 JDBC URL 保留 `connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true`** —— 属**冗余**（belt & suspenders），不是权威来源。保留原因是它同时影响 **JDBC 驱动侧的 `LocalDateTime` 转换语义**，与连接层 `SET time_zone` 覆盖的是不同环节；两者一致时无害。

## Consequences

**变得更容易**：
- 生产环境**不可能漏配时区**——即使运维给的 `MYSQL_URL` 一个时区参数都没带，连接层仍会强制 `+00:00`。**已实测**：prod 起于 6019，`MYSQL_URL` 刻意不加任何时区参数，`performance_schema.session_variables` 确认所有应用连接线程的 `time_zone` 均为 `+00:00`，而服务器全局仍是 `+08:00`（证明是连接级覆盖，不是改全局）。
- 时区纪律从"N 处约定"收敛为"1 处配置"，可 review、可 diff。
- 编号口径（上海）与存储口径（UTC）**各自显式声明**，不再靠注释口口相传。测试直接断言常量值，防止有人"顺手改成 UTC"。

**变得更难 / 需要注意**：
- **`connection-init-sql` 每条新连接执行一次**，连接池扩容时有微小开销（一条 `SET`，可忽略）。
- **它只覆盖通过该 DataSource 的连接**。运维手工用 `mysql` 客户端查库时**不受此约束**——手工排查时看到的是服务器全局 `+08:00`，而应用看到的是 `+00:00`。**这是最容易误判的点**：同一张表的同一列，两种客户端读出来差 8 小时。排查前先 `SELECT @@session.time_zone;` 确认自己在哪个基准。
- **已存在的混合基准数据需要一次性修正**（T4.5 已修 `channel` 存量时间）。新增环境若从别处导入数据，要检查导入数据的基准。
- `NUMBERING_ZONE` 是**硬编码上海**。公司若开海外主体，此处需改为按组织配置——DTO 尚无处挂载该配置，属未来工作。

## 验证

| 手段 | 结果 |
|---|---|
| 负向验证 | 不给 `JWT_SECRET` 时 prod **启动失败**（fail-fast 生效，与本文同批修复） |
| 正向验证 | prod 起于 6019，`MYSQL_URL` **不带任何时区参数** → 启动 OK |
| 连接级取证 | `performance_schema.session_variables`：应用连接的 `time_zone` 全为 `+00:00`，服务器 `@@global.time_zone` 为 `+08:00` —— 证明是**连接级覆盖**而非改了全局 |
| 单测 | `HrRequestNumberingTest` 断言 `NUMBERING_ZONE == Asia/Shanghai` + 编号格式 `REQ-<8位日期>-<4位序号>` 与日内递增 |
