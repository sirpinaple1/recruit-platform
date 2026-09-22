# 岗位 ID 捕获点取证（真机验证清单）

> 用途：用一次**真人发布**，回答「BOSS 到底在哪个接口、哪个字段给出这次发布的岗位 ID」。
> 这是路径 A（扩展自动关联平台岗位）能否成立的**唯一判据** —— 在此之前它只是合理推测。
>
> 相关设计：`docs/design/candidate-position-linking.md` §5 风险 1/2/4、§8.4 遗留项。

## 0. 为什么必须真机验，不能靠读代码

`CollectRules.JOB_ID_KEYS` 目前的取值 `["jobId","encryptJobId","jobIdEncrypt"]` 来自
**聊天简历卡片**（`body.resume.jobId`，实测 6/6 命中）。但那是「候选人聊天链路」，
不等于「我发布岗位时页面会告诉我岗位 ID」。

两者是完全不同的平台行为。猜错的后果是：
- 猜宽了 → 可能把列表里**别的岗位**的 ID 当成当前岗位（真机已知陷阱：一个列表接口会带回整页岗位）
- 猜窄了 → 永远抓不到，映射恒空，投递永远归不了类

另外 `extractFields` 只在**采集页**（chat/recommend）注入；发布页（`/web/frame/job/publish-edit`）
是另一条链路，那里的响应从未被观测过。

## 1. 前置检查

```bash
# ① 后端已是新代码（应见 version=boss-20260922-V3 与 jobIdKeys）
curl -s -o /dev/null -w '6017 health=%{http_code}\n' http://localhost:6017/api/health

# ② 扩展版本应为 0.4.0（chrome://extensions 卡片上直接看）
#    若不是 → 点「重新加载」，注意确认 Chrome 实际加载的目录（见 docs/EXTENSION_TROUBLESHOOTING.md）
```

- BOSS 账号**保持已登录**（扩展不接触凭据，只用你已登录的会话）。
- **确认这个 BOSS 账号下有几个在招岗位** —— 只有一个时，「一人多岗」相关的推断不成立，要标注。

## 2. 操作步骤（0.5.0 起，不再需要盯着 tab）

> **0.5.0 的关键变化**：录制期间改为**动态注册内容脚本**（document_start、全帧）+
> **导航兜底**（每个 zhipin 页面加载完成补注一次）。所以：
> **任何** BOSS 页面（含填充流程新开的发布页、iframe、以及发布后跳转/刷新的列表页）
> 都会自动带上探针 —— 不需要先开好页面、也不怕中途跳转。

| # | 动作 | 说明 |
|---|---|---|
| 1 | 在任意 BOSS 页面点扩展图标 → 「诊断录制」→ **开始录制** | 状态里若出现「⚠️ 脚本未注册」说明注册失败，此时**刷新一下目标页**（导航兜底会补注） |
| 2 | **走一次完整发布**（填充 → 点发布） | 点发布时 popup 会被关掉（它点页面任何处就关）——**录制没有停**，只是状态不再刷新 |
| 3 | 发布成功后**回职位列表页刷新一次** | 很多平台只在列表接口里给出新岗位的 ID |
| 4 | 重新打开 popup → **停止** → **导出 JSON**；或直接用 §2.3 的 console 片段 | |

> 早期版本（≤0.4.2）的坑：探针只注入到「点开始录制那一刻的活动 tab」，
> 且注入发生在**填充完成之后**——填充会新开一个发布页 tab，探针留在旧 tab，
> 于是「录制开着却 0 条」。0.5.0 用动态注册 + 导航兜底把这一类问题整体消除。

### 2.1 一行自查（在目标页 Console 里跑）

```js
JSON.stringify({ probe: typeof window.__recruit_job_probe_active,
                 rules: window.__RECRUIT_JOB_PROBE_RULES__,
                 rec: window.__RECRUIT_JOB_PROBE_RECORD__,
                 st: window.__recruit_job_probe_active?.status?.() || null })
```

| 结果 | 含义与动作 |
|---|---|
| `probe:"undefined"` | 探针不在此帧 → 刷新该页（导航兜底会补注）；若刷新后仍无，看 popup 状态是否「脚本未注册」 |
| `rec:false` | 探针在，但开关没同步过来 → 重新点「开始录制」 |
| `rec:true` | ✅ 在录，去发岗位/点发布 |

### 2.2 已修的坑（按版本）

