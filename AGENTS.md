# AGENTS.md

本文件是全项目（前端 + 后端）的 AI 协作约定。

## 工作原则

- 每次修改代码的时候，请优先确认需求是否明确，如果不明确，请先询问需求细节，直到需求明确为止。
- 每次修改代码，必须仅限于需求范围，不要做过多的改动。如果你觉得有必要做额外的改动，请先征求用户同意。
- 每次修改代码，必须确保代码的正确性和可运行性。请注意，每次都需要告诉用户，你的技术实现方案，包括你会新增/修改哪些文件，让用户确认。

## 硬性规则

### Git 操作：只读

- 只允许执行只读查询命令：`git status`、`git log`、`git diff`、`git show` 等。
- 禁止代替用户执行任何写操作：`push`、`commit`、`add`、`reset`、`rebase`、`merge`、`checkout`、`stash`、`tag`、`cherry-pick`、强制推送等。
- 需要提交或推送时，只输出建议的完整命令，由用户自己执行，不要代为操作。

### 数据库操作：只读

- 只允许只读查询：`SELECT`（含 `SHOW`、`DESC`、`EXPLAIN`）。
- 禁止执行任何写操作：`INSERT` / `UPDATE` / `DELETE` / `TRUNCATE`，以及 `CREATE` / `DROP` / `ALTER` 等 DDL。
- 需要变更数据或表结构时，输出 SQL 脚本交由用户执行，不直接连库执行。
- SQL 脚本的存放位置与命名规范见 `recruit-server/AGENTS.md`。

## 任务导航

> 下表**只列实际存在的文件**。指向不存在的路径比没有导航更糟——它会让人（和 AI）以为某份规范已经写了。

| 我想... | 看这里 |
|---|---|
| 了解系统架构 | [docs/architecture/overview.md](docs/architecture/overview.md) |
| 了解分层规则与依赖方向 | [docs/architecture/layer-structure.md](docs/architecture/layer-structure.md) |
| 查数据库表结构 | [docs/architecture/database-schema.md](docs/architecture/database-schema.md) |
| 查「为什么这样设计」 | [docs/architecture/adr/](docs/architecture/adr/README.md)（ADR 索引，共 5 份） |
| 了解渠道发布模块设计 | [docs/design/channel-publish.md](docs/design/channel-publish.md) |
| 了解 Java ↔ Python 集成 | [docs/conventions/java-python-integration.md](docs/conventions/java-python-integration.md) |
| 本地环境搭建 | [docs/ENVIRONMENT_SETUP.md](docs/ENVIRONMENT_SETUP.md) |
| 后端开发约定 | [recruit-server/AGENTS.md](recruit-server/AGENTS.md) |
| 前端开发约定 | [recruit-web/AGENTS.md](recruit-web/AGENTS.md) |
| AI 服务开发约定 | [recruit-ai-service/AGENTS.md](recruit-ai-service/AGENTS.md) |
| 数据库灌库 | `./scripts/db-bootstrap.sh`（见 [ADR-002](docs/architecture/adr/ADR-002-database-single-source.md)） |

### 尚未建立（正文缺失，勿引用）

以下路径在多处文档中被提及但**文件不存在**，属已知文档债务。需要时再补，不要在导航里给假链接：

| 缺失文件 | 本应承载的内容 |
|---|---|
| `docs/conventions/coding-standards.md` | 编码规范（命名、异常、日志）——部分内容目前散在 `layer-structure.md` |
| `docs/conventions/api-design.md` | API 设计规范（路径、错误码契约）——目前只有 `overview.md` §请求链路 的片段 |
| `docs/reference/0X-模块名.md` | 逐模块功能参考手册 |
| `docs/design/feature-template.md` | 新功能设计模板 |

### 存在但需谨慎阅读

| 文件 | 原因 |
|---|---|
| `docs/architecture/ai-integration-architecture.md`、`docs/architecture/model-training-pipeline.md` | 描述的是**未实装域**（AI 服务一期未落地，见 `overview.md` §已知结构缺口）。它们不是当前系统的实况，别据此判断"已有基础" |
| `docs/SETUP_COMPLETE.md`、`docs/AI_MODELS_DEMO.md` | 历史过程记录，非规范。以 `ENVIRONMENT_SETUP.md` 为准 |

