# 简历采集（Phase 1）端到端验证指南

> 对应《Chrome插件简历采集-分阶段任务框架》§2 Phase 1 与 Gate 1。
> 目标：验证「采集 → 筛选 → 归一 → 幂等 → 入库」整条链路，含附件重放下载入库。

## 1. 环境（本机实测值）

| 组件 | 地址 | 状态检查 |
|---|---|---|
| MySQL | `127.0.0.1:3307`（docker `recruit-mysql`），库 `recruit_platform` | `docker ps` 应见 healthy |
| Redis | `127.0.0.1:6380` | 同上 |
| 后端 | http://localhost:6017 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:6017/api/health` → 200 |
| 前端 | **http://localhost:5176** | 同上探测 200 |
| 扩展 | `chrome://extensions` → 招聘发布助手 v0.2.0 | 加载 `extension/` 目录 |

> ⚠️ 前端必须跑在 **5176**：扩展 `manifest.json` 的 `host_permissions` 与注入匹配都写死了
> `http://localhost:5176/*`。Vite 配置里的端口是 5173，被占用时会自增 —— 若自增到别的端口，
> **零配置换权会静默失效**（bridge 不会被注入），扩展拿不到 token。启动后先确认端口。

| 账号 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin123` | ADMIN（**本机实测可用**） |
| `hr001` | ~~`hr123456`~~ | HR —— ⚠️ 本机库里这个密码**已被改过**，`hr123456` 登录报「用户名或密码错误」 |

> `hr001` 的密码哈希与 `sql/seed/sys_user_seed_*.sql` 里的不一致（种子只有一次提交、没改过），
> 说明本机这一行是建库后被改的；而种子用 `INSERT IGNORE`，**重跑不会把密码恢复**。
> 想用 HR 角色验证（审计里记「HR张三」而不是「系统管理员」）就手工恢复一次：
>
> ```sql
> UPDATE sys_user
> SET password = '$2a$10$wAF4a73ZFo33vCwhPYZH9uZ/q1qPMVncJ1xSek1jdBgHaW5TMJAJm'
> WHERE username = 'hr001';
> ```

---

## 2. 前置步骤

### 2.1 建表 ✅ 已完成（2026-09-21）

```bash
cd ~/recruit-platform-github
./scripts/db-bootstrap.sh
```

四张表已建成（结构与索引已核对，均 0 行）：

```
attachment  candidate  collect_audit  resume_version
```

| 表 | 幂等唯一键 |
|---|---|
| `candidate` | `uk_platform_user (platform, platform_user_id)` |
| `resume_version` | `uk_candidate_hash (candidate_id, content_hash)` |
| `attachment` | `uk_platform_file (platform, platform_file_id)` |
| `collect_audit` | 4 个查询索引（append-only） |

> `sql/*.sql` 与 `sql/seed/*.sql` 会被本脚本反复执行且天然幂等，重复跑安全。
> `sql/upgrade/*.sql` **不会**被自动执行（一次性迁移需人工）。

**2026-09-21 16:0x 又跑过一次**，用于 `candidate_alter_add_alt_platform_user_id_20260921_V1.sql`
（双 ID 空间归一，见 §4.6）。已核对：

```
candidate.platform_user_id_alt  VARCHAR(64) NULL   —— 位置紧跟 platform_user_id
idx_platform_user_alt (platform, platform_user_id_alt)  NON_UNIQUE  —— 刻意非唯一
```

⚠️ 字典序下 `candidate_alter_*` 排在 `candidate_create_*` **之前**（`'a' < 'c'`），
所以 alter 脚本对「表尚不存在」必须自跳过 —— 它已这么写。**改本表结构时 create 与 alter 必须成对同步**，
否则全新库与存量库会分叉。

### 2.2 重启后端 ✅ 已完成（2026-09-21 13:53:51）

**判定方法**：见下方「怎么确认后端已加载新代码」。

若将来又改了 Java 代码，需要重启：

```bash
# 找到并结束旧进程
lsof -nP -iTCP:6017 -sTCP:LISTEN -t
kill <上面的PID>

# ⚠️ 必须显式指定端口 —— 见下面的坑
cd ~/recruit-platform-github/recruit-server
SERVER_PORT=6017 mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=6017
```

> 🔴 **坑：不加 `--server.port=6017`，后端会绑到一个随机端口。**
> 实测（2026-09-21）：直接 `mvn spring-boot:run` 时，日志里出现的是
> `Tomcat started on port 57763`，而 `application.yml` 明明白白写着 `server.port: 6017`。
> 原因是**宿主进程注入了 `SERVER_PORT` 环境变量**，而 Spring Boot 的宽松绑定会把它
> 当成 `server.port`，**优先级高于 `application.yml`**（命令行参数才压得过环境变量）。
> 症状：后端「起来了」但浏览器和扩展打 6017 全是 502 / 连不上。
> 自检：`lsof -nP -iTCP:6017 -sTCP:LISTEN` 应该有一个 java 进程。

> 本仓库 **没有引入 `spring-boot-devtools`**，改 Java 代码不会热重启，每次都要手工重启。
> **改了 Java 却没重启 = 白改**：实测踩过 —— 后端源码已加 `user.name` 支持、`mvn compile` 也过了，
> 但运行中的进程还是老字节码，结果采集到的候选人 `name` 一直是 NULL。判据见下。

> 🔴 **坑：不要从「受限执行环境」（沙箱化的 shell / Agent 工具）启动后端。**
> 2026-09-21 实测：由 Agent 沙箱 shell 启动的实例，能创建文件、**但不能 rename/unlink**，
> 于是附件落盘在最后一步炸出 `Operation not permitted`（详见 §4.4）。
> 自检与规避：
>
> ```bash
> # 现象：目录里留下了 .tmp，但目标文件没生成
> ls -l recruit-server/data/attachments/boss/*/
> # 判定：同一操作在普通终端（Terminal.app / IDEA）里跑一遍，成功 → 就是启动环境的问题
> ```
>
> 推荐直接在**自己的终端**或 **IDEA** 里起后端，别让 Agent 代起。**本次已改为无沙箱启动。**

**怎么确认后端已加载新代码**（⚠️ 这里有个坑）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:6017/api/ext/collect/rules
# 401 ≠ 接口存在！下面解释
```

> ❌ **不要用 401/404 判断接口是否已加载。**
> Spring Boot 默认把 `/**` 映射给静态资源处理器，所以「接口不存在」时请求**仍然会进入
> `/api/ext/**` 的鉴权拦截器**并返回 401；接口不存在也不会出现 404。
>
> ✅ **正确判据**：登录后用 JWT 打中台接口，看是否返回业务码而不是 500：
>
> ```bash
> JWT=$(curl -s -X POST http://localhost:6017/api/auth/login -H 'Content-Type: application/json' \
>   -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
> curl -s "http://localhost:6017/api/candidates?page=1&size=10" -H "Authorization: Bearer $JWT"
> # 未重启：{"code":500,"msg":"系统繁忙，请稍后重试"}   ← 日志里是 NoResourceFoundException
> # 已重启：{"code":200,"msg":"success","data":{"records":[],"total":0,...}}
> ```
>
> 或者直接搜日志：`grep NoResourceFoundException recruit-server/logs/recruit-server.log`
> —— 出现这个异常就说明后端里根本没有那个接口。

**怎么确认「这次改的 Java 代码」已经生效**（比上面更具体）：

拿一条只在新代码下才成立的输入打一发，看落库结果。例如验证「嵌套 `user.name` 能不能取到姓名」：

```bash
JWT=$(curl -s -X POST http://localhost:6017/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
EXT=$(curl -s -X POST http://localhost:6017/api/extension/session-token -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"token":null}' | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -X POST http://localhost:6017/api/ext/collect/resumes -H "X-Extension-Token: $EXT" \
  -H 'Content-Type: application/json' -d '{"platform":"boss",
  "consent":{"confirmed":true,"ts":"2026-09-21T06:30:00.000","pageUrl":"https://x","scene":"chat"},
  "candidates":[{"platformUserId":"__probe_restart__","source":"chat","scene":"chat",
    "collectedAt":"2026-09-21T06:30:00.000",
    "fields":{"education":"本科","user":{"uid":123456,"name":"重启判定"}}}]}' > /dev/null
mysql -h 127.0.0.1 -P 3307 -uroot -precruit2024 recruit_platform \
  -e "SELECT platform_user_id,name FROM candidate WHERE platform_user_id='__probe_restart__';"
```

