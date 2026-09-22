# 候选人 ↔ 职位关联（candidate-position-linking）

> 状态：**设计提案，未实装**。本文只回答「有哪些技术路径」，不含代码改动。
> 取证时间：2026-09-22，本地库 `recruit_platform`（docker 容器 `recruit-mysql`，127.0.0.1:3307）。
> 面向问题：「扩展已能采集简历，但简历没有和系统职位形成关联，候选人也没能按职位分类。」

## 0. 一句话结论

**职位线索已经在库里了，采集链路不用改。** 真机采集的 6/6 条简历版本中，
`resume_version.fields_json.jobId` 全部有值（`575500411`），
`fields_json.bottomText` 是「9月21日 沟通的职位-Java」。

断的不是采集，是**从 `fields_json` 到 `hr_request` 的那一段**：

| # | 断点 | 现状 | 性质 |
|---|---|---|---|
| ① | 后端不读 | `CollectService.applySummary()` 只映射 10 个人力特征字段，**从不读 `jobId`** | 代码缺口，小 |
| ② | 无处可放 | `candidate` 表无职位列；无「投递」表；`hr_request` 无平台职位标识列 | 模型缺口 |
| ③ | 无映射 | BOSS `jobId=575500411` ↔ 中台 `hr_request.id`（雪花）**之间没有任何映射** | **核心问题** |

③ 是唯一真正需要设计的部分：前两个是管道，第三个是语义。

## 1. 断链定位（逐层取证）

### 1.1 扩展层：已经采到了，无需改动

`background.js` 的 `extractFields(root, resumeKeys)` 不是白名单——它先用 `resumeKeys`
**打分选出「候选人对象」节点**（`body.resume`），然后把该节点上**所有**标量键原样带走：

```js
// extension/background.js:1435-1452
const fields = {};
Object.keys(best).forEach((k) => {
  const v = best[k];
  if (v == null) return;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    fields[k] = v;          // ← jobId / bottomText / brandName 走的就是这条路
  }
  ...
});
```

所以 `CollectRules.RESUME_KEYS` 里没写 `jobId` **不妨碍它被采集**（`resumeKeys` 只决定
「哪段响应算简历」和「哪个节点是候选人对象」）。这一点与 `noisyKeys` 里
`position`/`name` 的降级逻辑不冲突。

### 1.2 落库层：`jobId` 已入库，但被当成不透明 JSON

实测（本地库，只读 SELECT）：

```sql
SELECT id,
       JSON_UNQUOTE(JSON_EXTRACT(fields_json,'$.jobId'))      AS f_jobId,
       JSON_UNQUOTE(JSON_EXTRACT(fields_json,'$.bottomText')) AS f_bottomText
FROM resume_version WHERE fields_json IS NOT NULL ORDER BY id;
```

| resume_version.id | f_jobId | f_bottomText |
|---|---|---|
| 2101924376598999041 | 575500411 | 9月21日 沟通的职位-Java |
| 2101924445565939713 | 575500411 | 9月21日 沟通的职位-Java |
| 2101924559562928130 | 575500411 | 9月21日 沟通的职位-Java |
| 2101924714882199554 | 575500411 | 9月21日 沟通的职位-Java |
| 2101933690512404482 | 575500411 | 9月21日 沟通的职位-Java |
| 2101936105823309825 | NULL | NULL（空版本，无 raw_json） |
| 2101941906176655361 | 575500411 | 9月18日 沟通的职位-Java |

**6/6 命中**。`jobId` 从最外层 `raw_json.zpData.messages[0].body.resume.jobId` 一路
到 `fields_json.jobId` 都是通的。

同时确认：当前样本里**只有数字 `jobId`**，没有 `encryptJobId` / `bossId` /
`encryptBrandId` / `jobName`（`raw_json LIKE` 逐项为 0）。这是**单链路（historyMsg）的观测**，
不能外推为「BOSS 没有加密职位 ID」——见 §5 风险 1。

### 1.3 聚合层：`candidate` 摘要列不含职位

`CollectService.applySummary()` 明确只映射 10 项：

| 目标列 | 取值来源键 |
|---|---|
| `name` | `name` / `geekName` / `user.name` |
| `current_title` | `positionName` / `currentTitle` / `position` / `positionCategory` |
| `expect_salary` | `expectSalary` / `salaryDesc` / `salary` / `jobSalary` |
| `city` / `education` / `school` / `major` / `work_year` / `age` / `gender` | 同名或同义键 |

**没有 `jobId`。** 且 `applySummary` 有「只补空不覆盖」语义（低质量采集不得污染已有更完整字段），
这直接决定了：**职位关联不能做成 `candidate` 表上的一个列**（见 §4.1）。

### 1.4 映射层：平台职位 ↔ 需求单，完全空白

