# DDL 纳入 CD 自动执行（收敛式迁移）

> 决策日期：2026-09-22 ｜ 执行器：`scripts/db-migrate.sh` ｜ 台账表：`schema_migration`
> 起因：`docs/troubleshooting/collect-500-schema-drift-20260922.md` —— 漏执行一条 ALTER 就让采集全线 500。

## 1. 为什么不直接用 Flyway

| 维度 | 本仓库的脚本范式 | Flyway 的假设 |
|---|---|---|
| 脚本可变性 | **可变**：改守卫/注释后靠重跑收敛 | **不可变**：改了 checksum 直接校验失败 |
| ALTER 写法 | `information_schema` 守卫 + `PREPARE/EXECUTE`，可重复执行 | 一次性版本脚本，不重复执行 |
| 注释 | 有「注释收敛」段，不一致才 `MODIFY` | 无此概念 |
| 顺序 | 字典序（`ls | sort`） | 显式版本号 |

两套语义**正面冲突**。本仓库的 `sql/*.sql` 天生是「幂等收敛脚本」，所以自研一个 20 行的收敛器
比改造 20 个脚本去迁就 Flyway 更划算。将来真要迁 Flyway：`schema_migration` 表可直接当 baseline 依据。

## 2. 语义（先读这段）

```
sql/*.sql        = 幂等 DDL    → 每次都跑；内容没变则按 checksum 跳过，变了则重跑（收敛）
sql/seed/*.sql   = 幂等种子    → 同上（INSERT IGNORE）
sql/upgrade/*.sql= 一次性迁移  → 默认不跑，需 RUN_UPGRADE=1（人工闸门）
```

`CREATE TABLE IF NOT EXISTS` 对**已存在的表是空操作** —— 这条不变式决定了：
「改 create 脚本」≠「存量库会变」，**必须**有配套 alter 且**必须真的执行**。本机制要消灭的就是最后那半句。

## 3. 运行方式

| 命令 | 用途 |
|---|---|
| `bash scripts/db-migrate.sh` | 正常执行（CI 用这个） |
| `DRY_RUN=1 bash scripts/db-migrate.sh` | 只列出会发生什么，**零写入**（不建表、不备份、不执行） |
| `RUN_UPGRADE=1 bash scripts/db-migrate.sh` | 额外执行 `sql/upgrade/*.sql` |
| `ALLOW_DESTRUCTIVE=1 bash scripts/db-migrate.sh` | 放行被闸门拦下的破坏性 DDL |

## 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIGRATE_ENV_FILE` | `/etc/recruit/recruit-server.env` | 连库凭据来源（systemd EnvironmentFile 格式） |
| `MIGRATE_DB_HOST/PORT/NAME/USER/PASSWORD` | 由 `MYSQL_URL` 解析 | 显式覆盖，**优先于** env 文件 |
| `MIGRATE_DB_SOCKET` | 空 | 设了就走 socket 而非 TCP |
| `MIGRATE_SQL_DIR` | `<repo>/recruit-server/sql` | SQL 真源目录 |
| `MIGRATE_BACKUP_DIR` | `/opt/recruit/backup` | 结构快照落盘位置 |
| `MIGRATE_KEEP_BACKUPS` | `20` | 快照保留份数（滚动清理） |
| `MIGRATE_LOCK_FILE` | `/tmp/recruit-db-migrate.lock` | flock 锁文件 |
| `DRY_RUN` / `RUN_UPGRADE` / `ALLOW_DESTRUCTIVE` | `0` | 见上表 |

## 5. 五条硬约束（都已在脚本里实现）

1. **必须在 `systemctl restart` 之前跑** —— 迁移与代码不匹配就是事故本体。失败即非 0 退出 → CI job 失败 → 走不到 restart → 旧版继续对外服务。
2. **迁移前自动结构快照**（`mysqldump --no-data`），滚动保留 20 份。快照失败则**不执行任何 DDL**。
3. **`flock` 串行化** —— 防 pipeline retry / 手工重跑并发。
   （不用 MySQL `GET_LOCK`：命令行客户端每次调用都是新连接，锁随连接释放，拿不住整段迁移。）
