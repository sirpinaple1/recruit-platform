# recruit-platform 招聘数据中台

面向单公司的招聘全流程管理系统 —— 把分散在钉钉、招聘网站、邮件与会议系统中的招聘过程，统一成一条**可追踪、可审计、可统计**的业务链路。

核心思路不是替代钉钉 OA，而是让「人力需求 → 渠道发布 → 简历筛选 → 面试 → 录用 → 报到」这条链路在中台里留下完整、可回溯的记录。

---

## 技术栈

| 层次 | 选型 |
|---|---|
| 语言 / 运行时 | Java 17 + Python 3.11 |
| 后端框架 | Spring Boot + FastAPI |
| 数据库 | MySQL 8.x |
| 缓存 / 分布式 | Redis |
| 前端 | Vue 3 + Vite + TypeScript |
| AI 能力 | Ollama + LangChain / 智谱AI |
| 外部集成 | 钉钉审批、邮件、招聘渠道适配层 |

---

## 架构要点

### 模块化单体优先

本期采用 **模块化单体 + 异步任务 / 领域事件**，不直接拆微服务。招聘业务各状态关联紧密，分布式事务收益低、成本高；渠道、AI 面试等不确定能力隔离在适配层，而不是用微服务数量掩盖不确定性。当某模块出现独立扩缩容、独立 SLA 或安全隔离需求时，再按模块边界拆分服务。

### 业务主状态与外部状态分离

不用一个 `status` 表示整个系统。人力需求状态、渠道发布状态、候选人申请状态、面试轮次状态、钉钉审批状态、通知发送状态各自独立保存，通过领域事件协作 —— 避免「一个外部平台失败导致整个候选人状态不可解释」。

### AI 能力渐进式本地化

采用 **Java 业务 + Python AI 服务分离架构**，通过 HTTP/MQ 通信。AI 能力分三阶段演进：
1. **MVP阶段**：云端 API（智谱AI）快速验证 + 数据积累
2. **优化阶段**：关键路径本地化（Ollama + Qwen），成本降低 90%
3. **深度阶段**：端到端训练 + Agent 编排

详见 `docs/architecture/ai-integration-architecture.md`

### 自动化必须有人工兜底

所有外部集成按能力等级配置：

| 等级 | 说明 |
|---|---|
| `API` | 正式授权 API |
| `CONNECTOR` | 签约 ATS / 渠道连接器 |
| `MANUAL` | 系统生成操作任务，由 HR 人工完成并回填 |
| `RPA` | 经平台书面授权、法务及安全评审后才能启用 |

任何自动任务失败后都必须能切换为人工任务，不阻塞主流程。

### 当前状态与历史事件同时保存

每个聚合根保存当前状态以提高查询效率，同时用不可变事件日志保存状态流转。仪表盘按**事件发生时间**计算历史指标，不依赖当前状态反推历史。

---

## 后端模块

1. 组织与权限
2. 人力需求
3. 渠道发布
4. 候选人与人才库
5. 审批集成（钉钉）
6. 沟通与面试
7. AI 面试适配
8. 录用与通知书
9. 通知、待办与日程
10. 仪表盘与统计

---

## 核心业务主线

```
钉钉发起人力需求审批
  → 回调验签解密、幂等落库 → 创建人力需求单
  → 各渠道发布（授权 API 自动发布 / 无接口则生成 HR 人工待办）
  → 上传简历或从人才库推荐 → 创建候选人申请
  → AI 简历解析与评分 → 简历接受审批（钉钉） → 沟通与面试准备
  → 安排线上 / 线下面试 → 面试结果留存 → 领导轮次决策
  → 录用审批（钉钉） → 生成录用通知书 → 邮件发送 / HR 下载发送
  → 登记已报到 / 未报到 → 创建各渠道下架任务
```

关键数据模型约定：**候选人与应聘流程分离**（`candidate` / `candidate_resume` / `candidate_application` / `interview_round`），同一候选人可被不同需求单重复推荐，被淘汰后仍保留在人才库。

---

## 仓库结构

