# 系统总览（overview）

> **状态**：v1.0（2026-09-16）
> **定位**：本文件回答「这个系统由哪些东西组成、它们怎么连」；分层规则看 `layer-structure.md`，表结构看 `database-schema.md`。
> **维护约定**：本文档描述**已实现**的结构。规划但未实现的能力一律标注「未开工」，不要写成既成事实。

---

## 1. 一句话与边界

面向单公司的招聘数据中台：把「人力需求 → 渠道发布 → 简历筛选 → 面试 → 录用 → 报到」这条链路的过程记录沉淀下来，做到**可追踪、可审计、可统计**。

**边界（不做的事）**：不替代钉钉 OA；不接触招聘平台账号凭据；不做未经授权的外部平台自动提交。

---

## 2. 运行单元与端口

| 单元 | 技术栈 | 端口 | 现状 |
|---|---|---|---|
| `recruit-server` | Java 17 / Spring Boot 4.1.1 / MyBatis-Plus 3.5.17 | 6017 | ✅ 主后端，阶段一主线 |
| `recruit-web` | Vue 3.5 / Vite 6 / TS 5.7 / Tailwind 4 / Zod 3 | 5173（dev） | ✅ 管理端 |
| `extension` | Chrome MV3 原生 JS（无构建链） | — | ✅ 填充引擎 + popup + options |
| `recruit-ai-service` | FastAPI / Python 3.11 | — | ⏳ **未开工** |
| MySQL | 8.x（Docker） | 3307 | ✅ 唯一有状态依赖 |
| Redis | 6+（Docker） | 6380 | ✅ 仅用于健康检查，未承载业务缓存 |
| RabbitMQ / MinIO / ChromaDB | — | 5672 / 9000 / 8001 | ⏳ 编排已声明，**代码零引用** |

> Redis 只出现在 `HealthController`（`StringRedisTemplate` 探活）。把它当作业务依赖会让后续误判现状，因此此处显式记录。

---

## 3. 后端模块划分

后端是**模块化单体**：单个 Spring Boot 进程，模块边界靠包结构与表归属表达，不靠网络调用。

```
com.recruit
├── common/        统一响应 R、业务异常 MyException、JWT 工具、角色与事件类型常量
├── config/        WebMvc 拦截器注册、MyBatis-Plus 插件
├── interceptor/   认证（AuthInterceptor）、扩展鉴权（ExtensionAuthInterceptor）、授权（RoleInterceptor）
├── controller/    HTTP 入口，只做参数绑定与委派
├── service/       业务规则、事务边界、状态机
├── mapper/        MyBatis-Plus BaseMapper
├── entity/        数据库行映射
├── dto/ vo/       入参 / 出参（与 entity 分离）
└── exception/     （空，占位）
```

已落地三个业务域 + 一个横切域：

| 域 | 表 | 说明 |
|---|---|---|
| 需求单 | `hr_request` | 状态机 draft/pending_approval/open/closed + 招满自动关闭 |
| 渠道发布 | `channel` / `publish_draft` / `publish_record` / `extension_token` | 审批通过后按渠道渲染草稿，HR 用扩展预填充、亲手提交、回填台账 |
| 系统 | `sys_user` / `sys_dict` | 账号（BCrypt）与字典 |
| 横切 | `domain_event` | append-only 事件流水，供指标口径回溯 |

**职业化提醒**：`README.md` 的「后端模块」列了 10 个模块（候选人与人才库、面试、录用、通知…）。**其中只有上述 4 项有代码**，其余是路线图。本文件与代码保持一致，不以 README 的模块清单为准。

---

## 4. 请求链路

### 4.1 管理端（`/api/**`，Bearer 登录态）

```
浏览器 ──Bearer JWT──▶ AuthInterceptor ──▶ RoleInterceptor ──▶ Controller ──▶ Service ──▶ Mapper ──▶ MySQL
                          │                    │
                          │ 未登录/过期 → 401    │ @RequireRole 不命中 → 403
                          │                    │ 账号停用 → 403（实时查库，不等 token 过期）
                          ▼                    ▼
                    GlobalExceptionHandler 统一转 R；业务异常 MyException 透传 code
```