4. **`sql/upgrade/` 默认不跑** —— 一次性迁移仍走人工确认。
5. **破坏性 DDL 闸门** —— 判据是「**数据不可逆丢失**」而非「语句听起来可怕」：

| 拦（需 `ALLOW_DESTRUCTIVE=1`） | 不拦 |
|---|---|
| `DROP TABLE` / `DROP COLUMN` / `DROP DATABASE` / `TRUNCATE TABLE` | `DROP INDEX`（可从列定义重建，不丢数据） |
| `ADD UNIQUE` / `ADD CONSTRAINT`（改约束语义、可能因存量数据不满足而失败） | `MODIFY COLUMN`（仅汇总告警：本仓库注释收敛段合法使用，但也能收窄类型） |

## 6. 权限前置（★ 已按最小权限落地）

CI 以 **`gitlab-runner`** 用户运行，而 `/etc/recruit/recruit-server.env` 是 `root:root 600` —— 读不到。
**刻意不去放开它的读权限**：那等于把 `JWT_SECRET` / Redis 密码 / 应用 DB 密码一并交给
「任何能 push 到 main 的人」（`JWT_SECRET` 泄露可伪造任意登录态）。改为给迁移一份**独立的最小权限凭据**。

### 6.1 已落地配置（部署机 `118.145.246.201`，2026-09-22）

```bash
# 凭据文件：只含连库参数，不含任何应用密钥
/etc/recruit/migrate.env          # 640 root:gitlab-runner
#   MIGRATE_DB_HOST/PORT/NAME/USER/PASSWORD

# 迁移专用账号
CREATE USER 'recruit_ddl'@'localhost' IDENTIFIED BY '<随机>';
GRANT SELECT, INSERT, ALTER, CREATE, DROP, INDEX, REFERENCES
      ON recruit_platform.* TO 'recruit_ddl'@'localhost';
# ★ 台账表单独给表级 UPDATE（原因见 6.2）
GRANT UPDATE ON recruit_platform.schema_migration TO 'recruit_ddl'@'localhost';

# 备份目录：runner 可写
chown gitlab-runner:gitlab-runner /opt/recruit/backup
```

`.gitlab-ci.yml` 里通过 job 级变量指向该文件：`MIGRATE_ENV_FILE: /etc/recruit/migrate.env`。

**权限验证结果**（以 `gitlab-runner` 身份实测）：

| 操作 | 结果 |
|---|---|
| 读 `/etc/recruit/migrate.env` | ✅ |
| 连库 / SELECT / `mysqldump --no-data` | ✅ |
| `UPDATE candidate` / `DELETE FROM candidate` | ❌ `ERROR 1142 command denied` |
| `CREATE TABLE` / `INSERT` / `DROP TABLE` | ✅ |
| `UPDATE schema_migration` | ✅（表级授权） |

> 设计意图：**能改结构，改不了业务数据**。坏脚本最多把表结构搞坏（有快照可对照），
> 但无法悄悄改一行候选人数据 —— 这条比「能不能自动跑 DDL」更重要。

### 6.2 为什么台账表必须单独给 UPDATE（踩过的坑）

台账写入用的是 `INSERT … ON DUPLICATE KEY UPDATE`，它**同时需要 INSERT 与 UPDATE 权限**。
最初只授了 INSERT → 报：

```
ERROR 1142 (42000): UPDATE command denied to user 'recruit_ddl' for table 'schema_migration'
```

更危险的是：当时这个失败被**静默吞掉**（退出码仍 0、台账 0 行）→
跳过机制无声退化成「每次都全量重跑」，审计线索也丢了 —— 又是一次「静默漂移」。