`name = 重启判定` → 新代码已加载；`name = NULL` → **运行中的还是旧字节码，必须重启**。
（判定完按 §5 清掉这条探针。）

### 2.3 重新加载扩展

`chrome://extensions` → 「招聘发布助手」→ 点「重新加载」。**改了 `background.js` / `collect-hook.js` / `manifest.json` 都必须重载**，然后刷新 BOSS 页面。

> ⚠️ 本扩展需要 `webRequest` 权限（附件靠它兜底观察）**以及覆盖 `*.zhipin.com` 的 host 权限**
> （`http://*.zhipin.com/*` + `https://*.zhipin.com/*`）。
> 后者是新补的：真实附件在 `docdownload.zhipin.com`，只授权 `www` 的话观察器收不到请求、
> 重放下载也会漏 cookie。**升级已有安装时**，Chrome 可能把扩展置灰或提示「需要新权限」——
> 在同一个页面点「接受」/重新启用即可（可能需要再点一次「重新加载」）。
> 不重载的话，附件只剩页面 hook 一条路，遇到「PDF 由浏览器内置阅读器打开」就又会采不到。

重载后怎么确认新代码真的生效（不用打开 devtools）：

- `chrome://extensions` 里该扩展的版本号应为 **`0.2.1`** —— 版本不对就是没重载成功
- 页面右下角浮层按钮出现 → content script 已注入新版本
- 观察任一 PDF 预览后，扩展 Service Worker 控制台应打印
  `[Background] 观察到附件请求: <tabId> download4boss:<加密geekId>`
  —— 这一行出现就证明**扩展层观察生效**，附件不会再漏
- 采集时若命中跨 ID 空间映射，还会打印
  `[Background] 跨 ID 空间映射命中: [...]` —— 这一行出现说明「数字 uid ↔ 加密 ID」查表成功

### 2.4 让扩展拿到 token

1. 打开 http://localhost:5176 ，用 `admin / admin123` 登录（`hr001` 需先按 §1 表格里的说明恢复密码）
2. 扩展的 bridge 检测到登录态后会自动调 `/api/extension/session-token` 换权
3. 确认：`chrome://extensions` → 该扩展 → 「Service Worker」控制台，应看到换权成功日志；
   或到「扩展授权」页面看是否新增了一条 `登录态自动签发`

---

## 3. 验证清单

### V1 · 接口层冒烟（不依赖浏览器）

> **✅ 本节已实测通过**（2026-09-21 13:54），结果见每步的「实测」行。以下命令可直接重跑复现。

取两个 token（**不用 python**，避免解析失败时静默得到空 token）：

```bash
# 1) 取中台 JWT
JWT=$(curl -s -X POST http://localhost:6017/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "JWT 长度=${#JWT}    # 必须是 172 左右；为 0 说明登录失败或解析失败，后面一定 401"

# 2) 换扩展 token
EXT=$(curl -s -X POST http://localhost:6017/api/extension/session-token \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"token":null}' | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "EXT 长度=${#EXT}    # 必须非 0"
```

> ⚠️ **取 token 的命令不要吞错误**（`2>/dev/null` + python 解析是反面教材）：
> 解析失败时 `$JWT` 会是空串，`Authorization: Bearer ` 会被后端判为未登录并返回
> `{"code":401,"msg":"未登录或登录已过期"}` —— 看起来像"登录态问题"，实际是命令问题。
> 所以**先打印 token 长度**再往下走。

```bash
# 3) 规则下发
curl -s http://localhost:6017/api/ext/collect/rules -H "X-Extension-Token: $EXT" | python3 -m json.tool | head -30

# 4) 红线①：缺少 consent 必须被拒
curl -s -X POST http://localhost:6017/api/ext/collect/resumes \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d '{"platform":"boss","candidates":[{"platformUserId":"x"}]}'

# 5) 红线②：一次提交多条必须被拒
curl -s -X POST http://localhost:6017/api/ext/collect/resumes \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d '{"platform":"boss","consent":{"confirmed":true},"candidates":[{"platformUserId":"a"},{"platformUserId":"b"}]}'

# 6) 平台白名单
curl -s -X POST http://localhost:6017/api/ext/collect/resumes \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  -d '{"platform":"liepin","consent":{"confirmed":true},"candidates":[{"platformUserId":"a"}]}'
```

> ⚠️ **业务错误的 HTTP 状态码是 200，不是 400。**
> 本项目 `GlobalExceptionHandler` 把 `MyException` 映射成 `R.fail(code, msg)` 且**未加 `@ResponseStatus`**，
> 所以判据要看 **body 里的 `code`**，不要看 curl 的 `%{http_code}`。
> 只有拦截器层（未登录 / 无 token / 无权限）才是真 HTTP 401/403。
> 扩展侧 `background.js` 也是按 `data.code !== 200` 判断的，与这个约定一致。

| 检查 | 期望 | 实测 |
|---|---|---|
| rules 返回 | `code=200`；`data.version=boss-20260921-V2`；`resumeKeys` 含 `experiences`/`content1`；`noisePathPrefixes` 3 条 | ✅ 通过 |
| 缺 consent | `code=400`，msg 含「缺少采集前确认」 | ✅ `consent 缺少采集前确认` |
| 多条提交 | `code=400`，msg 含「不支持单次提交多条」 | ✅ 通过 |
| 非 boss 平台 | `code=400`，msg 含「一期仅支持 platform=boss」 | ✅ 通过 |
| 无 token | 真 HTTP 401 | ✅ 通过 |

### V1.5 · 写入链路（curl 版，**不需要浏览器**）✅ 已实测通过

本节在浏览器那半验证之前先把后端写路径钉死。**结果是整条链路（候选人 → 版本 → 附件 → 审计）全部通过。**

```bash
EXT=<上面拿到的扩展 token>
curl -s -X POST http://localhost:6017/api/ext/collect/resumes \
  -H "X-Extension-Token: $EXT" -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "platform": "boss",
  "consent": { "confirmed": true, "ts": "2026-09-21T05:58:14.123",
               "pageUrl": "https://www.zhipin.com/web/chat/index", "scene": "chat" },
  "candidates": [{
    "platformUserId": "__smoke_test_001", "sourceChannel": "chat", "scene": "chat",
    "source": "chat", "sourceApi": "/wapi/zpjob/chat/geek/info",
    "sourceUrl": "https://www.zhipin.com/wapi/zpjob/chat/geek/info?uid=608120464",
    "fields": { "name": "冒烟测试候选人", "school": "梧州学院", "major": "软件工程",
                "ageDesc": "23岁",
                "workExpList": [{"timeDesc":"2024.07-2025.06","company":"某公司","positionName":"Java"}] },
    "raw": "{\"code\":0,\"zpData\":{}}", "rawEncrypted": 0, "rawBytes": 22, "rawTruncated": 0,
    "collectedAt": "2026-09-21T05:58:14.123",
    "attachments": [{ "platformFileId": "preview4boss:__smoke_test_001:1",
      "originUrl": "https://www.zhipin.com/wflow/zpgeek/download/preview4boss/__smoke_test_001?d=1&id=x&authType=0&previewType=1",
      "fileName": "冒烟测试简历.pdf", "contentType": "application/pdf;charset=utf-8",
      "bytes": 4, "sourceScene": "attach" }]
  }]
}
JSON
```

| 检查 | 实测结果 |
|---|---|
| 第 1 次提交 | `candidateCreated=true`、`resumeVersionCreated=true`、`attachmentIds=[1 个]`、message「新建候选人；新建简历版本；待下载附件 1 个」 |
| **第 2 次提交同一份** | `candidateCreated=false`、`resumeVersionCreated=false`，**candidateId 与 resumeVersionId 完全相同** → **三级幂等生效** |
| 落库 | candidate 1 行（name/school/major/age 归一正确，`ageDesc → age="23岁"`）；resume_version 1 行（`field_count=5`）；attachment 1 行（`status=stored`）；collect_audit 5 行（consent×2 + collect×2 + attach_download×1，操作人/授权 ID/来源 URL 齐全） |
| 附件落盘 | `recruit-server/data/attachments/boss/202609/preview4boss_smoke_test_001_1.pdf`（4 字节，`sha256=8dcc7e60…`，文件名里的 `:` 被正确净化为 `_`） |
| 中台读取 | `/api/candidates` 返回该候选人，`versionCount=1`、`attachmentCount=1` |

