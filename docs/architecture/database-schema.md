# 数据库表结构（database-schema）

> 本文由**实测导出**（`SHOW CREATE TABLE` + `information_schema`）写成，非设计稿转录。
> 取证时间：2026-09-16，库 `recruit_platform`（本地 docker 容器 `recruit-mysql`）。
> 数据库真源与迁移约定见 [`adr/ADR-002-database-single-source.md`](adr/ADR-002-database-single-source.md)。

## 0. 一句话结论

**8 张业务表 + 6 张待删遗留表 = 14 张**。无外键、无逻辑删除列、主键统一 snowflake `bigint unsigned`（`sys_dict` 除外，用自增 `int`）、时间列统一 `datetime(3)` 且**语义为 UTC**。

## 1. 表清单

### 1.1 业务表（8 张，均有 Entity + Mapper）

| 表 | 行数 | 用途 | 代码归属 |
|---|---:|---|---|
| `sys_user` | 3 | 系统用户与角色 | `entity/SysUser` |
| `sys_dict` | 22 | 数据字典 | ⚠️ **无 Entity/Mapper，当前无任何代码消费** |
| `hr_request` | 8 | 人力需求单（核心聚合根） | `entity/HrRequest` |
| `publish_draft` | — | 发布草稿（按渠道渲染的字段快照） | `entity/PublishDraft` |
| `publish_record` | — | 发布台账（一对一挂草稿） | `entity/PublishRecord` |
| `channel` | 2 | 渠道注册表（boss / mock_demo） | `entity/Channel` |
| `extension_token` | — | 浏览器扩展独立鉴权（存 hash） | `entity/ExtensionToken` |
| `domain_event` | — | 领域事件流水（append-only） | `entity/DomainEvent` |

### 1.2 遗留表（6 张，`_legacy_` 前缀，**全部 0 行，待删**）

| 表 | 原用途 |
|---|---|
| `_legacy_candidate` | 候选人表 |
| `_legacy_candidate_resume` | 简历表 |
| `_legacy_resume_score` | 简历评分表 |
| `_legacy_ai_metric` | AI 调用指标表 |
| `_legacy_ai_training_sample` | AI 训练样本表 |
| `_legacy_idempotency_record` | 幂等性记录表 |

> 迁移来源：`sql/upgrade/legacy_orphan_tables_rename_20260916_V1.sql`（一次性，`db-bootstrap.sh` **不**自动执行）。
> 对应 README 里的「10 个领域」——其中简历/候选人/AI 三条线**只有表、没有代码**，一期未实装，已在 `overview.md` §已知结构缺口记录。
> ⚠️ 这 6 张表的 `TABLE_COMMENT` 是**双重编码乱码**（存储字节 `C3A5…`，正确应为 `E6B8A0…`），属旧库导入遗留；因表本身待删，不再单独修。

## 2. 全局约定（所有表遵守）

| 约定 | 取值 | 说明 |
|---|---|---|
| 主键 | `bigint unsigned NOT NULL`，snowflake 生成 | 应用侧生成，**非** `AUTO_INCREMENT`；`sys_dict` 例外（`int AUTO_INCREMENT`） |
| 时间列 | `datetime(3)` | **存储语义一律 UTC**。会话时区由 Hikari `connection-init-sql: SET time_zone='+00:00'` 在连接建立时钉死（见 `application.yml` baseline），不依赖 JDBC URL 参数 |
| 审计列 | `created_at NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` / `updated_at … ON UPDATE CURRENT_TIMESTAMP(3)` | 每张业务表都有 |
| 字符集 | `utf8mb4` / `utf8mb4_unicode_ci` | 全库统一 |
| 外键 | **零**（实测 `TABLE_CONSTRAINTS` FK count = 0） | 引用完整性由**应用层**保证；便于拆库、避免级联锁 |
| 逻辑删除 | **无** `deleted` 列 | 需要「软删」语义的用 `status` 表达（如 `publish_draft.status=cancelled`） |

> 业务编号（`hr_request.request_no = REQ-YYYYMMDD-XXXX`）用 **`Asia/Shanghai`** 生成，与存储 UTC 是两套口径：前者面向人，后者面向机器。见 `HrRequestService.NUMBERING_ZONE`。

