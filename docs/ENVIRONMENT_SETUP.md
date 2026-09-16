# recruit-platform 环境配置

> 本文档记录本地开发环境的配置与访问信息。
> 数据库结构以 `recruit-server/sql/` 为唯一真源（见 `docs/architecture/adr/ADR-002-database-single-source.md`），本文只做环境说明。

---

## 一、基础设施（docker-compose）

| 服务 | 容器名 | 宿主端口 | 凭据 |
|------|--------|----------|------|
| MySQL 8.0 | `recruit-mysql` | `3307` → 3306 | root / `recruit2024`，库 `recruit_platform` |
| Redis 7 | `recruit-redis` | `6380` → 6379 | 密码 `recruit2024` |
| RabbitMQ 3.12 | `recruit-rabbitmq` | `5672`、`15672` | admin / `admin123` |
| MinIO | `recruit-minio` | `9000`、`9001` | minioadmin / `minioadmin123` |
| ChromaDB | `recruit-chromadb` | `8001` → 8000 | 无鉴权 |

> ⚠️ 端口与 compose 一致（MySQL/Redis/ChromaDB 均为非默认宿主端口，避免与本机已有服务冲突）。
> RabbitMQ、MinIO 的密码来自 `docker-compose.yml`，**不是** 默认的 guest/guest 与 minioadmin/minioadmin。
>
> **当前代码实际用到的只有 MySQL 与 Redis**：MySQL 承载全部业务数据；Redis 目前仅由 `/api/health` 做连通性探测。
> RabbitMQ / MinIO / ChromaDB 已在 compose 中编排但暂无代码引用，属为后续模块预留的基础设施。

### 启动与停止

```bash
# 启动
docker-compose up -d

# 停止
docker-compose down

# 查看日志
docker-compose logs -f mysql
```

### 环境验证

```bash
./scripts/verify-env.sh
```

> 注：`verify-env.sh` 结尾打印的服务地址仍是 compose 调整前的旧值，以本文档表格为准。

---

## 二、数据库初始化

结构定义统一在 `recruit-server/sql/`，由脚本灌入（**不再使用** `docker/mysql/init/`）：

```bash
./scripts/db-bootstrap.sh
```

脚本走 `docker exec` 执行，不依赖本机 mysql 客户端，且**可重复执行**（所有脚本均为幂等写法）。

| 目录 | 内容 | 是否自动执行 |
|------|------|--------------|
| `recruit-server/sql/*.sql` | DDL 建表 | 是 |
| `recruit-server/sql/seed/*.sql` | 种子数据 | 是 |
| `recruit-server/sql/upgrade/*.sql` | 一次性迁移 | **否**，人工单独执行 |

### 当前表清单（7 张）

| 表名 | 用途 | 定义文件 |
|------|------|----------|
| `sys_user` | 系统用户（HR / 管理员账号） | `sql/sys_user_create_20260916_V1.sql` |
| `sys_dict` | 枚举字典 | `sql/sys_dict_create_20260916_V1.sql` |
| `hr_request` | 人力需求单 | `sql/hr_request_create_20260915_V1.sql` |
| `channel` | 渠道注册表 | `sql/channel_create_20260915_V1.sql` |
| `publish_draft` | 发布草稿 | `sql/publish_draft_create_20260915_V1.sql` |
| `publish_record` | 发布台账 | `sql/publish_record_create_20260915_V1.sql` |
| `extension_token` | 扩展授权（浏览器扩展独立鉴权） | `sql/extension_token_create_20260915_V1.sql` |

### 初始数据

- 2 个账号：`admin/admin123`（ADMIN）、`hr001/hr123456`（HR）
- 21 条字典数据（简历状态、候选人状态/来源、学历、用户角色、标注状态）
- 1 个演示渠道 `mock_demo`（配合 `extension/fixtures/publish-mock.html` 本地联调）

### 既有环境的旧表清理

若你的环境曾执行过**旧版** `docker/mysql/init/001_schema.sql`，库里会多出 6 张旧一代「职位中心」表
（`candidate` / `candidate_resume` / `resume_score` / `ai_training_sample` / `idempotency_record` / `ai_metric`）。
需要手动执行一次改名冻结迁移（幂等，可重复跑）：

```bash
docker exec -i recruit-mysql mysql -uroot -precruit2024 recruit_platform \
  < recruit-server/sql/upgrade/legacy_orphan_tables_rename_20260916_V1.sql
```

---

## 三、应用启动

```bash
# 后端（端口 6017，dev profile 连本地容器）
cd recruit-server && mvn spring-boot:run

# 前端（端口 5173，/api 经 Vite proxy 转发到 6017）
cd recruit-web && npm install && npm run dev
```

---

## 四、常用命令

### 备份

```bash
docker exec recruit-mysql mysqldump -uroot -precruit2024 recruit_platform > backup_$(date +%Y%m%d).sql
```

### 清理并重建（会丢数据）

```bash
docker-compose down -v          # 删除数据卷
docker-compose up -d
./scripts/db-bootstrap.sh       # 重建表结构与种子数据
```

---

## 五、Ollama 本地模型

| 模型 | 用途 | 状态 |
|------|------|------|
| `bge-m3` | 简历向量化（嵌入） | 按需下载 |
| `qwen2.5:7b` | 简历解析与评分（LLM） | 按需下载 |

```bash
ollama list
ollama pull bge-m3
```

> AI 服务（`recruit-ai-service`）尚未开工，以上模型当前无代码依赖。

---

## 六、故障排查

### MySQL 连接失败

```bash
docker ps | grep mysql
docker logs recruit-mysql
docker restart recruit-mysql
```

### Docker 磁盘空间不足

```bash
docker system df
docker system prune -a
```

---

## 七、配置文件位置

| 文件 | 路径 |
|------|------|
| Docker Compose | `docker-compose.yml` |
| 数据库结构真源 | `recruit-server/sql/` |
| 数据库初始化脚本 | `scripts/db-bootstrap.sh` |
| 环境验证脚本 | `scripts/verify-env.sh` |
| 项目文档 | `docs/` |