> 附件字节上传用：
> `curl -s -X POST ".../api/ext/collect/attachments/$AID/content" -H "X-Extension-Token: $EXT" -F "file=@/tmp/smoke.pdf;type=application/pdf"`

> ⚠️ **本节跑完会在库里留下 1 条测试候选人**（`platform_user_id = __smoke_test_001`，姓名「冒烟测试候选人」）。
> 好处是**不必等浏览器就能先验证中台「候选人」页的渲染**。用完按 §5 清掉即可。

> 🔴 **写客户端时必看：时间字段必须是 ISO-8601（带 `T`）。**
> `application.yml` 里的 `spring.jackson.date-format: yyyy-MM-dd HH:mm:ss` **只对 `java.util.Date` 生效，
> 对 `java.time.LocalDateTime` 无效** —— Jackson 的 JSR-310 模块固定按 ISO-8601 解析。
> 发成 `"2026-09-21 05:58:14"`（空格）会直接 500：
> `Text '2026-09-21 05:58:14' could not be parsed at index 10`。
> 正确写法：`new Date().toISOString().slice(0, 23)` → `2026-09-21T05:58:14.123`。
> 这与后端自身的输出格式一致（见 `recruit-web/src/lib/utils.ts` 的 `formatUtcIso` 注释）。

### V2 · 场景 C 聊天页采集（主路径）

> ⚠️ **附件（简历 PDF）只有在你先点开「简历预览」之后才会出现。**
> 实测踩过：只在聊天窗口点采集 → 候选人、简历版本都入库了，但 `attachment` 表**一行都没有** ——
> 因为页面根本没发出过 PDF 请求，扩展自然拿不到。
> 所以完整验证的顺序是：**打开聊天 → 点开简历预览（等 PDF 渲染出来）→ 再点采集**。

1. 在 BOSS 直聘打开某个候选人的聊天窗口（等简历卡片加载出来）
2. 页面右下角出现蓝色浮层按钮「采集到人才库」（若没有 → 见 §4 排障）
3. 点它
4. 期望 toast：

```
已采集 陈诗健
· 候选人：新建
· 简历版本：新建 1 份
· 附件：1/1 份已入库        ← 有简历预览过才有这一行
```

### V3 · 幂等（关键验收项）

**再点一次同一个候选人的采集按钮。**

期望 toast 变为：

```
· 候选人：已存在（复用）
· 简历版本：内容相同，已去重跳过
```

到数据库确认没有产生第二行：

```bash
mysql -h 127.0.0.1 -P 3307 -uroot -precruit2024 recruit_platform -e "
SELECT c.id, c.name, c.platform_user_id, c.version_count,
       (SELECT COUNT(*) FROM resume_version v WHERE v.candidate_id=c.id) AS versions,
       (SELECT COUNT(*) FROM collect_audit a WHERE a.candidate_id=c.id) AS audits
FROM candidate c ORDER BY c.id DESC LIMIT 5;"
```

| 期望 | 说明 |
|---|---|
| 候选人只有 1 行 | 幂等键 `platform + platform_user_id` 命中 |
| `versions = 1` | 内容哈希 `content_hash` 去重生效 |
| `audits` 随点击次数增长 | 每次点击都留痕（consent + collect 各一条） |

### V4 · 场景 A 列表页守卫（红线验证）

1. 切到「推荐牛人」列表页，**不要点开任何人的详情**
2. 点采集按钮
3. 期望**被拒绝**并提示：

```
当前响应包含 N 位候选人，没有明确的采集目标。
请点开具体候选人的简历或聊天窗口后再点采集（本功能只支持逐条采集，不做整页批量）。
```

这一条证明「整页批量」在服务端与扩展端双端都被挡住。

### V5 · 场景 D 附件采集（Phase 0 遗留的 D7 未决点）

> 🔴 **附件不走页面 JS —— 这是本项目最容易踩的一脚。**
> 实测三次踩坑（2026-09-21）：
> ① HR 没点预览 → 页面根本没发过 PDF 请求，采不到；
> ② HR **点开了预览、PDF 也渲染出来了，附件仍然是 0** ——
>    后端日志已证实那两次采集 `INSERT INTO attachment` 一条都没有。
>    根因：简历 PDF 常由「**浏览器内置阅读器 / iframe 导航 / 新标签页**」发起，
>    这些请求**不穿页面 JS 的 fetch/XHR**，跑在页面主世界的 hook 天然看不见。
> ③ 观察到了、也确认属于这个人，却**被归属校验判成「不匹配」而丢弃**。
>    根因是**两个 ID 空间**：文档侧以**数字 uid**（如 `608120464`）为幂等键，
>    而附件 URL 带的是**加密 geekId**（如 `01858de472ad39180XRy2t-9FFRU`）——
>    同一个人、两串完全不同的字符，拿单一口径比必然全灭（6 个真人全中）。
>
> 📌 **真机取证的 URL 形态**（2026-09-21 从 Chrome 下载链 `History` / `downloads_url_chains` 里挖出，
> 不再是推断值）：
>
> ```
> https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/<加密geekId>
>     ?d=1789957125000&geekId=<加密geekId>&previewType=1
> ```
>
> 三个此前**推断错**的点：域名是 `docdownload.zhipin.com`（不是 `www`）、
> 端点是 `download4boss`（不是 `preview4boss`）、末段是**加密** geekId（不是数字 uid）。
>
> 现在有**三条**采集路径，全部自动，HR 不需要多做任何动作：
>
> | 路径 | 能看见什么 | 实现 |
> |---|---|---|
> | 页面 hook | 页面 JS 自己 fetch/XHR 出来的附件 | `content/collect-hook.js` |
> | **扩展层观察** | **一切** zhipin 网络请求（含内置阅读器 / iframe / 新标签页） | `background.js` → `chrome.webRequest.onCompleted` |
> | DOM 兜底 | DOM 里挂着的 `<iframe>/<embed>/<object>/<a>` 附件 URL | `collect-hook.js` → `domAttachments()` |
>
> ⚠️ **`manifest.json` 的 host 权限必须覆盖 `*.zhipin.com`**（`http` + `https`）。
> 只授权 `https://www.zhipin.com/*` 时，`docdownload.zhipin.com` 的请求**根本不会触发**观察器，
> 重放下载也会因为缺权限而漏 cookie、被 CORS 拦。本轮已补上。
>
> **归属判定分三级，宁可不采也不张冠李戴：**
>
> | 级别 | 判据 | 结果 |
> |---|---|---|
> | 强证据 | 附件 URL（整条：路径段 + 全部 query 值）里出现本候选人的任一 ID —— 含**从多人列表响应里查到的「数字 uid ↔ 加密 ID」映射** | 直接采纳，`source_scene='attach'` |
> | 中证据 | 同上，但 ID 来自响应体全文扫描 | 直接采纳，`source_scene='attach'` |
> | 弱证据（兜底） | 同标签页 + 是该页**最近一次**附件请求 + 时差 ≤ 2 分钟 | 采纳但**必须**警告 HR 核对，`source_scene='attach_tab'`，且用掉即从缓存移除 |
> | 无 | 以上都不满足 | 丢弃，toast 报出**附件端点路径** + 候选人 ID，并落 `collect_audit` |
>
> 为什么保留弱证据这一级：BOSS 对**大多数**候选人不返回加密 ID，若该候选人的好友/会话列表这次没被抓到，
> 映射表就查不到 —— 一律拒绝会让「先预览再采集」这条**正确操作路径**永远采不到附件，功能等于没用。
> 约束是「同标签页 + 最近一条 + 2 分钟 + 用掉即失效 + 显式警告」，把张冠李戴压到最低。
> 观察缓存在 `chrome.storage.session`，窗口 30 分钟（与票据有效期同量级）。
> 注意缓存**按时间倒序且幂等**（`pruneAttachCache` 显式排序）—— 这个顺序是兜底判定的依据，不能靠数组顺序。

1. 在聊天里点开某候选人的简历预览（等 PDF 渲染出来）
2. **紧接着**点采集按钮 —— **在聊天页点即可**，不用切到 PDF 那个页签
   （兜底判定的时效窗是 2 分钟，隔太久只能靠强/中证据，见上表）
3. 结果判读（五种都有明确含义）：

