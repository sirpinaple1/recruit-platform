# 分层结构与依赖方向（layer-structure）

> **状态**：v1.0（2026-09-16）
> **定位**：本文件回答「代码放哪一层、允许依赖谁」。
> **维护约定**：文中「实测」结论来自对 `recruit-server/src/main/java` 的静态扫描，不是设计愿景。规则若被打破，要么改代码，要么改本文件并说明理由——不要让它变成一纸空文。

---

## 1. 分层与职责

```
        ┌──────────────────────────────────────────────┐
HTTP ──▶│ controller   参数绑定 / 委派 / 返回 R          │  不含业务判断
        ├──────────────────────────────────────────────┤
        │ service      业务规则 / 事务边界 / 状态机      │  唯一能开事务的层
        ├──────────────────────────────────────────────┤
        │ mapper       MyBatis-Plus BaseMapper          │  只做数据访问
        ├──────────────────────────────────────────────┤
        │ entity       数据库行映射（与表一一对应）       │  出层即风险
        └──────────────────────────────────────────────┘
                 ▲ dto（入参）      vo（出参）
```

横切：`interceptor`（认证/授权/扩展鉴权）、`common`（R / MyException / JwtUtil / 常量）、`config`（拦截器注册、MP 插件）。

---

## 2. 硬性依赖规则（实测 ✅）

| 规则 | 状态 | 验证方式 |
|---|---|---|
| Controller **不得**直接引用 Mapper | ✅ 无违规 | `grep -rn "Mapper" controller/` 无命中 |
| Service **不得**引用 Controller | ✅ 无违规 | `grep -rn "controller" service/` 无命中 |
| Controller → Service → Mapper 单向 | ✅ | 见上方 grep |
| 新增接口返回值用 `R` 包装 | ✅ | 全部 Controller 方法返回 `R<...>` |
| 业务异常用 `MyException` | ✅ | `GlobalExceptionHandler` 统一转 `R` |

复现命令（在 `recruit-server/src/main/java/com/recruit` 下执行）：

```bash
grep -rn "Mapper"  controller/   # 期望：无输出
grep -rn "controller" service/   # 期望：无输出
```

> ⚠️ 这两条 grep 是**可执行的**回归检查，不是口号。改动后请实际跑一次。

---

## 3. 各层允许/禁止做什么

### controller

- ✅ 参数绑定（`@RequestBody` / `@PathVariable`）、`@Valid` 校验、从 `request.getAttribute("userId")` 取登录态、委派 Service、包 `R`
- ❌ 业务规则、❌ 直接访问 Mapper、❌ 拼装查询条件
- ⚠️ 返回类型用 `vo` 而非 `entity`

**已修复的违规（2026-09-16）**：`AuthController.me()` 曾在 Controller 里取 `SysUser`、判空、拼 `LoginVO`——这是唯一一处 entity 泄漏到 controller 的地方，同时也是「controller 层含业务判断」的例子。已下沉为 `UserService.me(userId)`（顺带补上账号停用判断）。

### service

- ✅ 业务规则、状态机、事务边界（`@Transactional`）、读写 `mapper`、返回 `vo`
- ❌ 引用 `controller`、❌ 直接处理 `HttpServletRequest`
- ✅ 跨 service 调用（如 `HrRequestService` → `PublishDraftService` / `DomainEventService`）

**设计决策（有意为之）**：Service **直接返回 VO**，不设独立的 assembler/converter 层。理由：当前每张表对应一个 VO 且映射逻辑简单（`VO.from(entity)` 静态方法），引入 mapper 层只是搬运代码。**翻转条件**：当同一 entity 需要按场景产出多种视图（列表项 vs 详情 vs 导出）时，把映射逻辑提取出来。

### mapper

- ✅ `extends BaseMapper<T>`，只声明数据访问
- ❌ 业务逻辑、❌ 跨表编排
- 复杂查询：优先用 `LambdaQueryWrapper` 在 service 组装；确有必要才加 XML（`resources/mapper/**`）

### entity / dto / vo

| 类型 | 用途 | 边界 |
|---|---|---|
| `entity` | 表行映射，字段与列一一对应 | **不得**出现在 controller 签名里 |
| `dto` | HTTP 入参（带 `@NotBlank` 等校验注解） | 不跨层往下传业务语义 |
| `vo` | HTTP 出参 | 主键用 `String` 传输（雪花 ID 超 JS 安全整数） |

> 雪花 ID 必须序列化为字符串：`HrRequestVO.from` 里 `String.valueOf(e.getId())`。直接用 `Long` 会让前端丢精度（末位变 0）。