## 3. 表结构明细

### 3.1 `sys_user` — 系统用户表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint unsigned | PK | 用户 ID（snowflake） |
| username | varchar(64) | NOT NULL | 用户名 |
| password | varchar(255) | NOT NULL | BCrypt 密文 |
| real_name | varchar(64) | | 真实姓名 |
| email | varchar(128) | | 邮箱 |
| phone | varchar(32) | | 手机号 |
| role | varchar(32) | NOT NULL DEFAULT 'HR' | `ADMIN`/`HR`/`INTERVIEWER`（唯一真源 `com.recruit.common.Roles`） |
| status | varchar(16) | NOT NULL DEFAULT 'active' | `active`/`inactive` |
| last_login_at | datetime(3) | | 最后登录时间（UTC） |
| created_at / updated_at | datetime(3) | NOT NULL | 审计（UTC） |

索引：`PRIMARY(id)`、**`UNIQUE username`**、`INDEX idx_status(status)`
> 2026-09-16 修掉冗余：历史上同时存在 `UNIQUE username` 与 `INDEX idx_username(username)`，后者被前者完全覆盖。DDL 已删除，存量库由 `sql/sys_user_drop_redundant_idx_20260916_V1.sql` 收敛。
>
> **已执行并验证（2026-09-16）**——两条路径均收敛到同一终态（`PRIMARY` + `username` UNIQUE + `idx_status`）：
> - **存量库路径**：在临时库造出带 `idx_username` 的漂移态 → 跑迁移脚本**第 1 次成功 DROP**、**第 2 次输出「不存在，跳过」**（幂等证实）；对真实开发库执行时走跳过分支（该库已收敛）。
> - **新库路径**：空库跑 `sys_user_create_20260916_V1.sql`，连跑两次无报错且终态与存量路径一致。
> - **零查询代价证实**：`EXPLAIN SELECT ... WHERE username='admin'` → `type: const` / `key: username` / `rows: 1`，登录等值查询走唯一索引，达最优访问类型。

### 3.2 `sys_dict` — 系统字典表

| 列 | 类型 | 说明 |
|---|---|---|
| id | int unsigned AUTO_INCREMENT | |
| type | varchar(64) NOT NULL | 字典类型 |
| code | varchar(64) NOT NULL | 字典编码 |
| label | varchar(128) NOT NULL | 标签 |
| value | varchar(256) | 字典值 |
| sort_order | int DEFAULT 0 | 排序 |
| status | varchar(16) NOT NULL DEFAULT 'active' | |
| remark | varchar(256) | 备注 |
| created_at / updated_at | datetime(3) | |

索引：`PRIMARY(id)`、`UNIQUE uk_type_code(type, code)`、`INDEX idx_type(type)`

现有 6 类字典（22 行）：`education_level`(5)、`user_role`(3)、`candidate_status`(3)、`resume_status`(4)、`annotation_status`(4)、`candidate_source`(3)。
> ⚠️ 后 4 类属于未实装的简历/候选人线；全表当前**无 Entity / Mapper / Service 读取**，仅作事实上的枚举文档存在。是「要么接线、要么视为设计债务」的待决项。

### 3.3 `hr_request` — 人力需求单（核心聚合根）

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | 需求单 ID |
| request_no | varchar(32) NOT NULL | `REQ-YYYYMMDD-XXXX`（按上海时区生成） |
| title | varchar(128) NOT NULL | 岗位名称 |
| dept_name | varchar(64) NOT NULL | 用人部门（一期不做组织表，存文本） |
| headcount_total | int NOT NULL DEFAULT 1 | 计划招聘人数 |
| headcount_filled | int NOT NULL DEFAULT 0 | 已入职数（手动修正） |
| job_description | text NOT NULL | JD 正文（**公开字段**） |
| job_requirement | text | 任职要求（**公开字段**） |
| salary_min / salary_max | int | 月薪上下限（元） |
| location | varchar(128) | 工作地点 |
| education | varchar(32) | 学历要求（字典 `education_level`） |
| experience_years | int | 要求工作年限 |
| employment_type | varchar(32) | `full_time`/`part_time`/`internship`/`contract` |
| status | varchar(32) NOT NULL DEFAULT 'draft' | `draft`/`pending_approval`/`open`/`closed` |
| close_reason | varchar(32) | `closed` 时必填：`filled`/`cancelled`/`frozen` |
| auto_close | tinyint(1) NOT NULL DEFAULT 1 | 招满自动关闭开关 |
| reject_reason | varchar(256) | 最近一次驳回原因 |
| opened_at / closed_at | datetime(3) | 指标口径时间（UTC） |
| created_by | bigint unsigned | 创建人 `sys_user.id` |
| created_at / updated_at | datetime(3) | 审计（UTC） |

