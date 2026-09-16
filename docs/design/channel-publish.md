# 渠道发布 · 浏览器自动化填充设计

> **状态**：v1.0 评审稿（2026-09-15）
> **模块归属**：后端模块 3「渠道发布」/ 能力等级 `MANUAL`
> **设计来源**：老设计仓（`文稿 - sirpinaple的开发机/git/recruit-platform`）S6 渠道台账卡移植，适配本仓技术栈（Spring Boot 单体 + MyBatis-Plus + 雪花 ID + 小写状态）
> **配套任务**：T2（人力需求域）/ T3（渠道发布域）/ T4（浏览器扩展），见 §9

---

## 1. 定位（一句话）

人力需求审批通过后，按渠道渲染发布草稿 → **Chrome 扩展拉草稿预填充到外部招聘平台表单** → **HR 亲手点提交（共驾模式）** → 台账回填。系统全程不接触平台凭据、永不自动提交。

对应 README「自动化必须有人工兜底」的 `MANUAL` 等级：系统生成操作任务与预填充内容，由 HR 人工完成并回填。`RPA`（自动提交）需平台书面授权 + 法务及安全评审，**本期禁止**。

---

## 2. 红线（违反 = 返工）

1. **永不自动提交**——扩展不做任何定位/点击平台提交按钮的逻辑，点提交的必须是人的手；
2. **永不采集/存储平台凭据**——`publish_record` 只有 `account_label` 文本标识（HR 手填，如「BOSS-招聘专员01」），任何字段不得出现账号/密码/ Cookie；
3. **数据流向即合规边界**——系统 → 平台只走「人眼可见的表单预填充」（仅 JD 公开信息白名单）；平台 → 系统只走 HR 手工回填/上传；
4. **扩展不上传页面内容**——回填仅提交状态与备注文本，不采集平台页面 DOM/数据回后端；
5. **草稿渲染白名单**——`fields_json` 只允许 JD 公开字段（§5.3），候选人信息、内部备注在渲染层被硬编码白名单挡住，禁止整对象序列化。

---

## 3. 信息传输范围

| 允许出系统 | 禁止出系统 |
|---|---|
| 岗位发布字段（职位名/描述/地点/薪资/要求，即 JD 公开信息）经预填充到平台表单 | 平台账号密码（永不采集、永不存储） |
| 发布结果状态回填（published/failed + 备注 + 发布链接） | 候选人 PII 向平台方向的任何自动传输 |
| 深链（`deep_link`：投递回系统门户的 URL，随 JD 粘贴到平台） | 简历/手机号/邮箱的自动导出（渠道导简历 = HR 平台侧手工下载后回传） |

---

## 4. 总体流程

```
HR 建需求单(draft) → 提交(pending_approval) → 审批通过(open)
   └─ open 事务内：按启用渠道各生成 publish_draft(pending) + publish_record(pending)
HR 浏览器装扩展 → options 配后端地址+授权 token
   → popup 拉待发布草稿列表 → 选草稿 → 打开渠道发布页 → 一键填充
   → HR 核对后亲手在平台点提交
   → popup 点「标记已发布」→ 回填 publish_record(published)
   → 管理端台账页可查（渠道/状态/发布人/结果备注）
```

审批说明：一期审批动作由管理端 API 直接驱动（模拟钉钉回调语义）；真实钉钉审批接入后仅替换触发源，状态机不变（独立任务，不阻塞本模块）。

---

## 5. 数据模型（5 张表）

> 约定沿用本仓 README：表名小写下划线、主键 `BIGINT UNSIGNED` 雪花 ID（MyBatis-Plus `assign_id`）、状态 `VARCHAR(32)` 小写、时间 `DATETIME(3)` UTC、`InnoDB + utf8mb4_unicode_ci`、每列 COMMENT。
> DDL 脚本按 `recruit-server/AGENTS.md` 命名规范入 `recruit-server/sql/`，由用户执行。