| toast | 含义 | 后续 |
|---|---|---|
| `附件：1/1 份已入库` | 全链路通（观察 → 比对 → 下载 → 上传 → 落盘） | D7 结案 |
| `⚠️ 1 份附件未能下载入库` | 观察到了，但重放下载失败 | 看 `fail_reason` 定退化路径 |
| `⚠️ 有 1 份附件按「同标签页最近预览」认领（未获得 ID 佐证）` | 兜底生效，**需人工核对** | 到中台核对是否确属该候选人 |
| `⚠️ 观察到 N 个附件请求，但都与当前候选人 ID 不匹配` | 观察到了，但认不出属于谁 | 看 toast 里的**附件端点路径**与候选人 ID，判断是口径不对还是真不是这个人 |
| `⚠️ 本次没有采集到附件` | 压根没观察到任何附件请求 | 确认预览是否真的点开过 |

失败原因必然落在库里（这是 D7 的判据）：

```bash
mysql -h 127.0.0.1 -P 3307 -uroot -precruit2024 recruit_platform -e "
SELECT id, platform_file_id, status, bytes, LEFT(fail_reason,120) AS reason, origin_ticket_expires_at
FROM attachment ORDER BY id DESC LIMIT 5;"

# 被归属校验丢弃的附件：真实 URL 落在 client_note 里（诊断口径专用）
mysql -h 127.0.0.1 -P 3307 -uroot -precruit2024 recruit_platform -e "
SELECT id, LEFT(client_note,300) AS note, created_at FROM collect_audit
WHERE action='attach_download' AND result='skipped' ORDER BY id DESC LIMIT 5;"
```

原因对照：`HTTP 403` → 风控拒绝无 Referer；`HTTP 401` → cookie 未带上；`内容为空` → 被拦成空响应；
`附件不存在` → 后端配对错位。

成功时核对文件真的落盘了：

```bash
ls -laR ~/recruit-platform-github/recruit-server/data/attachments/ | head -20
# 目录形态：<platform>/<yyyyMM>/<净化后的端点段>_<文件ID>.pdf
#   例：boss/202609/download4boss_01858de472ad39180XRy2t-9FFRU.pdf
#   （platformFileId 里的 `:` 会被 AttachmentStorageService.sanitize 换成 `_`）
```


### V6 · 中台候选人库页

1. 打开 http://localhost:5176 → 侧栏「候选人」（原先显示「建设中」，现已启用）
2. 列表应出现刚采集的候选人，列含来源渠道（候选人主动来 / 我方主动发）、版本数、附件数
3. 点行进详情，核对三块：
   - **简历版本**：展开可看到归一字段（`name`/`school`/`workExpList`…）
   - **附件**：状态「已入库」+ 大小 + sha256 前 12 位；失败会红字显示原因
   - **采集审计**：每次点击都有 `采集前确认` + `提交采集` 两条，带操作人与 pageUrl

### V7 · 幂等键空间一致性 ✅ 已实证：**不一致**，已按「写入时归一」收敛（见 §4.6）

Phase 0 发现「聊天链路给加密 `encryptUid`、推荐列表给数字 `geekId`」，两者**从未在同一对象里同时出现**，
因此无法证明同一个人走两条链路会得到同一个 ID。

真机后果：**分裂成两条候选人**。实测两对 —— 陈诗健（`608120464` + `01858de…`）、
谢建广（`681940311` + `f4c1f177…`）。用户决策**写入时归一**，已实现，见 §4.6。

复测步骤（改造后应当**始终 1 条**）：

1. 在聊天里采集某人 → 记下候选人库里的 `platform_user_id`
2. 去推荐牛人列表搜到同一个人 → 点开其简历 → 采集
3. 看候选人库是 **1 条还是 2 条**

- 1 条 → 归一生效
- 2 条 → 看详情页：后建那条的 `platform_user_id_alt` 是否有值；
  若某一行 `alt` 为空说明是「单形态建行 → 后来只带另一种形态」的残留缺口，见 §4.6 末节

```sql
-- 任何时刻都该返回 0 行（除 §4.6 末节描述的残留缺口）
SELECT enc.id, enc.platform_user_id, num.id, num.platform_user_id, enc.name
FROM candidate enc
JOIN candidate num ON num.platform = enc.platform
 AND num.platform_user_id = enc.source_platform_user_raw AND num.id <> enc.id
WHERE enc.merged_into IS NULL AND num.merged_into IS NULL
  AND enc.platform_user_id REGEXP '[A-Za-z]'
  AND num.platform_user_id REGEXP '^[0-9]+$';
```

---

## 4. 排障

| 现象 | 原因 | 处置 |
|---|---|---|
| 页面右下角没有采集按钮 | ① 扩展没重载 ② 当前页面不在注入匹配列表里 ③ 在 iframe 里 | 重载扩展并刷新页面；确认 URL 属于 `/web/chat/*`、`/web/frame/recommend/*`、`/web/frame/c-resume/*`、`/bzl-office/pdf-viewer-b*` 之一；按钮只在顶层帧渲染 |
| 点按钮提示「扩展后台无响应」 | service worker 未启动或报错 | `chrome://extensions` → Service Worker → 看控制台报错 |
| 提示「未找到扩展 token」 | 没在 5176 登录过，或前端端口不是 5176 | 登录一次；确认前端端口 |
| 提示「没有可采集的简历数据」 | 环形缓冲里没有命中项 | 先在 BOSS 里打开候选人的简历详情或聊天窗口，等数据加载完再点 |
| 提示「未能识别候选人 ID」 | 响应里既没有加密 ID，URL 也没带 | 同上：先点开具体候选人 |
| 采集成功但候选人库为空 | 后端连的不是同一个库 | 核对 `application-dev.yml` 的 JDBC 指向 `127.0.0.1:3307/recruit_platform` |
| 改了 Java、也 `mvn compile` 过了，但行为没变 | **后端没重启**，运行中的还是旧字节码 | 重启（见 §2.2），并用「探针」确认新代码已加载 |
| 后端「起来了」但浏览器打 6017 连不上 | **端口被 `SERVER_PORT` 环境变量顶掉**，绑到了随机端口 | 启动时显式 `--server.port=6017`（见 §2.2）；用 `lsof -nP -iTCP:6017 -sTCP:LISTEN` 自查 |
| 候选人入库了但**附件为 0** | ① 没点开简历预览 ② 点开了但请求没被观察到 ③ 观察到了但 geekId 对不上 | 按 toast 的四种提示逐条判（见 V5 的表格）；情形 ③ 会把「看到几个」报出来 |
| 候选人的**姓名是空的** | ① 姓名嵌在 `body.resume.user.name` ② 后端没重启，`user.name` 支持未生效 | 已修（2026-09-21）：扩展保留浅层对象 + 后端支持点号路径。**须同时重载扩展 + 重启后端** |
| `platform_user_id` 是**一串数字**而不是加密串 | 选中了没有加密 ID 的响应（如 historyMsg） | 已修（2026-09-21）：改为「字段取最丰富的、身份取带加密 ID 的」。**须重载扩展** |
| 同一个人采两次变成两条候选人 | 两次拿到的 ID 形态不同（数字 vs 加密） | 即上一条的后果；修好后不会新产生，但**存量坏行要手工清**（见 §5） |
| 附件全部 `HTTP 403` | 平台风控拒绝无 Referer 的 SW 请求 | 这是 D7 的结论，Phase 2 需退化路径（DOM blob 或页面内发起） |

## 4.1 已于 2026-09-21 修复的两个真机问题

首次真机点击采集（14:01）时，候选人入库了但暴露两处缺陷，均已修复并离线验证（13/13 断言通过）：

