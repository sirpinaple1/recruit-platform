# recruit-server AGENTS.md

后端（Java 17 / Spring Boot）AI 协作约定。

## 工作原则

- 修改 DAO 时，必须同步修改对应 VO 和 Body。
- 新增 Controller/Service 时，参考现有代码风格。
- 实现方案采用简洁方式，不做过度设计。
- 每次告知技术实现方案（新增/修改哪些文件）。

## 硬性规则

- Controller 不能直接调用 Mapper。
- Service 不能引用 Controller。
- 新增接口返回值用 R 包装。
- 业务异常用 MyException（禁止 `throw new RuntimeException`）。
- JSON 用 FastJSON2（禁止 fastjson v1）。
- 禁止 `System.out.println`，用 Log4j2（Lombok `@Log4j2`）。

## SQL 脚本规范

> 数据库操作的只读约束见根 `AGENTS.md`；本节只约定 SQL 脚本的存放与命名。
> `recruit-server/sql/` 是数据库结构的**唯一真源**（见 `docs/architecture/adr/ADR-002-database-single-source.md`），
> 禁止在 `docker/mysql/init/` 放业务建表脚本。

### 目录分层

| 目录 | 内容 | 由谁执行 |
|---|---|---|
| `sql/*.sql` | DDL 建表 / 改表 | `scripts/db-bootstrap.sh` 自动执行 |
| `sql/seed/*.sql` | 种子与演示数据 | `scripts/db-bootstrap.sh` 自动执行 |
| `sql/upgrade/*.sql` | 一次性迁移（数据搬迁、改名、回填） | **人工单独执行**，不自动跑 |

### 命名

- 命名格式：`<数据表名>_<操作描述>_<日期YYYYMMDD>_<版本号>.sql`
- 示例：`candidate_alter_add_status_20260911_V1.sql`
- 版本号形如 `V1`、`V1.1`、`V2`，同一变更迭代时递增。

### 幂等要求（重要）

`sql/` 与 `sql/seed/` 下的脚本会被 `db-bootstrap.sh` **反复执行**，必须写成幂等：

- DDL 一律用 `CREATE TABLE IF NOT EXISTS`；改表用 `ALTER TABLE` 前先判断列/索引是否存在。
- 种子数据一律用 `INSERT IGNORE`（依赖表上的唯一键），**不要用裸 `INSERT`**。
- 一次性迁移放 `sql/upgrade/`，并在文件头写明适用场景与幂等策略。

