# ADR-002：数据库结构单一真源，docker init 退出业务建表

## Status

Accepted（2026-09-16）

## Context

项目里同时存在**两套互不一致的数据库结构定义**，且都会在真实环境生效：

| 来源 | 表 | 是否被代码使用 |
|---|---|---|
| `recruit-server/sql/*.sql`（现行设计，5 张） | `hr_request` / `channel` / `publish_draft` / `publish_record` / `extension_token` | 全部在用 |
| `docker/mysql/init/001_schema.sql`（**旧一代设计**，8 张） | `candidate` / `candidate_resume` / `resume_score` / `ai_training_sample` / `idempotency_record` / `ai_metric` / `sys_user` / `sys_dict` | 仅后 2 张在用，前 6 张**零引用** |

`docker-compose.yml` 把 `./docker/mysql/init` 挂到 `/docker-entrypoint-initdb.d`，因此**新环境首次 `docker-compose up` 会执行旧一代 DDL**。造成三个问题：

1. **README 的「一键起步」不成立**：新同事拉起容器后，库里没有任何现行业务表，必须先手工执行 `recruit-server/sql/` 下的 5 个脚本。
2. **旧表与现行模型冲突**：旧一代是「职位中心」模型（`candidate_resume.job_id`、`ai_score` 内联在简历表上），现行设计是「**候选人与应聘流程分离**」（`candidate` / `candidate_resume` / `candidate_application` / `interview_round`）。做模块 4「候选人与人才库」时，库里已经躺着一张**名字正确、口径错误**的 `candidate` 表——这比缺表更危险，容易被误认为"已有基础"而承接。
3. **规范自我违反**：旧 `sys_dict` 主键为 `INT UNSIGNED AUTO_INCREMENT`，违反自家「主键 `BIGINT UNSIGNED` 雪花 ID」约定；旧表时间列也没有 `(UTC)` 标注。文档 `docs/ENVIRONMENT_SETUP.md` 还把 `idempotency_record` 列为项目表，但代码零引用。

另有种子数据位置混乱：`channel_seed_mock_demo_20260915_V1.sql`（种子）与其他 5 个建表脚本（DDL）混放在 `sql/` 根目录，命名前缀无法区分两类脚本。

## Decision

1. **`recruit-server/sql/` 是数据库结构的唯一真源**，分三层：

   | 目录 | 内容 | 是否自动执行 | 幂等要求 |
   |---|---|---|---|
   | `sql/*.sql` | DDL | 是 | `CREATE TABLE IF NOT EXISTS` |
   | `sql/seed/*.sql` | 种子 / 演示数据 | 是 | `INSERT IGNORE` |
   | `sql/upgrade/*.sql` | 一次性迁移 | **否**，人工执行 | 脚本内自行保证 |

2. **`sys_user` / `sys_dict` 从 docker init 迁入** `sql/sys_user_create_20260916_V1.sql`、`sql/sys_dict_create_20260916_V1.sql`。DDL **忠实照搬**（仅补齐时间列 UTC 标注），不在迁移过程中顺手改设计——迁移的职责是搬运定义，不是重新设计。
3. **种子数据迁入** `sql/seed/`，并统一改为 `INSERT IGNORE` 使其可重复执行（依赖 `sys_user` 的 PK/`uk_username`、`sys_dict` 的 `uk_type_code`、`channel` 的 `uk_code`）。`channel_seed_mock_demo_20260915_V1.sql` 一并移入。
4. **`docker/mysql/init/` 清空业务建表脚本**，只留 `README.md` 说明原因与正确做法。防止任何人在此放置脚本、绕过 review 与版本化在所有新环境自动生效。
5. **新增 `scripts/db-bootstrap.sh`**：以 `docker exec` 方式按序灌入 `sql/` 与 `sql/seed/`，不依赖本机 mysql 客户端，可重复执行。`sql/upgrade/` 不在自动执行范围内（一次性迁移非幂等场景多，误自动执行风险高）。
6. **旧一代 6 张孤儿表改名冻结**：新增 `sql/upgrade/legacy_orphan_tables_rename_20260916_V1.sql`，把 `candidate` → `_legacy_candidate` 等 6 张表加前缀。**保留数据可回退**，同时用表名杜绝被误认为现行设计。脚本用 `information_schema` 判断「原名存在且目标名不存在」后才 `RENAME`，可重复执行。

   > 仅适用于**曾跑过旧版 docker init 的既有环境**；全新环境不会再创建这 6 张表。

## Consequences

**变得更容易**：
- 新环境初始化收敛为一条命令 `./scripts/db-bootstrap.sh`，且可反复执行，不再有「第一次必须按顺序手工跑 SQL」的隐性知识。
- 数据库结构与代码一一对应，`SHOW TABLES` 即能反映真实设计。
- 未来做模块 4 时不会撞上口径错误的旧 `candidate` 表。
- DDL 变更进入版本化 + review 流程，而不是藏在容器启动钩子里。

**变得更难 / 需要注意**：
- **既有环境需要手工执行一次改名迁移**（本决策只保证新环境正确）。这是一次性动作，脚本幂等、可重跑。
- `docker-compose up` 不再自动建任何业务表——**必须记得跑 `db-bootstrap.sh`**。这是刻意的取舍：把"隐式自动"换成"显式可追踪"，牺牲一点便利换取结构定义的唯一性。已在 `docker/mysql/init/README.md` 与 README 显著说明。
- `scripts/verify-env.sh` 输出的服务端口/口令与实际 `docker-compose.yml` 不一致（MySQL 报 3306 实为 3307、Redis 报 6379 实为 6380、RabbitMQ 报 guest/guest 实为 admin/admin123、ChromaDB 报 8000 实为 8001）。属同一类「文档与实况漂移」，**本 ADR 未一并修**，另立任务。

## 后续（本 ADR 未覆盖，需另行决策）

- `sys_user` 存在冗余索引：`username` 上既有 `UNIQUE` 又有 `INDEX idx_username`。本次为保持迁移忠实性**未修改**，待确认无外部依赖后单独清理。
- `sys_dict` 主键类型（`INT AUTO_INCREMENT`）与项目雪花 ID 约定不一致。该表当前无代码引用，可在模块 1「组织与权限」开工时一并重设计。
- 是否需要引入 schema migration 工具（Flyway / Liquibase）替代脚本目录约定。当前 7 张表规模下手工目录约定够用；表数量或变更频率上升后应重新评估。