| 事实 | 实测值 | 影响 |
|---|---|---|
| `publish_record.published_url` | **全部为 NULL**（17 行全 NULL） | 「用岗位链接反查」这条路的落点当前是空的 |
| `channel.publish_url_pattern`（boss） | `https://www.zhipin.com/web/frame/job/publish-edit?jobversion=11363&encryptId=0&enterSource=2` | 这是**发布编辑页**，不含 jobId |
| `channel.field_map_json.success`（boss） | `{"selectors":[".toast .icon-toast-success"],"timeoutMs":120000}` | 无 `urlPattern` → 哨兵退化为「仅选择器单命中」 |
| `hr_request` | 无任何平台侧标识列 | 需求单与平台职位之间没有锚点 |

**结论**：平台侧唯一稳定的职位标识是 `jobId=575500411`，而中台侧没有任何一处记录它。

## 2. 把问题拆成两个（它们不是一回事）

用户的问题实际包含两个语义完全不同的诉求，混在一起会做出错误的数据模型：

| | **A. 投递关联（application）** | **B. 适配分类（matching）** |
|---|---|---|
| 适用人群 | `source_channel = chat`（候选人主动来） | `source_channel = recommend`（我方主动发） |
| 有无职位事实 | **有**。BOSS 会话绑定在具体职位上（`jobId`） | **没有**。推荐列表候选人**没投任何岗** |
| 数据来源 | 采集响应里的 `jobId`（已到手） | 简历特征 × JD 的匹配计算 |
| 关系基数 | 1 候选人 : N 职位，**随时间累积** | 1 候选人 : N 职位，**可重算、可失效** |
| 正确性要求 | 必须是**事实**，错了就是事故 | 是**建议**，允许排序不准 |
| 落库方式 | 需要落库（事实不可重算） | 应可重算（存缓存或按需算） |

> `source_channel` 取值见 `CollectRules.SOURCE_CHANNELS = ["chat","recommend"]`，
> 由扩展在 `CollectService.collectOne` 写入 `candidate.source_channel`。
> 实测本地 8 条候选人**全部是 `chat`** —— 即当前库里全是有投递事实的样本，
> recommend 一路还没有真机数据。

**如果把两者合并成 `candidate.request_id` 一个列，会有三个后果**：
1. 推荐候选人被强行「分类」到某个职位，而它其实没投递 —— 事实被污染；
2. 一个人投第二个岗时，`applySummary` 的「只补空不覆盖」会让新职位写不进去；
3. 匹配分数变化时没有地方重算（事实列不该被重写）。

## 3. 四条技术路径

核心分歧只有一处：**`platform_job_id` → `hr_request.id` 的映射怎么建立**。
其余（读取 `jobId`、落库）各路径共用。

### 路径 A · 发布回填时捕获平台职位 ID（正向建映射）★ 推荐

**思路**：中台发布岗位到 BOSS 时，扩展本来就知道「这次发的是哪个 `hr_request`」——
`handleFillRequest(recordId, ...)` 拿的就是 `publish_record.id`，而 `publish_record.request_id`
就是需求单。只要在发布成功那一刻把 BOSS 生成的 `jobId` 一并回传，映射自动成立。

| 项 | 内容 |
|---|---|
| 改动点 | ① 扩展：发布成功后从页面/接口取 BOSS 职位标识（当前哨兵只回传 `window.location.href`）；② 后端：`publish_record` 增列 `platform_job_id`；③ `RecordReportDTO` 增字段 |
| 需要的先决条件 | BOSS 发布成功后必须能拿到 `jobId`。当前 `success` 只配了选择器、无 `urlPattern`，`published_url` 全 NULL —— **说明这条链路在真机还没跑通，需先实测** |
| 覆盖范围 | **只覆盖「经中台发布」的岗位**。手工在 BOSS 发的岗位没有映射 |
| 优点 | 语义确定（谁发的岗谁负责）、零歧义、可自动化 |
| 缺点 | 依赖发布链路先可用；历史岗位缺失 |

### 路径 B · 人工绑定（兜底必备，可与 A 并存）

在候选人详情页加「关联职位」下拉，HR 手动选 `hr_request`。

| 项 | 内容 |
|---|---|
| 改动点 | 后端：绑定接口 + 落库；前端：`CandidateDetailDialog.vue` 增控件 |
| 覆盖范围 | 全部（含历史、含手工发布岗位） |
| 优点 | 立刻可用、零推断风险、天然覆盖 A 的缺口 |
| 缺点 | 人力成本；不解决「分类」 |
| 定位 | **不是备选，是必备**。任何自动映射都需要人工可纠正的出口 |

### 路径 C · 文本反推（辅助建议值，不可自动落库）

用 `bottomText`（"9月21日 沟通的职位-Java"）或 `jobId` 反查 BOSS 职位详情接口拿职位名，
与 `hr_request.title` 匹配。

| 项 | 内容 |
|---|---|
| 优点 | 能覆盖历史数据 |
| 缺点 | ① `bottomText` 是**「沟通日期 + 职位名」的拼接文本**，不是独立字段；② BOSS 职位名与中台 `title` 是人工两次输入，必然漂移（实测 `hr_request` 里同时存在「Java高级工程师」与「Java工程师」）；③ 无映射时无法判定歧义 |
| 定位 | 只能作为**预填建议 + 人工确认**，绝不自动落库 |

