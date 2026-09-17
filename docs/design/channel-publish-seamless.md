# 渠道发布 · 无感化改造设计

> **状态**：v2.0 待评审（2026-09-16）
> **上游**：本文是 [channel-publish.md](channel-publish.md) §7/§8 的演进版，两者冲突时**以本文为准**（该文头部已列出逐条修订对照）
> **权限决策**：[ADR-008](../architecture/adr/ADR-008-resource-ownership-authorization.md) 是归属授权的权威记录，本文只写落地细节
> **触发**：HR 反馈使用步骤过多（8 步 / 3 个界面来回切），要求「专注系统本身，无感使用扩展」
>
> ### v2.0 相对 v1.0 的变化
>
> | 变化 | 说明 |
> |---|---|
> | **新增 §3 权限设计** | 从「附带提一句」提升为**前置章节**——它是第一轮验收条件的一部分，且必须先于无感化落地 |
> | **收敛本轮范围** | 只跑通 **BOSS 直聘单渠道**；v1.0 的 Phase 3（多平台串行、popup 诊断面板）**本轮不做** |
> | **§7 结论修正** | 初判「BOSS pattern 是通配 → 撞抛错分支」经只读核对**不成立**。真实问题是「一列两用 + 种子漂移 + BOSS 无种子」三条，见 §7 |
> | 新增 §10.1 验收数据前置 | 实测发现本地库 10 条岗位**全部由 admin 创建**，会导致 HR 侧验收无数据可测 |
> | 落地清单补 SQL 真源 | 4 个改表脚本 + 2 个种子 + 2 个一次性迁移，已全部落 `recruit-server/sql/` |

---

## 1. 问题定义

### 1.1 现状步骤盘点

| # | 步骤 | 界面 | 性质 |
|---|---|---|---|
| ① ② | 打开职位页 · 记住这次要发什么 | 中台 | **搬运上下文** |
| ③ ④ ⑤ | 点插件图标 · 列表里翻找草稿 · 点「去发布页填充」 | 扩展 popup | **搬运上下文** |
| ⑥ | 人工核对 · 亲手点提交 | 平台页 | 真实工作（红线保留） |
| ⑦ ⑧ | 再点图标 · 找回同一张卡 · 填链接/账号 · 确认 | 扩展 popup | **搬运上下文** |

**8 步里只有 1 步是真活**：人工核对提交。其余 7 步都是在三个界面之间搬运同一条上下文。

### 1.2 病根

不是填充能力不足（引擎的三级匹配已经足够强），而是**触发方向反了**：

- 现状 = 「人去扩展里找活干」——扩展是一个需要用户主动想起、主动打开的独立入口；
- 目标 = 「扩展跟着系统走」——扩展是对中台界面的一层**隐形能力**，用户脑子里不该有「插件」这个概念。

### 1.3 一个必须同时解决的副作用

「扩展 popup 是独立入口」这件事，此前**意外地起到了访问控制作用**：HR 要点开 popup、在草稿列表里挑，才可能操作到某条草稿。

触发点搬进中台后，岗位与发布入口**直接长在中台页面上**，归属隔离缺失就无处可藏了。因此 §3 的权限设计不是「顺手补的」，而是**这次改造的前置条件**——不做它，等于把一个已存在的越权路径从隐蔽处搬到显眼处。

---

## 2. 目标与本轮范围

### 2.1 目标与验收口径

| 指标 | 现状 | 目标 |
|---|---|---|
| 完成一次渠道发布的操作步数 | 8 | **3** |
| 跨越的界面数 | 3 | **2**（中台 + 平台，且平台是必要的） |
| 一次性配置成本 | 装扩展 + 抄 token（重启浏览器需重做） | **装扩展后零配置** |
| HR 主动打开 popup 的次数 | 每次发布 2 次 | **0** |
| 能看到他人负责岗位的 HR | 全部可见 | **0** |

**红线不变**：扩展永不点击平台提交按钮；提交永远由人手完成。

### 2.2 本轮验收条件（用户指定）

1. **代码质量审核过关**；
2. **只有负责该岗位的 HR 能看到该岗位，并能点击发布**——他人不可见、不可操作；
3. **点发布后自动弹出平台发布页**，HR 核对并亲手点提交。

### 2.3 本轮范围边界

| 做 | 不做（本轮） |
|---|---|
| BOSS 直聘（`zhipin.com`）单渠道跑通 | 多平台一键铺渠道（串行填 3 个平台） |
| 零配置授权 · 中台触发 · 哨兵自动回执 | popup 诊断面板改造 |
| 归属授权（§3）全量落地 | 岗位负责人**改派**接口（字段与默认值先就位） |
| BOSS 渠道的 `publish_entry_url` / `success` 配置数据 | 真实平台 success 信号调优（先用保守配置 + 人工兜底） |