**两处修正**：
1. 台账表授予**表级** UPDATE（`GRANT UPDATE ON recruit_platform.schema_migration`），业务表不受影响；
2. `scripts/db-migrate.sh` 里**记账失败即致命**（`exit 1`）—— 记账写不进去时整条流水线必须停下来，
   不能让「机制失效」伪装成「一切正常」。

### 6.3 备选方案（未采用）

若不想多维护一个账号，也可放开应用 env 的读权限：

```bash
chgrp gitlab-runner /etc/recruit/recruit-server.env && chmod 640 /etc/recruit/recruit-server.env
```

代价见上文（runner 可读全部应用密钥）。**除非明确接受该风险，否则用 6.1。**

### 6.4 一次性迁移（`sql/upgrade/*.sql`）的权限

`upgrade/` 里的数据回填需要 `UPDATE`/`DELETE`，`recruit_ddl` **没有**这些权限 ——
这是刻意的：那类操作仍按人工流程用高权限账号执行（与 `RUN_UPGRADE=1` 的人工闸门一致）。
若将来要让 CI 也能跑回填，需另外评估权限边界，不要图省事直接把 `ALL PRIVILEGES` 给 `recruit_ddl`。

## 7. CI 集成点

`.gitlab-ci.yml` 的 `deploy` job 里，**在前端构建之后、`systemctl restart` 之前**插入：

```yaml
    - bash scripts/db-migrate.sh
```

位置是刻意的：这行失败 → job 失败 → 后面 `cp jar` / `systemctl restart` 都不会执行。
**不要把它挪到 restart 之后**，那就把「迁移先于代码」这条不变式破坏了。

## 8. 回滚

DDL 一般**不可回滚**，所以策略是「把需要回滚的场景消灭在源头」：

1. **结构**：迁移前的快照在 `/opt/recruit/backup/schema-<时间戳>.sql`（仅结构，可对照差异）。
2. **应用层**：`git revert` 代码 + 在 `sql/upgrade/` 写一条反向 DDL（走人工闸门执行）。
3. **首选策略：扩展-收缩（expand-contract）**
   - 加列/加表/加索引时**留 nullable**，新旧代码都能跑 → 不需要回滚；
   - 删列/改类型**必须分两次发布**：先发「不再读该列」的代码，下一版才删。
   - 原因：迁移执行时**旧 jar 还在提供服务**，此刻删列会让旧版立刻 500。
4. 数据级回滚不在本机制职责内（只备结构）—— 要靠 DB 自身的备份策略。

## 9. 与其它脚本的关系

| 脚本 | 场景 | 差异 |
|---|---|---|
| `scripts/db-bootstrap.sh` | 本地 / 新环境初始化 | 走 `docker exec`，要求容器 `recruit-mysql`；**部署机没 docker，用它没用** |
| `scripts/db-migrate.sh` | 部署机上执行 | 走本机 `mysql` 客户端 + systemd env；带台账/快照/闸门 |

两者都按 `ls sql/*.sql | sort` 的顺序，口径一致。

## 10. 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| `连不上数据库` | 先看上方是否打印了「环境文件存在但当前用户读不到」——那才是真因，见 §6 |
| `结构快照失败` | `MIGRATE_BACKUP_DIR` 不可写；脚本会**拒绝继续**执行 DDL（刻意 fail-closed） |
| `另一个迁移进程正在运行` | 上一次异常退出的残留，确认无进程后删掉 `MIGRATE_LOCK_FILE` |
| 某脚本反复 `failed` | 即使本次没有待执行脚本，脚本也会非 0 退出（避免「库里还有没收敛的」被忽略）；看台账 `SELECT script,error FROM schema_migration WHERE status='failed'` |
| 想确认某个脚本跑过没有 | `SELECT script,status,duration_ms,applied_at FROM schema_migration ORDER BY applied_at DESC` |