### 5.1 `hr_request` 人力需求单（T2）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | 雪花 ID |
| request_no | VARCHAR(32) NOT NULL UNIQUE | 需求编号（`REQ-YYYYMMDD-XXXX`） |
| title | VARCHAR(128) NOT NULL | 岗位名称 |
| dept_name | VARCHAR(64) NOT NULL | 用人部门（一期不做组织表） |
| headcount_total | INT NOT NULL DEFAULT 1 | 计划招聘人数 |
| headcount_filled | INT NOT NULL DEFAULT 0 | 已入职数（手动修正） |
| job_description | TEXT NOT NULL | JD 正文（公开信息） |
| job_requirement | TEXT | 任职要求（公开信息） |
| salary_min | INT | 月薪下限（元） |
| salary_max | INT | 月薪上限（元） |
| location | VARCHAR(128) | 工作地点 |
| education | VARCHAR(32) | 学历要求（字典 education_level） |
| experience_years | INT | 要求工作年限 |
| employment_type | VARCHAR(32) | 用工性质 full_time/part_time/internship/contract |
| status | VARCHAR(32) NOT NULL DEFAULT 'draft' | draft/pending_approval/open/closed |
| close_reason | VARCHAR(32) | closed 时必填：filled/cancelled/frozen |
| auto_close | TINYINT(1) NOT NULL DEFAULT 1 | 招满自动关闭开关 |
| reject_reason | VARCHAR(256) | 最近一次驳回原因 |
| opened_at / closed_at | DATETIME(3) | 开放/关闭时间（指标口径） |
| created_by | BIGINT UNSIGNED | 创建人 sys_user.id |
| created_at / updated_at | DATETIME(3) | |

索引：`UNIQUE uk_request_no`、`INDEX idx_status`、`INDEX idx_created(created_at)`。

**状态机（代码内转移表，非法转移抛 MyException 4xx）**：

```
draft --submit--> pending_approval --approve--> open --close--> closed
                     pending_approval --reject--> draft（记 reject_reason）
                     closed --reopen--> draft
approve 副作用（同事务）：
  - 写 opened_at
  - 对每个 enabled 且 capability=manual 的渠道：生成 publish_draft(pending) + publish_record(pending)
close 副作用：写 closed_at + close_reason；未消费草稿置 cancelled
headcount：filled >= total 且 auto_close=1 → 自动 close(filled)（filled 手动修正 API 触发）
```

### 5.2 `channel` 渠道注册表（T3.1）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| code | VARCHAR(32) NOT NULL UNIQUE | 渠道代码：boss/liepin/zhilian/mock_demo… |
| name | VARCHAR(64) NOT NULL | 渠道名称 |
| publish_url_pattern | VARCHAR(512) | 发布页 URL 匹配模式（扩展注入判定，如 `https://www.zhipin.com/*publish*`） |
| field_map_json | JSON NOT NULL | 字段映射配置（§8 格式），**平台改版改数据不改扩展** |
| deep_link_template | VARCHAR(512) | 投递深链模板（`{requestNo}` 占位；门户建成前指向占位页） |
| capability | VARCHAR(16) NOT NULL DEFAULT 'manual' | manual/api/connector/rpa（本期只实装 manual） |
| status | VARCHAR(16) NOT NULL DEFAULT 'enabled' | enabled/disabled |
| sort_order | INT DEFAULT 0 | |
| remark | VARCHAR(256) | |
| created_at / updated_at | DATETIME(3) | |

**验收要求：新增一个渠道 = 插一行数据，不改任何代码。**

### 5.3 `publish_draft` 发布草稿（T3.2）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| request_id | BIGINT UNSIGNED NOT NULL | 所属需求 |
| channel_id | BIGINT UNSIGNED NOT NULL | 渠道 |
| fields_json | JSON NOT NULL | 按渠道映射渲染好的「平台字段名 → 值」，仅 JD 公开字段白名单 |
| deep_link | VARCHAR(512) | 实例化深链（随 JD 粘贴到平台） |
| status | VARCHAR(16) NOT NULL DEFAULT 'pending' | pending/consumed/cancelled |
| created_at / updated_at | DATETIME(3) | |