### 路径 D · 语义匹配打分（解决 B 类问题，不解决 A）

对 `recommend` 候选人（无投递事实）做「简历特征 × 开放岗位」打分排序。

| 项 | 内容 |
|---|---|
| 现成语料 | `hr_request` 已是完整匹配语料：`title` / `job_description` / `job_requirement` / `salary_min\|max` / `education` / `experience_years` / `location`；`candidate` 有 `current_title` / `expect_salary` / `city` / `education` / `school` / `major` / `work_year` |
| 建议起点 | **先上确定性规则**（学历门槛、年限区间、城市、薪资区间重叠度），不要一开始就上模型 |
| ⚠️ 前提 | `AGENTS.md` 已明确：`docs/architecture/ai-integration-architecture.md`、`model-training-pipeline.md` 描述的是**未实装域**，`recruit-ai-service` 一期未落地。**不要假设已有 AI 基础** |
| 定位 | 与 A/B/C 正交，可后置 |

### 对比小结

| 路径 | 解决 | 自动化程度 | 覆盖历史 | 前置依赖 | 优先级 |
|---|---|---|---|---|---|
| A 发布回填捕获 | A 类 | 全自动 | ❌ | 发布链路先跑通 | P0 |
| B 人工绑定 | A 类 | 手工 | ✅ | 无 | P0（与 A 同批） |
| C 文本反推 | A 类 | 建议值 | ✅ | BOSS 职位详情接口 | P2 |
| D 语义匹配 | B 类 | 全自动 | ✅ | 无（规则先行） | P1 |

**推荐组合：A + B 同批落地（自动带出 + 人工可改），D 用规则版跟进，C 暂不做。**

## 4. 数据模型建议

### 4.1 不要往 `candidate` 加职位列

三个理由：
1. `candidate` 是**人的主体**，按 `platform + platform_user_id` 幂等；职位是**行为**，一个人可投多个岗；
2. `applySummary` 的「只补空不覆盖」语义会直接吞掉第二次投递；
3. 与 `resume_version`（一个人多版本）的既有分层不一致——版本是「同一事实的快照」，投递是「不同事实」。

### 4.2 建议两张新表（事实与建议分离）

```
candidate_application  —— 投递事实（append-only，不可重算）
  id                    bigint unsigned PK
  candidate_id          bigint unsigned NOT NULL   -- candidate.id
  request_id            bigint unsigned NULL       -- hr_request.id；映射未知时为 NULL，待人工补
  platform              varchar(32)  NOT NULL
  platform_job_id       varchar(64)  NULL          -- BOSS jobId（如实测 575500411）
  platform_job_hint     varchar(128) NULL          -- bottomText 原文，仅供人工辨认
  source_channel        varchar(32)  NULL          -- chat / recommend
  bind_source           varchar(16)  NOT NULL      -- auto（映射命中）/ manual（人工）
  bound_by              bigint unsigned NULL       -- 人工绑定时 sys_user.id
  applied_at            datetime(3)  NOT NULL      -- 取自 resume_version.collected_at
  created_at / updated_at
  UNIQUE uk_candidate_job (platform, candidate_id, platform_job_id)   -- 天然幂等
  INDEX idx_request (request_id)                                        -- 按职位看候选人
  INDEX idx_candidate (candidate_id)

candidate_position_match  —— 适配建议（可重算、可失效）
  id / candidate_id / request_id
  score                 decimal(5,2)
  reason_json           json          -- 命中了哪些因子（可解释）
  algorithm_version     varchar(32)   -- 规则版本，便于重算与 A/B
  computed_at           datetime(3)
  UNIQUE uk_match (candidate_id, request_id, algorithm_version)
```

> 无外键、`datetime(3)` UTC、审计列——全部沿用全局约定（见 `database-schema.md` §2）。
> `candidate_application` 的 `uk_candidate_job` 让「同一人同一岗位重复投递」天然幂等，
> 与 `resume_version` 的 `content_hash` 去重是同一个设计手法。

### 4.3 映射表：由 `publish_record.platform_job_id` 承担

不新增独立映射表——`publish_record` 本来就一对一挂在草稿上、草稿挂需求单上，
加一列 `platform_job_id` 后，「平台职位 → 需求单」的查询就是一次等值 join：

```sql
-- 平台职位 → 需求单
SELECT request_id FROM publish_record WHERE platform = ? AND platform_job_id = ?;
```

### 4.4 与既有未接线资源的取舍

`sys_dict` 现存 4 类与候选人相关的字典（`candidate_status` / `resume_status` /
`annotation_status` / `candidate_source`，共 14 行）**当前零代码消费**，
`database-schema.md` §6 已把它列为「要么接线、要么视为设计债务」的待决项。

投递状态机若要引入（如 `applied / screening / interview / offer / rejected`），
建议**新建字典类型**，而不是复用语义不符的 `resume_status`（那是解析状态）。
同时借这次机会决定这 4 类的去留，避免债务继续叠加。

## 5. 风险与待确认（开工前必须先答）

