# ADR-008：资源级归属授权——岗位责任人与集中式授权组件

## Status

Accepted（2026-09-16）

> **Extends [ADR-001](ADR-001-authorization-model.md)**。ADR-001 的「翻转条件 #1」（需要资源级/所有权规则时应改用 Spring Security）已被本决策的触发场景**字面命中**，但我们**选择不翻转**，理由见 §Decision-1。ADR-001 的其余决策（角色不进 token、实时读库、`@RequireRole` 静态角色校验）仍然有效，未被取代。

## Context

### 1. 触发场景：发布入口从扩展搬进中台

渠道发布模块（见 [`../../design/channel-publish-seamless.md`](../../design/channel-publish-seamless.md)）正在把触发点从「用户主动点扩展图标」改为「在中台岗位页点发布按钮」。这带来一个副作用：

> 此前「扩展 popup 是一个独立入口」这件事，**意外地起到了访问控制的作用**——HR 要点开 popup、在草稿列表里挑，才可能操作到某条草稿。改动后，岗位与发布入口直接长在中台页面上，**归属隔离缺失就无处可藏了**。

### 2. 实测证据：当前完全无数据级隔离

| 位置 | 现状 | 后果 |
|---|---|---|
| `PublishRecordService.listPendingForExt()` | 注释明写「一期不按用户隔离」，查询只带 `status='pending'` | 任意持扩展 token 者可拉到**全公司**所有待发布草稿（含 JD、薪资区间、用人部门、内部编号） |
| `PublishRecordService.page()` | 无任何归属条件 | 台账页可见全部发布记录 |
| `PublishRecordService.report()` | 只校验 record 存在且为 `pending`，不校验归属 | 可回填**他人**台账，污染 `operated_by` 审计链 |
| `HrRequestService` 列表 / 详情 | 无归属条件 | 岗位列表对任意登录用户可见 |

`ADR-001` 的 Context 中已经描述过一条越权链（HR 自签扩展 token → 拉全量草稿）。ADR-001 用 `@RequireRole(ADMIN)` 堵住了「自签 token」这一步，但**没有堵住「持 token 者能看到什么」**——因为那属于数据隔离，不是功能授权。

### 3. ADR-001 显式把这件事推给了后续 ADR

ADR-001「未采用的替代方案」一表中记录：

> | 按 `created_by` 做数据级隔离 | 属另一维度（数据隔离而非功能授权），且与「部门共享招聘」的业务假设可能冲突，需要单独 ADR |

且其「翻转条件」第 1 条写：

> 1. **需要资源级 / 所有权规则**（如 HR 只能操作自己创建的需求单）——`@PreAuthorize` 的 SpEL 才能把这类规则收敛进一个注解。

本次需求原文即：「**只有负责发布该岗位的 HR 才能看到该岗位并点击发布**」。这就是 ADR-001 举例的那类规则。**ADR-001 的翻转条件已被触发，本 ADR 是对它的正式回应。**

### 4. 业务前提已澄清

ADR-001 当初不敢按 `created_by` 隔离，是因为不确定「部门共享招聘」是否成立。本次与产品侧确认结论是：**岗位归属于单个招聘负责人，不按部门共享**。因此可以安全地引入归属维度。

## Decision

### 1. 不引入 Spring Security（明确不翻转）

翻转条件虽已命中，但翻转的前提不成立。理由：

**a) 翻转条件的前提是「注解能表达这类规则」，而本场景的核心诉求注解表达不了。**

本需求的落地形态只有两种：

| 诉求 | 形态 | `@PreAuthorize` 能否覆盖 |
|---|---|---|
| 「只能**看到**自己负责的岗位」 | **查询过滤**（给 `WHERE` 加条件） | ❌ 不能。注解只能**拒绝**一次调用，无法改写查询结果集 |
| 「只能**发布**自己负责的岗位」 | 写前校验 | ✅ 能（`@PreAuthorize("@authz.canPublish(#id)")`） |

只覆盖一半。**列表过滤无论如何都要写在 Service 层**——而这恰恰是本需求里工作量与出错风险更大的那一半（漏加一个 `WHERE` 条件就是静默越权）。

**b) 引入成本与现有认证链路冲突。**

现有认证是自研 `JWT + AuthInterceptor`（ADR-001 已论证其工作正常）。引入 Spring Security 需要：新增依赖、配 `SecurityFilterChain`、关默认 CSRF、把 `AuthInterceptor` 挂载的 `userId` 桥接进 `SecurityContext`，或改用 `OncePerRequestFilter` 重做认证。结果是**两套认证机制并存**——ADR-001 的「Trade-off」一节担心的正是这个，如今成本只会更高。