索引：`INDEX idx_request`、`INDEX idx_channel`、`INDEX idx_status`。
重渲染规则：同一 (request, channel) 只允许一条 pending；重新生成（平台改版后）时旧草稿置 cancelled，台账 record 保留审计。

**渲染白名单（硬编码常量）**：`title / jobDescription / jobRequirement / location / salaryMin / salaryMax / salaryText / education / experienceYears / employmentType`——其余字段一律不进 `fields_json`。

### 5.4 `publish_record` 发布台账（T3.3）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| draft_id | BIGINT UNSIGNED NOT NULL UNIQUE | 一对一关联草稿 |
| request_id / channel_id | BIGINT UNSIGNED NOT NULL | 冗余便于查询 |
| status | VARCHAR(16) NOT NULL DEFAULT 'pending' | pending/published/failed |
| account_label | VARCHAR(64) | 平台账号文本标识（非凭据） |
| published_url | VARCHAR(512) | 发布成功后的岗位链接（HR 回填） |
| result_note | VARCHAR(512) | 结果备注 |
| operated_by | BIGINT UNSIGNED | 操作人（扩展 token 关联的 sys_user） |
| published_at | DATETIME(3) | |
| created_at / updated_at | DATETIME(3) | |

索引：`INDEX idx_request`、`INDEX idx_status`、`INDEX idx_channel`。

### 5.5 `extension_token` 扩展授权（T3.3）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT UNSIGNED PK | |
| token_hash | VARCHAR(128) NOT NULL UNIQUE | SHA-256(token)，**明文仅创建时返回一次，不落库不落日志** |
| name | VARCHAR(64) | 授权名称（如「HR张三的浏览器扩展」） |
| user_id | BIGINT UNSIGNED NOT NULL | 关联 sys_user |
| status | VARCHAR(16) NOT NULL DEFAULT 'active' | active/revoked |
| last_used_at | DATETIME(3) | |
| revoked_at | DATETIME(3) | |
| created_at / updated_at | DATETIME(3) | |

权限语义：扩展 token 仅可 ① 拉 pending 草稿 ② 回填 record——最小权限，吊销即失效（后续请求 401）。

---

## 6. 接口设计（R 包装，MyException 业务异常）

### 6.1 管理端（登录态，`/api` 前缀）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST / GET / GET {id} / PUT {id} | `/api/hr-requests` | 需求单 CRUD |
| POST | `/api/hr-requests/{id}/submit` | draft → pending_approval（校验必填：title/dept_name/headcount_total/job_description） |
| POST | `/api/hr-requests/{id}/approve` | pending_approval → open（事务内生成草稿+台账） |
| POST | `/api/hr-requests/{id}/reject` | 驳回回 draft，body 带 rejectReason |
| POST | `/api/hr-requests/{id}/close` | open → closed，body 带 closeReason（必填） |
| POST | `/api/hr-requests/{id}/reopen` | closed → draft |
| POST | `/api/hr-requests/{id}/headcount` | 手动修正 headcount_filled（触发 auto_close 判定） |
| POST / GET / PUT | `/api/channels` | 渠道 CRUD（管理端） |
| POST | `/api/extension-tokens` | 生成授权（响应含一次性明文 token） |
| GET | `/api/extension-tokens` | 列表（只展示 hash 前缀与元数据） |
| POST | `/api/extension-tokens/{id}/revoke` | 吊销 |
| GET | `/api/publish-records` | 台账查询（request/channel/status 筛选，分页） |

### 6.2 扩展端（扩展 token，独立鉴权）