| # | 事项 | 为什么关键 | 怎么验 |
|---|---|---|---|
| 1 | **BOSS 职位 ID 是否有加密形态** | 与 `geekId` 双 ID 空间是**完全同类的坑**（历史上已让候选人分裂两条，见 `candidate_normalize_dual_id_space_20260921_V1.sql`）。若 jobId 也有数字/加密两形态，映射键会静默分裂 | 多链路实测：聊天页 / 推荐列表 / 职位管理页 / 附件预览，检查是否出现 `encryptJobId` |
| 2 | **单账号单岗位掩盖了多岗位场景** | 本机 6/6 全是 `jobId=575500411`（该账号只有一个在招岗位）。「同一人对不同岗位产生会话」的真实分布完全未观测 | 用有 ≥2 个在招岗位的账号重采 |
| 3 | **`bottomText` 不可当选职位名** | 它是「沟通日期 + 职位名」拼接（"9月21日 沟通的职位-Java"），日期会变、格式可能改版 | 已确认，仅作 `platform_job_hint` 展示 |
| 4 | **`published_url` 全 NULL** | 路径 A 的落点当前为空，说明发布成功回填在真机**尚未跑通**（boss 的 `success` 只配了选择器） | 真机发一个岗位，看 `publish_record.status` 是否变 `published`、`published_url` 是否落值 |
| 5 | **`jobId` 数字 vs `encryptId`** | `channel.publish_url_pattern` 里的 `encryptId=0` 是**发布编辑页参数**，与职位身份无关，勿混用 | 代码走查确认 |
| 6 | **历史数据回填可行性** | `fields_json.jobId` 已入库 → 多数历史记录**无需重新采集**即可回填 `candidate_application`，但要先有映射（路径 A/B）才能填 `request_id` | 一次性 `upgrade/` 脚本，人工闸门 `RUN_UPGRADE=1` |

## 6. 分阶段落地建议

| 阶段 | 内容 | 前置换算 | 产出 |
|---|---|---|---|
| **P0-a** | 实测确认风险 1/2/4（不改代码） | — | 一份真机观测记录 |
| **P0-b** | `publish_record` 增 `platform_job_id` + 扩展发布成功回传 | 风险 4 已解 | 平台职位 ↔ 需求单 映射可用 |
| **P0-c** | `candidate_application` 建表 + `CollectService` 读 `fields.jobId` 落投递事实 | 映射表可用 | 新采集自动关联 |
| **P0-d** | `CandidateDetailDialog.vue` 人工绑定/纠正 | P0-c | 自动 + 人工双出口闭环 |
| **P1** | 历史回填（`fields_json.jobId` → `candidate_application`） | 映射覆盖足够 | 存量数据可查 |
| **P1** | 规则版适配打分（`candidate_position_match`） | — | 解决 recommend 分类 |
| **P2** | 文本反推辅助建议 / 语义模型 | P1 效果评估 | 可选 |

**每阶段的仓库纪律**（`AGENTS.md`）：
- DDL 走 `sql/*_create_*` + `sql/alter_*` **成对同步**（新增列必须 create 与 alter 都有，
  否则新老库结构静默分叉——这正是 2026-09-22 采集恒定 500 的根因）；
- 一次性回填脚本放 `sql/upgrade/`，默认不自动执行；
- 不代跑 git 写操作，不直接改库。

## 7. 证据附录

```bash
# 1) 职位线索是否已入库（本地库，只读）
docker exec recruit-mysql mysql -uroot -p<pw> recruit_platform \
  -e "SELECT id, JSON_UNQUOTE(JSON_EXTRACT(fields_json,'\$.jobId')) AS f_jobId \
      FROM resume_version WHERE fields_json IS NOT NULL ORDER BY id;"

# 2) 职位 ID 是否有多形态
docker exec recruit-mysql mysql -uroot -p<pw> recruit_platform \
  -e "SELECT id, raw_json LIKE '%encryptJobId%' AS enc, raw_json LIKE '%jobId%' AS plain \
      FROM resume_version WHERE raw_json IS NOT NULL;"

# 3) 映射链路的落点是否为空
docker exec recruit-mysql mysql -uroot -p<pw> recruit_platform \
  -e "SELECT COUNT(*) AS total, COUNT(published_url) AS with_url FROM publish_record;"
```

代码取证位置：

| 结论 | 位置 |
|---|---|
| `fields` 带走节点所有标量键 | `extension/background.js:1435-1452`（`extractFields`） |
| 采集摘要不含职位 | `recruit-server/.../service/CollectService.java:494-515`（`applySummary`） |
| `candidate` 表无职位列 | `recruit-server/sql/candidate_create_20260921_V1.sql` |
| 发布成功回传只带 URL | `extension/content/sentinel.js:127`（`publishedUrl = location.href`） |
| 发布回填契约 | `recruit-server/.../dto/RecordReportDTO.java` |
| 渠道配置（boss） | `channel` 表 `code='boss'` 行 |

## 8. 落地状态

用户决策（2026-09-22）：**A 为主流程、B 为兜底；B 的粒度为「岗位映射级」；改绑走级联重算；先落 A。**