**c) 收益面太窄。** 一期只有**一条**资源级规则（岗位归属）。为一条规则引入一整套安全框架，投入产出不匹配。

### 2. 新增归属字段 `hr_request.owner_user_id`

```sql
ALTER TABLE hr_request
  ADD COLUMN owner_user_id BIGINT UNSIGNED NULL
  COMMENT '招聘负责人 sys_user.id（该岗位发布责任人；NULL=未指派，仅 ADMIN 可见/可操作）',
  ADD INDEX idx_owner (owner_user_id);
```

**为什么不能直接用 `created_by`：**

- `created_by` 是**审计字段**，语义是「谁创建了这行」。归属是**业务字段**，语义是「现在谁负责」。两者在场 景上会分叉：人员交接、请假代管、创建人误建后转交，都需要改负责人，但**不应改写审计字段**。
- 因此字段必须独立。**本轮二者取值相同**（创建时 `owner_user_id = created_by`），但语义已经解耦，后续加改派接口时无需动数据模型。

**`NULL` 的处理是 fail-closed：**

`owner_user_id IS NULL` 的岗位（存量数据回填失败、或将来手工插入）**对 HR 一律不可见、不可操作，只有 ADMIN 能处理**。宁可让 ADMIN 兜底，也不让「未指派」静默退化成「人人可见」——后者是静默越权，前者是响亮失败。

**改派接口本轮不做。** 本轮目标是跑通 BOSS 单渠道发布链路，改派属管理便利功能。但字段与默认值现在就位，加接口时是纯增量。

### 3. 唯一授权真源：`PositionAccessService`

新增 `service/PositionAccessService`，作为「谁能对哪个岗位做什么」的**唯一判定入口**。

> 命名说明：业务语言里 `hr_request` 聚合根叫「岗位」（需求单是它的表单形态）。用 `Position` 而非 `HrRequest` 是为了让授权代码读起来是业务规则，而不是表操作。

| 方法 | 用途 |
|---|---|
| `boolean canView(HrRequest req, SysUser user)` | 读判定 |
| `boolean canOperate(HrRequest req, SysUser user)` | 写判定（发布/回填/状态流转） |
| `void assertCanOperate(HrRequest req, SysUser user)` | 写前校验，不通过抛 `MyException(403, …)` |
| `LambdaQueryWrapper<HrRequest> viewScope(SysUser user)` | **查询过滤条件**（ADMIN 返回空条件，HR 返回 `owner_user_id = self`） |

放在 `service` 层而非 `common` 层：它读取 entity 与角色常量、承载业务规则，符合 `layer-structure.md` 对 service 的定位；且 service → service 的跨服务调用在该文件中已被明确允许。

### 4. 两层落地，缺一不可

| 层 | 范围 | 规则 |
|---|---|---|
| **读（数据级过滤）** | `GET /api/hr-requests`（列表）<br>`GET /api/hr-requests/{id}`（详情）<br>`GET /api/hr-requests/{id}/drafts`（渠道草稿）<br>`GET /api/publish-records`（台账分页）<br>`GET /api/ext/drafts`（扩展拉草稿） | 一律经 `viewScope()` 收窄。<br>**扩展端尤其关键**：由 `extUserId` 反查 `SysUser` 后走同一套判定，不能因为是「内部扩展」就豁免。 |
| **写（动作级校验）** | `POST /api/hr-requests/{id}/{submit,approve,reject,close,reopen,headcount}`<br>`POST /api/ext/records/{id}/report`（回填）<br>`POST /api/ext/records/{id}/revert`（撤销回填） | 写操作前 `assertCanOperate()`。回填/撤销需由 `record.requestId` 反查岗位再判定。 |

### 5. 权限矩阵

| 主体 | 岗位列表 | 岗位详情 | 渠道草稿 / 台账 | 点发布 | 回填 / 撤销 | 审批 | 改派负责人 |
|---|---|---|---|---|---|---|---|
| **ADMIN** | 全部 | 全部 | 全部 | ✅ 可代发 | ✅ | ✅ | ✅（本轮不做接口） |
| **HR = 负责人** | 仅自己负责的 | 仅自己的 | 仅自己的 | ✅ | ✅ | ❌ | ❌ |
| **HR ≠ 负责人** | ❌ 不可见 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ | ❌ |
| **INTERVIEWER** | 未启用（模块 4 定） | — | — | — | — | — | — |

**ADMIN 可代发**是刻意保留的例外：岗位由 ADMIN 审批通过，若 HR 离职/请假，必须有人能顶上，否则发布流程会硬卡住。

**越权访问详情返回 403 而非 404**：不采用「404 隐藏存在性」的做法。理由是内部系统、岗位编号本身可枚举（`REQ-YYYYMMDD-XXXX`），隐藏的收益极小，而 403 + 明确文案能让排障成本显著下降。