| 现象 | 根因 | 修法（改的文件） |
|---|---|---|
| `candidate.name` 为 NULL | 聊天消息的简历对象是 `messages[].body.resume`，姓名在 **`body.resume.user.name`**（嵌一层）；扩展的 `extractFields` 只留标量与对象数组，把 `user` 这层丢了 | `extension/background.js`：`extractFields` 保留「浅层对象」（所有值都是标量、≤20 键）；`CollectService.pick` 支持 `user.name` 点号路径 |
| `platform_user_id` 是**数字**而非加密串 | 聊天页两条命中各有优势：`historyMsg` 字段最丰富但**没有加密 ID**；`chat/geek/info` 字段少但**有 encryptUid**。原来只取一条 → 字段全的那条把幂等键拖成了数字 uid | `collect-hook.js` 改为交出**多条**候选；`background.js` 新增 `selectSources()`：**字段取命中键最多的、身份取带加密 ID 的**，并把数字 uid 一并带上（落 `candidate.source_platform_user_raw` 供对账） |
| **`platform_user_id` 竟然是自己（HR）的 uid** | 修上一条时我把「**优先扫描候选人对象节点**」这层保护弄丢了，变成全响应体扫描。而 `historyMsg` 的消息信封里 `from`/`to` **同时含 HR 与候选人**，DFS 遍历顺序不可预测 —— 真机第二次采集就抓到了 HR 的 `618821200` | `background.js` 的 `selectSources()` 恢复「**节点优先、body 兜底**」：每个来源先扫 `extractFields(body).node`（候选人对象，不含信封），再退整份 body。**该修复不依赖 selfUid 是否已知**（离线回归 10/10：信封顺序调换、selfUid 未知两种情形都不再抓到 HR） |

> 第 3 条的实质影响：**会把 HR 自己存成一条候选人**（数据污染，不只是重复）。
> 判断存量坏行的方法：`SELECT * FROM candidate WHERE platform_user_id = '<你自己的 uid>';`
> 自己的 uid 可从 `sys_user` 对不上 —— 它在 BOSS 侧就是会话里 `to` 字段的那个 uid。

> 顺带说明为什么这三条都只改了扩展：**Java 侧改动需要重启后端才生效**，
> 只重载扩展是不够的。详见 §2.2 的重启提示。

> 第 2 条的实质影响：同一个人走聊天消息链路会拿到数字 uid、走候选人卡片链路会拿到 encryptUid，
> **两条链路会给同一个人两个不同的幂等键 → 分裂成两条候选人**。这正是 V7 要验的命题，
> 现在已有实证。修复后只要聊天页同时存在候选人卡片响应（通常都有），就会优先用加密 ID。


## 4.2 已于 2026-09-21 修复的另两处真机问题（第二轮）

第二次真机点击（14:14）的现象是「点开了预览、PDF 也渲染了，附件仍然是 0」。
靠**后端日志 + 离线回归**定位出两处（都不是猜的）：

| 现象 | 根因 | 修法（改的文件） |
|---|---|---|
| `candidate.name` 依然是 NULL —— 尽管源码已改、`mvn compile` 也过了 | **运行中的后端还是旧字节码**。本仓库没有 devtools，改 Java 必须重启。判定方式：打一条 `fields.user.name` 的探针，落库为 NULL 就证明跑的是旧代码 | 重启后端，并**显式加 `--server.port=6017`**（宿主注入的 `SERVER_PORT` 会顶掉 `application.yml` 的 6017）。判定探针已写进 §2.2 |
| 预览已点开、PDF 已渲染，采集结果**附件仍为 0** | **简历 PDF 不穿页面 JS** —— 它由浏览器内置阅读器 / iframe 导航 / 新标签页发起，页面主世界的 hook 看不见。后端日志佐证：那两次采集 `INSERT INTO attachment` **一条都没有**（不是下载失败，是压根没登记） | 三条路径齐上：① `background.js` 新增 `chrome.webRequest.onCompleted` 观察（需 `webRequest` 权限）→ 缓存进 `chrome.storage.session`；② `collect-hook.js` 新增 `domAttachments()` 扫 `<iframe>/<embed>/<object>/<a>`；③ 采集时按 **geekId 与当前候选人比对**后并入，比对不上就丢弃并明确告知 HR |

> 「按 ID 比对」是关键安全阀：附件 URL（整条：路径段 + 全部 query 值）里出现候选人的
> 任一已知 ID 才采纳。**认不出是谁的附件一律不采 —— 宁可漏，不可错。**
> ⚠️ 但本轮的初始口径（「路径末段就是 geekId」）**是推断的，真机证明不成立**，见 §4.3。

> 验证手段：离线回归 `node test/extension-collect-verify.cjs` **49/49 通过**（见 §7）；
> 另用 curl 模拟「webRequest 形态的附件（无 content-type、无 bytes）」打真实后端 ——
> 附件正常登记为 `pending`、`name` 从嵌套 `user.name` 取到、备用数字 ID 落进 `source_platform_user_raw`。

## 4.3 已于 2026-09-21 修复的第三轮真机问题（附件被 ID 匹配拦下）

第三次真机点击（14:41，6 个候选人）的现象是「只有对方真的发了简历的才观察到附件请求，
但都被判成 ID 不匹配而丢弃」。**这次没有再猜，直接去拿真 URL。**

**取证方式（可复用）**：Chrome 把「点开/下载 PDF」记进了浏览历史与下载链，
用 sqlite 直读即可拿到真实请求：

```bash
cp ~/Library/Application\ Support/Google/Chrome/Default/History /tmp/ch_hist.db
sqlite3 /tmp/ch_hist.db "SELECT target_path, tab_url FROM downloads ORDER BY start_time DESC LIMIT 10;"
sqlite3 /tmp/ch_hist.db "SELECT DISTINCT url FROM downloads_url_chains WHERE url LIKE '%zhipin%';"
```

**拿到了什么**：真实附件请求是
`https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/01858de472ad39180XRy2t-9FFRU?d=…&geekId=01858de472ad39180XRy2t-9FFRU&previewType=1`，
而库里这位候选人（陈诗健）的 `platform_user_id` 是**数字** `608120464`。

| 现象 | 根因 | 修法（改的文件） |
|---|---|---|
| 附件被「ID 不匹配」丢弃 | **两个 ID 空间**：文档侧以数字 uid 为幂等键，附件 URL 带**加密** geekId。而 BOSS 聊天页对**大多数**候选人不返回加密 ID（见 §4.1 第 2 条），所以加密 geekId 压根不在候选人的已知 ID 里，怎么比都不中 | `background.js` 新增 `bridgeIdentityIds()`：**从多人列表响应里查映射表**（数字 uid ↔ 加密 geekId）。这类响应不能当采集来源（会混进几十个人），但当映射表完全合法 —— 查到之后两者就是**精确相等**，不是放宽猜测 |
| 附件请求可能压根没被观察到 | `manifest.json` 只授权 `https://www.zhipin.com/*`，而真实附件在 **`docdownload.zhipin.com`** —— 没有该域 host 权限，`webRequest` 监听器不会被触发，重放下载也会漏 cookie + 被 CORS 拦 | `manifest.json` 补 `http://*.zhipin.com/*` + `https://*.zhipin.com/*`；`background.js` 的 `webRequest` 过滤条件同步加 `http://` |
| 同一份简历可能入库两行 | `platform_file_id` 里拼了 `previewType`，而同一份附件有「带 query」与「重定向后不带 query」两种 URL → 算出两个键；`uk_platform_file` 是**全局唯一**，于是同一份文件登记两行 | `buildPlatformFileId`（`background.js` + `collect-hook.js` **两处必须同步**）改为 `<端点段>:<路径末段>`，**不含 query** |
| 兜底认领会认领到**上一位**候选人的附件 | `pruneAttachCache()` 靠「从数组尾部倒着取」近似倒序，但该变换**不幂等** —— `loadAttachCache()` 与 `getRecentAttachments()` 各调一次，同一条调用链跑两遍就把顺序翻了回去 | `pruneAttachCache()` 改为**显式按 `ts` 倒序排序**，顺序不再依赖数组初始排列 |

> 兜底认领（`source_scene='attach_tab'`）是本轮新引入的**最低一级**证据：
> 同标签页 + 该页最近一次附件请求 + 时差 ≤ 2 分钟 + 用掉即从缓存移除 + 必须警告 HR。
> 为什么不得不加：BOSS 对大多数候选人不返回加密 ID，映射表也可能查不到 ——
> 一律拒绝会让「先预览再采集」这条**正确操作路径**永远采不到附件。详见 §V5 的三级判据表。

> 验证手段：离线回归扩到 **49/49 通过**，其中 T9–T13 全部使用**真机取证的 URL 形态**
> （`docdownload…/download4boss/<加密geekId>`），不再用推断样例；
> 覆盖「映射表查表」「无映射表时拒绝」「兜底时效窗与最近一条」「幂等键折叠」四组边界。
> 这轮里 T12b 还真逮到一个 bug（`pruneAttachCache` 不幂等导致顺序反转），不是测试写错。