### 8.1 已实现（未提交）

**DDL（已执行到本地库 `recruit_platform`）**

| 文件 | 内容 |
|---|---|
| `sql/candidate_application_create_20260922_V1.sql` | 新建投递事实表，`UNIQUE (platform, candidate_id, platform_job_id)` |
| `sql/publish_record_alter_add_platform_job_id_20260922_V1.sql` | 增 3 列 + `UNIQUE (channel_id, platform_job_id)`（幂等，`information_schema` 守卫） |
| `sql/publish_record_create_20260915_V1.sql` | 同步补列与唯一键（create/alter 成对） |

**后端**

| 文件 | 内容 |
|---|---|
| `entity/CandidateApplication.java`、`mapper/CandidateApplicationMapper.java` | 新建 |
| `service/CandidateApplicationService.java` | 落事实（三元组幂等）/ 解映射 / **级联重算** / 查询辅助 |
| `service/CollectService.java` | 采集流程增「投递事实」一步，与候选人/版本/附件/审计**同事务** |
| `service/PublishRecordService.java` | ① `report()` 自动捕获写映射（仅 published + 仅未绑定）+ 冲突 409；② `bindPlatformJob()` 人工绑定/更正/解除（路径 B）+ 双向级联；③ `requireCapturableChannel()` 静默失效守卫 |
| `dto/RecordReportDTO.java`、`dto/PlatformJobBindDTO.java`、`entity/PublishRecord.java`、`vo/PublishRecordVO.java` | 增 `platformJobId` / `bindSource` / `boundBy` / 绑定 DTO |
| `common/CollectRules.java`、`vo/ExtRulesVO.java` | 增 `JOB_ID_KEYS` / `JOB_HINT_KEYS` / `CAPTURABLE_PLATFORMS`（走既有采集规则下发端点，**不新增第二份枚举**） |
| `controller/PublishRecordController.java` | 新增 `PUT /api/publish-records/{id}/platform-job`（`@RequireRole({ADMIN, HR})`） |
| `service/CandidateQueryService.java`、`vo/CandidateVO.java`、`vo/CandidateApplicationVO.java`、`vo/CandidateDetailVO.java`、`controller/CandidateController.java` | 列表/详情透出投递；新增「按职位看候选人」`requestId` 筛选 |

**扩展**

| 文件 | 内容 |
|---|---|
| `content/job-probe.js` | 新建：MAIN 世界探针，旁观 fetch/XHR 提取岗位 ID（内存 + postMessage） |
| `content/sentinel.js` | 成功时按「探针 → URL → DOM」有序组装 `platformJobId`，全不中则不带上报 |
| `background.js` | 注入探针（MAIN、全帧）；回填带 `platformJobId` |
| `manifest.json` | 版本 0.2.4 → 0.3.0 |

**前端**

| 文件 | 内容 |
|---|---|
| `types/candidate.types.ts`、`types/publish-record.types.ts` | 契约同步（Zod schema） |
| `pages/publish-records/PublishRecordJobBindDialog.vue` | 新建：人工关联岗位抽屉（填写 / 更正 / 解除；409 后清空输入框） |
| `pages/publish-records/PublishRecordListPage.vue` | 增「平台岗位」列，点击进入关联 |
| `pages/candidates/CandidateListPage.vue` | 增「投递职位」列 + 「全部职位」筛选下拉 |
| `pages/candidates/CandidateDetailDialog.vue` | 增「投递职位」区块 |
| `lib/api/candidate.api.ts`、`lib/api/publish-record.api.ts` | 增 `requestId` 筛选参数与 `bindPlatformJob` |

**测试与验证**

| 载体 | 内容 |
|---|---|
| `src/test/.../CandidateApplicationConsistencyTest.java`（9 例） | 投递四条不变式：不落半行 / 幂等不改首次时间 / 不猜 / 级联一致 |
| `src/test/.../PublishRecordPlatformJobBindTest.java`（14 例） | A↔B 边界：自动不覆盖人工、人工可覆盖一切、唯一键冲突、双向级联、非采集渠道守卫、解除绑定 |
| `test/candidate-position-link-e2e.sh`（27 项断言） | 真实 HTTP 端到端：自建需求单链 → A 回填 → 采集归类 → B 改绑级联 → 冲突/状态/渠道/权限守卫 |

### 8.2 实现期的四个设计决定（与初稿的差异）