---

## 3. 权限设计（前置条件）

> **决策与权限矩阵的唯一真源是 [ADR-008](../architecture/adr/ADR-008-resource-ownership-authorization.md)**。本节只讲**落地点**与**具体接口清单**，不重复论证。

### 3.1 一句话规则

> 岗位有一个**招聘负责人**（`hr_request.owner_user_id`）。**只有他能看到该岗位、以及它的渠道草稿与发布台账，并执行发布/回填。** ADMIN 例外：可见全部、可代发。

### 3.2 归属字段

`hr_request.owner_user_id`（新增列，DDL 见 §8）：

- **默认值**：创建岗位时 = 创建人。本轮二者取值恒等，但**语义已解耦**——`created_by` 是审计字段（谁建的），`owner_user_id` 是业务字段（现在谁负责）。改派时改后者、不动前者。
- **`NULL` = 未指派 = fail-closed**：对 HR 一律不可见/不可操作，仅 ADMIN 可见。**这是刻意的**：宁可让 ADMIN 兜底，也不让「未指派」静默退化成「人人可见」。
- **改派本轮不做**。`POST /api/hr-requests` 亦不支持指定负责人（默认创建人）。这两项一起留作后续增量——字段已就位，加接口是纯新增。

### 3.3 唯一判定真源

`service/PositionAccessService`：

| 方法 | 用途 |
|---|---|
| `canView(req, user)` | 读判定 |
| `canOperate(req, user)` | 写判定 |
| `assertCanOperate(req, user)` | 写前校验，不通过抛 `MyException(403, …)` |
| `viewScope(user)` | 返回查询条件（ADMIN → 空条件；HR → `owner_user_id = self`） |

**为什么落在 service 层而不是拦截器**：拦截器只能「放不放行」，而本需求的主体是**查询过滤**（只查我负责的岗位），过滤条件必须参与查询构造。硬塞进拦截器会把过滤需求留成缺口。

### 3.4 逐接口落地清单

#### 读（必须过滤 / 校验）

| 端点 | 现状 | 改法 |
|---|---|---|
| `GET /api/hr-requests` | 无过滤 | `viewScope(user)` |
| `GET /api/hr-requests/{id}` | 无校验 | `canView` 不通过 → 403 |
| `GET /api/hr-requests/{id}/drafts` | 无校验 | 先校验岗位归属 → 403 |
| `GET /api/publish-records` | 无过滤 | 由 `request_id` 关联岗位归属过滤 |
| `GET /api/publish-records/{id}` | 无校验 | 由 `record.requestId` 反查岗位 → 403 |
| `GET /api/ext/drafts` | **全量返回**（已知越权） | 由 `extUserId` 反查 `SysUser` → 按 owner 过滤 |

#### 写（必须校验归属）

| 端点 | 改法 |
|---|---|
| `POST /api/hr-requests` | 写入时 `owner_user_id = created_by = 当前登录用户` |
| `PUT /api/hr-requests/{id}` | `assertCanOperate` |
| `POST /api/hr-requests/{id}/submit` \| `/close` \| `/reopen` \| `/headcount` | `assertCanOperate` |
| `POST /api/hr-requests/{id}/approve` \| `/reject` | `assertCanOperate`（ADMIN 例外覆盖现有流程，见下） |
| `POST /api/ext/records/{id}/report` | 由 `record.requestId` 反查岗位 → `assertCanOperate` |
| `POST /api/ext/records/{id}/revert` | 同上 |

**审批语义（一期说明）**：`approve` / `reject` 纳入 `assertCanOperate`，即「ADMIN 或岗位负责人可审批」。这与现状不冲突（现状无任何校验，且 E2E 全部用 admin 操作）。真实钉钉回调接入后，审批人应与岗位归属解耦，届时另行调整——**这一条属于 ADR-001 的功能授权范畴，不属于 ADR-008 的归属范畴**，此处只是为一致性而收口。

#### 扩展端不豁免

`/api/ext/**` 只换了一套**认证**（`X-Extension-Token` → `extUserId`），**授权**必须复用同一个 `PositionAccessService`。`extUserId` 需先反查 `SysUser`（沿用 `RoleInterceptor` 的做法，走 `UserService` 而不是直接调 Mapper）。

### 3.5 前后端分工

| 端 | 职责 |
|---|---|
| **后端** | **授权权威**。拒绝越权请求，过滤越权数据。被绕过前端不影响安全性 |
| 前端 | 仅体验优化：按钮可见性、空态文案。**禁止在页面里复刻归属规则**（如前端自己判断「这条是不是我负责的」）——前端只按后端**实际返回的数据**渲染 |

