# ADR-005：拦截器中「账号有效性检查」必须先于 `@RequireRole` 判定

## Status

Accepted（2026-09-16）— 修正 ADR-001 的实现缺陷

## Context

ADR-001 定下授权模型：`RoleInterceptor` 读 `@RequireRole` 注解，从 DB 取当前用户角色做匹配，**不把角色放进 token**，从而让「账号停用立即生效」。

原实现：

```java
if (!(handler instanceof HandlerMethod hm)) return true;
RequireRole requireRole = resolveAnnotation(hm);
if (requireRole == null) return true;          // ← 提前返回

Long userId = (Long) request.getAttribute("userId");
SysUser user = userService.getById(userId);
if (user == null) return reject(response, 401, ...);
if (!"active".equals(user.getStatus())) return reject(response, 403, "账号已停用");
// ... 角色比对
```

**缺陷**：所有**未标 `@RequireRole` 的接口**走 `return true` 直接放行，**根本没查用户状态**。于是：

1. HR 被停用（`status=inactive`）后，他手上那张**未过期的 token 依然能访问** `/api/hr-requests`、`/api/my/...` 等无注解接口；
2. 与 ADR-001 承诺的「停用立即生效」**直接矛盾**——只在带注解的接口上生效，在大部分业务接口上不生效；
3. 这是**静默的**：接口正常返回 200，没有任何日志或异常提示权限模型没生效。

触发条件不是边缘情况：只要有一个接口需要"登录即可访问、无需特定角色"，它就会成为绕过点。`@RequireRole` 只标在少数几个管理端接口上，意味着**绝大多数接口都是绕过点**。

> 发现方式：写 P1-5 架构文档时逐条核对拦截器链，"未标注解即 `return true`"与 ADR-001 的承诺对不上。随后用真实探针账号端到端验证：`active` → 200，置 `inactive` → 期望 403、**实际 200**，缺陷确认。

## Decision

**把「用户存在 + 账号 active」提升为拦截器对「所有 `HandlerMethod`」的无条件前置检查，先于 `@RequireRole` 判定。**

```java
if (!(handler instanceof HandlerMethod handlerMethod)) return true;

// ① 无条件：身份与账号状态（所有业务接口）
Long userId = (Long) request.getAttribute("userId");
SysUser user = userId == null ? null : userService.getById(userId);
if (user == null) return reject(response, 401, "未登录或登录已过期");
if (!"active".equals(user.getStatus())) return reject(response, 403, "账号已停用，请联系管理员");
request.setAttribute("role", user.getRole());

// ② 有注解才做角色比对
RequireRole requireRole = resolveAnnotation(handlerMethod);
if (requireRole == null) return true;
// ... 角色不匹配 → 403
```

分层语义由此明确：

| 检查 | 作用范围 | 失败码 |
|---|---|---|
| 用户存在 | 所有 `HandlerMethod` | 401 |
| 账号 active | 所有 `HandlerMethod` | 403 |
| 角色匹配 | 仅 `@RequireRole` 接口 | 403 |

## Consequences

**变得更容易**：
- 「停用立即生效」成为**全局不变量**，不再依赖每个接口作者记得加注解。
- 新接口默认获得 401/403 保护 —— **安全默认（secure by default）**，而不是默认裸奔。
- 权限模型中「认证（Authentication）」与「授权（Authorization）」的边界清晰：前者无条件，后者按注解。

**变得更难 / 需要注意**：
- **每次请求多一次 `sys_user` 查询**（原实现只对带注解接口查）。这是**刻意的成本**：AD4-001 选择「角色实时读 DB」而非「token 内嵌」，代价就是每请求一次查询。若将来成为瓶颈，正确做法是加**短 TTL 缓存 + 停用时主动失效**，而不是退回 token 内嵌（那会重新引入"停用不生效"窗口）。
- **公开接口**（登录 `/api/auth/login`、健康检查等）必须确认**不在拦截器路径内**，否则会被 401 误伤。当前这些路径未注册进拦截器，已核对；将来新增公开接口需同步检查 `WebMvcConfig` 的排除列表 —— 这是一处**必须成对改动的约束**（改拦截器范围 ↔ 改排除列表）。
- `request.setAttribute("role", ...)` 现在对所有接口生效，下游若指望"无注解接口没有 role 属性"会受影响。实测无此依赖。

## 验证

| 手段 | 结果 |
|---|---|
| 端到端探针 | `active` 账号访问无注解接口 → 200；改 `inactive` 后同一 token → **403**（修复前为 200） |
| 单测 | 59 项全绿；新增 `rejectsInactiveAccountOnNonAnnotatedEndpoint`（正是原缺陷场景）与 `mountsRoleOnNonAnnotatedEndpoint` |
| 回归 | 带注解接口的角色比对行为不变，原有 11 项 `RoleInterceptorTest` 全绿 |