## 4.4 已于 2026-09-21 修复的第四轮：归属判定通过后，落盘被环境拒绝

第四轮真机点击（15:16）**前四环全通了**：

```
观察 ✓ → 归属校验 ✓（preview4boss:01858de472ad39180XRy2t-9FFRU）→ 下载 ✓（220,840 字节真 PDF）→ 落盘 ✗
```

toast 报：

```
附件落盘失败: …/data/attachments/boss/202609/preview4boss_01858de….pdf.tmp
             -> …/preview4boss_01858de….pdf: Operation not permitted
```

**注意两个好消息**：① `platform_file_id` 是 `preview4boss:` 而不是 `download4boss:` ——
说明「预览」和「下载」是两个端点，而 `<端点段>:<路径末段>` 这个口径把两种都接住了；
② 加密 geekId 被正确认领，说明第 3 轮的映射表/整条 URL 比对起作用了。

### 根因：后端进程跑在**受限执行环境**里

判据（不是猜的）：

| 观察 | 结论 |
|---|---|
| 目录里留下了 `.tmp`（220 KB，`file` 认作 PDF v1.7 3 页），目标文件不存在 | 创建 + 写入**成功**，只有 **rename** 失败 |
| 同一个目录、同样的 `Files.write` + `Files.move(ATOMIC_MOVE, REPLACE_EXISTING)`，用普通方式起一个 JVM 跑 → **四种写法全 OK** | 不是代码问题、不是文件系统问题 |
| 失败的那个 JVM 启动于 Agent 的沙箱 shell；无沙箱跑同一操作则通过 | 是**进程继承的执行环境**问题 |

「能创建、能被写、不能 rename/unlink」正是受限执行环境（macOS seatbelt 一类）的典型特征 ——
因为 `rename()` 需要 unlink 源条目。**这类问题只在写文件时才暴露，看起来像应用 bug。**

### 两处修复

| # | 问题 | 修法 |
|---|---|---|
| 1 | `AttachmentStorageService.store()` 只有「临时文件 + `ATOMIC_MOVE`」一条路，环境不支持就永远落不了盘 | 新增 `writeAtomicOrDirect()`：原子替换失败即**退化直写**（本类当前无读回路径，`load`/`exists` 全仓无调用方，且 `status` 只在写库后才置 `stored`，所以直写安全） |
| 2 | 失败时把 `.tmp` 遗弃在数据目录（每次 200 KB+ 垃圾） | `finally` 里 `deleteIfExists(tmp)`；连 unlink 都被拒时也吞掉异常，不让清理失败连累落盘 |
| 3 | 环境层面 | 后端改为**无沙箱启动**（见 §2.2） |

> ⚠️ 这次失败**不影响可重试性**：`CollectService` 的 `needUpload` 只要 `status != 'stored'` 就会带上，
> 所以同一位候选人再点一次采集即可补上，不需要清库。
> 失败遗留的 `.tmp` 已手工清掉（内容可由 `origin_url` 重放复现）。


## 4.5 第五轮（同日）：中台可直接打开附件 + 附件无需点预览

### 结论：点开预览**不是必要条件**

真机取证（Chrome 本地下载库挖出的 URL）发现，附件下载 URL 的 query 里只有
`d`（毫秒时间戳）、`previewType`、`geekId`，**没有任何签名/票据字段** ——
说明它是页面在点击时自己拼出来的（`d` 就是当时的 `Date.now()`），授权只靠 cookie。
凡是页面能拼的 URL，扩展也能拼。所以预览只是「最省事的一条路」，
不是「唯一的路」：有加密 geekId 就能自己拼 URL 发一次请求。

### 三个改动

| # | 问题 | 改动 |
|---|---|---|
| 1 | 中台完全无法打开附件（`AttachmentStorageService.load/exists` 全仓无调用方） | 后端新增 `GET /api/candidates/attachments/{id}/content`（登录态，`inline` + `nosniff` + `no-store`）；`AttachmentVO` 增加**服务端算好**的 `openable`（status=stored **且**文件真在盘上）；前端详情弹窗给每条附件加「预览 / 下载」按钮 + 内联 PDF 面板 |
| 2 | 受限环境里 `.tmp` 删不掉、每次落盘都多留一份等大垃圾 | `atomicReplaceUsable` 记住「原子不可用」后**本进程一律直写**（不再产生新 `.tmp`）；删不掉就截成 0 字节（受限环境拒的是 unlink、写入通常允许，截 0 后一眼可辨是垃圾）；启动时清扫历史 `.tmp` |
| 3 | HR 必须先点预览才能采到附件 | 扩展新增**附件主动探测**：观察路径零收获时，用候选人的加密 geekId 依次试 `preview4boss` / `download4boss`，**只认 `%PDF` 魔数**（平台对「没有附件」常用 200 + HTML 回应，只看 HTTP 200 会把错误页当简历入库）；探测拿到的字节直接复用上传，不再二次请求平台 |

### 为什么要做内容嗅探（`%PDF` 魔数）

这是这轮最关键的一个防御点。平台对「这位候选人没有附件简历」很可能用
200 + 一个 HTML 错误页回应 —— 光看 `resp.ok` 和 `blob.size` 会把它当成一份简历
存进库。那比没采到更糟：脏数据 + 需人工核对 + 审计里看起来一切正常。

### 归属安全性

探测用的 URL 是用**这位候选人自己的**加密 geekId 拼的，归属由构造方式保证，
比 `attach_tab`（同标签页最近预览）那种弱证据兜底强得多。
但探测仍定位为**兜底**而非主路径：它要多打一次平台请求（多一分风控暴露面），
HR 点过预览的话，观察路径已经零成本拿到了。

### 验证记录（2026-09-21）

```bash
# 1) 接口层（真实 JWT + 真实附件，sha256 与库中一致）
TOKEN=$(curl -s -X POST http://127.0.0.1:6017/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
curl -s -D - -o /tmp/att.pdf \
  http://127.0.0.1:6017/api/candidates/attachments/<附件ID>/content \
  -H "Authorization: Bearer $TOKEN"
# 期望响应头：Content-Type: application/pdf / Content-Disposition: inline; filename=… /
#             X-Content-Type-Options: nosniff / Cache-Control: no-store

# 2) 错误分支：业务 404 走 HTTP 200 + JSON（前端 requestBlob 靠 content-type 识别），
#    未登录走真 HTTP 401

# 3) 落盘与清扫（不走 JUnit，直接 main）
mvn -q dependency:build-classpath -Dmdep.outputFile=/tmp/cp.txt
java --class-path "target/classes:$(cat /tmp/cp.txt)" StorageVerify.java
# 期望：启动清扫清掉预埋 .tmp / store+load 读回一致 / 同 key 重写后目录 1 文件 0 .tmp /
#       路径穿越被「非法存储路径」拦截

# 4) 离线回归（含 T14–T18 主动探测）
node test/extension-collect-verify.cjs   # 70/70

# 5) 前端类型检查
cd recruit-web && npx vue-tsc -b
```

UI 验证（Chrome headless + CDP，真实前端 + 真实 JWT）：候选人详情弹窗里
附件行出现「预览 / 下载」，点预览后 iframe 以 Chrome 内置阅读器渲染出 PDF 全部 3 页。

### 已知遗留

- **陈诗健两条候选人已按「写入时归一」收敛**，见 §4.6（同批还有谢建广）。
- 扩展版本 `0.2.2`：改动后需在 `chrome://extensions` 重新加载才会生效。


## 4.6 第六轮（同日）：双 ID 空间「写入时归一」

**用户决策**：「陈诗健的两条候选举止采用写入时归一，当有新的简历时，在我们的中台对应人的明细下更新即可。」

### 实测到的问题是两对，不是一对

用户当时只知道陈诗健。写完配对查询后跑真实库，**多出一对谢建广**：

| 姓名 | 加密键（规范键） | 数字键（备用键） | 备注 |
|---|---|---|---|
| 陈诗健 | `01858de472ad39180XRy2t-9FFRU` | `608120464` | 两行的 `content_hash` **完全相同**（`0418b86c…`） |
| 谢建广 | `f4c1f17734410c500Xx70tm9E1NR` | `681940311` | 两行的 `content_hash` **完全相同**（`0382ace0…`） |