**403 的文案要给对**：归属类 403 意味着「这条数据你无权访问」，需可见提示。否则按 §3.2 的 fail-closed 设计，用户看到空列表会误以为「岗位数据丢了」。

### 3.6 本轮不做的权限增强

| 项 | 为什么不做 |
|---|---|
| 岗位负责人改派接口 | 属管理便利功能，不进本轮验收链路（字段已就位） |
| 创建时指定负责人 | 同上（默认创建人已满足「HR 自建自发」主路径） |
| 按部门 / 团队共享 | 业务前提已确认为「岗位归单人」，不做 |
| 归属授权的行为审计 | 依赖 `domain_event`，属模块 4 范畴 |

---

## 4. 支柱一 · 零配置授权

### 4.1 接口契约

```
POST /api/extension/session-token
鉴权：AuthInterceptor（Authorization: Bearer <中台 JWT>，即登录态）
请求体：{ "token": "<扩展本地已有 token，可选>" }
响应：R<ExtensionSessionTokenVO>
```

```json
{
  "code": 0, "msg": "ok",
  "data": {
    "token": "只有新签发时才有明文，复用时为 null",
    "reused": false,
    "tokenId": "1234567890",
    "expiresAt": "2026-10-16T00:00:00Z"
  }
}
```

### 4.2 复用判定（关键，避免多设备互踢）

库中只存 SHA-256 hash，无法反推明文，所以**不能简单「查到就返回旧明文」**。解法是让扩展把本地 token 一并带上：

| 扩展本地状态 | 后端行为 | 结果 |
|---|---|---|
| 无 token（首次） | 签发新 token | 返回明文 |
| 有 token 且 hash 命中 active 且属于该 user | 不新建、不吊销 | `reused: true`，长期单设备零新增 |
| 有 token 但已失效 / 被吊销 | 签发新 token | 返回明文 |
| 无 token，但同 user 已有 active token（另一台设备） | 签发新 token | 两台设备各自持有，**互不踢** |

对比被否掉的方案：

- ❌ 「每次调用都吊销旧的」→ 多设备互相踢；
- ❌ 「库里存明文以便重复领取」→ 直接违反「明文不落库」红线；
- ❌ 「查到 active 就复用」→ 拿不回明文，做不到。

### 4.3 由 background 发起请求，不由 content script 直接 fetch

**这一条是硬约束，写错就白做：**

- MV3 content script 的 `fetch` **受页面同源策略约束**，中台页（`localhost:5173`）→ 后端（`localhost:6017`）属跨源，会被 CORS 拦；
- `host_permissions` 的 CORS 豁免**只给扩展的后台上下文**；
- 所以正确链路是：content script 读页面 `localStorage['recruit_token']` → `chrome.runtime.sendMessage` 交给 background → **background 发请求**。

副作用（好事）：后端**不需要新增任何 CORS 配置**，也就不存在把 CORS 开成通配的风险。

### 4.4 信任边界

`session-token` 本质上把「能登录中台」等价于「能领扩展 token」。信任级别没有升高（同一账号自己给自己签），但风险面确实变了——**任何能在中台页面里执行脚本的东西**（例如用户另外装的一个恶意扩展）现在都能领到 token。因此必须配套四条：

1. **只签发给 `status = active` 的 sys_user**；
2. **校验 `Origin`**——background 请求会带 `Origin: chrome-extension://<扩展ID>`，后端只接受白名单内的扩展 ID / 中台域名；
3. **必须带 `expires_at`**（建议 30 天）——补掉现状 `extension_token` 永久有效的缺口（DDL 见 §8）；
4. **打包时固定扩展 ID**（manifest 加 `key` 字段），否则重装后 ID 变化、Origin 白名单失效。

同时**权限语义不扩大**：新签发的 token 仍然只有「拉 pending 草稿 + 回填 record」两项权限。

### 4.5 关键实现约束（容易踩）

现有 `WebMvcConfig` 的实际行为是：

```
authInterceptor          → /api/**  排除 /api/auth/login, /api/health, /api/ext/**
extensionAuthInterceptor → /api/ext/**（要 X-Extension-Token）
```

也就是说 **`/api/ext/**` 是被排除在登录态校验之外的**。若把 session-token 挂在 `/api/ext/session-token`，会陷入两难：既要登录态（被排除）又要扩展 token（鸡生蛋）。

**所以新接口必须挂在 `/api/extension/**`（管理端命名空间）**：

