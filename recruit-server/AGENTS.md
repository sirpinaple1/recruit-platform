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

- 需要执行的 SQL 统一放在后端项目 `recruit-server/sql/` 目录下。
- 命名格式：`<数据表名>_<操作描述>_<日期YYYYMMDD>_<版本号>.sql`
- 示例：`candidate_alter_add_status_20260911_V1.sql`
- 版本号形如 `V1`、`V1.1`、`V2`，同一变更迭代时递增。