请求头：`X-Extension-Token: <token>`；拦截器校验 hash + active，通过则刷新 last_used_at，失败 401。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ext/drafts?status=pending` | 待发布草稿列表（含 fields_json、channel 元数据；一期不按用户隔离） |
| POST | `/api/ext/records/{id}/report` | 回填：body `{status: published|failed, accountLabel, publishedUrl, resultNote}` |

---

## 7. 浏览器扩展架构（`extension/`，Chrome Manifest V3）

```
extension/
├── manifest.json          # MV3；permissions: storage/scripting/activeTab
├── options/index.html     # 后端地址 + 授权 token 配置
├── popup/index.html       # 草稿列表 → 一键填充 → 标记已发布/失败
├── content/fill-engine.js # 填充引擎（动态注入，chrome.scripting.executeScript）
└── fixtures/publish-mock.html  # 本地模拟发布页（15+ 字段，结构与真实平台对齐）
```

- **manifest 最小权限**：`permissions: ["storage", "scripting", "activeTab"]`；`host_permissions` 只配后端域名（dev：`http://localhost:6017/*`；生产域名上线时追加）。不声明 `<all_urls>`；
- **token 存储**：`chrome.storage.session`（浏览器会话级，不落 localStorage 明文；代价是重启浏览器需重贴 token——安全优先，有意为之）；
- **content script 动态注入**：popup 点「填充」时对当前活动 tab `executeScript` 注入引擎，不做常驻 `content_scripts` 全站注入；
- **注入判定**：popup 根据草稿的 `channel.publish_url_pattern` 校验当前 tab URL（fixtures mock 页在 dev 模式放行）；
- **popup 流**：拉草稿列表 → 选择 → 跳转/停留发布页 → 注入填充 → 展示「标记已发布 / 标记失败」→ 调回填接口；
- **构建形态**：原生 HTML/JS，无 Node 构建链，zip 打包 + 装机文档交付（给 HR 的傻瓜式步骤）。

## 8. 填充引擎规格（三级匹配）

对 `fields_json` 的每个字段，按序尝试：

1. **文本匹配**（平台改版抗性主路径）：`input[name]` / `select[name]` / `textarea[name]`、`<label>` 文本、`placeholder`、`aria-label`——归一化（去空格/全半角/冒号）后与 `match` 数组比对；
2. **属性匹配**：`data-*`、`title` 属性兜底；
3. **选择器兜底**：`field_map_json` 中该字段的显式 `selector`。

控件类型处理：`input[text]/textarea` 直接赋值；`select` 按值或文本匹配 option；`radio` 按值选中；**遇 `file`/验证码/提交按钮一律跳过**（红线 1、4）。

`field_map_json` 格式（`mock_demo` 渠道示例）：

```json
{
  "fields": [
    { "key": "title",          "match": ["职位名称", "岗位名称", "jobTitle"], "type": "input" },
    { "key": "jobDescription", "match": ["职位描述", "岗位职责", "jobDesc"],  "type": "textarea" },
    { "key": "location",       "match": ["工作地点", "工作城市"],             "type": "input" },
    { "key": "salaryText",     "match": ["薪资范围", "月薪"],                 "type": "input" },
    { "key": "education",      "match": ["学历要求", "学历"],                 "type": "select" }
  ],
  "selectors": { "title": "#job-title-input" }
}
```

`fields_json`（draft 渲染产物）示例：`{ "title": "Java 工程师", "jobDescription": "…", "salaryText": "15-25K" }`。

---

## 9. 实施拆解与验收

**前置任务（本模块开工依赖）——均已完成**：
- ✅ T0 开发环境（Docker：MySQL 3307 / Redis 6380 等五件套 + Ollama 模型；初始化 schema/种子数据）
- ✅ T1 后端基础（统一响应 R / 全局异常 / 健康检查 / 登录 + JWT 会话：`POST /api/auth/login`、`GET /api/auth/me`，BCrypt + Bearer 拦截器）
- ✅ T1.4 前端登录接通（recruit-web：Vite + Vue3 + TS 脚手架、httpClient/Zod/路由守卫、登录页原型还原、工作台占位页）