- 命中 `/api/**` → 走 AuthInterceptor 校验登录态 ✅
- 不命中 `/api/ext/**` → 不会被扩展拦截器拦 ✅
- `WebMvcConfig` **零改动** ✅

> ⚠️ `/api/extension/**` 与 `/api/ext/**` **只差一个 `s`**。改拦截器排除列表时务必看清——写错会让换权端点**静默失去登录态校验**。

---

## 5. 支柱二 · 触发点搬到中台

### 5.1 桥协议（content script ↔ 页面）

消息统一带 `source` 区分方向，避免与页面自身消息混淆：

```js
// 页面 → 扩展
{ source: 'recruit-web',       type: 'FILL_REQUEST',  payload: { recordId, channelCode } }

// 扩展 → 页面
{ source: 'recruit-extension', type: 'EXT_READY',     payload: { version } }
{ source: 'recruit-extension', type: 'FILL_PROGRESS', payload: { recordId, phase } }
{ source: 'recruit-extension', type: 'FILL_RESULT',   payload: { recordId, summary, ok } }
{ source: 'recruit-extension', type: 'PUBLISH_BACK',  payload: { recordId, status, publishedUrl } }
```

`postMessage` 的 `targetOrigin` 一律写死中台域名，不写 `'*'`。

### 5.2 按钮状态机（中台侧）

| 状态 | 触发条件 | 表现 |
|---|---|---|
| 未安装 | 未收到 `EXT_READY` 心跳 | 按钮置灰 · tooltip「未检测到发布助手，点击查看安装指引」 |
| 就绪 | 收到 `EXT_READY` | 按钮可用 |
| 填充中 | 本地状态 | 按钮转 loading，文案「正在后台填充…」 |
| 待提交 | 收到 `FILL_RESULT` 且 `updated > 0` | 提示「已填充，请在 BOSS 页面核对后提交」 |
| 已登记 | 收到 `PUBLISH_BACK` | 台账行变绿 · 原地 toast |

**心跳**：`bridge.js` 注入后立即派发 `EXT_READY`，此后每 5s 一次；中台侧连续 15s 未收到即判定为未安装 / 被禁用。

### 5.3 中台只传 `recordId`，不传数据

`FILL_REQUEST` 只带 `recordId`。字段值、`fieldMapJson`、`publishUrlPattern`、`publishEntryUrl` 全部由 background 用扩展 token 调 `GET /api/ext/drafts` 自行匹配。

理由：中台**零渲染逻辑重复**；平台改版只需改渠道数据，中台一行都不用动。这也顺带保住了 channel-publish.md §5.2「新增渠道 = 插一行数据，不改任何代码」的验收要求。

**附带好处**：因为数据是 background 通过 `/api/ext/drafts` 拉的，而该端点按 §3.4 已按归属过滤——**中台只负责「点」，权限由后端在数据源头保证**，不存在「前端漏判」的风险。

---

## 6. 支柱三 · 结果自动回执

### 6.1 成功信号配置化（复用 JSON 列，零 DDL）

在渠道 `field_map_json` 中新增 `success` 节点：

```json
{
  "fields": [ ... ],
  "selectors": { ... },
  "success": {
    "urlPattern": "**/job/**",
    "selectors": [".publish-success", ".job-published-tip"],
    "timeoutMs": 60000
  }
}
```

哨兵注入平台页后，同时监听 `popstate` / URL 变化（覆盖 SPA 跳转）与选择器出现；命中任一即判成功。

> 本轮先用**保守配置**（要求 URL 变化 + 选择器双命中），宁可漏判走人工兜底，也不要误判污染台账。

### 6.2 自动回填 + 可撤销窗口

检测到成功后：

1. 取当前 tab URL 作为 `publishedUrl`；
2. 调 `POST /api/ext/records/{id}/report`（`status: published`）；
3. 向中台 tab 广播 `PUBLISH_BACK`；
4. 中台台账行原地变绿 + toast 显示「BOSS 渠道已登记发布 · 撤销」。

**撤销需要一个新接口**——现有 `report` 只接受 published/failed 终结且防重复回填，没有回退能力：

```
POST /api/ext/records/{id}/revert
鉴权：X-Extension-Token（+ 归属校验，见 §3.4）
约束：仅允许 operated_by == 当前 extUserId，且 published_at 在 5 分钟内
行为：status 置回 pending、published_url/published_at 清空、写审计备注
```

超时返回 400，toast 转为「超过撤销窗口，请到台账页手动更正」。

### 6.3 兜底路径