- 认证＝「你是谁」，只验签，不读数据库；
- 授权＝「你能做什么」，`@RequireRole` + `RoleInterceptor`，角色**每次从库读**（见 ADR-001）。

### 4.2 扩展端（`/api/ext/**`，`X-Extension-Token`）

扩展不走 JWT，走独立的 `ExtensionAuthInterceptor`：校验 SHA-256(token) 命中 `extension_token` 且 `status=active`，通过则刷新 `last_used_at`。权限语义是**最小权限**：只能拉 pending 草稿、回填台账。授权由 `ExtensionTokenController` 签发，整类收敛到 `ADMIN`。

### 4.3 前端响应约定

后端有两种错误到达路径，前端必须同时兼容（见 `recruit-web/src/lib/httpClient.ts`）：

| 来源 | 传输形态 | 例子 |
|---|---|---|
| 业务异常 / 全局异常处理 | **HTTP 200 + `body.code` 非 200** | 状态机非法转移 400、并发冲突 409、乐观锁未命中 |
| 拦截器拒绝 | **真 HTTP 401 / 403** + `{code,msg}` | 未登录、无权限、账号停用 |

⚠️ **409 属于第一类**（HTTP 200，body.code=409）。前端判断冲突必须用 `ApiError.code`，不能用 HTTP 状态码。

---

## 5. 关键跨模块机制

| 机制 | 位置 | 说明 |
|---|---|---|
| 状态转移乐观并发控制 | `HrRequestService.casStatus` | 条件 UPDATE 钉住源状态，0 行即 409。见 ADR-003 |
| 领域事件 | `DomainEventService` | 与状态变更**同事务**写入，append-only。见 ADR-004 |
| 渲染白名单 | `PublishDraftService.RENDER_WHITELIST` | 合规红线：草稿只含 JD 公开字段，单测断言键集合（设计文档 §11） |
| 数据库单一真源 | `recruit-server/sql/` | DDL/seed/upgrade 三层 + `scripts/db-bootstrap.sh` 幂等初始化。见 ADR-002 |
| 时间基准 | `application.yml` + `HrRequestService.NUMBERING_ZONE` | 存储 UTC / 编号用北京时区。见 `database-schema.md §4` |

---

## 6. 已知结构性缺口

按影响排序，均为**已识别未解决**：

1. **读模型缺失**：工作台统计靠实时 `COUNT` 当前行（`/api/hr-requests` 分页全量拉取后前端计数）。数据量上来后既慢又无法回答历史口径。`domain_event` 已铺好事件源，但**尚无读侧聚合**，也无定时投影。
2. **前端一次性拉全量**：`WorkbenchPage` 拉一页需求单在前端算统计，规模到千级会失效。
3. **单测覆盖只在两个安全/并发控制点**：渲染白名单、状态机+并发、授权拦截、编号。业务 CRUD、扩展回填、台账分页均无自动化覆盖。
4. **无 CI 配置**：编译与测试靠本地执行（`mvn test` / `npx vue-tsc -b`），无流水线强制。
5. **时间不可注入**：`LocalDateTime.now(...)` 直接读系统时钟，无法冻结时间做确定性测试（P1-3 的编号时区只能靠常量守卫，见 `HrRequestNumberingTest`）。

---

## 7. 相关文档

- 分层与依赖方向：`layer-structure.md`
- 表结构与时间基准：`database-schema.md`
- 架构决策：`adr/ADR-001`（授权模型）、`adr/ADR-002`（数据库单一真源）、`adr/ADR-003`（状态转移并发）、`adr/ADR-004`（领域事件）
- 模块设计：`../design/channel-publish.md`（渠道发布 · 浏览器自动化填充）
- 环境搭建：`../ENVIRONMENT_SETUP.md`
