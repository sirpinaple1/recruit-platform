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
- 禁止 `System.out.println`，用 Log4j2（`@Slf4j`）。