| 情况 | 处理 |
|---|---|
| 平台未登录（被踢到登录页 / 无表单控件） | **填充前置校验**：开 tab 后先探表单控件，5s 内无则立即失败并提示「请先在本机登录 BOSS 账号（扩展不接触凭据）」，不让 HR 白等 25s |
| 哨兵超时未检测到成功 | 不回填。中台行显示「待确认」内联按钮，一点即登记为 published（复用同一 report 接口） |
| 填充有字段失败（`failed > 0`） | 中台原地红色内联提示 + 「重新填充」按钮，列出未处理字段 |
| 后端不可达 / token 失效 | background 主动重试一次 `session-token`；仍失败则 toast 提示，并回落 options 手填 |

---

## 7. 发布页入口 URL（一列两用 + 真源漂移）

> ⚠️ 本节结论经过**只读核对本地库**后修正过。初判「BOSS 的 pattern 是通配串 → 撞上抛错分支」**不成立**，实际问题是另外三条。

### 7.1 实测事实

本地库 `channel` 表两条渠道（2026-09-16 只读导出）：

| code | publish_url_pattern | 含通配 |
|---|---|---|
| `mock_demo` | `http://localhost:8430/publish-mock.html` | ❌ |
| `boss` | `https://www.zhipin.com/web/frame/job/publish-edit?jobversion=11363&encryptId=0&enterSource=2` | ❌ |

两者都是**具体 URL**，按 `background.js` 现有逻辑都会走 `tabs.create`，**不会抛错**。

### 7.2 真实问题（三条）

| # | 问题 | 影响 |
|---|---|---|
| (a) | **一列两用**：`publish_url_pattern` 同时承担「导航入口」和「注入校验模式」两个职责。BOSS 塞的是完整业务 URL，带 `jobversion` / `encryptId` / `enterSource` 等易变参数，其中 `encryptId` 疑似会话相关 | 作**校验模式**时，SPA 路由变化后永远匹配不上；作**入口**时随时可能失效。职责不清 → 无法判断「该不该匹配」 |
| (b) | **真源漂移**：seed 文件里 `mock_demo` 的 pattern 仍是 `file://*publish-mock.html`（**含通配**），库里已被手工改成 http 8430 | 本地能跑，但用该 seed 建的**新库**点发布会直接抛错。`INSERT IGNORE` 不会自我修正 |
| (c) | **BOSS 渠道没有 seed 文件**：只存在于本地库 | 新库拿不到 BOSS 渠道 → 本轮验收（BOSS 单渠道跑通）在新环境无法复现 |

顺带记录一处历史回归：旧版 `popup.js` 曾有 `openPublishPage()` + `matchUrl()` 复用活动页的分支，重构进 `background.js` 时丢失了。当前渠道数据碰不到它，但**一旦有渠道配了通配 pattern 就会立刻暴露**。

### 7.3 解法：拆开两个语义

`channel` 表补 `publish_entry_url`（DDL 见 §8）：

- `publish_entry_url` = **去哪儿**（导航）→ 扩展 `tabs.create` 用它
- `publish_url_pattern` = **是不是对的地方**（注入校验）→ 扩展注入前比对
- `NULL` = 未配置 → 扩展应**明确报错**，不得猜 URL（猜错等于往错误页面注入表单）

**配套修正**（本批次已完成）：

| 修正 | 文件 |
|---|---|
| 种子 pattern 去掉通配，与库一致；两列补齐 | `sql/seed/channel_seed_mock_demo_20260915_V1.sql` **已改** ✅ |
| 新增 BOSS 渠道种子（field_map_json 从库**只读导出**，原样保留 `valueMap`/`nth`/`_unit`） | `sql/seed/channel_seed_boss_20260916_V1.sql` **已新增** ✅ |
| 存量库回填入口（不含通配的 pattern 原值抄入 entry） | `sql/upgrade/channel_backfill_publish_entry_url_20260916_V1.sql` **已新增** ✅ |

### 7.4 ⚠️ 两项必须人工核对的待办

| 待办 | 说明 |
|---|---|
| **BOSS 真实发布页入口** | 种子与回填用的是**权宜值**（从 pattern 抄来的 URL）。该 URL 带易变参数，`encryptId` 疑似会话相关，直接导航未必能落到可用的发布表单。**上线前需人工在浏览器里登录 BOSS → 进入「发布职位」页面 → 复制地址栏 URL**，更新库数据与种子文件 |
| **`publish_url_pattern` 收成通配** | 它的正式语义是「校验模式」。要等 `background.js` 的通配处理与注入校验逻辑就绪后再迁移。现在不动，避免在扩展未就绪时改变现有可用行为 |