索引：`PRIMARY(id)`、`UNIQUE uk_request_no(request_no)`、`INDEX idx_status(status)`、`INDEX idx_created(created_at)`

**状态机（5 条合法转移，代码硬编码，见 `HrRequestService`）**

```
draft ──submit──▶ pending_approval ──approve──▶ open ──close──▶ closed
                        │                                    ▲
                        └──reject──▶ draft       open ──auto_close──┘
                                   closed ──reopen──▶ open
```

**并发口径**：所有转移走 `casStatus()` —— `UPDATE ... WHERE id=? AND status=<from>`，0 行受影响即返回 **409**。
> 正确性不依赖 JDBC `useAffectedRows`：`TRANSFERS` 表内**无自环**，匹配到的行必然产生变更，因此「rows=0」只可能是状态不匹配。详见 [`adr/ADR-003-state-transfer-concurrency.md`](adr/ADR-003-state-transfer-concurrency.md)。

### 3.4 `publish_draft` — 发布草稿

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | |
| request_id | bigint unsigned NOT NULL | 所属需求 `hr_request.id` |
| channel_id | bigint unsigned NOT NULL | 渠道 `channel.id` |
| fields_json | **json** NOT NULL | 渲染后的「平台字段名 → 值」，**仅 14 项公开白名单** |
| deep_link | varchar(512) | 实例化深链（`{requestNo}` 已替换） |
| status | varchar(16) NOT NULL DEFAULT 'pending' | `pending`/`consumed`/`cancelled` |
| created_at / updated_at | datetime(3) | |

索引：`PRIMARY(id)`、`INDEX idx_request`、`INDEX idx_channel`、`INDEX idx_status`

**渲染白名单（14 项，代码唯一真源 `PublishDraftService.RENDER_WHITELIST`）**

`title` `jobDescription` `jobRequirement` `location` `salaryMin` `salaryMax` `salaryText` `education` `experienceYears` `employmentType` `deptName` `headcountTotal` `requestNo` `publishDate`

> 其中 `salaryText`、`publishDate` 是**派生字段**（分别由 salary 上下限、`created_at` 计算），非表列。
> 有单测 `PublishDraftRenderTest` 以「黄金列表双向比对」锁定该集合——既防漏渲染，也防越界泄漏。
> 📌 设计稿 `docs/design/channel-publish.md` §5.3 当时写的是 10 项，实际落地为 14 项，**已回填设计稿**。

### 3.5 `publish_record` — 发布台账

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | |
| draft_id | bigint unsigned NOT NULL | `UNIQUE` —— 与草稿**一对一** |
| request_id / channel_id | bigint unsigned NOT NULL | **冗余列**（为查询免 join 而冗余，非范式化） |
| status | varchar(16) NOT NULL DEFAULT 'pending' | `pending`/`published`/`failed` |
| account_label | varchar(64) | 平台账号**文本标识**；🔴 红线：永不采集凭据 |
| published_url | varchar(512) | 发布后岗位链接（HR 回填） |
| result_note | varchar(512) | 结果备注 / 系统终结原因 |
| operated_by | bigint unsigned | 操作人 `sys_user.id`（扩展端来自 token 关联用户） |
| published_at | datetime(3) | 发布成功时间（UTC） |
| created_at / updated_at | datetime(3) | |

索引：`PRIMARY(id)`、`UNIQUE uk_draft(draft_id)`、`INDEX idx_request`、`INDEX idx_channel`、`INDEX idx_status`