| 单元 | 内容 | 验证 | 状态 |
|---|---|---|---|
| T2.1 | `hr_request` 建表 SQL + CRUD | curl 建单/查单 | ✅ 已完成（2026-09-15） |
| T2.2 | 状态机（转移表+非法转移 4xx） | 非法转移被拒，合法转移落库 | ✅ 已完成（2026-09-15，含 recruit-web 需求单列表/表单/详情页 + Chrome 端到端验证全链路通过） |
| T3.1 | `channel` 表 + CRUD | 纯数据插 mock_demo 渠道，不改代码 | ✅ 已完成（2026-09-15，建表+种子 SQL、`/api/channels` 增改查；curl 验收 9 项通过：列表/创建/重复 code 409/非法 JSON 400/非法 capability 400/编辑/code 不可改/未登录 401/数据清理） |
| T3.2 | `publish_draft` 渲染（白名单+深链实例化） | approve 后每启用渠道各一条草稿，内容正确 | ✅ 已完成（2026-09-15，`GET /api/hr-requests/{id}/drafts`；approve/close/auto_close 事务挂接；curl 验收 8 项通过：渲染白名单∩渠道声明、salaryText 派生 15-25K、深链 {requestNo} 实例化、disabled 渠道排除、close/招满自动取消、reopen 重渲染幂等、未登录 401） |
| T3.4 | recruit-web 管理端页面原型对齐（AppShell / 工作台 / 职位列表与详情 / 渠道管理页） | Chrome 端到端全链路 | ✅ 已完成（2026-09-15，AppShell 侧栏+顶栏对齐原型 s1-s9 设计令牌；工作台统计卡/待审批/在招职位重做；详情页状态机操作+渠道草稿展示（待发布/已取消 chip、复制深链）+候选人管线占位；渠道管理页列表+新建/编辑抽屉（code 不可改、JSON 前置校验）；vue-tsc 通过，Chrome 端到端验证 10 项通过、console 零错误） |
| T3.3 | `extension_token` + `publish_record` + 回填 API | 拉草稿→回填→台账可查；吊销后 401 | ✅ 已完成（2026-09-15，`/api/extension-tokens` 生成/列表/吊销 + `/api/publish-records` 分页筛选 + `/api/ext/drafts`、`/api/ext/records/{id}/report`（X-Extension-Token 独立鉴权，SHA-256 hash 落库、明文仅创建响应一次）；approve 事务内草稿+台账一对一同步创建，close/auto_close/重渲染联动 pending 台账置 failed（行保留审计），回填终结 published/failed 同时草稿置 consumed、防重复回填；curl 验收 20 项通过：token 生命周期/无 token·假 token·吊销后 401/last_used_at 刷新/台账同步/回填 published·failed/重复回填 400/非法 status 400/close·重渲染联动/分页筛选/明文不落库） |
| T4.1 | MV3 骨架 + options | chrome://extensions 加载，配置持久 | ✅ 已完成（2026-09-15，manifest 最小权限 storage/scripting/activeTab + host_permissions 仅 localhost:6017；options 页后端地址存 chrome.storage.local（持久）、token 存 chrome.storage.session（重启自动清除，有意为之）+ 测试连接（真 token 200/假 token 401）；无头 Chrome for Testing 验收 7 项通过：页面加载/保存归一化/local·session 分离写入/reload 回显/连通性（host_permissions 豁免 CORS，后端零改动）/401 语义/重启后 local 持久+session 清空。注：正式版 Chrome 136+ 已禁用 --load-extension，自动化验收使用 Chrome for Testing 155） |
| T4.2 | fixtures/publish-mock.html | 15+ 字段结构完整（input/select/radio/textarea） | ✅ 已完成（2026-09-16，渲染白名单扩至 14 字段：+deptName/headcountTotal/requestNo/publishDate（createdAt 派生）；mock_demo 渠道 field_map 更新 14 字段映射；mock 页 21 个交互字段：text×6/number×4/date×1/email×1/file×1/radio×4/textarea×2/select×2 + 验证码 + 提交，三级匹配线索全覆盖（selector/label/placeholder/aria-label/data-*/legend+radio）；无头 CFT 验收：结构/无 disabled/线索就位全过，approve 渲染 fields_json 14 key 全输出（salaryText 派生 20-35K） |
| T4.3 | 填充引擎三级匹配 | mock 页 15+ 字段全命中 | ✅ 已完成（2026-09-16，content/fill-engine.js：归一化（小写/全角→半角/去空白/去冒号星号）后三级匹配 text→attr→selector（attr 级比对 match∪{key}，radio 组以 legend 为线索作整体单元）；input/textarea 赋值+派发 input/change 双事件（框架受控组件）、select 按值或文本（相等优先）、radio 按值；红线：UNSAFE_TYPES（file/submit/button/reset/image/hidden/password）与验证码启发式（name/id/placeholder/aria-label/class 含 captcha/验证码/vcode 等特征词）一律 skipped，引擎只赋值永不点击；报告 filled/skipped/failed 三分类+method 标注；预留 __RECRUIT_FILL_CONFIG__ 自动执行模式（T4.4 popup 两步注入）；无头 CFT 验收 42 项通过：14 字段全命中（label/name/placeholder/aria-label 线索路径全覆盖）、attr 级（移除 label 后 data-field 命中）、selector 级（移除全部文本线索后兜底命中）、file/验证码/提交按钮/未映射字段（职位类别/邮箱）一律不碰、页面零导航） |
| T4.4 | popup 全链路 | 草稿→填充→回填→台账闭环 | 待开发 |