> BOSS 的 `field_map_json` 是**实际联调时手工调好的**，含三处不可简化项：`nth`（薪资行两个下拉靠 0/1 区分）、`valueMap`（平台选项文本 ≠ 系统取值，如 `bachelor` → 本科）、`_unit: yuanToK`（`salary_min` 存元、平台要 K）。**任何"整理"都会让填充直接失效。**

---

## 8. 文件清单

### Phase 0 · 权限与数据真源（**必须先做**）

> 本轮**已完成的 SQL 真源部分**（下表标 ✅ 者）无需再写，只需**人工执行**。执行清单见 §12。

| 仓库 | 文件 | 动作 |
|---|---|---|
| recruit-server | `sql/hr_request_alter_add_owner_20260916_V1.sql` | **新增** ✅（表/列/索引三级守卫） |
| recruit-server | `sql/hr_request_create_20260915_V1.sql` | **改**：建表加 `owner_user_id` + `idx_owner` ✅ |
| recruit-server | `sql/upgrade/hr_request_backfill_owner_20260916_V1.sql` | **新增** ✅（**人工执行**） |
| recruit-server | `sql/channel_alter_add_publish_entry_url_20260916_V1.sql` | **新增** ✅ |
| recruit-server | `sql/channel_create_20260915_V1.sql` | **改**：加 `publish_entry_url` ✅ |
| recruit-server | `sql/seed/channel_seed_mock_demo_20260915_V1.sql` | **改**：pattern 去通配 + 补 `publish_entry_url` ✅ |
| recruit-server | `sql/seed/channel_seed_boss_20260916_V1.sql` | **新增** ✅（BOSS 渠道固化，field_map 从库导出） |
| recruit-server | `sql/upgrade/channel_backfill_publish_entry_url_20260916_V1.sql` | **新增** ✅（**人工执行**） |
| recruit-server | `sql/extension_token_alter_add_expires_20260916_V1.sql` | **新增** ✅ |
| recruit-server | `sql/extension_token_create_20260915_V1.sql` | **改**：加 `expires_at` + `idx_status_expires` ✅ |
| recruit-server | `service/PositionAccessService.java` | **新增**：授权判定唯一真源 |
| recruit-server | `service/HrRequestService.java` | **改**：创建时写 owner；读接口接 `viewScope`；状态流转接 `assertCanOperate` |
| recruit-server | `service/PublishRecordService.java` | **改**：`page` 归属过滤；`report` / `revert` 归属校验；`listPendingForExt` 按 `extUserId` 过滤 |
| recruit-server | `service/PublishDraftService.java` | **改**：`listByRequest` 归属前置校验 |
| recruit-server | `controller/HrRequestController.java` · `PublishRecordController.java` · `PublishDraftController.java` · `ExtApiController.java` | **改**：取 `userId` / `extUserId` 传入 service（Controller 不判权限） |
| recruit-server | `test/.../PositionAccessServiceTest.java` | **新增**：权限矩阵单测 |
| recruit-server | `test/.../ExtDraftIsolationTest.java` | **新增**：扩展端跨用户越权回归 |
| extension | `background.js` | **改**：修通配回归（补回 `matchUrl` 分支）+ 支持 `publishEntryUrl` |
| 人工 | BOSS / mock_demo 入口地址核对 | **必须人工**（见 §7.4） |

### Phase 1 · 零配置授权

| 仓库 | 文件 | 动作 |
|---|---|---|
| recruit-server | `controller/ExtensionSessionController.java` | **新增**：`POST /api/extension/session-token` |
| recruit-server | `vo/ExtensionSessionTokenVO.java` | **新增** |
| recruit-server | `service/ExtensionTokenService.java` | **改**：`resolveForSession(userId, oldToken)` 复用 / 签发；`verify` 增加过期判定 |
| recruit-server | `entity/ExtensionToken.java` | **改**：加 `expiresAt` |
| extension | `manifest.json` | **改**：中台域 host_permissions + `content_scripts` + `tabs` 权限 + 固定 ID 的 `key` |
| extension | `content/bridge.js` | **新增**：心跳 · postMessage 桥 · 原地 toast · 触发换权 |
| extension | `background.js` | **改**：换权流程 + `startFill({recordId})` 自拉草稿 |
| extension | `options/` | **改**：降级为「后端地址 + 高级手动 token」，修正 token 存储文案漂移 |

### Phase 2 · 中台侧触发 + 自动回执

