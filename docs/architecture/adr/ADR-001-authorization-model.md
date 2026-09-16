# ADR-001：授权模型——注解式角色校验，暂不引入 Spring Security

## Status

Accepted（2026-09-16）

## Context

项目此前只有**认证**没有**授权**：`AuthInterceptor` 校验 JWT 并挂载 `userId`，但全后端没有任何角色判断。`sys_user.role` 字段存在、登录接口也会把 `role` 返回给前端，前端则按角色显示不同文案——但**没有任何一处拒绝越权请求**。

这导致一条在代码上完全成立的越权链：

```
hr001（普通 HR）登录
  → POST /api/extension-tokens        自签一张扩展授权（无角色校验）
  → GET  /api/ext/drafts              携带该 token
  → 拿到全公司所有 pending 发布草稿（含 JD、薪资区间、用人部门、内部编号）
  → POST /api/ext/records/{id}/report 回填台账，污染审计链
```

同时 `POST/PUT /api/channels` 对任意登录用户开放，而渠道的 `field_map_json` / `deep_link_template` 是所有后续发布的控制参数。

需求：补上授权层，且**必须在真实钉钉审批回调接入之前完成**——回调是第一个外部可重放触发源，权限边界一旦在外部打开就收不回来。

约束：
- 现有技术栈为 Spring Boot 4.1.1，pom 中**刻意只引入 `spring-security-crypto`**（用于 BCrypt），注释明确写着"仅用 crypto，不引入 Security 全家桶"。
- 现有认证实现（JWT + `HandlerInterceptor`）工作正常，无需重做。
- 前后端均为纯 JSON API 的内部系统，无服务端渲染、无表单提交、无跨站会话。

## Decision

采用**注解 + 拦截器**方案：

1. 新增注解 `@RequireRole`，可标注在 Controller 类（整类生效）或方法（方法级优先于类级）上，`value` 为允许角色集合（OR 语义），默认值取最严的 `ADMIN` 以免漏写时误放行。
2. 新增 `RoleInterceptor`，读取 Handler 上的注解；标注了注解的端点做角色校验，未标注的仅要求登录态。
3. `RoleInterceptor` 注册在 `AuthInterceptor` **之后**（依赖其挂载的 `userId`），排除路径与之完全一致（`/api/auth/login`、`/api/health`、`/api/ext/**`）。**`/api/ext/**` 必须排除**：扩展端走 `X-Extension-Token` 独立鉴权，请求属性里是 `extUserId` 而非 `userId`，不排除会被误判 401。
4. **角色取自数据库而非 JWT claim**：`RoleInterceptor` 通过 `UserService.getById()` 加载用户（走 Service 层而非直接调 Mapper，遵守分层纪律）。理由：角色变更与账号停用**立即生效**，无需等 token 过期。副作用是顺带修掉了一个既有缺陷——此前账号被停用后，其尚未过期的 token 仍然可用。
5. 一期收敛范围为**最小闭环**：
   - `ExtensionTokenController` 整类 → `ADMIN`（签发 / 列表 / 吊销）
   - `ChannelController` 的 `create` / `update` → `ADMIN`（`list` 保持登录态，台账页与需求详情页需要展示渠道名称）
6. 前端配合（仅为体验，非授权权威）：路由 `meta.role` + 守卫、侧栏按角色过滤导航、`httpClient` 对 403 明确提示且**不清除登录态**。

### 未采用的替代方案

| 方案 | 为什么本次不采用 |
|---|---|
| 引入 Spring Security | 见下方「Trade-off」——不是不好，是当前阶段收益不匹配成本 |
| 在 JWT claim 里放 role | 角色与停用状态在 token 有效期内（24h）不生效；签发给已停用账号的 token 仍可通行 |
| 每个 Controller 里手写 `if (!"ADMIN".equals(role))` | 分散、易遗漏、无法统一审计；新端点默认放行 |
| 按 `created_by` 做数据级隔离 | 属另一维度（数据隔离而非功能授权），且与「部门共享招聘」的业务假设可能冲突，需要单独 ADR |

### 前后端分工

**后端是授权权威，前端只做入口隐藏。** 前端守卫被绕过（改 JS、直接调 API）不会造成越权，因为 `RoleInterceptor` 会独立拒绝。

## Consequences

**变得更容易**：
- 新增端点只需加一个注解；未标注的端点默认为「登录即可」，行为可预期。
- 角色变更、账号停用立即生效，无需等 token 过期。
- 可测试性好：`RoleInterceptor` 是独立组件，可单测；权限矩阵可枚举（端点 × 角色）。
- 零新增依赖，pom 中「仅用 crypto」的既有决策得以保持。

**变得更难 / 需要注意**：
- `RoleInterceptor` 的排除路径与 `AuthInterceptor` 必须保持同步，**这是一处隐式耦合**；改动其中一个的路径规则时，必须同步另一个。
- 每请求多一次 `sys_user` 主键查询。内部系统规模下可忽略；若将来成为热点，可在 Redis 加一层带 TTL 的角色缓存（Redis 已在编排中）。
- **当前注解只能表达静态角色，无法表达资源级规则**（如「HR 只能修改自己创建的需求单」）。这类规则需要换工具。

## 翻转条件（何时改用 Spring Security）

本决策是**可逆**的，且迁移成本被刻意压低（注解语义可直接平移为 `@PreAuthorize("hasAnyRole('ADMIN')")`）。出现下列**任一**情况时，应改用 Spring Security 并以其取代本 ADR：

1. **需要资源级 / 所有权规则**（如 HR 只能操作自己创建的需求单）——`@PreAuthorize` 的 SpEL 才能把这类规则收敛进一个注解。
2. **接入外部身份体系**——钉钉免登、Token Link 六类免登场景、OAuth2/OIDC；`OAuth2ResourceServer` 是标准解法，自研会重复造轮子。
3. **需要通过安全评审**，要求标准化的 CSRF / 会话管理 / 审计 / 方法级安全。
4. **团队已具备 Spring Security 经验**——学习成本从"负债"变为"资产"，权衡反转。
5. 需要保护的端点出现**非 MVC 入口**（Servlet Filter 层才能覆盖的路径）。

## Trade-off（为什么本次选轻量方案）

大厂事实标准确实是 Spring Security，但它的大部分价值在**认证侧**的标准化（OAuth2 / SAML / 会话 / CSRF / Remember-me）。本项目：

- **认证已经自研完成且工作正常**，本次要解决的是**授权**，而授权部分 Spring Security 提供的核心能力是 `@PreAuthorize` 的 SpEL 与 Filter 层的覆盖。
- 业务规则目前全是**静态角色判断**（ADMIN 能做什么），没有任何资源级规则——用 SpEL 是杀鸡用牛刀。
- Spring Security 的配置心智负担不低（FilterChain、SecurityContext、CSRF 默认开启、方法安全的自调用陷阱），在**团队尚未沉淀该经验**时引入，会同时抬高开发与排障成本。
- 反过来说：**代价是这套自研方案未来很可能要被替换**。我们接受这个代价，因为迁移路径清晰、成本可控，而且翻转条件已经写明——不做不可逆的选择。