→ 这让「归并时必须去重」成为**运行期硬障碍**：`resume_version` 上有唯一键
`uk_candidate_hash (candidate_id, content_hash)`，所以「把落后方的版本直接改挂到幸存者」必然
`ERROR 1062 Duplicate entry`。**首跑就是这么失败的**（见下方「首跑失败与修正」）。

### ⚠️ 首跑失败与修正（2026-09-21 16:15）

首版脚本把去重放在改挂**之后**，第 4 步 `UPDATE resume_version … SET candidate_id = 幸存者` 直接撞唯一键：

```
ERROR 1062 (23000) at line 100: Duplicate entry '2101933690487238658-0418b86cec0325cf…'
for key 'resume_version.uk_candidate_hash'
```

MySQL 每条语句自动提交、脚本没有显式事务，所以**落在了半途**：

| 步骤 | 首跑是否生效 |
|---|---|
| 幸存者补 `platform_user_id_alt`、时间取并集 | ✅ 已生效 |
| 落后方标记 `merged_into` | ✅ 已生效 |
| 简历版本改挂 | ❌ 语句整体回滚（未生效） |
| `version_count` 重算 / 附件改挂 | ❌ 因报错提前退出，未执行 |

修正后步骤顺序改为：**先把与幸存者同 hash 的落后版本挑出来 → 救附件 → 删掉 → 再把剩下的
（hash 不冲突的）改挂**；并让配对条件接受「落后方已指向本幸存者」，因此**能从半途续跑**，
不需要回滚。第二条修正：`content_hash` 判重用 `=` 而不是 `<=>` —— 唯一键对 NULL 视为互不相同，
把 NULL hash 当重复删掉会平白丢一份快照。

**同时也纠正一处先前的错误结论**：这之前判断「`resume_version` 没有 (candidate_id, content_hash)
唯一键、#同 hash 去重是为了躲 `TooManyResults`」是**错的** —— 唯一键存在，代价因此从
「采集偶发失败」变成「迁移直接卡住」。

### 归并方向与终态

**幸存者 = 加密键那一行**（附件下载端点的路径段就是加密 geekId，用同一标识对齐可省一次 ID 换算）。
配对的依据是**精确字段**而非姓名模糊匹配：`加密行.source_platform_user_raw = 数字行.platform_user_id`
（该字段由扩展上报的备用 ID 写入，语义就是「同一个人的另一种形态」），再叠加 platform 相同、id 不同、姓名相同。

终态：

| 内容 | 处理 |
|---|---|
| 幸存者 `platform_user_id_alt` | = 被兼并方的数字 uid（**这是「写入时归一」生效的运行期依据**） |
| 幸存者 `first/last_collected_at` | 取两行的最早 / 最晚（不丢「首次见到他」的时刻） |
| 简历版本 | hash 不冲突的**改挂**到幸存者；与幸存者同 hash 的落后版本**删除**（先救附件再删） |
| 冲突版本保留哪一份 | **幸存者那一份**（不是 `MIN(id)`）。理由：① 现有 `attachment` 就指向它，保留它无需改附件指针，风险最小；② 两份 `content_hash` 相同 = 字段内容完全一致，没有信息损失 |
| 附件 | 先改挂到幸存者；若它指向的版本被删，则改指到保留版本 |
| 被兼并方 | `merged_into` 指向幸存者（列表已按 `merged_into IS NULL` 过滤） |
| `collect_audit` | **一行都不改**（append-only 红线），靠详情页的 `platform_user_id` OR 条件重新接回 |

### 四处代码改动

| # | 位置 | 改动 |
|---|---|---|
| 1 | `candidate` 表 | 新增 `platform_user_id_alt VARCHAR(64) NULL` + **非唯一**复合索引 `idx_platform_user_alt (platform, platform_user_id_alt)` |
| 2 | `CollectService.collectOne` | 候选人查找从单键改为 **双键 `(platform_user_id ∪ platform_user_id_alt)`**；规范键优先取加密形态；已有行首次学到另一形态时补写 `alt` |
| 3 | `CollectService` 版本查找 | `selectOne` → `selectList(...).last("LIMIT 1")`（**零成本防御**：表上其实有唯一键 `uk_candidate_hash`，正常情况下 selectOne 也能跑；改成列表形式是为了万一唯一键将来被放宽时不至于因 `TooManyResults` 堵死整个采集） |
| 4 | `CandidateQueryService.detail` | 跟随 `merged_into`（一跳）到幸存者；审计按 `candidate_id OR (platform + platform_user_id IN ids)` 重新接回 |

配套扩展改动：`background.js` 新增 `counterpartIdOf(primary, candidates)` 产出 `secondaryPlatformUserId`
（**严格限定为同一个人的另一种形态**，刻意排除 `idHints` 这个过宽的集合 —— 混进别人的 ID 就是候选人级张冠李戴）。

### 为什么 `platform_user_id_alt` 不复用 `source_platform_user_raw`

| 字段 | 语义 | 活的还是死的 |
|---|---|---|
| `source_platform_user_raw` | **首次**采集时的平台原始 ID 文本，只写一次，纯对账 | 死的 |
| `platform_user_id_alt` | 同一人的另一种 ID 形态，会随「学到的形态」补齐，**参与幂等查询** | 活的 |

两者混用会让查询侧无法区分「这是查找键」还是「这是历史快照」。

### 执行顺序（有强制关系，别调换）

```bash
# ① 加列（幂等；ALTER 排在 create 之前，表不存在时自跳过）
cd /Users/zhuanzmima0000/recruit-platform-github && ./scripts/db-bootstrap.sh

# ② 重启后端 —— 新代码会 SELECT platform_user_id_alt，列不加会直接报错
cd recruit-server && SERVER_PORT=6017 mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=6017

# ③ 一次性归并（sql/upgrade/ 不自动执行）
#    必须整个文件在同一个会话内执行（用到 TEMPORARY TABLE），拆成多条命令逐段跑会因临时表消失而失败。
```

**实际执行（2026-09-21 16:14，AI 代跑，用户明确授权）**：

```bash
# 备份（123KB，4 张表）
docker exec recruit-mysql sh -c 'mysqldump -uroot -precruit2024 --default-character-set=utf8mb4 \
  --single-transaction recruit_platform candidate resume_version attachment collect_audit' \
  > /tmp/before_normalize_20260921.sql

# 执行（首跑在第 4 步撞唯一键 → 修脚本 → 重跑成功）
docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 -uroot -precruit2024 recruit_platform \
  < recruit-server/sql/upgrade/candidate_normalize_dual_id_space_20260921_V1.sql
```

### 验证记录（2026-09-21）

| 项 | 命令 / 判据 | 结果 |
|---|---|---|
| 后端编译 | `mvn compile -DskipTests` | **BUILD SUCCESS** |
| 前端类型 | `npx vue-tsc -b --force` | **exit 0，零输出** |
| 离线回归 | `node test/extension-collect-verify.cjs` | **81/81**（T19–T22 = 归一用例） |
| 加列结果 | `information_schema` 查列与索引 | `platform_user_id_alt` 位于 `platform_user_id` 之后；`idx_platform_user_alt` 非唯一 |
| 归并预览（只读） | 脚本 §0 的配对查询 | 恰好 **2 对**（陈诗健 / 谢建广），无误配 |
| **归并执行结果** | 候选 8（有效 **6**）/ 版本 9 → **7** / 附件 2 / 审计 **27 未变** | ✅ 与预期完全一致 |
| 脚本 §8 自检 | 残留版本=0 / 残留附件=0 / 悬空附件=0 / 重复版本组=0 | ✅ **全 0** |
| 归并终态 | 陈诗健 `alt=608120464`、`version_count=2`、时间 06:41:05→07:49:31；谢建广 `alt=681940311`、`version_count=1`、时间 06:40:50→07:50:33 | ✅ 两行的 `merged_into` 均为 NULL（= 幸存者），落后方均指向它们 |
| **脚本幂等性** | 原样再跑一遍 | ✅ 「待删的冲突版本数 = 0」，四项自检仍全 0，四表计数不变 |
| 附件受影响面 | `SELECT * FROM attachment` | 2 条都挂在**幸存者**上，且指向的是**被保留**的那份版本 → 本次未触发「救附件」分支（保留幸存者那份的选择让这条风险路径根本不出现） |

T22 是最关键的用例：**多人列表里「别人」的 ID 绝不进入备用键**。它锁住了整个归一的正确性前提。

### 已知的残留缺口（未修，建议后续处理）