| 仓库 | 文件 | 动作 |
|---|---|---|
| recruit-web | `src/composables/useExtensionBridge.ts` | **新增**：心跳监听 · 状态机 · 发指令 · 收结果 |
| recruit-web | `src/components/PublishButton.vue` | **新增** |
| recruit-web | `src/pages/hr-requests/HrRequestDetailPage.vue` | **改**：草稿行接入发布按钮 |
| recruit-web | `src/pages/publish-records/PublishRecordListPage.vue` | **改**：接入 + 待确认内联按钮 + toast + 权限空态文案 |
| recruit-server | `controller/ExtApiController.java` | **改**：加 `POST /records/{id}/revert` |
| extension | `content/sentinel.js` | **新增**：平台页提交哨兵 |
| extension | `background.js` | **改**：填充后注入哨兵 · 自动 report · 广播回中台 |

### Phase 3 · 打磨（**本轮不做**）

- 多平台一键铺渠道（串行打开、逐个填充）
- popup 改造为诊断面板
- 岗位负责人改派接口 / 创建时指定负责人

---

## 9. 红线修订

支柱三触及原红线 4「扩展不上传页面内容」的字面。**修订后**：

> **不上传平台页面的 DOM 内容、文本与候选人数据**；仅允许回传**发布结果状态与发布页 URL**——即 `publish_record.published_url` 的自动取值路径。

依据：`published_url` 与 `status` 本就是设计里允许 HR 手填回传的字段（channel-publish.md §5.4），性质未变，只是从「人抄」变成「机器抄」。禁止项反而比原文更明确。

红线 1（永不自动提交）**不变**，哨兵只观测、不点击。红线 2、3、5 不变。

---

## 10. 验收

### 10.1 ⚠️ 验收数据前置（实测发现，必须先处理）

只读核对本地库（2026-09-16）：

```
hr_request 共 10 行，created_by 全部 = 1（admin），created_by IS NULL 的行数 = 0
```

即**所有岗位都属于 admin，没有一行属于 hr001**（此前 E2E 验收全部用 admin 的 token 建单）。

因此 `owner = created_by` 回填后：**hr001 登录后一条岗位都看不到**（fail-closed 按设计工作，不是 bug）。

**要跑通第 2 条验收条件（HR 能看到自己岗位并发布），必须先造一条 owner = hr001 的岗位**：

```
1) 用 hr001 登录中台（POST /api/auth/login）
2) hr001 创建需求单 → created_by = owner_user_id = hr001
3) submit → approve（一期审批无角色限制，hr001 亦可）
4) 该岗位的渠道草稿与台账随之生成，owner 归属 hr001
```

验收时需**同时**验证反向：admin 登录能看到全部 11 条，hr001 只看到自己那 1 条。

### 10.2 权限验收（对应 §2.2 第 2 条）

| # | 场景 | 期望 |
|---|---|---|
| 1 | `PositionAccessServiceTest` 枚举（ADMIN / owner / 非 owner）×（canView / canOperate / NULL 归属） | 与 ADR-008 §5 矩阵逐格一致 |
| 2 | hr001 拉 `GET /api/ext/drafts` | **不含** admin 负责岗位的草稿 |
| 3 | hr001 用 admin 的 recordId 调 `report` | 403，且台账行**未被修改** |
| 4 | hr001 带 admin 的岗位 id 访问详情 | 403（前端给出可见提示，非静默） |
| 5 | hr001 拉 `GET /api/hr-requests` | 仅自己的 1 条 |
| 6 | admin 重复 2~5 | 全部可见 / 可操作 |
| 7 | `owner_user_id IS NULL` 的岗位，hr001 访问 | 403（fail-closed） |
| 8 | 中台页面上，非本人岗位 | **发布按钮不出现**（数据未返回，非前端隐藏） |

### 10.3 无感化验收（对应 §2.2 第 3 条）

| # | 场景 | 期望 |
|---|---|---|
| 9 | 首次装扩展后打开中台并登录 | 零配置，扩展自动获得 token（`chrome.storage.local` 可见） |
| 10 | 重启浏览器后再打开中台 | token 复用（`reused: true`），不产生新 token 行 |
| 11 | 中台点「发布」 | 后台打开 BOSS 发布页并填充，**焦点不被打断**；完成后切前台 |
| 12 | 平台人工提交 | 中台原地 toast + 台账行变绿，`published_url` 正确 |
| 13 | 5 秒内点「撤销」 | record 回到 pending，`published_at` / `published_url` 清空 |
| 14 | BOSS 未登录 | 5s 内失败并给出明确提示，不空等 |
| 15 | 扩展未安装 | 按钮置灰 + 安装引导，不报错 |
| 16 | 通配 pattern 渠道（`https://www.zhipin.com/*publish*`） | 用 `publish_entry_url` 正常打开，不再抛错 |

### 10.4 代码质量验收（对应 §2.2 第 1 条）