```
recruit-platform/
├── recruit-server/      # Spring Boot 后端（Java 17 / Maven）；内有 AGENTS.md；sql/ 为数据库结构唯一真源
├── recruit-ai-service/  # FastAPI AI 服务（Python 3.11）；内有 AGENTS.md（尚未开工）
├── recruit-web/         # Vue 3 前端（Vite + TypeScript + Tailwind v4）；内有 AGENTS.md
├── extension/           # Chrome MV3 扩展（原生 JS，无构建）：填充引擎 + popup + options
├── docker/              # 基础设施编排与数据卷（mysql/redis/rabbitmq/minio/chromadb）
├── scripts/             # db-bootstrap.sh 数据库初始化 / verify-env.sh 环境自检
├── docs/                # 设计文档：架构设计（含 ADR）、数据库设计、AI 集成方案
├── research/            # 调研资料：渠道 API、钉钉 AI 面试
├── test/                # 手工验证页面
├── .agent/skills/       # AI 协作技能（SKILL.md）
├── AGENTS.md            # AI 协作约定：工作原则 + 任务导航
└── README.md
```

> 前后端各自独立构建、独立运行，不共用构建产物；根目录不放工程代码。
> AI 协作约定见根 `AGENTS.md`，各工作区约束见各子目录的 `AGENTS.md`。

> 约定：表名小写下划线、主键 `BIGINT UNSIGNED` 雪花 ID、状态用 `VARCHAR(32)` 不用 MySQL `ENUM`、
> 时间统一 `DATETIME(3)` 按 UTC 存储、金额 `DECIMAL(18,2)`。

---

## 开发环境

| 依赖 | 版本 |
|---|---|
| JDK | 17 |
| Python | 3.11+ |
| Maven | 3.8+ |
| MySQL | 8.x |
| Redis | 6+ |
| Node.js | 18+（前端） |
| Ollama | latest（可选，本地 AI 推理） |

---

## 实施路线

| 阶段 | 目标 |
|---|---|
| 阶段一 | 可控闭环 MVP + AI 云端验证 |
| 阶段二 | 授权集成 + AI 本地化 |
| 阶段三 | 数据治理与分析 + 模型微调 |

---

## 本地运行

```bash
# 1) 基础设施（MySQL 3307 / Redis 6380 / RabbitMQ 5672+15672 / MinIO 9000+9001 / ChromaDB 8001）
docker-compose up -d

# 2) 建表 + 种子数据（幂等，可重复执行；不依赖本机 mysql 客户端）
./scripts/db-bootstrap.sh

# 3) 后端（端口 6017，dev profile 连本地容器）
cd recruit-server && mvn spring-boot:run

# 4) 前端（端口 5173，/api 经 Vite proxy 转发到 6017）
cd recruit-web && npm install && npm run dev
```

种子账号：`admin/admin123`（管理员）、`hr001/hr123456`（HR）。

> **数据库结构的唯一真源是 `recruit-server/sql/`**，详见 `docs/architecture/adr/ADR-002-database-single-source.md`：
>
> | 目录 | 内容 | 执行方式 |
> |---|---|---|
> | `recruit-server/sql/*.sql` | DDL 建表 | `db-bootstrap.sh` 自动，幂等 |
> | `recruit-server/sql/seed/*.sql` | 种子数据 | `db-bootstrap.sh` 自动，幂等 |
> | `recruit-server/sql/upgrade/*.sql` | 一次性迁移 | **人工执行**，脚本不自动跑 |
>
> `docker/mysql/init/` 不再承载业务建表脚本（原因见该目录 README）。

---

## 当前状态

**阶段一 MVP：渠道发布模块已闭环**（设计见 `docs/design/channel-publish.md` §9）。

基础与需求单：

- ✅ T0 开发环境就绪（Docker 五件套 + Ollama 模型 + 初始化数据）
- ✅ T1 后端基础：统一响应/全局异常/健康检查、登录与 JWT 会话（BCrypt + 拦截器）
- ✅ T1.4 前端工程搭建并接通登录（httpClient + Zod、路由守卫、登录页原型还原、工作台）
- ✅ T2.1 `hr_request` 建表 + CRUD（`REQ-YYYYMMDD-XXXX` 编号、draft 编辑守卫、雪花 ID 字符串序列化）
- ✅ T2.2 需求单状态机：submit/approve/reject/close/reopen/headcount 六个转移接口 + 招满自动关闭
- ✅ T2 前端：需求单列表 / 新建编辑抽屉 / 详情状态操作弹窗，Chrome 端到端全链路验证通过