### 3.6 `channel` — 渠道注册表

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | |
| code | varchar(32) NOT NULL | `boss`/`liepin`/`zhilian`/`mock_demo`… |
| name | varchar(64) NOT NULL | 渠道名称 |
| publish_url_pattern | varchar(512) | 发布页 URL 匹配模式（扩展注入判定依据） |
| field_map_json | **json** NOT NULL | 字段映射配置 —— **平台改版改数据不改代码** |
| deep_link_template | varchar(512) | 深链模板（`{requestNo}` 占位） |
| capability | varchar(16) NOT NULL DEFAULT 'manual' | `manual`/`api`/`connector`/`rpa`（本期只实装 manual） |
| status | varchar(16) NOT NULL DEFAULT 'enabled' | `enabled`/`disabled` |
| sort_order | int NOT NULL DEFAULT 0 | |
| remark | varchar(256) | |
| created_at / updated_at | datetime(3) | |

索引：`PRIMARY(id)`、`UNIQUE uk_code(code)`

现有 2 行：`mock_demo`（id=1，本地演示）、`boss`（BOSS 直聘，id=snowflake）。

### 3.7 `extension_token` — 扩展授权

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | |
| token_hash | varchar(128) NOT NULL | `SHA-256(token)` 十六进制；🔴 **明文永不落库** |
| name | varchar(64) NOT NULL | 授权名称 |
| user_id | bigint unsigned NOT NULL | 关联 `sys_user.id` |
| status | varchar(16) NOT NULL DEFAULT 'active' | `active`/`revoked` |
| last_used_at | datetime(3) | 最近使用时间（UTC） |
| revoked_at | datetime(3) | 吊销时间（UTC） |
| created_at / updated_at | datetime(3) | |

索引：`PRIMARY(id)`、`UNIQUE uk_token_hash(token_hash)`、`INDEX idx_user`、`INDEX idx_status`

### 3.8 `domain_event` — 领域事件流水（append-only）

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigint unsigned PK | |
| event_type | varchar(64) NOT NULL | `<聚合>.<动作过去式>`，如 `hr_request.approved` |
| aggregate_type | varchar(32) NOT NULL | 如 `hr_request` |
| aggregate_id | bigint unsigned NOT NULL | 聚合根 ID |
| from_status / to_status | varchar(32) | 仅状态机事件有值，其余 NULL |
| payload_json | **json** | 事件附加数据；🔴 严禁写入候选人 PII |
| operator_id | bigint unsigned | 操作人 `sys_user.id` |
| occurred_at | datetime(3) NOT NULL | 事件发生时刻（UTC） |
| created_at | datetime(3) NOT NULL | 落库时刻（UTC） |

索引：`PRIMARY(id)`、`INDEX idx_aggregate(aggregate_type, aggregate_id, occurred_at)`、`INDEX idx_type_occurred(event_type, occurred_at)`、`INDEX idx_operator(operator_id)`

**已定义事件类型**（`common/DomainEventTypes`）：`hr_request.submitted` / `.approved` / `.rejected` / `.closed` / `.auto_closed` / `.reopened`

> **写入语义**：与状态变更**同一个 `@Transactional`** 内同步落库，不是 MQ 异步。设计文档 §10 明确把异步投递推到后期。因此「状态改了但事件丢了」在当前实现下不可能发生——两者要么一起提交，要么一起回滚。
> 见 [`adr/ADR-004-domain-event-log.md`](adr/ADR-004-domain-event-log.md)。

## 4. 关系图（应用层维护，DB 无 FK）

```
                       ┌──────────────┐
                       │   sys_user   │
                       └───┬──────┬───┘
             created_by    │      │  user_id
                           │      ▼
                           │  ┌──────────────────┐
                           │  │ extension_token  │
                           │  └──────────────────┘
                           ▼
   ┌──────────────┐   ┌─────────────────┐  request_id  ┌─────────────────┐
   │   channel    │──▶│  publish_draft  │◀─────────────│   hr_request    │
   └──────┬───────┘   └────────┬────────┘              └────────┬────────┘
          │ channel_id         │ draft_id (1:1)                 │
          │                    ▼                                │ aggregate_id
          │            ┌─────────────────┐                      ▼
          └───────────▶│ publish_record  │              ┌─────────────────┐
                       └─────────────────┘              │  domain_event   │
                                                        └─────────────────┘
                       ┌──────────────┐
                       │   sys_dict   │   （独立，当前无代码引用）
                       └──────────────┘
```