**单形态建行 → 后来只带另一种形态** 的场景仍会分裂：

1. 某次采集只拿到加密 ID（`secondary` 也为空）→ 建行 `key=加密, alt=NULL`；
2. 之后某次采集只拿到数字 uid（页面确实不返回加密 ID，真机上对多数候选人成立）→
   双键查询：`platform_user_id IN ('数字')` 不中；`platform_user_id_alt IN ('数字')` 因 `alt IS NULL` 结果为 NULL → **不中** → 建第二行。

根因是**信息不足**：只有一个 ID 形态时，没有任何字段能把两个 ID 关联起来（这正是「不用姓名模糊匹配」的代价）。
可选补丁（都未被采纳，留待决策）：

- **低风险**：建行时若只有一种形态，追加一条 WARN 日志（同 platform + 同姓名 + 未归并 + id 不在本次集合内），
  只报告不自动合并 —— 与框架 §4.3「不自动合并」一致；
- **中风险**：`bridgeIdentityIds` 的覆盖再扩一档，让「加密首发」时尽量能同时拿到数字形态。

### 另一处顺带发现（低优先级，未修）

`attachment` 表里那条 `status=stored` 的附件**残留着 `fail_reason`**（第 4 轮 EPERM 的失败原因）。
`CollectService.saveAttachmentContent` 里写了 `attachment.setFailReason(null)`，但 **MyBatis-Plus
默认 `updateStrategy = NOT_NULL` 会跳过 null 字段** → 这个"清除"其实是空操作（本项目没有配置
`MetaObjectHandler`，也没有改过 field-strategy）。影响面小：`AttachmentVO` 目前**没有**暴露
`fail_reason`，中台看不到 → 但该列的语义是「失败证据」，留着脏值会让证据失真。
修法（一行）：给实体字段加 `@TableField(updateStrategy = FieldStrategy.ALWAYS)`。


## 5. 清空重来

> 数据变更脚本由人工执行（项目根 AGENTS.md 红线）。以下仅供本地反复验证用。
> **2026-09-21 已由 AI 执行过一次全量清理**（用户明确授权「数据库的清除操作由你自己完成」）：
> 删除了 3 条候选人 / 3 份版本 / 1 个附件 / 11 条审计 + 1 个落盘文件，四表均回到 0 行。
> 所以下列 SQL 保留作为**下次**重来的模板。

**先看要删什么，再删**（`DELETE` 前务必先 SELECT 预览）：

```sql
-- 全部清空前的预览
SELECT (SELECT COUNT(*) FROM candidate)      AS 候选人,
       (SELECT COUNT(*) FROM resume_version) AS 简历版本,
       (SELECT COUNT(*) FROM attachment)     AS 附件,
       (SELECT COUNT(*) FROM collect_audit)  AS 审计;

-- 顺序：先子后父（无外键约束，但顺序错了会留下悬空引用）
DELETE FROM collect_audit;
DELETE FROM attachment;
DELETE FROM resume_version;
DELETE FROM candidate;
```

```bash
# 落盘文件同步清理
rm -rf ~/recruit-platform-github/recruit-server/data/attachments/*
```

**只清某几条坏行**（不要全清时）：

```sql
-- 坏行特征：姓名为空 且 键是纯数字（修复前的 bug 产物）
SELECT id, name, platform_user_id FROM candidate
WHERE name IS NULL AND platform_user_id REGEXP '^[0-9]+$';

SET @cid := <上面查出的 id>;
DELETE FROM collect_audit   WHERE candidate_id = @cid;
DELETE FROM attachment      WHERE candidate_id = @cid;
DELETE FROM resume_version  WHERE candidate_id = @cid;
DELETE FROM candidate       WHERE id = @cid;
```

## 6. Gate 1 检查表

- [ ] V1 接口冒烟：rules 200 / 缺 consent 400 / 多条 400 / 无 token 401
- [ ] V2 聊天页采集成功，toast 显示新建候选人 + 新建版本
- [ ] V3 重复采集不产生重复数据（候选人 1 行、版本 1 份、审计递增）
- [ ] V4 列表页整页采集被拒绝
- [ ] V5 附件有明确结论（成功入库 或 原因已落库 或 toast 明确说明为何丢弃）
- [ ] V6 候选人库页能看到候选人 + 版本 + 附件 + 审计
- [ ] V7 幂等键空间一致性有结论 —— ✅ **已实证不一致**，已按「写入时归一」实现并收敛存量（§4.6）；
      复测判据：同一个人走两条链路采集后，候选人库仍为 **1 条**，且该行 `platform_user_id_alt` 有值

---

## 7. 离线回归（改采集代码后先跑这个）

```bash
cd ~/recruit-platform-github
node test/extension-collect-verify.cjs
```

不依赖浏览器、不连后端、不写库（安全，可反复跑）。**共 81 项断言**，覆盖：

**A. `background.js`** —— 在 `node:vm` 里跑真实 Service Worker 代码：

| 断言组 | 验的是什么 |
|---|---|
| A/T1 | 真机场景复现：hook 看不到附件、但扩展层观察到了 → 补入、下载、上传、toast 显示 `1/1` |
| A/T2 | 附件端点 ID 与候选人不匹配 → **丢弃**（不张冠李戴） |
| A/T3 | 附件 ID 与两种 ID 都不沾边 → 丢弃，且提示里带出「看到的 ID / 本候选人 ID」以便自证 |
| A/T3b | URL 里没有 `gid` 时，仍按响应体里的数字 uid 认领（守卫比「只比 URL 参数」更宽也更准） |
| A/T4 | 页面 hook 已拿到的附件不重复登记 |
| A/T5 | 超过 30 分钟窗口的观察缓存不生效 |
| A/T6 | **HR 自己不会被当成候选人**（历史真机事故的回归） |
| A/T7 / T7b | 观察器只收附件 URL、只收 2xx、缓存带 tabId；**真机 `download4boss` 形态必须命中**，且带/不带 query 折叠为一条 |
| A/T8 | 附件 URL 末段是**加密 ID** 时也能认（不只数字 uid 一种形态） |
| **A/T9** | **本轮核心**：候选人是数字 uid、附件 URL 是加密 geekId → 靠多人列表响应里的**映射表**建立精确相等并认领 |
| **A/T10** | 没有映射表且不在同一标签页 → 必须丢弃（不能靠猜） |
| **A/T11** | 兜底认领：同标签页 + 2 分钟内 + 最近一条 → 认领 + 显式警告 + 用掉即从缓存移除 |
| **A/T12a/b** | 兜底边界：超时不认；同标签页多条时**只认最近一条** |
| **A/T13** | 幂等键必须把「带 query」与「重定向后不带 query」两种 URL 折叠成同一个键 |
| **A/T14–T18** | **附件主动探测**：零观察时用加密 geekId 拼 `preview4boss`/`download4boss`；无加密 ID 不探测；`200 + HTML` 必须被 `%PDF` 魔数拒掉；预览失败退下载；已有附件不重复探测 |
| **A/T19–T22** | **双 ID 空间写入时归一**（§4.6）：主键数字 → `alt` 带加密；主键加密 → `alt` 带数字；`counterpartIdOf` 边界（同值/空值/非法形态一律不取，只有一种形态时返回 null） |
| **A/T22（关键）** | **多人列表里「别人」的 ID 绝不进入备用键** —— 这是整个归一的正确性前提，写错就是候选人级张冠李戴 |

**B. `collect-hook.js`** —— 从源码切出 DOM 兜底函数单独执行（B/T1–T6）：
相对 URL 绝对化、同一 URL 去重、无关外链不误收、幂等键与 background 口径一致。

> 为什么固化这份脚本：附件这一环历史上**连续踩过三次**
> （① hook 根本没看见 PDF 请求；② 补采时差点认错人；
> ③ 文档侧以数字 uid 为幂等键、而真机附件 URL 带的是**加密** geekId，永远比不中）。
> 改采集代码后跑它，比在浏览器里点一遍快得多，也不会留下脏数据。
>
> **T9–T13 用的是真机取证的 URL 形态**（见 §4.3 的取证方法），不是推断样例 ——
> 这一改动的价值已经被验证：T12b 当场逮出 `pruneAttachCache` 顺序不幂等的 bug。
> 以后新增附件相关的假数据，**优先从 Chrome 历史/下载链里取真 URL**，别自己编。