| # | 决定 | 理由 |
|---|---|---|
| 1 | 岗位 ID 键表放 `CollectRules`（走采集规则端点），**不**放 `channel.field_map_json` | 它与 `RESUME_KEYS` / `ATTACH_URL_PATTERN` 同属「如何从平台响应里认出某样东西」的识别规则。放渠道数据会形成两份必须人工同步的枚举 —— 正是 `sys_dict` 那条设计债务的成因 |
| 2 | 探针只**程序化注入**（发布任务期间），不做声明式 `content_scripts` | 声明式会让 zhipin 站点上常驻一条 hook。项目红线是「只做主动触发采集」，扩大挂载面与之相悖 |
| 3 | 映射写入额外要求 `status=published` | 发布失败不存在新岗位；若允许 failed 也写，误捕获的 ID 会**占住唯一键**，把后续正确绑定挡在 409 外 |
| 4 | 新增 `requireCapturableChannel()` 守卫：非采集渠道（如 `mock_demo`）禁止写入岗位映射 | **实测发现的静默失效**：端到端回归把一条 mock_demo 台账绑上岗位后，采集回来的投递 `request_id` 永远是 NULL —— 因为归属按 `(platform, platform_job_id)` 解析，而 platform 只能是采集平台。台账上却显示「已关联」。这类"看着成功、实际没接线"的状态最难排查，必须当场拒绝 |

### 8.3 关键不变式（写进代码与测试）

> **`publish_record.platform_job_id` 只有在「该台账所属渠道的 `channel.code` == 采集上报的 `platform`」时才可解析。**

来源：`CollectRules.CAPTURABLE_PLATFORMS`（当前 = `[boss]`）。违反它的表现是**写入成功但永不生效**，
因此由 `PublishRecordService.requireCapturableChannel()` 在两条写入路径（回填 / 人工绑定）上强制校验。
后续若接入第二个采集平台，只需往该集合加值 —— 守卫与错误提示自动跟着走。

### 8.4 遗留（未做）

| 项 | 说明 |
|---|---|
| **真机验证 A** | `job-probe` 能否在 BOSS 真实发布页抓到 jobId，仍需真机实测（见 §5 风险 1/2/4）。E2E 只证明了「回填带上 ID 就能建立映射」，没证明「平台会给出 ID」 |
| **`jobIdKeys` 双向比对测试** | 目前由 `CollectRules` 常量与扩展侧兜底表（`FALLBACK_JOB_ID_KEYS` / `DEFAULT_RULES`）两处承载，沿用 `RESUME_KEYS` 的既有约定，未加锁定测试 |
| **`sys_dict` 四类候选人字典** | 仍未接线，本次未触碰（避免范围外改动） |
| **`manifest.json` 声明式匹配错位**（既有问题） | `sentinel.js` 的 `content_scripts.matches` 是 `/web/geek/job/publish*`，而实际发布页是 `/web/frame/job/publish-edit`；且 `/web/geek/*` 是求职者侧路径。主路径靠程序化注入不受影响（`injectedSentinel` 直注目标 tab），但该配置应修 —— 它与 `published_url` 全 NULL 互为印证 |
| **三处既有 create/alter 未成对**（既有问题，见 §9） | 全新环境 `db-bootstrap.sh` 会失败 |

## 9. DDL 执行记录与「双路径不分叉」核验

执行时间：2026-09-22 11:53（本地库，容器 `recruit-mysql`，库 `recruit_platform`）。
备份：`/tmp/rp-ddl-20260922/backup-no-data-20260922-115327.sql`（结构，579 行）。

### 9.1 执行结果

| 脚本 | 第一遍 | 第二遍（幂等） |
|---|---|---|
| `candidate_application_create_20260922_V1.sql` | ✅ 建表（11 列 + 唯一键 + 3 索引） | ⏭️ `CREATE TABLE IF NOT EXISTS` 空操作 |
| `publish_record_alter_add_platform_job_id_20260922_V1.sql` | ✅ 加 3 列 + 唯一索引；自检 `col_job_ok=1 col_src_ok=1 col_by_ok=1 uk_ok=2` | ⏭️ 全部「已存在，跳过」，**零改动** |

列序已验证：三列精确插在 `published_url` 之后（`AFTER published_url` 生效），
`result_note` 起整体后移 —— 与 create 脚本逐字一致。

> `uk_ok=2` 不是异常：`uk_channel_platform_job` 由 2 个列组成，`information_schema.STATISTICS`
> 一个索引列一行，故为 2。

### 9.2 双路径 diff（抓「新老库静默分叉」）

方法：临时空库跑 `db-bootstrap.sh`（create 路径）→ 与存量库（alter 路径）逐列 + 逐索引 diff。
本地库与全新库各 273 / 267 行快照。

**本次新增的两处改动，两条路径零差异** ✅（`candidate_application` 全表、`publish_record` 三列 + 唯一索引）。

diff 同时暴露 **4 处既有分叉**（与本次改动无关，均为「create 从未同步 alter」）：

| # | 对象 | 存量库 | 全新库 | 后果 |
|---|---|---|---|---|
| 1 | `channel.publish_entry_url` | 有 | **无** | ⚠️ 直接导致 `channel_seed_boss_*.sql` 报 `ERROR 1054 Unknown column 'publish_entry_url'`，**全新环境 bootstrap 失败** |
| 2 | `extension_token.expires_at` + `idx_status_expires` | 有 | **无** | 全新环境扩展 token 过期能力缺失 |
| 3 | `hr_request.owner_user_id` + `idx_owner` | 有 | **无** | 全新环境 ADR-008 归属能力缺失 |
| 4 | `candidate.platform_user_id` / `source_platform_user_raw`、`hr_request.created_by` 的**列注释** | 旧注释 | 新注释 | 注释分叉，不报错但会误导下一个读 DDL 的人 |

