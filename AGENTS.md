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

| 我想... | 看这里 |
|---|---|
| 了解系统架构 | docs/architecture/overview.md |
| 了解分层规则 | docs/architecture/layer-structure.md |
| 查数据库表结构 | docs/architecture/database-schema.md |
| 了解编码规范 | docs/conventions/coding-standards.md |
| 了解 API 设计规范 | docs/conventions/api-design.md |
| 了解某个业务模块 | docs/reference/0X-模块名.md |
| 设计新功能 | docs/design/feature-template.md |