---

## 4. 事务边界

| 规则 | 说明 |
|---|---|
| 事务只开在 service 的公开方法上 | Controller 不开事务 |
| 状态变更 + 副作用 + 事件必须在**同一**事务 | 例：`approve` = 改状态 + 渲染草稿 + 写事件；`close` = 改状态 + 草稿置 cancelled + 台账置 failed + 写事件 |
| 跨 service 调用共享事务 | `DomainEventService` 用默认 `REQUIRED` 传播，加入调用方事务，避免「有状态无事件」 |
| 对外副作用要能回滚 | 因此事件是**同库写入**而非发 MQ（见 ADR-004）；未来引入 MQ 需处理 outbox |

**反例说明**：`PublishRecordService.report`（扩展回填）开了事务，但它的「调用外部平台」并不存在——回填只是记录 HR 的手工结果，所以无分布式一致性问题。若将来接入自动发布 API，这个假设就不成立了。

---

## 5. 拦截器链顺序（隐式耦合，改动需成对）

```
/api/**
├── AuthInterceptor          验 JWT，挂 userId            （排除 /api/auth/login、/api/health、/api/ext/**）
├── RoleInterceptor          查库判在册 + 判角色           （排除路径必须与上者**完全一致**）
└── /api/ext/**
    └── ExtensionAuthInterceptor   校验 X-Extension-Token
```

**两条必须成对修改的约束**：

1. `AuthInterceptor` 与 `RoleInterceptor` 的 `addPathPatterns` / `excludePathPatterns` 必须一致。不一致的后果不对称：
   - 若 RoleInterceptor 排除得少 → 扩展端请求取不到 `userId` → 被误判 401（**响亮失败**，可接受）；
   - 若 RoleInterceptor 排除得多 → 端点静默失去在册/角色校验（**静默放行**，危险）。
2. 顺序不能颠倒：`RoleInterceptor` 依赖 `AuthInterceptor` 挂载的 `userId`。

---

## 6. 前端分层（recruit-web）

```
pages/    路由级组件（每页一个，负责取数与编排）
components/layout/   AppShell 等壳层
lib/api/   接口封装（每个域一个 .api.ts，用 Zod schema 校验响应的 data）
lib/httpClient.ts   唯一 HTTP 出口（禁止在页面里直接 import axios / fetch）
stores/    auth（token 读写与清理）
types/     共享类型 + Zod schema
router/    路由表 + meta.role 守卫
```

规则：

- **禁止**页面里直接 `import axios / fetch`，一律走 `lib/httpClient.ts`；
- 响应体先过 Zod，`safeParse` 失败即抛「响应数据异常」——把后端契约漂移变成显式错误，而不是让 `undefined` 渗进模板；
- **UI 组件库**：本项目不使用 Pinia，模块级 composable + `ref` 即状态载体。不要为「规范」引入状态库。

---

## 7. 测试分层

| 层 | 做法 | 例子 |
|---|---|---|
| Service 纯逻辑 | Mockito mock mapper + MP 元数据引导 | `PublishDraftRenderTest`（渲染白名单）、`HrRequestStateMachineTest`（状态机 + 并发） |
| 拦截器 | `MockHttpServletRequest/Response` + 真实 `HandlerMethod` | `RoleInterceptorTest` |
| 上下文装配 | `@SpringBootTest`（需本地 MySQL + Redis） | `RecruitServerApplicationTests` |

**关键坑**：MyBatis-Plus 的 `LambdaQueryWrapper` / `LambdaUpdateWrapper` 依赖 `TableInfoHelper` 的实体缓存，而该缓存**只在 Spring 上下文启动、Mapper 注册时才建立**。因此只要 service 方法内部构造 Lambda wrapper，脱离 Spring 单测就会抛 `can not find lambda cache for this entity`。解法见 `src/test/java/com/recruit/support/MybatisPlusTestSupport.java`（测试侧引导，不动生产代码）。

> 这条同时也是**可测性信号**：如果某个 service 的纯逻辑测试必须靠框架引导才能跑，说明它把「纯计算」和「持久化副作用」揉在了一起。当这类方法增多时，应把纯逻辑抽成无副作用方法或独立组件（当前不需要，见 `overview.md §6` 第 3 条）。

---

## 8. 相关文档

- 系统组成与运行单元：`overview.md`
- 表结构与时间基准：`database-schema.md`
- 后端代码约定（含 SQL 脚本规范）：`../../recruit-server/AGENTS.md`
- 前端代码约定：`../../recruit-web/AGENTS.md`