### 6. 未采用的替代方案

| 方案 | 为什么不用 |
|---|---|
| 引入 Spring Security + `@PreAuthorize` | 见 §Decision-1：过滤场景覆盖不了、与现有认证链路双轨、单条规则收益不匹配 |
| 按 `hr_request.dept_name` 部门共享 | 与本次确认的业务前提（岗位归单人）不符；且部门是自由文本列，无组织表，天然不可靠 |
| 只用 `created_by` 不新增字段 | 审计字段被业务语义污染，改派时被迫改写审计记录 |
| 在 Controller 里逐个 `if` 判权限 | 分散、易漏、无法统一审计；新增端点默认放行（ADR-001 已否决同类做法） |
| 仅靠前端隐藏按钮/菜单 | 前端可被绕过（改 JS、直接调 API）。**前端隐藏只是体验，后端拒绝才是授权权威** |

## Consequences

**变得更容易**：

- 授权规则集中在一个可单测的组件里，权限矩阵可直接枚举成测试用例；
- 新增涉及岗位资源的端点，只需记得接 `viewScope()` / `assertCanOperate()` 两件事；
- 归属与审计解耦，人员交接不再需要动 `created_by`；
- 零新增依赖，ADR-001「仅用 spring-security-crypto」的既有决策得以保持。

**变得更难 / 需要注意**：

- ⚠️ **规则分散在调用点，靠纪律而非机制保证**。这是本方案最大的代价：`viewScope()` 是一个「要记得用」的东西，漏用不会报错，只会静默越权。缓解手段是 §验证 的回归测试清单——新增读接口必须同步补一条越权用例。
- ⚠️ `NULL` 归属岗位对 HR 不可见，若回填脚本漏跑，表现为「岗位凭空消失」。运维上需可查（数据库可查，但中台页面上看不出）。
- 每请求可能多一次 `sys_user` 查询（扩展端需要由 `extUserId` 反查）。内部系统规模下可忽略，成为热点时的出路同 ADR-001（Redis 加 TTL 缓存）。
- 扩展端与中台端现在是**两套入口、同一套判定**。后加新入口（如将来的钉钉小程序）时必须复用 `PositionAccessService`，不得各写一份。

## 验证

| # | 用例 | 期望 |
|---|---|---|
| 1 | `PositionAccessServiceTest`：枚举（ADMIN / owner / 非 owner）×（canView / canOperate / NULL 归属） | 与 §5 矩阵逐格一致 |
| 2 | hr001 的 token 调 `GET /api/ext/drafts`，库中存在 hr002 负责岗位的 pending 草稿 | 响应中**不含** hr002 的草稿 |
| 3 | hr001 的 token 调 `POST /api/ext/records/{hr002的recordId}/report` | 403，且台账行**未被修改** |
| 4 | hr001 带 hr002 的岗位 id 调 `GET /api/hr-requests/{id}` | 403 |
| 5 | hr001 调 `GET /api/hr-requests` | 仅返回 `owner_user_id = hr001` 的行 |
| 6 | ADMIN 重复用例 2~5 | 全部可见/可操作 |
| 7 | 构造 `owner_user_id IS NULL` 的岗位，hr001 访问 | 403（fail-closed） |
| 8 | 回归：`RoleInterceptorTest` 仍全绿 | ADR-001 / ADR-005 行为未被破坏 |

**回归检查（可执行）**：新增任何返回岗位相关数据的接口后，检查其是否出现 `positionAccessService`：

```bash
grep -rn "positionAccessService" recruit-server/src/main/java/com/recruit/service/
```

## 翻转条件（更新 ADR-001 的版本）

本决策可逆。出现下列**任一**情况时，改用 Spring Security 并以其取代 ADR-001 与 ADR-008：

1. **资源级规则从 1 条涨到多条且形态各异**（如候选人、面试、Offer 各有归属规则）——届时 `PositionAccessService` 会分裂成多个 guard，「规则靠纪律」的代价开始超过框架成本；
2. **规则需要配置化**（不同部门不同可见范围、行级权限由管理员配置）——代码内的 guard 表达不了，需要真正的权限引擎；
3. **接入外部身份体系**（钉钉免登、Token Link 六类免登、OAuth2/OIDC）——此时**认证侧**才是真痛点，ADR-001 的翻转条件 #2 成立，与授权一起换才划算；
4. **需要通过安全评审**，要求标准化的方法级安全与审计。

在此之前，本方案在「成本 / 收益 / 可迁移性」上优于引入框架。迁移路径仍然清晰：`PositionAccessService` 的四个方法可平移到 `@PreAuthorize` 的 SpEL bean 调用，列表过滤保留在 Service 层。