| # | 检查 | 期望 |
|---|---|---|
| 17 | `mvn compile -DskipTests` | BUILD SUCCESS |
| 18 | `npx vue-tsc -b`（recruit-web） | 无类型错误 |
| 19 | `grep -rn "Mapper" controller/` | 无输出（分层纪律） |
| 20 | `grep -rn "getRole()" controller/` | 无输出（Controller 不判权限） |
| 21 | 全部新增读接口 | 均出现 `positionAccessService` 调用 |

---

## 11. 风险

| 风险 | 对策 |
|---|---|
| **漏接 `viewScope()` 导致静默越权** | 这是本方案最大代价（§3.3）。靠 §10.4 第 21 条 grep + 每个新读接口补越权用例兜住 |
| 存量回填漏跑 → 岗位对 HR 集体消失 | fail-closed 的已知代价。backfill 脚本头部显式警告；验收 §10.2 第 7 条覆盖 |
| 哨兵误判（把非成功状态当成功） | `success` 保守配置（URL + 选择器双命中）；5s 撤销窗口；超时转人工「待确认」 |
| 平台改版导致 success / 字段配置失效 | 同 `field_map_json`，数据化热更，不改代码 |
| BOSS 真实页面与 mock 页结构差异大 | 本轮以真实 BOSS 页为准调 `field_map_json`；`publish_entry_url` 需实填 |
| content script 在中台域被 CSP 拦 | bridge 走 `chrome.scripting.registerContentScripts` 动态注册兜底 |
| 扩展 ID 变化导致 Origin 白名单失效 | manifest 固定 `key`，装机文档说明 |
| 零配置被滥用（恶意扩展借登录态领 token） | §4.4 四条：active 校验 + Origin 白名单 + 过期时间 + 固定 ID |
| `/api/extension/**` 与 `/api/ext/**` 混淆 | 差一个 `s`，已在 §4.5 与 `layer-structure.md §5` 双向标注 |

---

## 12. 实施顺序

### 12.1 先执行的 SQL（人工，按序）—— ✅ 2026-09-16 已在本地库执行完毕

> **当前状态**：以下 ①②③ 全部已执行，核对项通过（三列 + 两索引均在）。本节保留为**可重复执行的路径**，新环境 / 需要重置时照跑即可；幂等性已实测（连跑两次，第二次全部打印「已存在，跳过」，零改动）。
> 后续如需改列注释，改的是 `sql/*.sql` 里的「注释收敛」段——重跑 `db-bootstrap.sh` 即自动收敛到库里，不要手工 `UPDATE` 注释。

```bash
# ① 幂等改表 + 种子（db-bootstrap.sh 会跑 sql/*.sql 与 sql/seed/*.sql）
#    三个 *_alter_* 脚本自带「表/列/索引」三级守卫，可安全重复执行；
#    注意字典序下 alter 会排在 create 之前，脚本已按此设计（表不存在则跳过）。
./scripts/db-bootstrap.sh

# ② 一次性迁移（按序，bootstrap 不会跑）
docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 \
  -uroot -precruit2024 recruit_platform \
  < recruit-server/sql/upgrade/hr_request_backfill_owner_20260916_V1.sql

docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 \
  -uroot -precruit2024 recruit_platform \
  < recruit-server/sql/upgrade/channel_backfill_publish_entry_url_20260916_V1.sql

# ③ 核对（应看到 owner_user_id / publish_entry_url / expires_at 三列存在）
docker exec -i recruit-mysql mysql --default-character-set=utf8mb4 \
  -uroot -precruit2024 recruit_platform -e "
    SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='recruit_platform'
      AND COLUMN_NAME IN ('owner_user_id','publish_entry_url','expires_at');
    SELECT id, code, publish_url_pattern, publish_entry_url FROM channel ORDER BY sort_order;"
```

### 12.2 阶段推进

```
Phase 0  权限与数据真源（先做，否则后面白做）
  0.1 执行 §12.1 的 SQL（人工）
  0.2 造 owner=hr001 的验收数据（§10.1）—— 不做这步，第 2 条验收无数据可测
  0.3 PositionAccessService + 逐接口接线 + 单测 → 跑通 §10.2
  0.4 修 background.js 通配回归 + publishEntryUrl 支持 → 跑通 §10.3-16
  0.5 人工核对 BOSS 真实发布页入口（§7.4）

Phase 1  零配置授权 → 跑通 §10.3-9/10
Phase 2  中台触发 + 哨兵自动回执 → 跑通 §10.3-11~15
Phase 3  本轮不做
```

**每阶段结束都必须过 §10.4 代码质量检查**，且 `mvn compile` 未通过不得进入下一阶段。