根因：`ls sql/*.sql | sort` 字典序下 `*_alter_*` 跑在 `*_create_*` **之前**；
全新库此时表还不存在 → alter 按设计跳过 → 而 create 脚本里从未补上这些列，于是**永久缺失**。

> 这与本设计的两张脚本形成对照：`publish_record` 的 create 与 alter 是**成对同步**的，
> 所以两路径零差异。既有那三处应同样处理（补进各自的 create 脚本 + 加注释收敛段）。

**未修**：属既有问题、超出本次范围（`AGENTS.md`：改动仅限需求范围）。已报告，待决策。

### 9.3 其他记录

- 临时库 `recruit_platform_dryrun` / `recruit_platform_dryrun2` 已 **DROP 清理**，仅剩业务库。
- 本地 `schema_migration` 台账尚无这两个脚本的记录（上次 `db-migrate.sh` 运行于 11:09）。
  下次 CI 运行会按 checksum 识别并补记；因脚本幂等，重跑无副作用。
  另因 `publish_record_create_*.sql` 被本次修改，其 checksum 变化会触发**重跑**（`IF NOT EXISTS` → 空操作）。

## 10. 真机取证结果（2026-09-22）：BOSS 岗位 ID 有**两套 ID 空间**

> 本节推翻了 §4.3 与 §8 的一个隐含前提：「平台岗位 ID 是一个稳定的单一标识」。
> 证据来自一次真实发布 + 一次 326 条响应的全量录制（扩展 0.5.0 诊断录制器）。

### 10.1 实测事实

| 形态 | 值（样例） | 出现的端点 | 出现次数 |
|---|---|---|---|
| **数字** | `jobId = 575500411` | `zprelation/friend/getBossFriendListV2`、`zpjob/job/chatted/jobList` | 613 |
| **加密** | `encryptJobId = 352f92eda67db1080nN_3t29FFNR` | `zpjob/job/name/list`、`zpjob/job/data/list`、`chatted/jobList` | 619 |

**发布提交接口的响应**（路径 A 原本的捕获点）：
```
POST /wapi/zpjob/job/save
{"code":0,"zpData":{"jobId":"a5d0bf426e1373a90nN92dS_F1RX","jobName":"…"}}
```
⚠️ 注意：**键名叫 `jobId`，值却是加密形态**。同一个键名在不同接口里装不同形态的 ID ——
`job/data/list` 里的 `jobId` 是数字、`job/save` 里的 `jobId` 是加密。**该键不能当稳定标识。**

### 10.2 为什么这会打断映射（本设计的核心前提被推翻）

- 采集侧拿到的是 `body.resume.jobId` = **数字**（已从本地库确证：采集落到 `resume_version.fields_json`
  的 6 条记录里 `encryptJobId` 全部缺席，只有数字形态）
- 发布侧拿到的是 **加密**形态
- **两者永不相等 → `platform_job_id` 映射永远解析不到**（与 geekId 的「数字 uid ↔ 加密 geekId」同类）

### 10.3 桥存在（已确证）

```
jobId(575500411) <-> encryptJobId(352f92eda67db1080nN_3t29FFNR)   同框出现 613 次
端点: zprelation/friend/getBossFriendListV2, zpjob/job/chatted/jobList
```
→ 两套 ID 空间之间有**确定的翻译路径**，路径 A 可救。

**但桥只在聊天/好友侧端点出现**；职位管理侧（`job/name/list`、`job/data/list`）只给加密形态。
而**刚发布的岗位还没有任何聊天**，所以它在桥里暂时没有数字形态。

### 10.4 这看起来是死结，其实不是

**需要映射的时刻是「采集」，不是「发布」。** 有候选人聊天才谈得上采集，
而那时该岗位已经进入 `chatted/jobList`（桥里两种形态都在）。所以：

| 时刻 | 拿到的形态 | 从哪拿 |
|---|---|---|
| 发布 | **加密**（权威、必然可得） | `job/save` 响应 |
| 采集 | **数字**（`body.resume.jobId`）+ 同会话可见的桥 | 聊天页 |

### 10.5 方案（已确认并实现，实现细节见 §10.8）

1. **以加密形态为规范形**（BOSS 管理侧、职位详情页用的都是它）
   → `publish_record.platform_job_id` 存加密形态；`Job → job/save` 的返回值直接可用
2. **采集侧归一**：采集时用同一会话观测到的桥，把数字形态换算成加密形态再落库
   （`CollectService.looksEncryptedId` 已经能判形态，可复用）
3. **可选增强**
   - 小表 `platform_job_alias(platform, job_id_numeric, job_id_encrypted)` 持久化别名，
     让「桥晚到」也能自愈（不依赖单次会话的时序）
   - 同步 BOSS 岗位清单（名称 + 加密 ID）到中台 → **B 的人工绑定可以按岗位名选**，
     而不是让 HR 手填一串加密 ID