渠道发布（T3 全部完成）：

- ✅ T3.1 `channel` 表 + CRUD（平台改版改数据不改代码）
- ✅ T3.2 `publish_draft` 渲染（14 项白名单 + 深链实例化，approve/close/auto_close 事务挂接）
- ✅ T3.3 `extension_token` + `publish_record` + 回填 API（SHA-256 落库、明文仅创建响应一次、吊销后 401）
- ✅ T3.4 管理端页面原型对齐（AppShell / 工作台 / 职位列表与详情 / 渠道管理页）

Chrome 扩展（T4 全部完成）：

- ✅ T4.1 MV3 骨架 + options（token 存 session、重启自清）
- ✅ T4.2 `fixtures/publish-mock.html`（21 个交互字段，三级匹配线索全覆盖）
- ✅ T4.3 填充引擎三级匹配（text→attr→selector；🔴 验证码与 file/submit/password 一律跳过，只赋值永不点击）
- ✅ T4.4 popup 全链路（拉草稿 → 填充 → 回填 → 台账闭环）
- ✅ T4.5 管理端前端接通（扩展授权页 / 发布台账页）

**尚未开工**：

- 🚧 AI 服务工程（`recruit-ai-service`，FastAPI）—— 目录与 `AGENTS.md` 就位，代码未动
- 🚧 后端模块 4–10（候选人与人才库 / 钉钉审批集成 / 沟通与面试 / AI 面试 / 录用 / 通知待办 / 仪表盘）

> README 开头列了 10 个后端模块，**实际只有前 3 个有代码**（组织与权限、人力需求、渠道发布）。模块 4–10 的表若在库中出现 `_legacy_` 前缀，属旧一代设计残留，**不是已有基础**。详见 `docs/architecture/overview.md` §已知结构缺口。

### 近期架构加固（2026-09-16）

- ✅ **授权层落地**：此前只有认证没有授权，任意登录用户可自签扩展授权并读取全量待发布草稿。新增 `@RequireRole` + `RoleInterceptor`（角色实时查库，停用立即失效），扩展授权整类与渠道写操作收敛到 `ADMIN`。见 [ADR-001](docs/architecture/adr/ADR-001-authorization-model.md)
- ✅ **数据库结构单一真源**：`recruit-server/sql/` 分 DDL / seed / upgrade 三层，`docker/mysql/init/` 清空业务建表脚本，新增 `scripts/db-bootstrap.sh` 一键幂等初始化；旧一代 6 张孤儿表改名 `_legacy_` 冻结。见 [ADR-002](docs/architecture/adr/ADR-002-database-single-source.md)
- ✅ **状态转移并发保护**：所有转移改为条件更新 `UPDATE ... WHERE id=? AND status=<from>`，冲突返回 409，不依赖 `useAffectedRows`。见 [ADR-003](docs/architecture/adr/ADR-003-state-transfer-concurrency.md)
- ✅ **领域事件流水**：新增 append-only `domain_event` 表，事件与状态变更同事务落库，指标口径可回溯。见 [ADR-004](docs/architecture/adr/ADR-004-domain-event-log.md)
- ✅ **修复授权绕过缺陷**：`RoleInterceptor` 此前对无 `@RequireRole` 的接口直接放行、不查账号状态，导致停用账号的旧 token 仍可访问绝大多数业务接口。已把「账号 active」检查提为所有接口的无条件前置。见 [ADR-005](docs/architecture/adr/ADR-005-auth-check-ordering.md)
- ✅ **生产 profile 可启动**：`application-prod.yml` 的 JWT 密钥改为 `${JWT_SECRET}` 无默认值（缺失即失败退出），避免默认密钥带上线
- ✅ **时区口径统一**：Hikari `connection-init-sql` 钉死会话时区为 UTC，不依赖各环境 JDBC URL 参数（易漏）；业务编号仍按 `Asia/Shanghai`
- ✅ **测试基线**：59 项单测全绿（渲染白名单 / 状态机 / 拦截器 / 编号时区），并做变异测试验证测试确实能捕获缺陷
- ✅ **架构文档补齐**：`docs/architecture/` 下新增 overview / layer-structure / database-schema 三份实测文档 + 5 份 ADR 索引

