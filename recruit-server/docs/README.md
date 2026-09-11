# recruit-server 后端文档

后端工程（Java 17 / Spring Boot / Maven）的本地文档入口。
系统总体架构、数据库设计等跨端文档见仓库根目录 [`../docs/`](../docs/)。

## 目录结构

```
recruit-server/
├── pom.xml
├── docs/                     # 本文档目录：后端自身说明
├── sql/                      # 待执行 SQL 脚本（命名规范见 AGENTS.md）
└── src/
    ├── main/
    │   ├── java/com/recruit/
    │   │   ├── RecruitServerApplication.java
    │   │   ├── controller/   # 接口层
    │   │   ├── service/      # 业务层（impl/ 为实现）
    │   │   ├── mapper/       # 持久层接口（MyBatis-Plus）
    │   │   ├── entity/       # 数据库实体
    │   │   ├── dto/          # 入参
    │   │   ├── vo/           # 出参
    │   │   ├── config/       # 配置类
    │   │   ├── common/       # 通用返回、常量、工具
    │   │   └── exception/    # 异常与全局异常处理
    │   └── resources/
    │       ├── application.yml           # 公共配置
    │       ├── application-dev.yml       # 本地
    │       ├── application-prod.yml      # 生产
    │       ├── log4j2-spring.xml         # 日志
    │       └── mapper/                   # Mapper XML
    └── test/java/com/recruit/
```

## 本地启动

前置依赖：JDK 17、Maven 3.8+、MySQL 8.x、Redis 6+。

```bash
# 在 recruit-server/ 目录下
mvn clean install
mvn spring-boot:run
```

数据源与 Redis 连接默认走 `dev` profile（`application-dev.yml`），
数据库账号密码可用环境变量覆盖：`MYSQL_USERNAME`、`MYSQL_PASSWORD`、`REDIS_PASSWORD`。

## 分层调用规则

```
Controller → Service → Mapper
```

- Controller 不得直接调用 Mapper。
- Service 不得引用 Controller。
- 接口返回值统一用 `R` 包装；业务异常抛 `MyException`。

## 技术选型

| 组件 | 选型 |
|---|---|
| JDK | 17 |
| 框架 | Spring Boot 4.1.1 |
| 持久层 | MyBatis-Plus 3.5.17 |
| 数据库 | MySQL 8.x |
| 缓存 | Redis |
| 日志 | Log4j2（已排除 Logback） |
| JSON | FastJSON2 |

## 相关约定

- 全项目 AI 协作约定：[`../AGENTS.md`](../AGENTS.md)
- 后端硬性规则：[`AGENTS.md`](AGENTS.md)
- SQL 脚本命名与存放：[`AGENTS.md`](AGENTS.md) → SQL 脚本规范