### 10.6 仍待验证的唯一问题

**采集所处的聊天页（`/web/chat/*`）上，桥端点会不会出现？**
本次录制是在**发布页**做的（发布页也加载了 `getBossFriendListV2`，所以桥被录到了）。
若聊天页不加载这类端点，则第 2 步无法在采集时当场归一 —— 那就必须走第 3 步的别名表
（从任何一次能看到桥的会话里学习，持久化后供后续采集使用）。

→ 需要补一次「在聊天页采集一个候选人」的短录制来确认。见
`docs/troubleshooting/job-id-capture-probe.md`。

### 10.7 聊天页确证（2026-09-22 第二次录制）— §10.6 已有答案

在**聊天页**做一次真实采集（含附件探测命中 + 附件入库），桥端点确实出现：

```
7  JOBKEY  CTX  /wapi/zprelation/friend/getBossFriendListV2.json
2  JOBKEY  CTX  /wapi/zpjob/job/chatted/jobList
```

→ **采集时能当场拿到桥**，不必新建别名表也能归一（§10.5 第 2 步成立；第 3 步的
`platform_job_alias` 表**本轮不做**）。

### 10.8 已落地的实现（扩展 0.6.0 + 后端同批）

**规范形 = 加密形态。这不是偏好，是唯一自洽的方向：**

| 若选 | 结果 |
|---|---|
| 数字为规范形 | 发布时必须把加密换算成数字 —— 但**新岗位在桥里还没有数字形态**（还没人跟它聊过），当场换不出来 ✗ |
| 加密为规范形 | 发布响应直接就给加密；采集时该岗位必已进入 `chatted/jobList`（两形态同框），可当场换 ✓ |

**改动落点：**

| 层 | 改动 |
|---|---|
| `extension/content/collect-hook.js` | 命中扫描**同一次遍历**顺路做「同一对象节点内 数字↔加密」配对（`pairFromNode`）；`extract()` 跨整条环形缓冲汇总成 `jobPairs` 一并上报。放在页面侧是必须的 —— 桥响应只有页面看得到，且它没有 resume 命中键，走不进原 `captures` |
| `extension/background.js` | `collectJobPairs()` 汇总各帧配对成翻译表；`normalizeJobId()` 按**值的形状**归一（加密原样 / 数字查桥 / 查不到原样返回）；提交载荷新增 `platformJobId`、`platformJobHint` |
| `recruit-server` `CollectRules` | 新增 `JOB_ID_CANONICAL_ENCRYPTED`、`isEncryptedJobId()`、`isNumericJobId()`；`JOB_ID_KEYS` 注释明确「键名不可信，判定必须按值」 |
| `recruit-server` `CollectService` | 优先采信扩展端给的 `platformJobId`；拿不到时退回从 `fields` 按键表取（兼容老扩展）；非加密形态**打 warn 但照常落行** |

**⚠️ 判定口径（易错点，已写进代码注释）：**
`jobId` 这个键名本身不可信 —— `job/data/list` 里它是数字、`job/save` 里它是加密。
**判定一律按值的形状，不按键名。**

**归一失败时的兜底（已与用户确认）：照常落行。**
该条投递的 `platform_job_id` 落原始数字形态，`request_id` 解析不到 → 候选人库显示
「未归类」。宁可显示未归类，也不让投递事实凭空消失（丢行 = 这次投递永久无法补）。

**回归覆盖：** `test/extension-collect-verify.cjs` Part C（16 项）
—— 归一主路径、多岗位不串岗、无桥落行、键名骗人（键 `jobId` 值为加密）、
无岗位 ID 提交 null、脏配对过滤、四种归一结局、跨节点不配对、真实桥响应端到端。

### 10.9 真机验证（2026-09-22 15:14，扩展 0.6.0 + 重启后的后端）

**扩展侧**（Service Worker console）：
```
岗位 ID 归一: { raw: '575500411', jobId: '352f92eda67db1080nN_3t29FFNR',
                normalized: true, reason: 'bridged', bridgeSize: 1 }
```

**库侧**（`candidate_application` 最新一行）：
```
platform_job_id: 352f92eda67db1080nN_3t29FFNR   ← 加密形态 ✅（不再是 575500411）
platform_job_hint: 9月22日 沟通的职位-Java
request_id: NULL
```

**`request_id` 为什么还是 NULL（符合预期，不是 bug）**：该岗位在 `publish_record` 里
**还没有映射**——查库确认台账最新记录全是 E2E 数据，没有 `platform_job_id = 352f92…` 的行。
映射一旦建立即自动补齐：`PublishRecordService.bindPlatformJob` 末尾会调
`candidateApplicationService.recomputeByPlatformJob(...)` 级联刷新该岗位下所有投递行，
「先采集、后绑定」的顺序天然自愈，不需要再采一次。

> ⚠️ 部署注意：本项目**没有 spring-boot-devtools**，`mvn compile` 只写 `target/classes`，
> 运行中的 JVM 不会加载新 class —— 改后端代码后**必须重启**才生效（本次即因此第一次
> 落库仍是数字形态）。