## 5. 脚本与真源布局

```
recruit-server/sql/
├── *_create_YYYYMMDD_V1.sql      DDL 建表，CREATE TABLE IF NOT EXISTS（始终执行、幂等）
├── *_drop_*_YYYYMMDD_V1.sql      幂等修正，如删冗余索引（始终执行、幂等，靠 information_schema 守卫）
├── seed/*_seed_YYYYMMDD_V1.sql   种子数据，INSERT IGNORE（始终执行、天然幂等）
└── upgrade/*_YYYYMMDD_V1.sql     一次性迁移，脚本不自动跑，需人工执行
```

**三类脚本的判定标准**——只看一条：**「它对一个全新库执行，会不会出错或产生副作用？」**

| 类别 | 位置 | 对全新库 | 是否进自动流程 |
|---|---|---|---|
| DDL 建表 | 根 | 正常建表 | ✅ |
| **幂等修正** | 根 | 守卫判为「无需处理」→ 打印跳过，无副作用 | ✅ |
| 一次性迁移 | `upgrade/` | **可能报错或改错东西**（如旧表改名：全新库没有该表） | ❌ 人工 |

> `sys_user_drop_redundant_idx_20260916_V1.sql` 属**幂等修正**，故放根目录而非 `upgrade/`——它靠 `information_schema` 判存在性后再 `PREPARE`/`EXECUTE`，对全新库只会打印「不存在，跳过」。**「幂等」不等于「可进自动流程」，还要「无副作用」**；`upgrade/` 里那些脚本即便写成幂等，缺的也是后一条。

灌库入口：`./scripts/db-bootstrap.sh`（走 `docker exec`，不依赖本机 mysql 客户端）。
> 已实测**连跑两次结果一致**：14 张表、2 个种子账号、无重复。
> **幂等修正类脚本确认已进自动流程**：`db-bootstrap.sh` 按 `ls sql/*.sql | sort` 全量执行，输出中可见
> `✓ sys_user_drop_redundant_idx_20260916_V1.sql` 通过、整体以 `✓ 初始化完成` 结束——即"可反复执行"在真实流程里成立，而不只是脚本自身的设计意图。
> `upgrade/` 下的脚本只在「环境曾跑过旧版 `docker/mysql/init/001_schema.sql`」时才需手工执行——这正是不放进自动流程的原因。
>
> ⚠️ **`db-bootstrap.sh` 的客户端字符集**：脚本内的 `mysql_exec` 必须带 `--default-character-set=utf8mb4`。否则容器内客户端可能以 latin1 解释结果集，把**完好的中文印成 `?????`**（数据无损，纯读数问题）。2026-09-16 已修——此前曾据此误判"种子数据损坏"。


## 6. 已知缺口 / 待决项

| # | 事项 | 性质 | 建议 |
|---|---|---|---|
| 1 | `sys_dict` 无 Entity/Mapper/消费方，但与 `Roles`、`auth.types.ts` 存在**人工同步的三份枚举** | 设计债务 | 接一个只读字典接口；或明确废弃该表，把枚举收敛到代码常量 |
| 2 | 6 张 `_legacy_*` 空表未删 | 清理 | 确认无历史数据需求后 `DROP`；注释乱码随表一起消失 |
| 3 | `_legacy_*` 的 `TABLE_COMMENT` 双重编码乱码 | 数据质量 | 随表删除一并解决，不单独投入 |
| 4 | `publish_record` 的 `request_id`/`channel_id` 是冗余列，无 DB 级一致性约束 | 有意为之 | 写入路径唯一（仅 `PublishRecordService`），风险可控；若将来出现第二写入点，需改用触发器或改为视图 |
| 5 | 无外键 → 应用层引用完整性全靠代码自觉 | 有意为之（ADR-002 权衡） | 删除需求单时需显式处理草稿/台账；建议补一条「引用检查」测试 |
| 6 | `hr_request` 无 `updated_by`，只有 `created_by` | 缺字段 | 若要审计「谁改的」，需补列（现只能靠 `domain_event.operator_id` 反查） |