| 版本 | 坑 | 症状 | 修法 |
|---|---|---|---|
| 0.5.0 | **注入时机与范围** | 只覆盖「点录制时的活动 tab」，且注入在填充之后 → 新开的发布页 tab 录不到、页面一跳转就丢 | 动态注册（document_start／全帧）+ `tabs.onUpdated` 导航兜底 |
| 0.5.0 | **跨帧重复上报** | 探针会同时投本帧与顶层；若转发层不按 `ev.source` 过滤，顶层会把子帧那份再转一次 → 同一条录两遍，**数据看起来翻倍** | 转发层全帧各一份 + 只上报本帧（`ev.source === window`） |
| 0.5.0 | **开关同步** | 动态注册的探针在 document_start 就跑，此刻 window 上还没有开关标志 → 探针以为自己是关的，**静默录不到** | 转发层装载时向 background 问一次 `DIAG_GET_FLAG`，再广播进本帧 |
| 0.4.2 | **水合竞态** | MV3 worker 在「填充完成」与「点发布」之间被回收；冷启后内存标志仍 `false`，此窗口到达的记录被**静默丢弃** | `diagAppend` 先 `await` 水合再判定 |
| 0.4.2 | **meta 被整体覆盖** | 再点「开始录制」会抹掉 `bytes/count/trimmed`，状态显示 0 KB、「丢过条目」警告消失 | 改为合并写入 |
| 0.4.2 | **显式设置被晚到水合覆盖** | 点了开始却没在录 / 点了停止却还在录 | 加 `diagExplicit` 标记，显式动作优先 |

### 2.3 取数（不用传文件）

**首选：Service Worker 的 Console** —— `copy()` 在 Service Worker console 里**不存在**
（它属 DevTools 命令行 API），所以别用；改用
`test/browser-console-diag-analysis.js` 里 `── 粘贴以下内容 ──` 与 `── 粘贴到此为止 ──`
之间的整段，粘进 Console 即出报告。

**备选：popup「导出 JSON」** → `node test/analyze-job-probe-export.cjs ~/Downloads/recruit-job-probe-*.json`
（大 JSON 的 blob 下载可能被 popup 关闭打断，失败就用「复制」按钮或上面的 Console 方案）

## 3. 判据：三种结果与对应动作

| 结果 | 分析器表现 | 结论与动作 |
|---|---|---|
| **A. 抓到唯一岗位 ID** | 某个 `jobId = xxx` 在**多个**端点反复出现 | ✅ 路径 A 成立。把该键名补进 `CollectRules.JOB_ID_KEYS`（若已在列表里则无需改），真机再复核一次回填是否落库 |
| **B. 只抓到岗位列表** | 候选里有**多个**不同 `jobId`，全都在列表类接口 | ⚠️ 不能直接取第一个。需要「取最近创建」策略：按 `createTime`/`jobStatus` 排序取最新，或用草稿标题匹配。**属于新增设计，需先讨论** |
| **C. 一条都没抓到** | `❌ 一条都没录到` | ❌ 响应体里没有岗位 ID。退路：① 从**已发布岗位的 URL** 里取（需实测 URL 形态）；② 只靠人工绑定（路径 B）。此时 A 的自动捕获部分**应下掉**，避免留一个永远不生效的机制 |

> ⚠️ 结果 B/C 都不是「没关系」——它们意味着 §8.2 里「A 为主流程」的前提不成立，
> 需要把 B（人工绑定）从「兜底」上调为**主流程**。所以这一步的结论直接决定后续排期。

## 4. 录不到时的排查顺序

1. **录制是在发布之前开的吗** —— 探针只在注入后的会话里生效，事后开录录不到发布过程。
2. **popup 的条目数是否 >0**
   - 为 0：脚本没注进去。检查当前页是否 `*.zhipin.com`；刷新页面后重试；看 `chrome://extensions` 的「错误」。
3. **导出里 `trimmed > 0`** —— 环形缓冲丢了最早的条目。发布若发生在录制早期，可能已被丢掉，重录一次（先开录 → 立刻发）。
4. **发布页是否在 iframe 里** —— 探针按 `allFrames` 注入、子帧会往 `window.top` 投递，理论上覆盖；若仍为空，检查该页是否有跨源 iframe 把请求包在里面。
5. **是否根本没走「发布」而是改的存量岗位** —— 改岗位不产生新岗位 ID，验不出来。

## 5. 顺带要确认的两件事（同一轮就能验）

| 事项 | 怎么看 |
|---|---|
| 发布成功信号到底有没有触发 | 台账页看该条 `status` 是否变 published、`published_url` 是否落值。全 NULL 说明 `sentinel` 的成功判定在真机从未命中（`channel.field_map_json.success` 只配了选择器、无 `urlPattern`） |
| 职位 ID 是否有多形态 | 分析器会给 `encryptJobId` 之类键名的命中。BOSS 对「人」有数字 uid + 加密 geekId 两套 ID（曾导致候选人分裂两条），岗位 ID 极可能重演 —— 若确有两形态，`JOB_ID_KEYS` 的顺序与归一策略都要跟着定 |

## 6. 已知待修（与本次取证相邻，不在本次改动内）

- `extension/manifest.json` 里 `sentinel.js` 的声明式 `matches` 是 `/web/geek/job/publish*`，
  而实际发布页是 `/web/frame/job/publish-edit` —— **不匹配**，且 `/web/geek/*` 是求职者侧路径。
  主路径靠 `injectSentinel` 程序化注入不受影响，但该配置应修。