**MVP 验收脚本**：

```bash
# 1) docker-compose up -d && recruit-server 起（6017）
# 2) 登录 → 建需求 → submit → approve → open：每启用渠道生成草稿+台账(pending)
# 3) 管理端生成扩展 token（明文只出现一次）
# 4) chrome://extensions 加载 extension/ → options 配 http://localhost:6017 + token
# 5) 打开 extension/fixtures/publish-mock.html → popup 选草稿 → 填充 → 15+ 字段全命中
# 6) 平台页 HR 亲手提交后，popup 点「标记已发布」→ 台账 published + 备注/链接可见
# 7) 吊销 token → popup 再拉草稿 → 401
```

**真实平台验收（进阶，需 HR 在场）**：BOSS 直聘真实发布页走一次预填充 + 人工提交，确认三级匹配命中；不阻塞 MVP。

---

## 10. 范围外与升级路径

- 自动提交（RPA）：需平台书面授权 + 法务/安全评审，本期代码层不实现任何提交逻辑；
- `api`/`connector` 能力等级（授权 API 自动发布）：表结构已预留 `capability`，独立任务实装；
- RabbitMQ 异步化草稿生成：MVP 同步事务生成（渠道数量小，无性能压力），异步化后置；
- 真实钉钉审批触发源替换：见 §4；
- 门户深链落地：`deep_link_template` 一期指向占位页，门户建成后替换；
- 台账管理前端页面（recruit-web T5.3）：本设计只定接口契约。

## 11. 风险与注意事项

| 风险 | 对策 |
|---|---|
| 平台改版导致匹配失效 | `field_map_json` 数据化热更；某平台月发布 >20 单才投入专项适配 |
| token 泄露 | hash 落库、明文一次性、session 存储、可吊销、最小权限 |
| 误把敏感字段带进草稿 | 渲染层硬编码白名单 + 单测断言 fields_json 键集合 |
| MV3 service worker 生命周期 | 拉数据一律由 popup 交互触发，不依赖后台常驻 |
| 扩展分发 | zip + 内部装机文档；Chrome 企业策略为备选 |
