# Phase 2 端到端测试指南

## 测试环境

### 服务状态
- ✅ 后端服务：http://localhost:6017
- ✅ 前端服务：http://localhost:8430
- ✅ 数据库：127.0.0.1:3307 (recruit_platform)

### 测试账号

| 账号 | 密码 | 角色 | 说明 |
|------|------|------|------|
| `admin` | `admin123` | ADMIN | 系统管理员 |
| `hr001` | `hr123456` | HR | HR 张三 |

## 测试数据

- 招聘需求（hr_request）：15 条
- 待发布记录（publish_record，status='pending'）：9 条

## Phase 2 功能测试清单

### 2.1 零配置授权（Phase 1 已完成）

✅ **前置条件**：浏览器扩展已加载

1. 访问 http://localhost:8430
2. 使用 `hr001` / `hr123456` 登录
3. 打开浏览器扩展 popup，确认自动换权成功

**预期结果**：
- popup 显示当前用户信息
- 扩展获得 X-Extension-Token

---

### 2.2 中台触发填充

✅ **测试路径**：岗位列表页 → 发布到 BOSS

#### 步骤

1. 登录中台：http://localhost:8430 (`hr001` / `hr123456`)
2. 导航到「岗位管理」→「需求列表」
3. 找到有「发布到 BOSS」按钮的岗位（status='pending' 的记录）
4. 观察按钮状态变化：
   - **初始状态**：灰色 "扩展未安装"（如果扩展未加载）
   - **扩展就绪**：橙色 "发布到 BOSS"（可点击）
5. 点击「发布到 BOSS」按钮

**预期结果**：

- 按钮变为 loading 状态（旋转图标 + "填充中..."）
- 控制台显示 bridge 协议消息：
  ```
  [Bridge] 收到页面 FILL_REQUEST，转发给 background
  [Background] 收到 FILL_REQUEST
  [Background] 草稿数据获取成功
  ```
- 自动打开 BOSS 直聘发布页（后台 tab）
- 表单自动填充完成
- 发布页切换到前台
- 按钮状态变为 "已填充"

---

### 2.3 哨兵自动回执

✅ **测试路径**：填充完成 → 手动提交 → 自动回填

#### 步骤

1. 完成 2.2 的填充操作
2. 在打开的 BOSS 直聘页面，**手动**点击"发布"按钮（扩展不会自动点击）
3. 等待 BOSS 直聘跳转到发布成功页面
4. 观察哨兵监听：
   - 哨兵脚本自动检测 URL 变化和页面元素
   - 满足成功信号条件（URL pattern + CSS selectors）

**预期结果**：

- 控制台显示哨兵日志：
  ```
  [Sentinel] URL 匹配成功
  [Sentinel] 选择器匹配成功
  [Sentinel] 成功信号双命中，准备回填
  [Sentinel] 回填成功
  ```
- 后端收到 POST /api/ext/records/{id}/report 请求
- publish_record 状态更新为 'published'
- 中台岗位列表页按钮状态变为 "已发布"
- 控制台显示 PUBLISH_BACK 消息

---

### 2.4 撤销发布（5分钟窗口）

✅ **测试路径**：已发布 → 撤销 → pending

#### 步骤

1. 找到一条刚发布的记录（5分钟内）
2. 调用撤销接口（通过 API 测试工具或扩展功能）：
   ```bash
   curl -X POST http://localhost:6017/api/ext/records/{recordId}/revert \
     -H "X-Extension-Token: {your_token}"
   ```

**预期结果**：

- 返回成功：`{"code": 200, "message": "撤销成功"}`
- publish_record.status 恢复为 'pending'
- publish_record.published_url 清空
- 岗位列表页重新显示「发布到 BOSS」按钮

#### 边界测试

- ❌ **超过5分钟**：返回 `{"code": 400, "message": "超过撤销时限（5分钟）"}`
- ❌ **非 pending 状态**：返回 `{"code": 400, "message": "当前状态不可撤销"}`
- ❌ **无权限**：返回 `{"code": 403, "message": "无权访问该岗位"}`

---

### 2.5 归属权限验证

✅ **测试路径**：跨用户数据隔离

#### 步骤

1. 使用 `hr001` 登录
2. 记录一个 hr001 创建的 recordId
3. 登出，使用 `admin` 登录
4. 尝试访问 hr001 的 recordId：
   ```bash
   curl http://localhost:6017/api/ext/drafts/{recordId} \
     -H "X-Extension-Token: {admin_token}"
   ```

**预期结果**：

- ❌ 返回 403 或数据为空（取决于 PositionAccessService 实现）
- 后端日志显示归属校验失败

---

## 调试提示

### 查看扩展日志

1. Chrome DevTools → Console（查看页面端日志）
2. Chrome 扩展管理页 → 详情 → 查看视图：Service Worker（查看 background 日志）

### 查看 bridge 协议消息

打开控制台，筛选包含以下关键词的日志：
- `[Bridge]`：页面 bridge.js 日志
- `[Background]`：扩展 background.js 日志
- `[Sentinel]`：哨兵 sentinel.js 日志

### 常见问题

1. **按钮显示"扩展未安装"**
   - 检查扩展是否正确加载
   - 检查 manifest.json 的 host_permissions 是否包含 http://localhost:8430/*

2. **填充失败**
   - 检查 X-Extension-Token 是否有效
   - 检查 publish_record 的 field_map_json 配置是否正确

3. **哨兵未触发**
   - 检查 field_map_json.success 配置
   - 检查 urlPattern 和 selectors 是否匹配实际页面

---

## 技术实现要点

### Bridge 协议消息类型

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `EXT_READY` | extension → page | 扩展心跳（5秒间隔） |
| `FILL_REQUEST` | page → extension | 触发填充请求 |
| `FILL_PROGRESS` | extension → page | 填充进度通知 |
| `FILL_RESULT` | extension → page | 填充结果 |
| `PUBLISH_BACK` | extension → page | 发布成功回传 |
| `SENTINEL_SUCCESS` | sentinel → background | 哨兵成功信号 |

### 状态机

```
not_installed → ready → filling → filled → registered
     ↑                                         ↓
     └─────────── (5分钟撤销) ───────────────┘
```

### 关键文件

- Backend: `PublishRecordService.revert()`, `ExtApiController`
- Frontend: `useExtensionBridge.ts`, `HrRequestListPage.vue`
- Extension: `background.js`, `bridge.js`, `sentinel.js`

---

## 验收标准

✅ **Phase 2 完整流程验收**：

1. 在中台岗位列表页点击「发布到 BOSS」
2. 自动打开 BOSS 页面并填充表单
3. 手动点击 BOSS 的「发布」按钮
4. 哨兵自动检测成功并回填状态
5. 中台页面显示「已发布」状态
6. 5分钟内可撤销，按钮恢复为「发布到 BOSS」

**通过条件**：以上流程全部无报错、无手动干预（除提交按钮）、状态同步正确。
