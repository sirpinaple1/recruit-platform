# docker/mysql/init

本目录挂载到容器的 `/docker-entrypoint-initdb.d`，**仅在数据卷为空时（首次 `docker-compose up`）执行其中的 `.sh` / `.sql` 文件**。

## 为什么这里是空的

这里原本放着 `001_schema.sql` 与 `002_data.sql`，属于**旧一代「职位中心」设计**（`candidate_resume.job_id`、`resume_score`、`ai_metric` 等 8 张表），已与现行「候选人与应聘流程分离」模型冲突。

它造成过一个真实问题：新同学 `docker-compose up` 起出来的库里**没有**任何现行业务表，却又多出一批口径错误的旧表，容易被误认为「已有基础」。详见 `docs/architecture/adr/ADR-002-database-single-source.md`。

## 现在怎么初始化数据库

唯一真源是 **`recruit-server/sql/`**，统一由脚本灌入：

```bash
# 1) 基础设施
docker-compose up -d

# 2) 建表 + 种子数据（幂等，可重复执行）
./scripts/db-bootstrap.sh
```

目录约定：

| 目录 | 内容 | 是否自动执行 |
|---|---|---|
| `recruit-server/sql/*.sql` | DDL（`CREATE TABLE IF NOT EXISTS`） | 是 |
| `recruit-server/sql/seed/*.sql` | 种子数据（`INSERT IGNORE`） | 是 |
| `recruit-server/sql/upgrade/*.sql` | 一次性迁移（如旧表改名冻结） | **否**，需人工单独执行 |

## 注意事项

- 本目录**不要再放业务建表脚本**。放进来会在所有新环境自动生效，绕过 review 与版本化。
- 若确实需要容器启动即执行的基础设施级初始化（如创建只读账号），放在这里并在此文件登记用途。
